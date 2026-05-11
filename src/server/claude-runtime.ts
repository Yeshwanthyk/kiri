import { randomUUID } from 'node:crypto'
import {
  query as claudeQuery,
  type Options as ClaudeOptions,
  type Query as ClaudeQuery,
  type SDKAssistantMessage,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SettingSource,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk'
import { Effect } from 'effect'
import type { AnswerQuestionInput, PendingQuestion, SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import {
  appendUserMessage,
  clearAgentRuntimeState,
  clearRuntimeContextUsage,
  getAgentLaunchConfig,
  getAgentRuntimeState,
  getAgentThinkingLevel,
  getSessionDiffFallbackCwds,
  recordAgentInfoEvent,
  recordRuntimeContextUsage,
  recordRuntimeMessage,
  recordRuntimeTimelineEvent,
  resetSession as resetStoredSession,
  setAgentStatus,
} from './db'
import { collectGitDiffArtifactsWithFallback } from './git-diff'
import {
  captureRuntimeDiffs,
  enqueueAgentTurn,
  nextThinkingLevel,
  runAgentTurnLifecycle,
  runRuntimeLifecyclePromise,
  setRuntimeState,
} from './runtime-lifecycle'

type ClaudeRuntimeState = {
  resume?: string
  resumeSessionAt?: string
  binaryPath?: string
  homePath?: string
  pendingQuestion?: PendingQuestion
}

type ClaudeTurn = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

type ClaudeLiveSession = {
  query: ClaudeQuery
  promptQueue: AsyncQueue<SDKUserMessage>
  pendingQuestions: Map<string, PendingQuestionResolver>
  inFlightTools: Map<number, ClaudeToolInFlight>
  readLoop: Promise<void>
  state: ClaudeRuntimeState
  activeTurn: ClaudeTurn | null
  generation: number
}

type PendingQuestionResolver = {
  resolve: (answers: AnswerQuestionInput['answers']) => void
  reject: (error: unknown) => void
}

type ClaudeToolInFlight = {
  itemId: string
  toolName: string
  title: string
  detail: string
  input: Record<string, unknown>
  partialInputJson: string
  lastEmittedInput?: string
}

const sessions = new Map<string, ClaudeLiveSession>()
const queues = new Map<string, Promise<void>>()
const sessionGenerations = new Map<string, number>()
const CLAUDE_SETTING_SOURCES = ['user', 'project', 'local'] as const satisfies ReadonlyArray<SettingSource>
const CLAUDE_IMAGE_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

export async function promptClaudeAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'claude') {
    throw new Error(`${config.runtime} agent is not a Claude session`)
  }

  const prompt = buildUserMessage(input.text, input.images ?? [])
  await runRuntimeLifecyclePromise(enqueueAgentTurn(config.id, queues, () =>
    promptClaudeAgentNow(config, prompt),
  ))
}

export async function steerClaudeAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'claude') {
    throw new Error(`${config.runtime} agent is not a Claude session`)
  }

  const message = buildUserMessage(input.text, input.images ?? [])
  const live = sessions.get(config.id)
  if (!live?.activeTurn) return promptClaudeAgent(input)

  appendUserMessage({ agentId: config.id, text: input.text })
  live.promptQueue.push(message)
}

export async function interruptClaudeAgent(input: { agentId: string }) {
  const live = sessions.get(input.agentId)
  if (!live?.activeTurn) {
    throw new Error('Claude session has no active turn to interrupt')
  }
  await live.query.interrupt()
}

export async function setClaudeThinkingLevel(input: {
  agentId: string
  level?: ThinkingLevel
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'claude') {
    throw new Error(`${config.runtime} agents do not support Claude thinking`)
  }

  const level = input.level ?? nextThinkingLevel(getAgentThinkingLevel(config.id))
  const live = sessions.get(config.id)
  if (live) {
    if (level === 'off') await live.query.setMaxThinkingTokens(0)
    else await live.query.setMaxThinkingTokens(thinkingTokenBudget(level))
  }
  recordAgentInfoEvent({
    agentId: config.id,
    kind: 'thinking_level',
    label: 'Thinking level changed',
    detail: level,
  })
  return level
}

export async function resetClaudeSession(input: { agentId: string }) {
  sessionGenerations.set(input.agentId, (sessionGenerations.get(input.agentId) ?? 0) + 1)
  closeClaudeSession(input.agentId)
  clearAgentRuntimeState(input.agentId)
  resetStoredSession(input.agentId)
}

export async function answerClaudeQuestion(input: AnswerQuestionInput) {
  const live = sessions.get(input.agentId)
  const pending = live?.pendingQuestions.get(input.requestId)
  if (!live || !pending) {
    expireClaudeQuestion(input.agentId, input.requestId)
    return
  }
  const activeTurn = live.activeTurn?.promise
  live.pendingQuestions.delete(input.requestId)
  pending.resolve(input.answers)
  await activeTurn
}

async function promptClaudeAgentNow(
  config: ReturnType<typeof getAgentLaunchConfig>,
  message: SDKUserMessage,
) {
  const generation = sessionGenerations.get(config.id) ?? 0
  await runRuntimeLifecyclePromise(runAgentTurnLifecycle({
    agentId: config.id,
    displayText: messageDisplayText(message),
    errorEvent: { kind: 'claude_error', label: 'Claude error' },
    isCurrent: () => (sessionGenerations.get(config.id) ?? 0) === generation,
    run: async () => {
      const live = getOrCreateClaudeSession(config)
      await prepareClaudeTurn(live, config)
      await runClaudeTurn(live, message)
      if ((sessionGenerations.get(config.id) ?? 0) !== generation) return
      captureClaudeGitDiffArtifacts(config)
    },
  }))
}

async function prepareClaudeTurn(
  live: ClaudeLiveSession,
  config: ReturnType<typeof getAgentLaunchConfig>,
) {
  await live.query.setModel(config.model)
  await live.query.setPermissionMode('bypassPermissions')
  const thinkingLevel = getAgentThinkingLevel(config.id)
  if (thinkingLevel) {
    await live.query.setMaxThinkingTokens(
      thinkingLevel === 'off' ? 0 : thinkingTokenBudget(thinkingLevel),
    )
  }
  await refreshClaudeContextUsage(config.id, live)
}

async function runClaudeTurn(live: ClaudeLiveSession, message: SDKUserMessage) {
  if (live.activeTurn) throw new Error('Claude session already has an active turn')

  let resolveTurn!: () => void
  let rejectTurn!: (error: unknown) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve
    rejectTurn = reject
  })
  live.activeTurn = { promise, resolve: resolveTurn, reject: rejectTurn }
  live.promptQueue.push(message)
  await promise
}

function getOrCreateClaudeSession(config: ReturnType<typeof getAgentLaunchConfig>) {
  const existing = sessions.get(config.id)
  if (existing) return existing

  const state = claudeState(getAgentRuntimeState(config.id))
  const resume = state.resume
  const sessionId = resume ?? randomUUID()
  const promptQueue = new AsyncQueue<SDKUserMessage>()
  const pendingQuestions = new Map<string, PendingQuestionResolver>()
  const query = createClaudeQuery({
    prompt: promptQueue,
    options: claudeOptions(config, state, sessionId, pendingQuestions),
  })
  const live: ClaudeLiveSession = {
    query,
    promptQueue,
    pendingQuestions,
    inFlightTools: new Map(),
    readLoop: Promise.resolve(),
    state: { ...state, resume: sessionId },
    activeTurn: null,
    generation: sessionGenerations.get(config.id) ?? 0,
  }
  live.readLoop = readClaudeStream(config.id, live).catch(() => {})
  sessions.set(config.id, live)
  setClaudeState(config.id, live.state)
  return live
}

async function readClaudeStream(agentId: string, live: ClaudeLiveSession) {
  try {
    for await (const message of live.query) {
      if ((sessionGenerations.get(agentId) ?? 0) !== live.generation) return
      handleClaudeMessage(agentId, live, message)
    }
  } catch (error) {
    live.activeTurn?.reject(error)
    live.activeTurn = null
    sessions.delete(agentId)
    throw error
  }
}

function handleClaudeMessage(agentId: string, live: ClaudeLiveSession, message: SDKMessage) {
	const sessionId = stringValue(objectValue(message).session_id)
	if (sessionId) {
		const currentState = claudeState(getAgentRuntimeState(agentId))
		live.state = { ...live.state, pendingQuestion: currentState.pendingQuestion, resume: sessionId }
		setClaudeState(agentId, live.state)
	}

	if (message.type === 'assistant') {
		recordClaudeAssistantMessage(agentId, message)
		const currentState = claudeState(getAgentRuntimeState(agentId))
		live.state = {
			...live.state,
			pendingQuestion: currentState.pendingQuestion,
			resumeSessionAt: message.uuid,
		}
		setClaudeState(agentId, live.state)
		return
	}

  if (message.type === 'stream_event') {
    recordClaudeStreamEvent(agentId, live, message)
    return
  }

  if (message.type === 'user') {
    recordClaudeUserMessage(agentId, live, message)
    return
  }

  if (message.type === 'result') {
    recordClaudeResult(agentId, live, message)
    if (message.subtype !== 'success' || message.is_error) {
      live.activeTurn?.reject(new Error(resultErrorText(message)))
    } else {
      live.activeTurn?.resolve()
    }
    live.activeTurn = null
    return
  }

  if (message.type === 'system' && 'subtype' in message) {
    recordClaudeSystemEvent(agentId, message)
  }
}

function recordClaudeAssistantMessage(agentId: string, message: SDKAssistantMessage) {
  const text = assistantText(message)
  if (!text) return
  recordRuntimeMessage({
    agentId,
    id: `claude-${agentId}-${message.uuid}`,
    role: 'assistant',
    text,
  })
}

function recordClaudeStreamEvent(
  agentId: string,
  live: ClaudeLiveSession,
  message: Extract<SDKMessage, { type: 'stream_event' }>,
) {
  const event = objectValue(message.event)
  if (event.type === 'content_block_start') {
    const index = numberValue(event.index)
    const block = objectValue(event.content_block)
    const type = stringValue(block.type)
    if (index === undefined || !['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(type ?? '')) return
    const toolName = stringValue(block.name) ?? 'tool'
    const input = objectValue(block.input)
    const detail = summarizeToolRequest(toolName, input)
    const tool: ClaudeToolInFlight = {
      itemId: stringValue(block.id) ?? randomUUID(),
      toolName,
      title: titleForTool(toolName),
      detail,
      input,
      partialInputJson: '',
      lastEmittedInput: stableJson(input),
    }
    live.inFlightTools.set(index, tool)
    recordRuntimeTimelineEvent({
      agentId,
      kind: 'claude_tool_started',
      tone: 'tool',
      label: tool.title,
      detail,
      payload: { toolName, input, toolUseId: tool.itemId },
    })
    return
  }

  if (event.type === 'content_block_delta') {
    const index = numberValue(event.index)
    const delta = objectValue(event.delta)
    if (index === undefined || delta.type !== 'input_json_delta') return
    const tool = live.inFlightTools.get(index)
    const partialJson = stringValue(delta.partial_json)
    if (!tool || partialJson === undefined) return
    const nextPartial = tool.partialInputJson + partialJson
    const parsedInput = tryParseJsonRecord(nextPartial)
    const input = parsedInput ?? tool.input
    const detail = parsedInput ? summarizeToolRequest(tool.toolName, parsedInput) : tool.detail
    const fingerprint = stableJson(input)
    live.inFlightTools.set(index, {
      ...tool,
      partialInputJson: nextPartial,
      input,
      detail,
      lastEmittedInput: fingerprint,
    })
    if (!parsedInput || fingerprint === tool.lastEmittedInput) return
    recordRuntimeTimelineEvent({
      agentId,
      kind: 'claude_tool_updated',
      tone: 'tool',
      label: tool.title,
      detail,
      payload: { toolName: tool.toolName, input, toolUseId: tool.itemId },
    })
  }
}

function recordClaudeUserMessage(
  agentId: string,
  live: ClaudeLiveSession,
  message: Extract<SDKMessage, { type: 'user' }>,
) {
  for (const result of toolResultBlocksFromUserMessage(message)) {
    const entry = [...live.inFlightTools.entries()].find(([, tool]) => tool.itemId === result.toolUseId)
    if (!entry) continue
    const [index, tool] = entry
    const status = result.isError ? 'failed' : 'completed'
    const output = result.text.trim()
    recordRuntimeTimelineEvent({
      agentId,
      kind: 'claude_tool_completed',
      tone: result.isError ? 'error' : 'tool',
      label: `${tool.title} ${status}`,
      detail: tool.detail,
      payload: {
        toolName: tool.toolName,
        input: tool.input,
        result: result.block,
        status,
      },
    })
    if (output) {
      recordRuntimeMessage({
        agentId,
        id: `claude-tool-${agentId}-${result.toolUseId}`,
        role: 'tool',
        text: `${tool.title}\n${tool.detail}\n\n${output}`,
      })
    }
    live.inFlightTools.delete(index)
  }
}

function recordClaudeResult(agentId: string, live: ClaudeLiveSession, message: SDKResultMessage) {
  const usedTokens: number = usedTokensFromResult(message)
  if (usedTokens > 0) recordRuntimeContextUsage({ agentId, usedTokens })
  void refreshClaudeContextUsage(agentId, live)
  if (message.subtype !== 'success' || message.is_error) {
    recordRuntimeTimelineEvent({
      agentId,
      kind: 'claude_result_error',
      tone: 'error',
      label: 'Claude turn failed',
      detail: 'errors' in message ? message.errors.join('\n') : message.stop_reason,
      payload: message,
    })
  }
}

function resultErrorText(message: SDKResultMessage) {
  if ('errors' in message && message.errors.length > 0) return message.errors.join('\n')
  return message.stop_reason ?? 'Claude turn failed'
}

function recordClaudeSystemEvent(agentId: string, message: Extract<SDKMessage, { type: 'system' }>) {
  const subtype = stringValue(objectValue(message).subtype)
  if (!subtype) return
  if (subtype === 'api_retry') {
    recordRuntimeTimelineEvent({
      agentId,
      kind: 'claude_api_retry',
      tone: 'info',
      label: 'Claude API retry',
      detail: stringValue(objectValue(message).error),
      payload: message,
    })
    return
  }
  if (subtype === 'compact_boundary') {
    const metadata = objectValue(objectValue(message).compact_metadata)
    const postTokens = numberValue(metadata.post_tokens)
    const preTokens = numberValue(metadata.pre_tokens)
    if (postTokens !== undefined) {
      recordRuntimeContextUsage({ agentId, usedTokens: postTokens })
    } else {
      clearRuntimeContextUsage(agentId)
    }
    recordRuntimeTimelineEvent({
      agentId,
      kind: 'claude_context_compacted',
      tone: 'info',
      label: 'Context compacted',
      detail: preTokens === undefined
        ? undefined
        : `Claude compacted context from ${preTokens.toLocaleString('en')} tokens.`,
      payload: message,
    })
  }
}

function closeClaudeSession(agentId: string) {
  const live = sessions.get(agentId)
  if (!live) return
  for (const pending of live.pendingQuestions.values()) {
    pending.reject(new Error('Claude session closed'))
  }
  live.pendingQuestions.clear()
  live.promptQueue.close()
  live.query.close()
  sessions.delete(agentId)
}

function captureClaudeGitDiffArtifacts(config: ReturnType<typeof getAgentLaunchConfig>) {
  Effect.runSync(captureRuntimeDiffs(config.id, () =>
    collectGitDiffArtifactsWithFallback(
      config.cwd,
      getSessionDiffFallbackCwds(config.id),
    )))
}

function claudeOptions(
  config: ReturnType<typeof getAgentLaunchConfig>,
  state: ClaudeRuntimeState,
  sessionId: string,
  pendingQuestions: Map<string, PendingQuestionResolver>,
): ClaudeOptions {
  const binaryPath = process.env.AETHER_CLAUDE_BIN ?? state.binaryPath
  const options: ClaudeOptions = {
    cwd: config.cwd,
    model: config.model,
    additionalDirectories: [config.cwd],
    pathToClaudeCodeExecutable: binaryPath,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settingSources: [...CLAUDE_SETTING_SOURCES],
    settings: { autoCompactEnabled: true },
    canUseTool: (toolName, input, options) =>
      handleClaudePermission(config.id, pendingQuestions, toolName, input, options),
    env: claudeEnvironment(state),
    ...extraArgsOption(),
    ...claudeThinkingOptions(getAgentThinkingLevel(config.id)),
  }
  if (state.resume) {
    return {
      ...options,
      resume: state.resume,
      resumeSessionAt: state.resumeSessionAt,
    }
  }
  return { ...options, sessionId }
}

async function handleClaudePermission(
  agentId: string,
  pendingQuestions: Map<string, PendingQuestionResolver>,
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string },
) {
  if (toolName !== 'AskUserQuestion') {
    return {
      behavior: 'allow' as const,
      updatedInput: input,
      toolUseID: options.toolUseID,
    }
  }

  const requestId = randomUUID()
  const pendingQuestion: PendingQuestion = {
    requestId,
    questions: parseClaudeQuestions(input),
  }
  const previousState = claudeState(getAgentRuntimeState(agentId))
  setClaudeState(agentId, { ...previousState, pendingQuestion })
  setAgentStatus(agentId, 'blocked')
  recordRuntimeTimelineEvent({
    agentId,
    kind: 'claude_question_requested',
    tone: 'info',
    label: 'Question requested',
    detail: pendingQuestion.questions.map((question) => question.question).join('\n'),
    payload: { requestId, questions: pendingQuestion.questions, toolUseID: options.toolUseID },
  })

  try {
	    const answers = await new Promise<AnswerQuestionInput['answers']>((resolve, reject) => {
	      pendingQuestions.set(requestId, { resolve, reject })
	      options.signal.addEventListener('abort', () => {
	        pendingQuestions.delete(requestId)
	        reject(new Error('Claude question was aborted'))
	      }, { once: true })
	    })
    const claudeAnswers = answersForClaude(answers)
	    const latestState = claudeState(getAgentRuntimeState(agentId))
	    setClaudeState(agentId, { ...latestState, pendingQuestion: undefined })
	    setAgentStatus(agentId, 'running')
	    recordRuntimeTimelineEvent({
	      agentId,
      kind: 'claude_question_answered',
      tone: 'info',
	      label: 'Question answered',
	      detail: Object.entries(claudeAnswers).map(([question, answer]) => (
	        `${question}: ${answer}`
	      )).join('\n'),
	      payload: { requestId, answers: claudeAnswers },
	    })
	    return {
	      behavior: 'allow' as const,
	      updatedInput: {
	        questions: input.questions,
	        answers: claudeAnswers,
	      },
	      toolUseID: options.toolUseID,
	    }
  } catch (error) {
    const latestState = claudeState(getAgentRuntimeState(agentId))
    setClaudeState(agentId, { ...latestState, pendingQuestion: undefined })
    setAgentStatus(agentId, 'running')
    return {
      behavior: 'deny' as const,
      message: error instanceof Error ? error.message : 'Question cancelled',
      toolUseID: options.toolUseID,
	  }
	}
}

function expireClaudeQuestion(agentId: string, requestId: string) {
  const state = claudeState(getAgentRuntimeState(agentId))
  if (state.pendingQuestion?.requestId === requestId) {
    setClaudeState(agentId, { ...state, pendingQuestion: undefined })
  }
  setAgentStatus(agentId, 'failed')
  recordRuntimeTimelineEvent({
    agentId,
    kind: 'claude_question_expired',
    tone: 'error',
    label: 'Question expired',
    detail: 'Claude question was no longer attached to a live session.',
    payload: { requestId },
  })
}

function answersForClaude(answers: AnswerQuestionInput['answers']) {
  return Object.fromEntries(
    Object.entries(answers).map(([question, answer]) => [
      question,
      Array.isArray(answer) ? answer.join(', ') : answer,
    ]),
  )
}

function createClaudeQuery(params: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeOptions }) {
  if (process.env.AETHER_FAKE_CLAUDE === '1') return fakeClaudeQuery(params)
  return claudeQuery(params)
}

function claudeThinkingOptions(level: ThinkingLevel | null): Pick<ClaudeOptions, 'thinking' | 'effort'> {
  if (!level) return {}
  if (level === 'off') return { thinking: { type: 'disabled' } }
  return {
    thinking: thinkingConfig(level),
    effort: level === 'minimal' ? 'low' : level,
  }
}

function thinkingConfig(level: ThinkingLevel): ThinkingConfig {
  if (level === 'off') return { type: 'disabled' }
  return { type: 'enabled', budgetTokens: thinkingTokenBudget(level), display: 'summarized' }
}

function thinkingTokenBudget(level: ThinkingLevel) {
  if (level === 'minimal') return 1_024
  if (level === 'low') return 2_048
  if (level === 'medium') return 4_096
  if (level === 'high') return 8_192
  if (level === 'xhigh') return 16_384
  return 0
}

function buildUserMessage(text: string, images: SendMessageImage[]) {
  const content: Array<Record<string, unknown>> = []
  const trimmed = text.trim()
  if (trimmed) content.push({ type: 'text', text: trimmed })
  for (const image of images) {
    if (!CLAUDE_IMAGE_MIME_TYPES.has(image.mimeType)) {
      throw new Error(`Unsupported Claude image attachment type "${image.mimeType}"`)
    }
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType === 'image/jpg' ? 'image/jpeg' : image.mimeType,
        data: image.data,
      },
    })
  }
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content,
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  } as unknown as SDKUserMessage
}

function messageDisplayText(message: SDKUserMessage) {
  const text = messageText(message).trim()
  const content = objectValue(message.message).content
  const imageCount = Array.isArray(content)
    ? content.filter((item: unknown) => objectValue(item).type === 'image').length
    : 0
  if (imageCount === 0) return text
  return `${text}\n\n${imageCount} image attachment${imageCount === 1 ? '' : 's'}`
}

function parseClaudeQuestions(input: Record<string, unknown>): PendingQuestion['questions'] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : []
  const questions = rawQuestions
    .map((item, index) => {
      const question = objectValue(item)
      const text = stringValue(question.question)?.trim() || `Question ${index + 1}`
      const options = Array.isArray(question.options)
        ? question.options.map((option) => {
            const object = objectValue(option)
            return {
              label: stringValue(object.label) ?? '',
              description: stringValue(object.description) ?? '',
            }
          })
        : []
      return {
        id: text,
        header: stringValue(question.header)?.trim() || `Question ${index + 1}`,
        question: text,
        options,
        multiSelect: question.multiSelect === true,
      }
    })
    .filter((question) => question.question.length > 0)
  return questions.length > 0
    ? questions
    : [{
        id: 'Question',
        header: 'Question',
        question: stringValue(input.question)?.trim() || 'Claude needs input.',
        options: [],
        multiSelect: false,
      }]
}

function toolResultBlocksFromUserMessage(message: Extract<SDKMessage, { type: 'user' }>) {
  const content = objectValue(message.message).content
  if (!Array.isArray(content)) return []
  return content.flatMap((entry) => {
    const block = objectValue(entry)
    if (block.type !== 'tool_result') return []
    const toolUseId = stringValue(block.tool_use_id)
    if (!toolUseId) return []
    return [{
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    }]
  })
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractTextContent).join('')
  const object = objectValue(value)
  if (Object.keys(object).length === 0) return ''
  return stringValue(object.text) ?? extractTextContent(object.content)
}

function tryParseJsonRecord(value: string) {
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return undefined
  }
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>) {
  const command = stringValue(input.command) ?? stringValue(input.cmd)
  if (command?.trim()) return `${toolName}: ${command.trim().slice(0, 400)}`
  const path = stringValue(input.file_path) ?? stringValue(input.path)
  if (path?.trim()) return `${toolName}: ${path.trim()}`
  const pattern = stringValue(input.pattern)
  if (pattern?.trim()) return `${toolName}: ${pattern.trim().slice(0, 400)}`
  const description = stringValue(input.description) ?? stringValue(input.prompt)
  if (description?.trim()) return `${toolName}: ${description.trim().slice(0, 400)}`
  const serialized = stableJson(input)
  return serialized.length <= 400 ? `${toolName}: ${serialized}` : `${toolName}: ${serialized.slice(0, 397)}...`
}

function titleForTool(toolName: string) {
  const normalized = toolName.toLowerCase()
  if (normalized.includes('bash') || normalized.includes('command') || normalized.includes('shell')) {
    return 'Command run'
  }
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('file')) {
    return 'File change'
  }
  if (normalized.includes('agent') || normalized === 'task') return 'Subagent task'
  if (normalized.includes('web')) return 'Web search'
  return toolName
}

function stableJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function assistantText(message: SDKAssistantMessage) {
  const content = objectValue(message.message).content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => {
      const object = objectValue(item)
      if (object.type === 'text') return stringValue(object.text) ?? ''
      if (object.type === 'thinking') return stringValue(object.thinking) ?? ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function usedTokensFromResult(message: SDKResultMessage) {
  const modelUsage = objectValue(message.modelUsage)
  const fromModelUsage = Object.values(modelUsage).reduce<number>((total, usage) => {
    const object = objectValue(usage)
    return total +
      (numberValue(object.inputTokens) ?? 0) +
      (numberValue(object.outputTokens) ?? 0) +
      (numberValue(object.cacheReadInputTokens) ?? 0) +
      (numberValue(object.cacheCreationInputTokens) ?? 0)
  }, 0)
  if (fromModelUsage > 0) return fromModelUsage

  const usage = objectValue(message.usage)
  return (numberValue(usage.input_tokens) ?? 0) +
    (numberValue(usage.output_tokens) ?? 0) +
    (numberValue(usage.cache_read_input_tokens) ?? 0) +
    (numberValue(usage.cache_creation_input_tokens) ?? 0)
}

async function refreshClaudeContextUsage(agentId: string, live: ClaudeLiveSession) {
  try {
    const usage = await live.query.getContextUsage()
    recordClaudeContextUsage(agentId, usage)
  } catch {
    // Context usage is an observability projection; chat execution should not fail on it.
  }
}

function recordClaudeContextUsage(
  agentId: string,
  usage: SDKControlGetContextUsageResponse,
) {
  const usedTokens = Math.max(0, Math.round(usage.totalTokens))
  const windowTokens = Math.max(0, Math.round(usage.maxTokens || usage.rawMaxTokens))
  if (!windowTokens) return
  recordRuntimeContextUsage({ agentId, usedTokens, windowTokens })
}

function setClaudeState(agentId: string, state: ClaudeRuntimeState) {
  Effect.runSync(setRuntimeState(agentId, state))
}

function claudeState(value: Record<string, unknown>): ClaudeRuntimeState {
  const resume = stringValue(value.resume) ?? stringValue(value.sessionId)
  const pendingQuestion = parsePendingQuestion(value.pendingQuestion)
  return {
    resume: isUuid(resume) ? resume : undefined,
    resumeSessionAt: stringValue(value.resumeSessionAt),
    binaryPath: stringValue(value.binaryPath),
    homePath: stringValue(value.homePath),
    pendingQuestion,
  }
}

function parsePendingQuestion(value: unknown): PendingQuestion | undefined {
  const object = objectValue(value)
  const requestId = stringValue(object.requestId)
  if (!requestId || !Array.isArray(object.questions)) return undefined
  const questions = object.questions.flatMap((item) => {
    const question = objectValue(item)
    const id = stringValue(question.id)
    const text = stringValue(question.question)
    if (!id || !text) return []
    return [{
      id,
      header: stringValue(question.header) ?? 'Question',
      question: text,
      options: Array.isArray(question.options)
        ? question.options.map((option) => {
            const entry = objectValue(option)
            return {
              label: stringValue(entry.label) ?? '',
              description: stringValue(entry.description) ?? '',
            }
          })
        : [],
      multiSelect: question.multiSelect === true,
    }]
  })
  return questions.length > 0 ? { requestId, questions } : undefined
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
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function claudeEnvironment(state: ClaudeRuntimeState): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
  }
  if (process.env.AETHER_CLAUDE_USE_EXTERNAL_API_KEY !== '1') {
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.ANTHROPIC_OAUTH_TOKEN
  }
  const homePath = process.env.AETHER_CLAUDE_HOME ?? state.homePath
  if (homePath) env.HOME = homePath
  return env
}

function extraArgsOption(): Pick<ClaudeOptions, 'extraArgs'> {
  const extraArgs = parseCliArgs(process.env.AETHER_CLAUDE_ARGS)
  return Object.keys(extraArgs).length > 0 ? { extraArgs } : {}
}

function parseCliArgs(value: string | undefined) {
  if (!value?.trim()) return {}
  const args: Record<string, string | null> = {}
  for (const part of value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
    const cleaned = part.replace(/^["']|["']$/g, '')
    if (!cleaned.startsWith('--')) continue
    const [rawKey, rawValue] = cleaned.slice(2).split('=', 2)
    if (!rawKey) continue
    args[rawKey] = rawValue ?? null
  }
  return args
}

function isUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly pending: T[] = []
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = []
  private closed = false

  push(message: T) {
    if (this.closed) throw new Error('Claude prompt queue is closed')
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: message, done: false })
      return
    }
    this.pending.push(message)
  }

  close() {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const message = this.pending.shift()
        if (message) return { value: message, done: false }
        if (this.closed) return { value: undefined, done: true }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}

function fakeClaudeQuery(params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: ClaudeOptions
}): ClaudeQuery {
  let closed = false
  let interrupted = false
  const output = new AsyncQueue<SDKMessage>()
  const sessionId = params.options.sessionId ?? params.options.resume ?? randomUUID()

  void (async () => {
    for await (const prompt of params.prompt) {
      if (closed) return
      const text = messageText(prompt)
      const toolUseId = `toolu_${randomUUID()}`
      output.push({
        type: 'stream_event',
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: toolUseId,
            name: 'Read',
            input: {},
          },
        },
      } as unknown as SDKMessage)
      output.push({
        type: 'stream_event',
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"file_path":"package.json"}',
          },
        },
      } as unknown as SDKMessage)
      output.push({
        type: 'stream_event',
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        event: {
          type: 'content_block_stop',
          index: 0,
        },
      } as unknown as SDKMessage)
      output.push({
        type: 'user',
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'fake file contents',
          }],
        },
      } as unknown as SDKMessage)
      if (text.toLowerCase().includes('ask question')) {
        await params.options.canUseTool?.(
          'AskUserQuestion',
          {
            questions: [{
              header: 'Direction',
              question: 'Which option should Claude use?',
              options: [
                { label: 'Option A', description: 'Use A' },
                { label: 'Option B', description: 'Use B' },
              ],
            }],
          },
          { signal: new AbortController().signal, toolUseID: `ask_${randomUUID()}` },
        )
      }
      const assistantId = randomUUID()
      output.push({
        type: 'assistant',
        uuid: assistantId,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: `msg_${assistantId}`,
          type: 'message',
          role: 'assistant',
          model: params.options.model ?? 'claude-fake',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: 'text', text: `fake claude received: ${text}` }],
        },
      } as unknown as SDKMessage)
      output.push({
        type: 'result',
        subtype: interrupted ? 'error_during_execution' : 'success',
        uuid: randomUUID(),
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: interrupted,
        num_turns: 1,
        result: interrupted ? '' : `fake claude received: ${text}`,
        stop_reason: interrupted ? 'interrupt' : 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
        },
        modelUsage: {
          [params.options.model ?? 'claude-fake']: {
            inputTokens: 12,
            outputTokens: 8,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 200_000,
            maxOutputTokens: 8_192,
          },
        },
        permission_denials: [],
        errors: interrupted ? ['interrupted'] : [],
      } as unknown as SDKMessage)
      interrupted = false
    }
  })().catch(() => output.close())

  const iterator = output[Symbol.asyncIterator]()
  return {
    next: () => iterator.next() as Promise<IteratorResult<SDKMessage>>,
    return: async () => {
      closed = true
      output.close()
      return { value: undefined, done: true }
    },
    throw: async (error?: unknown) => {
      closed = true
      output.close()
      throw error
    },
    [Symbol.asyncIterator]() {
      return this
    },
    interrupt: async () => {
      interrupted = true
    },
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMaxThinkingTokens: async () => {},
    close: () => {
      closed = true
      output.close()
    },
  } as unknown as ClaudeQuery
}

function messageText(message: SDKUserMessage) {
  const content = objectValue(message.message).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => stringValue(objectValue(item).text) ?? '')
    .filter(Boolean)
    .join('\n')
}
