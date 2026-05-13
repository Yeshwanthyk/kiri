import type { AgentStatus, AgentTask, RuntimeKind, ThinkingLevel, TimelineEventTone } from '~/lib/contracts'
import { Cause, Context, Data, Effect, Exit, Layer, Option } from 'effect'
import {
  appendUserMessage,
  clearRuntimeContextUsage,
  recordRuntimeContextUsage,
  recordRuntimeMessage,
  recordRuntimeTimelineEvent,
  replaceAgentTasks,
  replaceAgentDiffArtifacts,
  setAgentRuntimeState,
  setAgentStatus,
} from './db'
import type { RuntimeDiffArtifact } from './git-diff'

export type RuntimeProjectionEvent =
  | {
    type: 'status'
    agentId: string
    status: AgentStatus
  }
  | {
    type: 'userMessage'
    agentId: string
    text: string
  }
  | {
    type: 'runtimeMessage'
    agentId: string
    id: string
    role: Parameters<typeof recordRuntimeMessage>[0]['role']
    text: string
    timestamp?: string
  }
  | {
    type: 'timelineEvent'
    value: Parameters<typeof recordRuntimeTimelineEvent>[0]
  }
  | {
    type: 'contextUsage'
    value: Parameters<typeof recordRuntimeContextUsage>[0]
  }
  | {
    type: 'clearContextUsage'
    agentId: string
  }
  | {
    type: 'diffsUpdated'
    agentId: string
    diffs: RuntimeDiffArtifact[]
  }
  | {
    type: 'tasksUpdated'
    agentId: string
    source: RuntimeKind
    tasks: AgentTask[]
    updatedAt?: string
  }
  | {
    type: 'runtimeState'
    agentId: string
    state: Record<string, unknown>
  }
  | {
    type: 'fileOperationStarted'
    agentId: string
    toolName: string
    path?: string
    summary?: string
  }
  | {
    type: 'fileOperationCompleted'
    agentId: string
    toolName: string
    status: 'completed' | 'failed'
    path?: string
    summary?: string
  }

export type RuntimeLifecycleProjection = {
  project: (event: RuntimeProjectionEvent) => Effect.Effect<void>
}

export type InMemoryRuntimeProjector = RuntimeLifecycleProjection & {
  readonly events: RuntimeProjectionEvent[]
}

export type RuntimeErrorEvent = {
  kind: string
  label: string
  tone?: TimelineEventTone
}

export class RuntimeLifecycleError extends Data.TaggedError('RuntimeLifecycleError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const liveProjector: RuntimeLifecycleProjection = {
  project: (event) => Effect.sync(() => {
    if (event.type === 'status') {
      setAgentStatus(event.agentId, event.status)
      return
    }
    if (event.type === 'userMessage') {
      appendUserMessage({ agentId: event.agentId, text: event.text })
      return
    }
    if (event.type === 'runtimeMessage') {
      recordRuntimeMessage({
        agentId: event.agentId,
        id: event.id,
        role: event.role,
        text: event.text,
        timestamp: event.timestamp,
      })
      return
    }
    if (event.type === 'timelineEvent') {
      recordRuntimeTimelineEvent(event.value)
      return
    }
    if (event.type === 'contextUsage') {
      recordRuntimeContextUsage(event.value)
      return
    }
    if (event.type === 'clearContextUsage') {
      clearRuntimeContextUsage(event.agentId)
      return
    }
    if (event.type === 'diffsUpdated') {
      replaceAgentDiffArtifacts({
        agentId: event.agentId,
        diffs: event.diffs,
      })
      return
    }
    if (event.type === 'tasksUpdated') {
      replaceAgentTasks({
        agentId: event.agentId,
        source: event.source,
        tasks: event.tasks,
        updatedAt: event.updatedAt,
      })
      return
    }
    if (event.type === 'runtimeState') {
      setAgentRuntimeState(event.agentId, runtimeStateWithoutUndefined(event.state))
      return
    }
    if (event.type === 'fileOperationStarted' || event.type === 'fileOperationCompleted') {
      recordRuntimeTimelineEvent(fileOperationTimelineEvent(event))
    }
  }),
}

export class RuntimeProjector extends Context.Tag('@aether/RuntimeProjector')<
  RuntimeProjector,
  RuntimeLifecycleProjection
>() {
  static readonly liveLayer = Layer.succeed(RuntimeProjector, liveProjector)
}

export function inMemoryRuntimeProjectorLayer(events: RuntimeProjectionEvent[] = []) {
  const projector: InMemoryRuntimeProjector = {
    events,
    project: (event) => Effect.sync(() => {
      events.push(event)
    }),
  }
  return {
    projector,
    layer: Layer.succeed(RuntimeProjector, projector),
  }
}

export function enqueueAgentTurn(
  agentId: string,
  queues: Map<string, Promise<void>>,
  run: () => Promise<void>,
) {
  return Effect.tryPromise({
    try: () => {
      const previous = queues.get(agentId) ?? Promise.resolve()
      const next = previous.then(run)
      queues.set(agentId, next.catch(() => {}))
      return next
    },
    catch: (cause) => runtimeLifecycleError('Runtime turn failed', cause),
  })
}

export function nextThinkingLevel(current: ThinkingLevel | null) {
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
  const index = current ? levels.indexOf(current) : -1
  return levels[(index + 1) % levels.length]
}

export function runtimeStateWithoutUndefined<T extends Record<string, unknown>>(state: T) {
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => value !== undefined),
  )
}

export function setRuntimeState(
  agentId: string,
  state: Record<string, unknown>,
  projection: RuntimeLifecycleProjection,
): Effect.Effect<void, never, never>
export function setRuntimeState(
  agentId: string,
  state: Record<string, unknown>,
): Effect.Effect<void, never, RuntimeProjector>
export function setRuntimeState(
  agentId: string,
  state: Record<string, unknown>,
  projection?: RuntimeLifecycleProjection,
) {
  const event = { type: 'runtimeState' as const, agentId, state }
  return projection ? projectRuntimeEvent(event, projection) : projectRuntimeEvent(event)
}

function setRuntimeStatus(
  agentId: string,
  status: AgentStatus,
  projection: RuntimeLifecycleProjection,
): Effect.Effect<void, never, never>
function setRuntimeStatus(
  agentId: string,
  status: AgentStatus,
): Effect.Effect<void, never, RuntimeProjector>
function setRuntimeStatus(
  agentId: string,
  status: AgentStatus,
  projection?: RuntimeLifecycleProjection,
) {
  const event = { type: 'status' as const, agentId, status }
  return projection ? projectRuntimeEvent(event, projection) : projectRuntimeEvent(event)
}

function recordRuntimeError(
  agentId: string,
  error: unknown,
  event: RuntimeErrorEvent,
  projection: RuntimeLifecycleProjection,
): Effect.Effect<void, never, never>
function recordRuntimeError(
  agentId: string,
  error: unknown,
  event: RuntimeErrorEvent,
): Effect.Effect<void, never, RuntimeProjector>
function recordRuntimeError(
  agentId: string,
  error: unknown,
  event: RuntimeErrorEvent,
  projection?: RuntimeLifecycleProjection,
) {
  const projectionEvent: RuntimeProjectionEvent = {
    type: 'timelineEvent',
    value: {
      agentId,
      kind: event.kind,
      tone: event.tone ?? 'error',
      label: event.label,
      detail: runtimeErrorDetail(error),
    },
  }
  return projection ? projectRuntimeEvent(projectionEvent, projection) : projectRuntimeEvent(projectionEvent)
}

export function captureRuntimeDiffs(
  agentId: string,
  collect: () => RuntimeDiffArtifact[],
  projection: RuntimeLifecycleProjection,
): Effect.Effect<void, never, never>
export function captureRuntimeDiffs(
  agentId: string,
  collect: () => RuntimeDiffArtifact[],
): Effect.Effect<void, never, RuntimeProjector>
export function captureRuntimeDiffs(
  agentId: string,
  collect: () => RuntimeDiffArtifact[],
  projection?: RuntimeLifecycleProjection,
) {
  return Effect.exit(Effect.sync(() => collect())).pipe(
    Effect.flatMap((exit) => {
      if (Exit.isFailure(exit)) return Effect.void
      const diffs = exit.value
      const event = { type: 'diffsUpdated' as const, agentId, diffs }
      return Effect.exit(projection ? projectRuntimeEvent(event, projection) : projectRuntimeEvent(event))
    }),
    Effect.asVoid,
  )
}

type RuntimeTurnLifecycleInput<T> = {
  agentId: string
  displayText: string
  errorEvent: RuntimeErrorEvent
  run: () => Promise<T>
  onSuccess?: (result: T) => void | Promise<void>
  onError?: (error: unknown) => void | Promise<void>
  isCurrent?: () => boolean
  successStatus?: AgentStatus | null | ((result: T) => AgentStatus | null)
  projection?: RuntimeLifecycleProjection
}

export function runAgentTurnLifecycle<T>(
  input: RuntimeTurnLifecycleInput<T> & { projection: RuntimeLifecycleProjection },
): Effect.Effect<T, RuntimeLifecycleError, never>
export function runAgentTurnLifecycle<T>(
  input: RuntimeTurnLifecycleInput<T> & { projection?: undefined },
): Effect.Effect<T, RuntimeLifecycleError, RuntimeProjector>
export function runAgentTurnLifecycle<T>(input: RuntimeTurnLifecycleInput<T>) {
  let finalStatus: AgentStatus | null = null

  return Effect.flatMap(input.projection
    ? Effect.succeed(input.projection)
    : RuntimeProjector, (projection) =>
      Effect.gen(function* () {
        yield* setRuntimeStatus(input.agentId, 'running', projection)
        yield* projectRuntimeEvent({
          type: 'userMessage',
          agentId: input.agentId,
          text: input.displayText,
        }, projection)
        const result = yield* Effect.tryPromise({
          try: input.run,
          catch: (cause) => runtimeLifecycleError('Runtime turn failed', cause),
        })
        if (input.isCurrent?.() === false) return result
        yield* callbackEffect(() => input.onSuccess?.(result), 'Runtime turn success hook failed')
        finalStatus = typeof input.successStatus === 'function'
          ? input.successStatus(result)
          : input.successStatus ?? 'idle'
        return result
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            if (input.isCurrent?.() === false) return
            yield* callbackEffect(() => input.onError?.(error), 'Runtime turn error hook failed')
            finalStatus = 'failed'
            yield* recordRuntimeError(input.agentId, error, input.errorEvent, projection)
          })),
        Effect.catchAll((error) =>
          input.isCurrent?.() === false
            ? Effect.void
            : Effect.fail(error)),
        Effect.ensuring(Effect.suspend(() =>
          finalStatus
            ? setRuntimeStatus(input.agentId, finalStatus, projection)
            : Effect.void)),
      ),
  )
}

export function projectRuntimeEvent(
  event: RuntimeProjectionEvent,
  projection: RuntimeLifecycleProjection,
): Effect.Effect<void, never, never>
export function projectRuntimeEvent(
  event: RuntimeProjectionEvent,
): Effect.Effect<void, never, RuntimeProjector>
export function projectRuntimeEvent(
  event: RuntimeProjectionEvent,
  projection?: RuntimeLifecycleProjection,
) {
  const run = (projection: RuntimeLifecycleProjection) =>
    Effect.suspend(() => projection.project(event))
  return projection ? run(projection) : Effect.flatMap(RuntimeProjector, run)
}

function callbackEffect(
  callback: () => void | Promise<void> | undefined,
  message: string,
) {
  return Effect.tryPromise({
    try: async () => {
      await callback()
    },
    catch: (cause) => runtimeLifecycleError(message, cause),
  })
}

function runtimeLifecycleError(message: string, cause: unknown) {
  if (cause instanceof RuntimeLifecycleError) return cause
  return new RuntimeLifecycleError({ message, cause })
}

export async function runRuntimeLifecyclePromise<A>(
  effect: Effect.Effect<A, unknown, RuntimeProjector>,
) {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(RuntimeProjector.liveLayer)))
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
  if (failure instanceof RuntimeLifecycleError && failure.message === 'Runtime turn failed') {
    throw failure.cause ?? failure
  }
  if (failure) throw failure
  throw Cause.squash(exit.cause)
}

export function runRuntimeLifecycleSync<A>(
  effect: Effect.Effect<A, unknown, RuntimeProjector>,
) {
  const exit = Effect.runSyncExit(effect.pipe(Effect.provide(RuntimeProjector.liveLayer)))
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
  if (failure instanceof RuntimeLifecycleError && failure.message === 'Runtime turn failed') {
    throw failure.cause ?? failure
  }
  if (failure) throw failure
  throw Cause.squash(exit.cause)
}

function runtimeErrorDetail(error: unknown): string {
  if (error instanceof RuntimeLifecycleError) {
    if (error.cause instanceof Error) return error.cause.message
    if (error.cause !== undefined) return String(error.cause)
  }
  return error instanceof Error ? error.message : String(error)
}

function fileOperationTimelineEvent(
  event: Extract<RuntimeProjectionEvent, {
    type: 'fileOperationStarted' | 'fileOperationCompleted'
  }>,
): Parameters<typeof recordRuntimeTimelineEvent>[0] {
  const status = event.type === 'fileOperationStarted' ? 'started' : event.status
  const path = event.path ? ` ${event.path}` : ''
  const label = `${event.toolName} ${status}`
  return {
    agentId: event.agentId,
    kind: event.type,
    tone: event.type === 'fileOperationCompleted' && event.status === 'failed' ? 'error' : 'tool',
    label,
    detail: event.summary ?? `${event.toolName}${path}`,
    payload: event,
  }
}
