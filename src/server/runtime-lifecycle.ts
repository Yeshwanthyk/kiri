import type { AgentStatus, ThinkingLevel, TimelineEventTone } from '~/lib/contracts'
import { Cause, Context, Data, Effect, Exit, Layer, Option } from 'effect'
import {
  appendUserMessage,
  recordRuntimeTimelineEvent,
  replaceAgentDiffArtifacts,
  setAgentRuntimeState,
  setAgentStatus,
} from './db'
import type { RuntimeDiffArtifact } from './git-diff'

export type RuntimeLifecycleProjection = {
  appendUserMessage: typeof appendUserMessage
  recordRuntimeTimelineEvent: typeof recordRuntimeTimelineEvent
  replaceAgentDiffArtifacts: typeof replaceAgentDiffArtifacts
  setAgentRuntimeState: typeof setAgentRuntimeState
  setAgentStatus: typeof setAgentStatus
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

const defaultProjection: RuntimeLifecycleProjection = {
  appendUserMessage,
  recordRuntimeTimelineEvent,
  replaceAgentDiffArtifacts,
  setAgentRuntimeState,
  setAgentStatus,
}

export class RuntimeProjection extends Context.Tag('@aether/RuntimeProjection')<
  RuntimeProjection,
  RuntimeLifecycleProjection
>() {
  static readonly liveLayer = Layer.succeed(RuntimeProjection, defaultProjection)
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
  projection: Pick<RuntimeLifecycleProjection, 'setAgentRuntimeState'>,
): Effect.Effect<void, never, never>
export function setRuntimeState(
  agentId: string,
  state: Record<string, unknown>,
): Effect.Effect<void, never, RuntimeProjection>
export function setRuntimeState(
  agentId: string,
  state: Record<string, unknown>,
  projection?: Pick<RuntimeLifecycleProjection, 'setAgentRuntimeState'>,
) {
  const persist = (projection: Pick<RuntimeLifecycleProjection, 'setAgentRuntimeState'>) => Effect.sync(() => {
    projection.setAgentRuntimeState(agentId, runtimeStateWithoutUndefined(state))
  })
  return projection ? persist(projection) : Effect.flatMap(RuntimeProjection, persist)
}

export function setRuntimeStatus(
  agentId: string,
  status: AgentStatus,
  projection: Pick<RuntimeLifecycleProjection, 'setAgentStatus'>,
): Effect.Effect<void, never, never>
export function setRuntimeStatus(
  agentId: string,
  status: AgentStatus,
): Effect.Effect<void, never, RuntimeProjection>
export function setRuntimeStatus(
  agentId: string,
  status: AgentStatus,
  projection?: Pick<RuntimeLifecycleProjection, 'setAgentStatus'>,
) {
  const persist = (projection: Pick<RuntimeLifecycleProjection, 'setAgentStatus'>) => Effect.sync(() => {
    projection.setAgentStatus(agentId, status)
  })
  return projection ? persist(projection) : Effect.flatMap(RuntimeProjection, persist)
}

export function recordRuntimeError(
  agentId: string,
  error: unknown,
  event: RuntimeErrorEvent,
  projection: Pick<RuntimeLifecycleProjection, 'recordRuntimeTimelineEvent'>,
): Effect.Effect<void, never, never>
export function recordRuntimeError(
  agentId: string,
  error: unknown,
  event: RuntimeErrorEvent,
): Effect.Effect<void, never, RuntimeProjection>
export function recordRuntimeError(
  agentId: string,
  error: unknown,
  event: RuntimeErrorEvent,
  projection?: Pick<RuntimeLifecycleProjection, 'recordRuntimeTimelineEvent'>,
) {
  const persist = (
    projection: Pick<RuntimeLifecycleProjection, 'recordRuntimeTimelineEvent'>,
  ) => Effect.sync(() => {
    projection.recordRuntimeTimelineEvent({
      agentId,
      kind: event.kind,
      tone: event.tone ?? 'error',
      label: event.label,
      detail: runtimeErrorDetail(error),
    })
  })
  return projection ? persist(projection) : Effect.flatMap(RuntimeProjection, persist)
}

export function captureRuntimeDiffs(
  agentId: string,
  collect: () => RuntimeDiffArtifact[],
  projection: Pick<RuntimeLifecycleProjection, 'replaceAgentDiffArtifacts'>,
): Effect.Effect<void, never, never>
export function captureRuntimeDiffs(
  agentId: string,
  collect: () => RuntimeDiffArtifact[],
): Effect.Effect<void, never, RuntimeProjection>
export function captureRuntimeDiffs(
  agentId: string,
  collect: () => RuntimeDiffArtifact[],
  projection?: Pick<RuntimeLifecycleProjection, 'replaceAgentDiffArtifacts'>,
) {
  const persist = (
    projection: Pick<RuntimeLifecycleProjection, 'replaceAgentDiffArtifacts'>,
  ) => Effect.sync(() => {
    try {
      projection.replaceAgentDiffArtifacts({
        agentId,
        diffs: collect(),
      })
    } catch {
      // Diff capture is an observability projection; runtime transcripts remain authoritative.
    }
  })
  return projection ? persist(projection) : Effect.flatMap(RuntimeProjection, persist)
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
): Effect.Effect<T, RuntimeLifecycleError, RuntimeProjection>
export function runAgentTurnLifecycle<T>(input: RuntimeTurnLifecycleInput<T>) {
  let finalStatus: AgentStatus | null = null

  return Effect.flatMap(input.projection
    ? Effect.succeed(input.projection)
    : RuntimeProjection, (projection) =>
      Effect.gen(function* () {
        yield* setRuntimeStatus(input.agentId, 'running', projection)
        yield* Effect.sync(() => {
          projection.appendUserMessage({ agentId: input.agentId, text: input.displayText })
        })
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
        Effect.ensuring(Effect.sync(() => {
          if (finalStatus) projection.setAgentStatus(input.agentId, finalStatus)
        })),
      ),
  )
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
  effect: Effect.Effect<A, unknown, RuntimeProjection>,
) {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(RuntimeProjection.liveLayer)))
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
  if (failure instanceof RuntimeLifecycleError && failure.message === 'Runtime turn failed') {
    throw failure.cause ?? failure
  }
  if (failure) throw failure
  throw Cause.squash(exit.cause)
}

export function runRuntimeLifecycleSync<A>(
  effect: Effect.Effect<A, unknown, RuntimeProjection>,
) {
  const exit = Effect.runSyncExit(effect.pipe(Effect.provide(RuntimeProjection.liveLayer)))
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
