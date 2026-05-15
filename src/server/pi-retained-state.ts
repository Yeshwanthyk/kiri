import type { PiRpcProcessAdapter } from './pi-rpc'

export type PiRetainedStateStats = {
  adapters: number
  adapterKeys: number
  queues: number
  sessionGenerations: number
}

export function makePiRetainedState() {
  const adapters = new Map<string, PiRpcProcessAdapter>()
  const adapterKeys = new Map<string, string>()
  const queues = new Map<string, Promise<void>>()
  const sessionGenerations = new Map<string, number>()
  let nextGeneration = 0

  function stopAdapter(agentId: string) {
    const adapter = adapters.get(agentId)
    adapter?.stop()
    adapters.delete(agentId)
    adapterKeys.delete(agentId)
    queues.delete(agentId)
  }

  function getOrCreateAdapter(
    agentId: string,
    adapterKey: string,
    create: () => PiRpcProcessAdapter,
  ) {
    let adapter = adapters.get(agentId)
    if (adapter && adapterKeys.get(agentId) !== adapterKey) {
      bumpGeneration(agentId)
      stopAdapter(agentId)
      adapter = undefined
    }

    if (!adapter) {
      adapter = create()
      adapters.set(agentId, adapter)
      adapterKeys.set(agentId, adapterKey)
    }
    return adapter
  }

  function forgetAgent(
    agentId: string,
    options: { readonly keepGeneration?: boolean } = {},
  ) {
    stopAdapter(agentId)
    if (!options.keepGeneration) sessionGenerations.delete(agentId)
  }

  function generation(agentId: string) {
    const existing = sessionGenerations.get(agentId)
    if (existing !== undefined) return existing
    const created = ++nextGeneration
    sessionGenerations.set(agentId, created)
    return created
  }

  function clearRuntimeStateForTest() {
    for (const agentId of adapters.keys()) {
      stopAdapter(agentId)
    }
    queues.clear()
    sessionGenerations.clear()
  }

  function stats(): PiRetainedStateStats {
    return {
      adapters: adapters.size,
      adapterKeys: adapterKeys.size,
      queues: queues.size,
      sessionGenerations: sessionGenerations.size,
    }
  }

  return {
    queues,
    getAdapter: (agentId: string) => adapters.get(agentId),
    getOrCreateAdapter,
    forgetAgent,
    bumpGeneration,
    generation,
    isCurrentGeneration: (agentId: string, generation: number) =>
      sessionGenerations.get(agentId) === generation,
    stats,
    clearRuntimeStateForTest,
  }

  function bumpGeneration(agentId: string) {
    const created = ++nextGeneration
    sessionGenerations.set(agentId, created)
    return created
  }
}
