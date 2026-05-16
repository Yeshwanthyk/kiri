import { Context, Effect, Layer } from 'effect'
import type { KiriControlApi } from './kiri-control'

export type KiriMcpRuntimeControl = Pick<KiriControlApi, 'getContext'>
export type KiriMcpContext = Effect.Effect.Success<ReturnType<KiriControlApi['getContext']>>

export type KiriMcpRuntimeServiceApi = {
  readonly run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>
  readonly context: () => Promise<KiriMcpContext>
  readonly withContext: <A>(result: A) => Promise<{
    readonly result: A
    readonly context: KiriMcpContext
  }>
  readonly selectedSessionId: () => Promise<string>
}

class KiriMcpRuntimeService extends Context.Tag('@kiri/KiriMcpRuntime')<
  KiriMcpRuntimeService,
  KiriMcpRuntimeServiceApi
>() {
  static layer(control: KiriMcpRuntimeControl) {
    return Layer.sync(KiriMcpRuntimeService, () =>
      KiriMcpRuntimeService.of(makeKiriMcpRuntimeService(control)))
  }
}

export function makeKiriMcpRuntimeService(
  control: KiriMcpRuntimeControl,
): KiriMcpRuntimeServiceApi {
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
  const context = () => run(control.getContext())
  return {
    run,
    context,
    withContext: async (result) => ({
      result,
      context: await context(),
    }),
    selectedSessionId: async () => {
      const contextValue = await context()
      const agentId = contextValue.selectedSession?.id
      if (!agentId) throw new Error('No selected session available')
      return agentId
    },
  }
}
