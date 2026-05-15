import { Context, Effect, Layer } from 'effect'
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
}

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
  static readonly layer = Layer.succeed(RuntimeRegistry, RuntimeRegistry.of(makeRuntimeRegistry(runtimeAdapters)))
}

export function makeRuntimeRegistry(
  adapters: Readonly<Record<RuntimeKind, ProviderRuntimeAdapter>>,
): RuntimeRegistryApi {
  return {
    get: (runtime) => Effect.succeed(adapters[runtime]),
    list: Effect.succeed(adapters),
  }
}

export function forgetProviderRuntimeAgent(runtime: RuntimeKind, agentId: string) {
  if (runtime === 'pi') forgetPiRuntimeAgent(agentId)
  if (runtime === 'codex') forgetCodexRuntimeAgent(agentId)
}

async function rejectClaudeGuiRuntime(): Promise<never> {
  throw new Error('Claude sessions run in terminal mode only')
}
