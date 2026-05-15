import { Context, Data, Effect, Either, Layer } from 'effect'
import type { ReviewTarget, SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import {
  interruptCodexAgent,
  promptCodexAgent,
  resetCodexSession,
  reviewCodexSession,
  setCodexThinkingLevel,
  steerCodexAgent,
  forgetCodexRuntimeAgent,
} from './codex-runtime'
import {
  forkPiSession,
  interruptPiAgent,
  promptPiAgent,
  resetPiSession,
  setPiThinkingLevel,
  steerPiAgent,
  forgetPiRuntimeAgent,
} from './pi-runtime'
import type { RuntimeKind } from '~/lib/contracts'

export type ProviderRuntimeAdapter = {
  prompt: (input: {
    agentId: string
    text: string
    images?: SendMessageImage[]
  }) => Promise<unknown>
  steer?: (input: {
    agentId: string
    text: string
    images?: SendMessageImage[]
  }) => Promise<unknown>
  interrupt?: (input: { agentId: string }) => Promise<unknown>
  setThinkingLevel?: (input: {
    agentId: string
    level?: ThinkingLevel
  }) => Promise<unknown>
  reset?: (input: { agentId: string }) => Promise<unknown>
  fork?: (input: { agentId: string }) => Promise<string>
  review?: (input: {
    agentId: string
    target: ReviewTarget
  }) => Promise<unknown>
  answerQuestion?: (input: {
    agentId: string
    requestId: string
    answers: Record<string, string | string[]>
  }) => Promise<unknown>
}

export type RuntimeRegistryApi = {
  readonly get: (runtime: RuntimeKind) => Effect.Effect<ProviderRuntimeAdapter>
  readonly list: Effect.Effect<Readonly<Record<RuntimeKind, ProviderRuntimeAdapter>>>
  readonly forget: (runtime: RuntimeKind, agentId: string) => Effect.Effect<void, RuntimeRegistryError>
}

export class RuntimeRegistryError extends Data.TaggedError('RuntimeRegistryError')<{
  readonly message: string
  readonly runtime: RuntimeKind
  readonly agentId?: string
  readonly cause?: unknown
}> {}

export const runtimeAdapters: Record<RuntimeKind, ProviderRuntimeAdapter> = {
  pi: {
    prompt: promptPiAgent,
    steer: steerPiAgent,
    interrupt: interruptPiAgent,
    setThinkingLevel: setPiThinkingLevel,
    reset: resetPiSession,
    fork: forkPiSession,
  },
  codex: {
    prompt: promptCodexAgent,
    steer: steerCodexAgent,
    interrupt: interruptCodexAgent,
    setThinkingLevel: setCodexThinkingLevel,
    reset: resetCodexSession,
    review: reviewCodexSession,
  },
  claude: {
    prompt: rejectClaudeGuiRuntime,
  },
}

export class RuntimeRegistry extends Context.Tag('@kiri/RuntimeRegistry')<
  RuntimeRegistry,
  RuntimeRegistryApi
>() {
  static readonly layer = Layer.succeed(
    RuntimeRegistry,
    RuntimeRegistry.of(makeRuntimeRegistry(runtimeAdapters, {
      pi: forgetPiRuntimeAgent,
      codex: forgetCodexRuntimeAgent,
    })),
  )
}

export function makeRuntimeRegistry(
  adapters: Readonly<Record<RuntimeKind, ProviderRuntimeAdapter>>,
  cleanup: Partial<Record<RuntimeKind, (agentId: string) => void>> = {},
): RuntimeRegistryApi {
  return {
    get: (runtime) => Effect.succeed(adapters[runtime]),
    list: Effect.succeed(adapters),
    forget: (runtime, agentId) => Effect.try({
      try: () => {
        cleanup[runtime]?.(agentId)
      },
      catch: (error) => new RuntimeRegistryError({
        message: error instanceof Error ? error.message : 'Runtime cleanup failed',
        runtime,
        agentId,
        cause: error,
      }),
    }),
  }
}

export function forgetProviderRuntimeAgent(runtime: RuntimeKind, agentId: string) {
  const result = Effect.runSync(
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry
      return yield* registry.forget(runtime, agentId)
    }).pipe(
      Effect.provide(RuntimeRegistry.layer),
      Effect.either,
    ),
  )
  if (Either.isRight(result)) return
  throw result.left
}

function rejectClaudeGuiRuntime(): Promise<never> {
  return Promise.reject(new Error('Claude sessions run in terminal mode only'))
}
