import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import { CodexAppServerAdapter, defaultCodexWebsocketUrl, type CodexServerMessage } from './codex-app-server'
import {
  appendUserMessage,
  clearAgentRuntimeState,
  clearRuntimeContextUsage,
  getAgentLaunchConfig,
  getAgentThinkingLevel,
  getAgentRuntimeState,
  recordAgentInfoEvent,
  recordRuntimeContextUsage,
  recordRuntimeMessage,
  recordRuntimeTimelineEvent,
  replaceAgentDiffArtifacts,
  resetSession as resetStoredSession,
  setAgentRuntimeState,
  setAgentStatus,
} from './db'

type CodexRuntimeState = {
  threadId?: string
  activeTurnId?: string
  websocketUrl?: string
  userAgent?: string
}

type CodexTurn = {
  id?: string
  status?: string
  items?: unknown[]
}

const adapters = new Map<string, CodexAppServerAdapter>()
const adapterListeners = new Set<string>()
const threadAgents = new Map<string, string>()
const agentThreads = new Map<string, string>()
const queues = new Map<string, Promise<void>>()
const sessionGenerations = new Map<string, number>()
const CODEX_SANDBOX_MODE = 'danger-full-access'
const CODEX_SANDBOX_POLICY = { type: 'dangerFullAccess' } as const

export async function promptCodexAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'codex') {
    throw new Error(`${config.runtime} agent is not a Codex session`)
  }

  const state = codexState(readState(config.runtimeStateJson) ?? getAgentRuntimeState(config.id))
  const text = promptWithSavedImages(config.id, input.text, input.images ?? [])
  if (state.threadId && state.activeTurnId) {
    await steerCodexTurn(config.id, state, text)
    return
  }

  const previous = queues.get(config.id) ?? Promise.resolve()
  const next = previous.then(() => promptCodexAgentNow({
    ...config,
    runtimeState: getAgentRuntimeState(config.id),
  }, text))
  queues.set(config.id, next.catch(() => {}))
  await next
}

export async function steerCodexAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  const state = codexState(getAgentRuntimeState(config.id))
  if (!state.threadId || !state.activeTurnId) {
    return promptCodexAgent(input)
  }

  await steerCodexTurn(
    config.id,
    state,
    promptWithSavedImages(config.id, input.text, input.images ?? []),
  )
}

export async function interruptCodexAgent(input: { agentId: string }) {
  const state = codexState(getAgentRuntimeState(input.agentId))
  if (!state.threadId || !state.activeTurnId) {
    throw new Error('Codex session has no active turn to interrupt')
  }
  const adapter = getOrCreateCodexAdapter(state.websocketUrl)
  await adapter.request('turn/interrupt', {
    threadId: state.threadId,
    turnId: state.activeTurnId,
  })
}

export async function setCodexThinkingLevel(input: {
  agentId: string
  level?: ThinkingLevel
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'codex') {
    throw new Error(`${config.runtime} agents do not support Codex thinking`)
  }

  const level = input.level ?? nextThinkingLevel(getAgentThinkingLevel(config.id))
  recordAgentInfoEvent({
    agentId: config.id,
    kind: 'thinking_level',
    label: 'Thinking level changed',
    detail: level,
  })
  return level
}

export async function resetCodexSession(input: { agentId: string }) {
  sessionGenerations.set(input.agentId, (sessionGenerations.get(input.agentId) ?? 0) + 1)
  const state = codexState(getAgentRuntimeState(input.agentId))
  if (state.threadId && state.activeTurnId) {
    try {
      const adapter = getOrCreateCodexAdapter(state.websocketUrl)
      await adapter.request('turn/interrupt', {
        threadId: state.threadId,
        turnId: state.activeTurnId,
      })
    } catch {
      // Reset should clear local state even if the remote turn is already gone.
    }
  }
  if (state.threadId) {
    threadAgents.delete(state.threadId)
    agentThreads.delete(input.agentId)
  }
  clearAgentRuntimeState(input.agentId)
  resetStoredSession(input.agentId)
}

async function promptCodexAgentNow(
  config: ReturnType<typeof getAgentLaunchConfig> & { runtimeState: Record<string, unknown> },
  text: string,
) {
  const adapter = getOrCreateCodexAdapter(stringValue(config.runtimeState.websocketUrl))
  const state = codexState(config.runtimeState)
  const generation = sessionGenerations.get(config.id) ?? 0
  let activeThreadId = state.threadId
  setAgentStatus(config.id, 'running')
  appendUserMessage({ agentId: config.id, text })

  try {
    const threadId = await ensureCodexThread({ adapter, config, state })
    if ((sessionGenerations.get(config.id) ?? 0) !== generation) return
    activeThreadId = threadId
    threadAgents.set(threadId, config.id)
    agentThreads.set(config.id, threadId)
    const latestState = codexState(getAgentRuntimeState(config.id))
    if (latestState.threadId && latestState.activeTurnId) {
      await steerCodexTurn(config.id, latestState, text)
      return
    }
    const turnResponse = objectValue(await adapter.request('turn/start', {
      threadId,
      input: textInput(text),
      model: config.model,
      sandboxPolicy: CODEX_SANDBOX_POLICY,
      ...codexReasoningOptions(getAgentThinkingLevel(config.id)),
    }))
    const turn = objectValue(turnResponse.turn)
    const turnId = stringValue(turn.id)
    setCodexState(config.id, {
      ...state,
      threadId,
      activeTurnId: turnId,
      websocketUrl: adapterUrl(state.websocketUrl),
    })
    const completedTurn = objectValue(
      await adapter.waitForTurnCompleted({ threadId, turnId }),
    ) as CodexTurn
    if ((sessionGenerations.get(config.id) ?? 0) !== generation) return
    recordCodexTurn(config.id, completedTurn)
    setCodexState(config.id, {
      ...state,
      threadId,
      websocketUrl: adapterUrl(state.websocketUrl),
    })
    setAgentStatus(config.id, 'idle')
  } catch (error) {
    if ((sessionGenerations.get(config.id) ?? 0) !== generation) return
    setCodexState(config.id, {
      ...state,
      threadId: activeThreadId,
      websocketUrl: adapterUrl(state.websocketUrl),
    })
    setAgentStatus(config.id, 'failed')
    recordRuntimeTimelineEvent({
      agentId: config.id,
      kind: 'codex_error',
      tone: 'error',
      label: 'Codex error',
      detail: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function ensureCodexThread(input: {
  adapter: CodexAppServerAdapter
  config: ReturnType<typeof getAgentLaunchConfig>
  state: CodexRuntimeState
}) {
  if (input.state.threadId) {
    await input.adapter.request('thread/resume', {
      threadId: input.state.threadId,
      cwd: input.config.cwd,
      model: input.config.model,
      approvalPolicy: 'never',
      sandbox: CODEX_SANDBOX_MODE,
    })
    return input.state.threadId
  }

  const response = objectValue(await input.adapter.request('thread/start', {
    cwd: input.config.cwd,
    model: input.config.model,
    approvalPolicy: 'never',
    sandbox: CODEX_SANDBOX_MODE,
  }))
  const thread = objectValue(response.thread)
  const threadId = stringValue(thread.id)
  if (!threadId) throw new Error('Codex app-server did not return a thread id')
  setCodexState(input.config.id, {
    ...input.state,
    threadId,
    websocketUrl: adapterUrl(input.state.websocketUrl),
  })
  return threadId
}

function getOrCreateCodexAdapter(websocketUrl: string | undefined) {
  const url = adapterUrl(websocketUrl)
  let adapter = adapters.get(url)
  if (!adapter) {
    adapter = new CodexAppServerAdapter({
      websocketUrl: url,
      spawnIfMissing: !process.env.PICAN_CODEX_APP_SERVER_URL,
      codexHome: process.env.PICAN_CODEX_HOME,
    })
    adapters.set(url, adapter)
  }
  if (!adapterListeners.has(url)) {
    adapterListeners.add(url)
    adapter.onMessage((message) => handleCodexServerMessage(adapter, message))
  }
  return adapter
}

function handleCodexServerMessage(adapter: CodexAppServerAdapter, message: CodexServerMessage) {
  const params = objectValue(message.params)
  const threadId = stringValue(params.threadId)
  const agentId = threadId ? threadAgents.get(threadId) : undefined
  if (agentId && agentThreads.get(agentId) !== threadId) return

  if ('id' in message) {
    if (agentId) {
      setAgentStatus(agentId, 'blocked')
      recordRuntimeTimelineEvent({
        agentId,
        kind: 'codex_server_request',
        tone: 'info',
        label: message.method,
        detail: 'Codex requested client-side input or approval.',
        payload: message,
      })
    }
    const response = automaticServerRequestResponse(message.method)
    if (response) {
      adapter.respond(message.id, response)
    } else {
      adapter.reject(message.id, `Pican cannot handle ${message.method} yet`)
    }
    return
  }

  if (!agentId) return
  if (message.method === 'thread/status/changed') {
    const status = objectValue(params.status)
    if (status.type === 'active') setAgentStatus(agentId, 'running')
    else if (status.type === 'systemError') setAgentStatus(agentId, 'failed')
    else setAgentStatus(agentId, 'idle')
    return
  }
  if (message.method === 'thread/tokenUsage/updated') {
    const usage = objectValue(params.tokenUsage)
    const total = objectValue(usage.total)
    const usedTokens = numberValue(total.totalTokens)
    recordRuntimeContextUsage({ agentId, usedTokens })
    return
  }
  if (message.method === 'thread/compacted') {
    clearRuntimeContextUsage(agentId)
    recordRuntimeTimelineEvent({
      agentId,
      kind: 'codex_context_compacted',
      tone: 'info',
      label: 'Context compacted',
      detail: 'Codex compacted this thread context.',
      payload: message,
    })
    return
  }
  if (message.method === 'turn/diff/updated') {
    const diff = stringValue(params.diff) ?? ''
    replaceAgentDiffArtifacts({
      agentId,
      diffs: diff ? [{ title: 'Codex diff', path: '.', patch: diff }] : [],
    })
    return
  }
  if (message.method === 'turn/started') {
    const turnId = stringValue(params.turnId) ?? stringValue(objectValue(params.turn).id)
    if (turnId) {
      const currentState = codexState(getAgentRuntimeState(agentId))
      setCodexState(agentId, {
        ...currentState,
        threadId,
        activeTurnId: turnId,
        websocketUrl: adapterUrl(currentState.websocketUrl),
      })
    }
    recordRuntimeTimelineEvent({
      agentId,
      kind: 'codex_turn_started',
      tone: 'thinking',
      label: 'Turn started',
      payload: message,
    })
    return
  }
  if (message.method === 'item/completed') {
    recordCodexItem(agentId, params.item, timestampFromMs(params.completedAtMs))
  }
}

async function steerCodexTurn(agentId: string, state: CodexRuntimeState, text: string) {
  const adapter = getOrCreateCodexAdapter(state.websocketUrl)
  await adapter.request('turn/steer', {
    threadId: state.threadId,
    expectedTurnId: state.activeTurnId,
    input: textInput(text),
  })
  appendUserMessage({ agentId, text })
}

function recordCodexTurn(agentId: string, turn: CodexTurn) {
  const timestamp = new Date().toISOString()
  for (const item of turn.items ?? []) {
    recordCodexItem(agentId, item, timestamp)
  }
}

function recordCodexItem(agentId: string, item: unknown, timestamp = new Date().toISOString()) {
  const object = objectValue(item)
  const id = stringValue(object.id)
  const type = stringValue(object.type)
  if (!id || !type) return
  if (type === 'agentMessage') {
    recordRuntimeMessage({
      agentId,
      id: `codex-${agentId}-${id}`,
      role: 'assistant',
      text: stringValue(object.text) ?? '',
      timestamp,
    })
    return
  }
  if (type === 'reasoning') {
    const text = [...stringArray(object.summary), ...stringArray(object.content)].join('\n')
    recordRuntimeTimelineEvent({
      agentId,
      kind: 'codex_reasoning',
      tone: 'thinking',
      label: 'Reasoning',
      detail: text || null,
      payload: item,
      timestamp,
    })
    return
  }
  if (type === 'commandExecution') {
    recordRuntimeMessage({
      agentId,
      id: `codex-${agentId}-${id}`,
      role: 'tool',
      text: commandText(object),
      timestamp,
    })
  }
}

function setCodexState(agentId: string, state: CodexRuntimeState) {
  setAgentRuntimeState(agentId, Object.fromEntries(
    Object.entries(state).filter(([, value]) => value !== undefined),
  ))
}

function codexState(value: Record<string, unknown>): CodexRuntimeState {
  return {
    threadId: stringValue(value.threadId),
    activeTurnId: stringValue(value.activeTurnId),
    websocketUrl: stringValue(value.websocketUrl),
    userAgent: stringValue(value.userAgent),
  }
}

function readState(value: string | null | undefined) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return objectValue(parsed)
  } catch {
    return null
  }
}

function textInput(text: string) {
  return [{ type: 'text', text, text_elements: [] }]
}

function promptWithSavedImages(agentId: string, text: string, images: SendMessageImage[]) {
  if (images.length === 0) return text

  const paths = images.map((image, index) => savePromptImage(agentId, image, index))
  return `${text.trim()}\n\nAttached image files:\n${paths
    .map((path) => `- ${path}`)
    .join('\n')}\n\nUse these file paths if you need to inspect the images.`
}

function savePromptImage(agentId: string, image: SendMessageImage, index: number) {
  const bytes = Buffer.from(image.data, 'base64')
  if (bytes.length > 5 * 1024 * 1024) {
    throw new Error(`Image "${image.name}" is larger than 5MB`)
  }

  const dir = join(process.cwd(), '.pican', 'attachments', safePathSegment(agentId))
  mkdirSync(dir, { recursive: true })
  const path = join(
    dir,
    `${Date.now()}-${index + 1}-${safePathSegment(image.name, 'image')}${imageExtension(image)}`,
  )
  writeFileSync(path, bytes, { flag: 'wx' })
  return path
}

function imageExtension(image: SendMessageImage) {
  const existing = extname(image.name).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(existing)) return ''
  if (image.mimeType === 'image/png') return '.png'
  if (image.mimeType === 'image/webp') return '.webp'
  if (image.mimeType === 'image/gif') return '.gif'
  return '.jpg'
}

function safePathSegment(value: string, fallback = 'attachment') {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || fallback
}

function adapterUrl(value: string | undefined) {
  return value ?? defaultCodexWebsocketUrl()
}

function codexReasoningOptions(level: ThinkingLevel | null) {
  if (!level) return {}
  return { effort: level === 'off' ? 'none' : level }
}

function nextThinkingLevel(current: ThinkingLevel | null) {
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
  const index = current ? levels.indexOf(current) : -1
  return levels[(index + 1) % levels.length]
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === 'number' ? value : undefined
}

function timestampFromMs(value: unknown) {
  return typeof value === 'number' ? new Date(value).toISOString() : undefined
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function commandText(item: Record<string, unknown>) {
  const command = stringValue(item.command) ?? 'Command'
  const output = stringValue(item.aggregatedOutput)
  return output ? `${command}\n${output}` : command
}

function automaticServerRequestResponse(method: string) {
  if (method === 'item/commandExecution/requestApproval') {
    return { decision: 'decline' }
  }
  if (method === 'item/fileChange/requestApproval') {
    return { decision: 'decline' }
  }
  if (method === 'item/permissions/requestApproval') {
    return { permissions: {}, scope: 'turn' }
  }
  if (method === 'item/tool/requestUserInput') {
    return { answers: {} }
  }
  if (method === 'mcpServer/elicitation/request') {
    return { action: 'decline', content: null, _meta: null }
  }
  if (method === 'item/tool/call') {
    return {
      contentItems: [{ type: 'inputText', text: 'Pican cannot run client dynamic tools yet.' }],
      success: false,
    }
  }
  if (method === 'execCommandApproval') {
    return { decision: 'denied' }
  }
  if (method === 'applyPatchApproval') {
    return { decision: 'denied' }
  }
  return null
}
