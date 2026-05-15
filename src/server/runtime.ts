import type { ReviewTarget, SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import type { RuntimeKind } from '~/lib/contracts'
import { Context, Data, Effect, Either, Layer } from 'effect'
import { getAgentLaunchConfig } from './db'
import {
  RuntimeRegistry,
  type ProviderRuntimeAdapter,
  type RuntimeRegistryApi,
} from './provider-runtime'

type RuntimeLaunchConfig = {
  readonly runtime: RuntimeKind
}

export type RuntimeCommandsApi = {
  readonly prompt: (input: {
    readonly agentId: string
    readonly text: string
    readonly images?: SendMessageImage[]
  }) => Effect.Effect<unknown, RuntimeCommandError>
  readonly steer: (input: {
    readonly agentId: string
    readonly text: string
    readonly images?: SendMessageImage[]
  }) => Effect.Effect<unknown, RuntimeCommandError>
  readonly interrupt: (input: { readonly agentId: string }) => Effect.Effect<unknown, RuntimeCommandError>
  readonly setThinkingLevel: (input: {
    readonly agentId: string
    readonly level?: ThinkingLevel
  }) => Effect.Effect<unknown, RuntimeCommandError>
  readonly reset: (input: { readonly agentId: string }) => Effect.Effect<unknown, RuntimeCommandError>
  readonly fork: (input: { readonly agentId: string }) => Effect.Effect<string, RuntimeCommandError>
  readonly review: (input: {
    readonly agentId: string
    readonly target: ReviewTarget
  }) => Effect.Effect<unknown, RuntimeCommandError>
  readonly answerQuestion: (input: {
    readonly agentId: string
    readonly requestId: string
    readonly answers: Record<string, string | string[]>
  }) => Effect.Effect<unknown, RuntimeCommandError>
}

export class RuntimeCommandError extends Data.TaggedError('RuntimeCommandError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class RuntimeCommands extends Context.Tag('@kiri/RuntimeCommands')<
  RuntimeCommands,
  RuntimeCommandsApi
>() {
  static readonly layer = Layer.effect(
    RuntimeCommands,
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry
      return RuntimeCommands.of(makeRuntimeCommands({
        registry,
        getLaunchConfig: getAgentLaunchConfig,
      }))
    }),
  )
}

const liveRuntimeCommandsLayer = RuntimeCommands.layer.pipe(
  Layer.provide(RuntimeRegistry.layer),
)

export function makeRuntimeCommands(input: {
  readonly registry: RuntimeRegistryApi
  readonly getLaunchConfig: (agentId: string) => RuntimeLaunchConfig
}): RuntimeCommandsApi {
  const adapterFor = Effect.fn('RuntimeCommands.adapterFor')(function* (agentId: string) {
    const config = yield* Effect.try({
      try: () => input.getLaunchConfig(agentId),
      catch: (error) => new RuntimeCommandError({
        message: error instanceof Error ? error.message : 'Runtime launch config lookup failed',
        cause: error,
      }),
    })
    const adapter = yield* input.registry.get(config.runtime)
    return { runtime: config.runtime, adapter }
  })

  return {
    prompt: Effect.fn('RuntimeCommands.prompt')(function* (command) {
      const { adapter } = yield* adapterFor(command.agentId)
      return yield* callAdapter(() => adapter.prompt(command))
    }),
    steer: Effect.fn('RuntimeCommands.steer')(function* (command) {
      const { runtime, adapter } = yield* adapterFor(command.agentId)
      const steer = yield* requireCapability(runtime, adapter, 'steer', 'steer yet')
      return yield* callAdapter(() => steer(command))
    }),
    interrupt: Effect.fn('RuntimeCommands.interrupt')(function* (command) {
      const { runtime, adapter } = yield* adapterFor(command.agentId)
      const interrupt = yield* requireCapability(runtime, adapter, 'interrupt', 'interrupt yet')
      return yield* callAdapter(() => interrupt(command))
    }),
    setThinkingLevel: Effect.fn('RuntimeCommands.setThinkingLevel')(function* (command) {
      const { runtime, adapter } = yield* adapterFor(command.agentId)
      const setThinkingLevel = yield* requireCapability(
        runtime,
        adapter,
        'setThinkingLevel',
        '/thinking yet',
      )
      return yield* callAdapter(() => setThinkingLevel(command))
    }),
    reset: Effect.fn('RuntimeCommands.reset')(function* (command) {
      const { runtime, adapter } = yield* adapterFor(command.agentId)
      const reset = yield* requireCapability(runtime, adapter, 'reset', '/new yet')
      return yield* callAdapter(() => reset(command))
    }),
    fork: Effect.fn('RuntimeCommands.fork')(function* (command) {
      const { runtime, adapter } = yield* adapterFor(command.agentId)
      const fork = yield* requireCapability(runtime, adapter, 'fork', '/fork yet')
      return yield* callAdapter(() => fork(command))
    }),
    review: Effect.fn('RuntimeCommands.review')(function* (command) {
      const { runtime, adapter } = yield* adapterFor(command.agentId)
      const review = yield* requireCapability(runtime, adapter, 'review', '/review yet')
      return yield* callAdapter(() => review(command))
    }),
    answerQuestion: Effect.fn('RuntimeCommands.answerQuestion')(function* (command) {
      const { runtime, adapter } = yield* adapterFor(command.agentId)
      const answerQuestion = yield* requireCapability(
        runtime,
        adapter,
        'answerQuestion',
        'interactive questions yet',
      )
      return yield* callAdapter(() => answerQuestion(command))
    }),
  }
}

async function runRuntimeCommand<A>(
  effect: Effect.Effect<A, RuntimeCommandError, RuntimeCommands>,
) {
  const result = await Effect.runPromise(
    effect.pipe(
      Effect.provide(liveRuntimeCommandsLayer),
      Effect.either,
    ),
  )
  if (Either.isRight(result)) return result.right
  throw normalizeRuntimeCommandFailure(result.left)
}

function callAdapter<A>(call: () => Promise<A>) {
  return Effect.tryPromise({
    try: call,
    catch: (error) => new RuntimeCommandError({
      message: error instanceof Error ? error.message : 'Runtime command failed',
      cause: error,
    }),
  })
}

function requireCapability<K extends keyof ProviderRuntimeAdapter>(
  runtime: RuntimeKind,
  adapter: ProviderRuntimeAdapter,
  key: K,
  unsupported: string,
): Effect.Effect<NonNullable<ProviderRuntimeAdapter[K]>, RuntimeCommandError> {
  const capability = adapter[key]
  return capability
    ? Effect.succeed(capability)
    : Effect.fail(new RuntimeCommandError({
      message: `${runtime} agents do not support ${unsupported}`,
    }))
}

function normalizeRuntimeCommandFailure(error: unknown) {
  if (error instanceof Error) return error
  return new RuntimeCommandError({
    message: 'Runtime command failed',
    cause: error,
  })
}

export async function promptAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  return runRuntimeCommand(Effect.gen(function* () {
    const commands = yield* RuntimeCommands
    return yield* commands.prompt(input)
  }))
}

export async function steerAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  return runRuntimeCommand(Effect.gen(function* () {
    const commands = yield* RuntimeCommands
    return yield* commands.steer(input)
  }))
}

export async function interruptAgent(input: { agentId: string }) {
  return runRuntimeCommand(Effect.gen(function* () {
    const commands = yield* RuntimeCommands
    return yield* commands.interrupt(input)
  }))
}

export async function setAgentThinkingLevel(input: {
  agentId: string
  level?: ThinkingLevel
}) {
  return runRuntimeCommand(Effect.gen(function* () {
    const commands = yield* RuntimeCommands
    return yield* commands.setThinkingLevel(input)
  }))
}

export async function resetAgentSession(input: { agentId: string }) {
  return runRuntimeCommand(Effect.gen(function* () {
    const commands = yield* RuntimeCommands
    return yield* commands.reset(input)
  }))
}

export async function forkAgentSession(input: { agentId: string }) {
  return runRuntimeCommand(Effect.gen(function* () {
    const commands = yield* RuntimeCommands
    return yield* commands.fork(input)
  }))
}

export async function reviewAgentSession(input: {
  agentId: string
  target: ReviewTarget
}) {
  return runRuntimeCommand(Effect.gen(function* () {
    const commands = yield* RuntimeCommands
    return yield* commands.review(input)
  }))
}

export async function answerAgentQuestion(input: {
  agentId: string
  requestId: string
  answers: Record<string, string | string[]>
}) {
  return runRuntimeCommand(Effect.gen(function* () {
    const commands = yield* RuntimeCommands
    return yield* commands.answerQuestion(input)
  }))
}
