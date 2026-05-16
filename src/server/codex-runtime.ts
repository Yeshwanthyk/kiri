import { Effect } from 'effect'
import type { ReviewTarget, SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import {
  CodexAppServerAdapter,
  decodeServerParams,
  ItemCompletedParamsSchema,
  ThreadCompactedParamsSchema,
  ThreadTokenUsageUpdatedParamsSchema,
  TurnDiffUpdatedParamsSchema,
  TurnPlanUpdatedParamsSchema,
  TurnStartedParamsSchema,
  type CodexServerMessage,
  type CodexTurn,
} from './codex-app-server'
import {
  adapterUrl as stateAdapterUrl,
  codexReasoningOptions,
  codexState,
  parseCodexRuntimeStateJson,
  stringValue,
  type CodexRuntimeState,
} from './codex-runtime-state'
import { codexReviewDisplayText } from './codex-review'
import { automaticCodexServerRequestResponse } from './codex-server-requests'
import {
  normalizeTaskStatus,
  numberValue,
  objectValue,
  timestampFromMs,
} from './codex-value-helpers'
import { codexItemRecord } from './codex-item-recording'
import { makeCodexRetainedState } from './codex-retained-state'
import { activeCodexTurnId, codexThreadAgentStatus } from './codex-thread-state'
import {
  appendUserMessage,
  clearAgentRuntimeState,
  getAgentLaunchConfig,
  getAgentThinkingLevel,
  getAgentRuntimeState,
  recordAgentInfoEvent,
  recordRuntimeMessage,
  recordRuntimeTimelineEvent,
  resetSession as resetStoredSession,
  setAgentStatus,
} from './db'
import { collectGitDiffArtifacts, diffArtifactsFromPatch } from './git-diff'
import { fileOperationFromCodexItem } from './runtime-file-operations'
import {
  captureRuntimeDiffs,
  enqueueAgentTurn,
  nextThinkingLevel,
  projectRuntimeEvent,
  runAgentTurnLifecycle,
  RuntimeLifecycleError,
  runRuntimeLifecyclePromise,
  runRuntimeLifecycleSync,
  setRuntimeState,
} from './runtime-lifecycle'
import { promptWithSavedImages } from './runtime-attachments'
import type { RuntimeBinariesApi } from './runtime-binaries'

export { parseCodexRuntimeStateJson } from './codex-runtime-state'

const retainedState = makeCodexRetainedState()
const CODEX_SANDBOX_MODE = 'danger-full-access'
const CODEX_SANDBOX_POLICY = { type: 'dangerFullAccess' } as const

type CodexRuntimeDependencies = {
  readonly runtimeBinaries: RuntimeBinariesApi
}

export async function promptCodexAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
} & CodexRuntimeDependencies) {
  const runtimeBinaries = runtimeBinariesFor(input)
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'codex') {
    throw new Error(`${config.runtime} agent is not a Codex session`)
  }

  const state = codexState(parseCodexRuntimeStateJson(config.runtimeStateJson) ?? getAgentRuntimeState(config.id))
  const text = promptWithSavedImages(config.id, input.text, input.images ?? [])
  if (state.threadId) {
    const adapter = getOrCreateCodexAdapter(state.websocketUrl, runtimeBinaries)
    const thread = await readCodexThreadIfAvailable(adapter, state.threadId)
    if (thread) {
      syncCodexThreadStatus(config.id, thread)
      const activeTurnId = activeCodexTurnId(thread)
      if (activeTurnId) {
        await steerCodexTurn(config.id, {
          ...state,
          threadId: state.threadId,
        }, activeTurnId, text, runtimeBinaries)
        return
      }
    } else {
      forgetCodexThread(config.id, state)
    }
  }

  const generation = retainedState.generation(config.id)
  await runRuntimeLifecyclePromise(enqueueAgentTurn(config.id, retainedState.queues, () => {
    if (!retainedState.isCurrentGeneration(config.id, generation)) return Promise.resolve()
    return promptCodexAgentNow({
      ...config,
      runtimeState: getAgentRuntimeState(config.id),
    }, text, generation, runtimeBinaries)
  }))
}

export async function steerCodexAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
} & CodexRuntimeDependencies) {
  const runtimeBinaries = runtimeBinariesFor(input)
  const config = getAgentLaunchConfig(input.agentId)
  const state = codexState(getAgentRuntimeState(config.id))
  if (!state.threadId) {
    return promptCodexAgent(input)
  }
  const adapter = getOrCreateCodexAdapter(state.websocketUrl, runtimeBinaries)
  const thread = await readCodexThreadIfAvailable(adapter, state.threadId)
  if (!thread) {
    forgetCodexThread(config.id, state)
    return promptCodexAgent(input)
  }
  syncCodexThreadStatus(config.id, thread)
  const activeTurnId = activeCodexTurnId(thread)
  if (!activeTurnId) return promptCodexAgent(input)

  await steerCodexTurn(
    config.id,
    { ...state, threadId: state.threadId },
    activeTurnId,
    promptWithSavedImages(config.id, input.text, input.images ?? []),
    runtimeBinaries,
  )
}

export async function interruptCodexAgent(input: { agentId: string } & CodexRuntimeDependencies) {
  const runtimeBinaries = runtimeBinariesFor(input)
  const state = codexState(getAgentRuntimeState(input.agentId))
  if (!state.threadId) {
    throw new Error('Codex session has no active turn to interrupt')
  }
  const adapter = getOrCreateCodexAdapter(state.websocketUrl, runtimeBinaries)
  const thread = await readCodexThreadIfAvailable(adapter, state.threadId)
  if (!thread) {
    forgetCodexThread(input.agentId, state)
    throw new Error('Codex session has no active turn to interrupt')
  }
  syncCodexThreadStatus(input.agentId, thread)
  const activeTurnId = activeCodexTurnId(thread)
  if (!activeTurnId) {
    throw new Error('Codex session has no active turn to interrupt')
  }
  await adapter.interruptTurn({
    threadId: state.threadId,
    turnId: activeTurnId,
  })
}

export function setCodexThinkingLevel(input: {
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
  return Promise.resolve(level)
}

export async function resetCodexSession(input: { agentId: string } & CodexRuntimeDependencies) {
  const runtimeBinaries = runtimeBinariesFor(input)
  retainedState.bumpGeneration(input.agentId)
  const state = codexState(getAgentRuntimeState(input.agentId))
  if (state.threadId) {
    try {
      const adapter = getOrCreateCodexAdapter(state.websocketUrl, runtimeBinaries)
      const thread = await readCodexThread(adapter, state.threadId)
      const activeTurnId = activeCodexTurnId(thread)
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
  forgetCodexRuntimeAgent(input.agentId, { keepGeneration: true })
  clearAgentRuntimeState(input.agentId)
  resetStoredSession(input.agentId)
}

export async function reviewCodexSession(input: {
  agentId: string
  target: ReviewTarget
} & CodexRuntimeDependencies) {
  const runtimeBinaries = runtimeBinariesFor(input)
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'codex') {
    throw new Error(`${config.runtime} agents do not support /review yet`)
  }
  const generation = retainedState.generation(config.id)
  await runRuntimeLifecyclePromise(enqueueAgentTurn(config.id, retainedState.queues, () => {
    if (!retainedState.isCurrentGeneration(config.id, generation)) return Promise.resolve()
    return reviewCodexSessionNow({
      ...config,
      runtimeState: getAgentRuntimeState(config.id),
    }, input.target, generation, runtimeBinaries)
  }))
}

async function promptCodexAgentNow(
  config: ReturnType<typeof getAgentLaunchConfig> & { runtimeState: Record<string, unknown> },
  text: string,
  generation: number,
  runtimeBinaries: RuntimeBinariesApi,
) {
  const adapter = getOrCreateCodexAdapter(stringValue(config.runtimeState.websocketUrl), runtimeBinaries)
  const state = codexState(config.runtimeState)
  let activeThreadId = state.threadId
  await runRuntimeLifecyclePromise(runAgentTurnLifecycle({
    agentId: config.id,
    displayText: text,
    errorEvent: { kind: 'codex_error', label: 'Codex error' },
    isCurrent: () => retainedState.isCurrentGeneration(config.id, generation),
    successStatus: (markIdle) => markIdle ? 'idle' : null,
    onError: () => {
      setCodexState(config.id, {
        ...state,
        threadId: activeThreadId,
        websocketUrl: adapterUrl(state.websocketUrl, runtimeBinaries),
      })
    },
    run: () => runRuntimeLifecyclePromise(startOrSteerCodexTurn({
      adapter,
      config,
      state,
      text,
      generation,
      runtimeBinaries,
      setActiveThreadId: (threadId) => {
        activeThreadId = threadId
      },
    })),
  }))
}

async function reviewCodexSessionNow(
  config: ReturnType<typeof getAgentLaunchConfig> & { runtimeState: Record<string, unknown> },
  target: ReviewTarget,
  generation: number,
  runtimeBinaries: RuntimeBinariesApi,
) {
  const adapter = getOrCreateCodexAdapter(stringValue(config.runtimeState.websocketUrl), runtimeBinaries)
  const state = codexState(config.runtimeState)
  let activeThreadId = state.threadId
  const displayText = codexReviewDisplayText(target)
  await runRuntimeLifecyclePromise(runAgentTurnLifecycle({
    agentId: config.id,
    displayText,
    errorEvent: { kind: 'codex_error', label: 'Codex error' },
    isCurrent: () => retainedState.isCurrentGeneration(config.id, generation),
    successStatus: (markIdle) => markIdle ? 'idle' : null,
    onError: () => {
      setCodexState(config.id, {
        ...state,
        threadId: activeThreadId,
        websocketUrl: adapterUrl(state.websocketUrl, runtimeBinaries),
      })
    },
    run: () => runRuntimeLifecyclePromise(startCodexReview({
      adapter,
      config,
      state,
      target,
      generation,
      runtimeBinaries,
      setActiveThreadId: (threadId) => {
        activeThreadId = threadId
      },
    })),
  }))
}

function captureCodexGitDiffArtifacts(config: ReturnType<typeof getAgentLaunchConfig>) {
  runRuntimeLifecycleSync(captureRuntimeDiffs(config.id, () =>
    collectGitDiffArtifacts(config.cwd)))
}

function startOrSteerCodexTurn(input: {
  adapter: CodexAppServerAdapter
  config: ReturnType<typeof getAgentLaunchConfig>
  state: CodexRuntimeState
  text: string
  generation: number
  runtimeBinaries: RuntimeBinariesApi
  setActiveThreadId: (threadId: string) => void
}) {
  return Effect.gen(function* () {
    const threadId = yield* ensureCodexThreadEffect(input)
    if (!isCurrentCodexGeneration(input.config.id, input.generation)) return false
    yield* Effect.sync(() => {
      input.setActiveThreadId(threadId)
      rememberCodexThread(input.config.id, threadId)
    })
    const thread = yield* readCodexThreadEffect(input.adapter, threadId)
    yield* Effect.sync(() => {
      syncCodexThreadStatus(input.config.id, thread)
    })
    const activeTurnId = activeCodexTurnId(thread)
    if (activeTurnId) {
      yield* steerCodexTurnEffect(input.config.id, {
        ...input.state,
        threadId,
        websocketUrl: adapterUrl(input.state.websocketUrl, input.runtimeBinaries),
      }, activeTurnId, input.text, input.runtimeBinaries)
      return false
    }

    const turnResponse = yield* codexProtocolPromise(() => input.adapter.startTurn({
      threadId,
      input: textInput(input.text),
      model: input.config.model,
      sandboxPolicy: CODEX_SANDBOX_POLICY,
      ...codexReasoningOptions(getAgentThinkingLevel(input.config.id)),
    }))
    const turnId = turnResponse.turn.id
    yield* Effect.sync(() => {
      if (turnId) retainedState.rememberTurn(threadId, turnId)
      setCodexState(input.config.id, {
        ...input.state,
        threadId,
        websocketUrl: adapterUrl(input.state.websocketUrl, input.runtimeBinaries),
      })
    })
    const completedTurn = yield* codexProtocolPromise(() =>
      input.adapter.waitForTurnCompleted({ threadId, turnId }))
    if (!isCurrentCodexGeneration(input.config.id, input.generation)) return false
    yield* Effect.sync(() => {
      recordCodexTurn(input.config.id, completedTurn)
      captureCodexGitDiffArtifacts(input.config)
      setCodexState(input.config.id, {
        ...input.state,
        threadId,
        websocketUrl: adapterUrl(input.state.websocketUrl, input.runtimeBinaries),
      })
    })
    return true
  })
}

function startCodexReview(input: {
  adapter: CodexAppServerAdapter
  config: ReturnType<typeof getAgentLaunchConfig>
  state: CodexRuntimeState
  target: ReviewTarget
  generation: number
  runtimeBinaries: RuntimeBinariesApi
  setActiveThreadId: (threadId: string) => void
}) {
  return Effect.gen(function* () {
    const threadId = yield* ensureCodexThreadEffect(input)
    if (!isCurrentCodexGeneration(input.config.id, input.generation)) return false
    yield* Effect.sync(() => {
      input.setActiveThreadId(threadId)
      rememberCodexThread(input.config.id, threadId)
    })
    const thread = yield* readCodexThreadEffect(input.adapter, threadId)
    const activeTurnId = activeCodexTurnId(thread)
    if (activeTurnId) {
      return yield* new RuntimeLifecycleError({
        message: 'Runtime turn failed',
        cause: new Error('Codex session already has an active turn'),
      })
    }

    const review = yield* codexProtocolPromise(() => input.adapter.startReview({
      threadId,
      target: input.target,
      delivery: 'inline',
    }))
    const turnId = review.turn.id
    yield* Effect.sync(() => {
      if (turnId) retainedState.rememberTurn(threadId, turnId)
      setCodexState(input.config.id, {
        ...input.state,
        threadId,
        websocketUrl: adapterUrl(input.state.websocketUrl, input.runtimeBinaries),
      })
    })
    const completedTurn = yield* codexProtocolPromise(() =>
      input.adapter.waitForTurnCompleted({ threadId, turnId }))
    if (!isCurrentCodexGeneration(input.config.id, input.generation)) return false
    yield* Effect.sync(() => {
      recordCodexTurn(input.config.id, completedTurn)
      captureCodexGitDiffArtifacts(input.config)
      setCodexState(input.config.id, {
        ...input.state,
        threadId,
        websocketUrl: adapterUrl(input.state.websocketUrl, input.runtimeBinaries),
      })
    })
    return true
  })
}

function ensureCodexThreadEffect(input: {
  adapter: CodexAppServerAdapter
  config: ReturnType<typeof getAgentLaunchConfig>
  state: CodexRuntimeState
  runtimeBinaries: RuntimeBinariesApi
}) {
  return Effect.gen(function* () {
    const existingThreadId = input.state.threadId
    if (existingThreadId) {
      const resumed = yield* Effect.either(codexProtocolPromise(() => input.adapter.resumeThread({
        threadId: existingThreadId,
        cwd: input.config.cwd,
        model: input.config.model,
        approvalPolicy: 'never',
        sandbox: CODEX_SANDBOX_MODE,
      })))
      if (resumed._tag === 'Right') {
        yield* Effect.sync(() => {
          syncCodexThreadStatus(input.config.id, resumed.right.thread)
        })
        return existingThreadId
      }
      if (!isMissingRolloutError(runtimeCause(resumed.left))) {
        return yield* resumed.left
      }
      yield* Effect.sync(() => {
        forgetCodexThread(input.config.id, input.state)
      })
    }

    const response = yield* codexProtocolPromise(() => input.adapter.startThread({
      cwd: input.config.cwd,
      model: input.config.model,
      approvalPolicy: 'never',
      sandbox: CODEX_SANDBOX_MODE,
    }))
    const threadId = response.thread.id
    if (!threadId) {
      return yield* new RuntimeLifecycleError({
        message: 'Runtime turn failed',
        cause: new Error('Codex app-server did not return a thread id'),
      })
    }
    yield* Effect.sync(() => {
      setCodexState(input.config.id, {
        ...input.state,
        threadId,
        websocketUrl: adapterUrl(input.state.websocketUrl, input.runtimeBinaries),
      })
    })
    return threadId
  })
}

function adapterUrl(websocketUrl: string | undefined, runtimeBinaries: RuntimeBinariesApi) {
  return stateAdapterUrl(websocketUrl, runtimeProcessEnv(runtimeBinaries))
}

function getOrCreateCodexAdapter(
  websocketUrl: string | undefined,
  runtimeBinaries: RuntimeBinariesApi,
) {
  const env = runtimeProcessEnv(runtimeBinaries)
  const url = stateAdapterUrl(websocketUrl, env)
  let adapter = retainedState.getAdapter(url)
  if (!adapter) {
    adapter = new CodexAppServerAdapter({
      websocketUrl: url,
      spawnIfMissing: !env.KIRI_CODEX_APP_SERVER_URL,
      codexHome: env.KIRI_CODEX_HOME,
      runtimeBinaries,
    })
    retainedState.rememberAdapter(url, adapter)
  }
  if (!retainedState.hasAdapterListener(url)) {
    retainedState.rememberAdapterListener(url)
    adapter.onMessage((message) => handleCodexServerMessage(adapter, message))
  }
  return adapter
}

function runtimeProcessEnv(runtimeBinaries: RuntimeBinariesApi) {
  return Effect.runSync(runtimeBinaries.processEnv())
}

function runtimeBinariesFor(input: CodexRuntimeDependencies) {
  return input.runtimeBinaries
}

function handleCodexServerMessage(adapter: CodexAppServerAdapter, message: CodexServerMessage) {
  runRuntimeLifecycleSync(projectCodexNotification(adapter, message))
}

function projectCodexNotification(adapter: CodexAppServerAdapter, message: CodexServerMessage) {
  return Effect.gen(function* () {
    const params = objectValue(message.params)
    const threadId = stringValue(params.threadId)
    const agentId = threadId ? retainedState.agentForThread(threadId) : undefined
    if (agentId && retainedState.threadForAgent(agentId) !== threadId) return

    if ('id' in message) {
      if (agentId) {
        yield* projectRuntimeEvent({ type: 'status', agentId, status: 'blocked' })
        yield* projectRuntimeEvent({
          type: 'timelineEvent',
          value: {
            agentId,
            kind: 'codex_server_request',
            tone: 'info',
            label: message.method,
            detail: 'Codex requested client-side input or approval.',
            payload: message,
          },
        })
      }
      const response = automaticCodexServerRequestResponse(message.method)
      if (response) {
        adapter.respond(message.id, response)
      } else {
        adapter.reject(message.id, `kiri cannot handle ${message.method} yet`)
      }
      return
    }

    if (!agentId) return
    if (message.method === 'thread/status/changed') {
      const status = objectValue(params.status)
      if (status.type === 'active') yield* projectRuntimeEvent({ type: 'status', agentId, status: 'running' })
      else if (status.type === 'systemError') yield* projectRuntimeEvent({ type: 'status', agentId, status: 'failed' })
      else yield* projectRuntimeEvent({ type: 'status', agentId, status: 'idle' })
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
      yield* projectRuntimeEvent({ type: 'contextUsage', value: { agentId, usedTokens, windowTokens } })
      return
    }
    if (message.method === 'thread/compacted') {
      if (!decodeServerParams(message, ThreadCompactedParamsSchema)) return
      yield* projectRuntimeEvent({ type: 'clearContextUsage', agentId })
      yield* projectRuntimeEvent({
        type: 'timelineEvent',
        value: {
          agentId,
          kind: 'codex_context_compacted',
          tone: 'info',
          label: 'Context compacted',
          detail: 'Codex compacted this thread context.',
          payload: message,
        },
      })
      return
    }
    if (message.method === 'turn/diff/updated') {
      const decoded = decodeServerParams(message, TurnDiffUpdatedParamsSchema)
      if (!decoded) return
      const diff = decoded.diff ?? ''
      const turnKey = codexTurnKey(threadId, codexNotificationTurnId(params, threadId))
      if (turnKey && retainedState.hasRepoDiffRefreshedTurn(turnKey)) return
      yield* projectRuntimeEvent({
        type: 'diffsUpdated',
        agentId,
        diffs: diffArtifactsFromPatch(diff),
      })
      return
    }
    if (message.method === 'turn/plan/updated') {
      const decoded = decodeServerParams(message, TurnPlanUpdatedParamsSchema)
      if (!decoded) return
      const updatedAt = new Date().toISOString()
      yield* projectRuntimeEvent({
        type: 'tasksUpdated',
        agentId,
        source: 'codex',
        updatedAt,
        tasks: decoded.plan
          .flatMap((step, index) => {
            const title = step.step.trim()
            if (!title) return []
            return [{
              id: String(index + 1),
              title,
              status: normalizeTaskStatus(step.status) ?? 'pending',
              source: 'codex' as const,
              updatedAt,
            }]
          })
      })
      return
    }
    if (message.method === 'turn/started') {
      const decoded = decodeServerParams(message, TurnStartedParamsSchema)
      if (!decoded) return
      const turnId = decoded.turnId ?? decoded.turn?.id
      if (threadId && turnId) {
        yield* Effect.sync(() => retainedState.rememberTurn(threadId, turnId))
      }
      if (turnId) {
        const currentState = codexState(getAgentRuntimeState(agentId))
        yield* setRuntimeState(agentId, {
          ...currentState,
          threadId,
          websocketUrl: currentState.websocketUrl ?? adapter.getWebsocketUrl(),
        })
      }
      yield* projectRuntimeEvent({
        type: 'timelineEvent',
        value: {
          agentId,
          kind: 'codex_turn_started',
          tone: 'thinking',
          label: 'Turn started',
          payload: message,
        },
      })
      yield* projectCodexFileOperation(agentId, decoded.turn, 'fileOperationStarted', threadId, turnId)
      return
    }
    if (message.method === 'item/started') {
      yield* projectCodexFileOperation(agentId, objectValue(params).item, 'fileOperationStarted', threadId, codexNotificationTurnId(params, threadId))
      return
    }
    if (message.method === 'item/completed') {
      const decoded = decodeServerParams(message, ItemCompletedParamsSchema)
      if (!decoded) return
      recordCodexItem(agentId, decoded.item, timestampFromMs(decoded.completedAtMs))
      yield* projectCodexFileOperation(agentId, decoded.item, 'fileOperationCompleted', threadId, codexNotificationTurnId(params, threadId))
    }
  })
}

function projectCodexFileOperation(
  agentId: string,
  item: unknown,
  type: 'fileOperationStarted' | 'fileOperationCompleted',
  threadId: string | undefined,
  turnId: string | undefined,
) {
  const operation = fileOperationFromCodexItem(objectValue(item))
  if (!operation) return Effect.void
  const event = type === 'fileOperationStarted'
    ? { type, agentId, ...operation } as const
    : { type, agentId, status: 'completed' as const, ...operation }
  return Effect.gen(function* () {
    yield* projectRuntimeEvent(event)
    if (type === 'fileOperationCompleted') {
      const config = yield* Effect.sync(() => getAgentLaunchConfig(agentId))
      yield* captureRuntimeDiffs(agentId, () => collectGitDiffArtifacts(config.cwd))
      const turnKey = codexTurnKey(threadId, turnId)
      if (turnKey) yield* Effect.sync(() => rememberRepoDiffRefreshedTurn(turnKey))
    }
  })
}

function codexTurnKey(threadId: string | undefined, turnId: string | undefined) {
  return threadId && turnId ? `${threadId}:${turnId}` : null
}

function codexNotificationTurnId(params: Record<string, unknown>, threadId: string | undefined) {
  return stringValue(params.turnId) ?? (threadId ? retainedState.turnForThread(threadId) : undefined)
}

async function steerCodexTurn(
  agentId: string,
  state: CodexRuntimeState & { threadId: string },
  activeTurnId: string,
  text: string,
  runtimeBinaries: RuntimeBinariesApi,
) {
  const adapter = getOrCreateCodexAdapter(state.websocketUrl, runtimeBinaries)
  await adapter.steerTurn({
    threadId: state.threadId,
    expectedTurnId: activeTurnId,
    input: textInput(text),
  })
  appendUserMessage({ agentId, text })
}

async function readCodexThread(adapter: CodexAppServerAdapter, threadId: string) {
  return runRuntimeLifecyclePromise(readCodexThreadEffect(adapter, threadId))
}

async function readCodexThreadIfAvailable(
  adapter: CodexAppServerAdapter,
  threadId: string,
) {
  return runRuntimeLifecyclePromise(readCodexThreadIfAvailableEffect(adapter, threadId))
}

function readCodexThreadEffect(adapter: CodexAppServerAdapter, threadId: string) {
  return Effect.gen(function* () {
    const withTurns = yield* Effect.either(codexProtocolPromise(() =>
      adapter.readThread({ threadId, includeTurns: true })))
    if (withTurns._tag === 'Right') return withTurns.right.thread
    if (!isUnmaterializedThreadReadError(runtimeCause(withTurns.left))) {
      return yield* withTurns.left
    }
    const withoutTurns = yield* codexProtocolPromise(() =>
      adapter.readThread({ threadId, includeTurns: false }))
    return withoutTurns.thread
  })
}

function readCodexThreadIfAvailableEffect(
  adapter: CodexAppServerAdapter,
  threadId: string,
) {
  return Effect.gen(function* () {
    const thread = yield* Effect.either(readCodexThreadEffect(adapter, threadId))
    if (thread._tag === 'Right') return thread.right
    if (!isMissingRolloutError(runtimeCause(thread.left))) {
      return yield* thread.left
    }
    return null
  })
}

function steerCodexTurnEffect(
  agentId: string,
  state: CodexRuntimeState & { threadId: string },
  activeTurnId: string,
  text: string,
  runtimeBinaries: RuntimeBinariesApi,
) {
  return Effect.gen(function* () {
    const adapter = getOrCreateCodexAdapter(state.websocketUrl, runtimeBinaries)
    yield* codexProtocolPromise(() => adapter.steerTurn({
      threadId: state.threadId,
      expectedTurnId: activeTurnId,
      input: textInput(text),
    }))
    yield* Effect.sync(() => {
      appendUserMessage({ agentId, text })
    })
  })
}

function codexProtocolPromise<T>(run: () => Promise<T>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new RuntimeLifecycleError({
      message: 'Runtime turn failed',
      cause,
    }),
  })
}

function runtimeCause(error: unknown) {
  return error instanceof RuntimeLifecycleError ? error.cause : error
}

function isCurrentCodexGeneration(agentId: string, generation: number) {
  return retainedState.isCurrentGeneration(agentId, generation)
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
  retainedState.forgetThread(agentId, state.threadId)
  setCodexState(agentId, {
    ...state,
    threadId: undefined,
  })
}

export function forgetCodexRuntimeAgent(
  agentId: string,
  options: { readonly keepGeneration?: boolean } = {},
) {
  retainedState.forgetAgent(agentId, options)
}

function rememberCodexThread(agentId: string, threadId: string) {
  retainedState.rememberThread(agentId, threadId)
}

function rememberRepoDiffRefreshedTurn(turnKey: string) {
  retainedState.rememberRepoDiffRefreshedTurn(turnKey)
}

export function codexRuntimeRetainedStateStats() {
  return retainedState.stats()
}

export function __unsafeRetainCodexRuntimeStateForTest(input: {
  readonly agentId: string
  readonly threadId: string
  readonly turnId?: string
}) {
  retainedState.retainForTest(input)
}

export function __unsafeClearCodexRuntimeStateForTest() {
  retainedState.clearRuntimeStateForTest()
}

function syncCodexThreadStatus(
  agentId: string,
  thread: Parameters<typeof codexThreadAgentStatus>[0],
) {
  const status = codexThreadAgentStatus(thread)
  if (status) setAgentStatus(agentId, status)
}

function recordCodexTurn(agentId: string, turn: CodexTurn) {
  const timestamp = new Date().toISOString()
  for (const item of turn.items ?? []) {
    recordCodexItem(agentId, item, timestamp)
  }
}

function recordCodexItem(agentId: string, item: unknown, timestamp = new Date().toISOString()) {
  const record = codexItemRecord(agentId, item, timestamp)
  if (!record) return
  if (record.type === 'message') {
    recordRuntimeMessage(record.value)
    return
  }
  recordRuntimeTimelineEvent(record.value)
}

function setCodexState(agentId: string, state: CodexRuntimeState) {
  runRuntimeLifecycleSync(setRuntimeState(agentId, state))
}

function textInput(text: string) {
  return [{ type: 'text', text, text_elements: [] }]
}
