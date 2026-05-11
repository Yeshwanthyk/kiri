import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { Effect } from 'effect'
import type { SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import {
  CodexAppServerAdapter,
  defaultCodexWebsocketUrl,
  decodeServerParams,
  ItemCompletedParamsSchema,
  ThreadCompactedParamsSchema,
  ThreadTokenUsageUpdatedParamsSchema,
  TurnDiffUpdatedParamsSchema,
  TurnStartedParamsSchema,
  type CodexServerMessage,
  type CodexThread,
  type CodexTurn,
} from './codex-app-server'
import {
  appendUserMessage,
  clearAgentRuntimeState,
  clearRuntimeContextUsage,
  getAgentLaunchConfig,
  getSessionDiffFallbackCwds,
  getAgentThinkingLevel,
  getAgentRuntimeState,
  recordAgentInfoEvent,
  recordRuntimeContextUsage,
  recordRuntimeMessage,
  recordRuntimeTimelineEvent,
  replaceAgentDiffArtifacts,
  resetSession as resetStoredSession,
  setAgentStatus,
} from './db'
import { collectGitDiffArtifactsWithFallback, diffArtifactsFromPatch } from './git-diff'
import {
  captureRuntimeDiffs,
  enqueueAgentTurn,
  nextThinkingLevel,
  runAgentTurnLifecycle,
  runRuntimeLifecyclePromise,
  setRuntimeState,
} from './runtime-lifecycle'

type CodexRuntimeState = {
  threadId?: string
  websocketUrl?: string
  userAgent?: string
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
  if (state.threadId) {
    const adapter = getOrCreateCodexAdapter(state.websocketUrl)
    const thread = await readCodexThreadIfAvailable(adapter, state.threadId)
    if (thread) {
      syncCodexThreadStatus(config.id, thread)
      const activeTurnId = activeTurnIdFromThread(thread)
      if (activeTurnId) {
        await steerCodexTurn(config.id, {
          ...state,
          threadId: state.threadId,
        }, activeTurnId, text)
        return
      }
    } else {
      forgetCodexThread(config.id, state)
    }
  }

  await runRuntimeLifecyclePromise(enqueueAgentTurn(config.id, queues, () => promptCodexAgentNow({
    ...config,
    runtimeState: getAgentRuntimeState(config.id),
  }, text)))
}

export async function steerCodexAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  const state = codexState(getAgentRuntimeState(config.id))
  if (!state.threadId) {
    return promptCodexAgent(input)
  }
  const adapter = getOrCreateCodexAdapter(state.websocketUrl)
  const thread = await readCodexThreadIfAvailable(adapter, state.threadId)
  if (!thread) {
    forgetCodexThread(config.id, state)
    return promptCodexAgent(input)
  }
  syncCodexThreadStatus(config.id, thread)
  const activeTurnId = activeTurnIdFromThread(thread)
  if (!activeTurnId) return promptCodexAgent(input)

  await steerCodexTurn(
    config.id,
    { ...state, threadId: state.threadId },
    activeTurnId,
    promptWithSavedImages(config.id, input.text, input.images ?? []),
  )
}

export async function interruptCodexAgent(input: { agentId: string }) {
  const state = codexState(getAgentRuntimeState(input.agentId))
  if (!state.threadId) {
    throw new Error('Codex session has no active turn to interrupt')
  }
  const adapter = getOrCreateCodexAdapter(state.websocketUrl)
  const thread = await readCodexThreadIfAvailable(adapter, state.threadId)
  if (!thread) {
    forgetCodexThread(input.agentId, state)
    throw new Error('Codex session has no active turn to interrupt')
  }
  syncCodexThreadStatus(input.agentId, thread)
  const activeTurnId = activeTurnIdFromThread(thread)
  if (!activeTurnId) {
    throw new Error('Codex session has no active turn to interrupt')
  }
  await adapter.interruptTurn({
    threadId: state.threadId,
    turnId: activeTurnId,
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
  if (state.threadId) {
    try {
      const adapter = getOrCreateCodexAdapter(state.websocketUrl)
      const thread = await readCodexThread(adapter, state.threadId)
      const activeTurnId = activeTurnIdFromThread(thread)
      if (activeTurnId) {
        await adapter.interruptTurn({
          threadId: state.threadId,
          turnId: activeTurnId,
        })
      }
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
  await runRuntimeLifecyclePromise(runAgentTurnLifecycle({
    agentId: config.id,
    displayText: text,
    errorEvent: { kind: 'codex_error', label: 'Codex error' },
    isCurrent: () => (sessionGenerations.get(config.id) ?? 0) === generation,
    successStatus: (markIdle) => markIdle ? 'idle' : null,
    onError: () => {
      setCodexState(config.id, {
        ...state,
        threadId: activeThreadId,
        websocketUrl: adapterUrl(state.websocketUrl),
      })
    },
    run: async () => {
      const threadId = await ensureCodexThread({ adapter, config, state })
      if ((sessionGenerations.get(config.id) ?? 0) !== generation) return false
      activeThreadId = threadId
      threadAgents.set(threadId, config.id)
      agentThreads.set(config.id, threadId)
      const thread = await readCodexThread(adapter, threadId)
      syncCodexThreadStatus(config.id, thread)
      const activeTurnId = activeTurnIdFromThread(thread)
      if (activeTurnId) {
        await steerCodexTurn(config.id, {
          ...state,
          threadId,
          websocketUrl: adapterUrl(state.websocketUrl),
        }, activeTurnId, text)
        return false
      }
      const turnResponse = await adapter.startTurn({
        threadId,
        input: textInput(text),
        model: config.model,
        sandboxPolicy: CODEX_SANDBOX_POLICY,
        ...codexReasoningOptions(getAgentThinkingLevel(config.id)),
      })
      const turnId = turnResponse.turn.id
      setCodexState(config.id, {
        ...state,
        threadId,
        websocketUrl: adapterUrl(state.websocketUrl),
      })
      const completedTurn = await adapter.waitForTurnCompleted({ threadId, turnId })
      if ((sessionGenerations.get(config.id) ?? 0) !== generation) return false
      recordCodexTurn(config.id, completedTurn)
      captureCodexGitDiffArtifacts(config)
      setCodexState(config.id, {
        ...state,
        threadId,
        websocketUrl: adapterUrl(state.websocketUrl),
      })
      return true
    },
  }))
}

function captureCodexGitDiffArtifacts(config: ReturnType<typeof getAgentLaunchConfig>) {
  Effect.runSync(captureRuntimeDiffs(config.id, () =>
    collectGitDiffArtifactsWithFallback(
      config.cwd,
      getSessionDiffFallbackCwds(config.id),
    )))
}

async function ensureCodexThread(input: {
  adapter: CodexAppServerAdapter
  config: ReturnType<typeof getAgentLaunchConfig>
  state: CodexRuntimeState
}) {
  if (input.state.threadId) {
    try {
      const response = await input.adapter.resumeThread({
        threadId: input.state.threadId,
        cwd: input.config.cwd,
        model: input.config.model,
        approvalPolicy: 'never',
        sandbox: CODEX_SANDBOX_MODE,
      })
      syncCodexThreadStatus(input.config.id, response.thread)
      return input.state.threadId
    } catch (error) {
      if (!isMissingRolloutError(error)) throw error
      forgetCodexThread(input.config.id, input.state)
    }
  }

  const response = await input.adapter.startThread({
    cwd: input.config.cwd,
    model: input.config.model,
    approvalPolicy: 'never',
    sandbox: CODEX_SANDBOX_MODE,
  })
  const threadId = response.thread.id
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
      spawnIfMissing: !process.env.AETHER_CODEX_APP_SERVER_URL,
      codexHome: process.env.AETHER_CODEX_HOME,
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
      adapter.reject(message.id, `Aether cannot handle ${message.method} yet`)
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
    const decoded = decodeServerParams(message, ThreadTokenUsageUpdatedParamsSchema)
    if (!decoded) return
    const usage = decoded.tokenUsage
    const total = objectValue(usage.total)
    const last = objectValue(usage.last)
    const usedTokens = numberValue(last.inputTokens) ?? numberValue(total.inputTokens)
    const windowTokens = usage.modelContextWindow
    recordRuntimeContextUsage({ agentId, usedTokens, windowTokens })
    return
  }
  if (message.method === 'thread/compacted') {
    if (!decodeServerParams(message, ThreadCompactedParamsSchema)) return
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
    const decoded = decodeServerParams(message, TurnDiffUpdatedParamsSchema)
    if (!decoded) return
    const diff = decoded.diff ?? ''
    replaceAgentDiffArtifacts({
      agentId,
      diffs: diffArtifactsFromPatch(diff),
    })
    return
  }
  if (message.method === 'turn/started') {
    const decoded = decodeServerParams(message, TurnStartedParamsSchema)
    if (!decoded) return
    const turnId = decoded.turnId ?? decoded.turn?.id
    if (turnId) {
      const currentState = codexState(getAgentRuntimeState(agentId))
      setCodexState(agentId, {
        ...currentState,
        threadId,
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
    const decoded = decodeServerParams(message, ItemCompletedParamsSchema)
    if (!decoded) return
    recordCodexItem(agentId, decoded.item, timestampFromMs(decoded.completedAtMs))
  }
}

async function steerCodexTurn(
  agentId: string,
  state: CodexRuntimeState & { threadId: string },
  activeTurnId: string,
  text: string,
) {
  const adapter = getOrCreateCodexAdapter(state.websocketUrl)
  await adapter.steerTurn({
    threadId: state.threadId,
    expectedTurnId: activeTurnId,
    input: textInput(text),
  })
  appendUserMessage({ agentId, text })
}

async function readCodexThread(adapter: CodexAppServerAdapter, threadId: string) {
  let response: { thread: CodexThread }
  try {
    response = await adapter.readThread({ threadId, includeTurns: true })
  } catch (error) {
    if (!isUnmaterializedThreadReadError(error)) throw error
    response = await adapter.readThread({ threadId, includeTurns: false })
  }
  return response.thread
}

async function readCodexThreadIfAvailable(
  adapter: CodexAppServerAdapter,
  threadId: string,
) {
  try {
    return await readCodexThread(adapter, threadId)
  } catch (error) {
    if (!isMissingRolloutError(error)) throw error
    return null
  }
}

function isUnmaterializedThreadReadError(error: unknown) {
  return error instanceof Error &&
    error.message.includes('not materialized yet') &&
    error.message.includes('includeTurns')
}

function isMissingRolloutError(error: unknown) {
  return error instanceof Error &&
    error.message.includes('no rollout found for thread id')
}

function forgetCodexThread(agentId: string, state: CodexRuntimeState) {
  if (state.threadId) {
    threadAgents.delete(state.threadId)
    agentThreads.delete(agentId)
  }
  setCodexState(agentId, {
    ...state,
    threadId: undefined,
  })
}

function activeTurnIdFromThread(thread: CodexThread) {
  const activeTurn = [...(thread.turns ?? [])].reverse().find((turn) => turn.status === 'inProgress')
  return activeTurn?.id
}

function syncCodexThreadStatus(agentId: string, thread: CodexThread) {
  if (thread.status?.type === 'active') {
    setAgentStatus(agentId, 'running')
  } else if (thread.status?.type === 'systemError') {
    setAgentStatus(agentId, 'failed')
  } else if (thread.status?.type === 'idle' || thread.status?.type === 'notLoaded') {
    setAgentStatus(agentId, 'idle')
  }
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
  Effect.runSync(setRuntimeState(agentId, state))
}

function codexState(value: Record<string, unknown>): CodexRuntimeState {
  return {
    threadId: stringValue(value.threadId),
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

  const dir = join(process.cwd(), '.aether', 'attachments', safePathSegment(agentId))
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
      contentItems: [{ type: 'inputText', text: 'Aether cannot run client dynamic tools yet.' }],
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
