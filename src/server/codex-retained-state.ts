import type { CodexAppServerAdapter } from './codex-app-server'

export type CodexRetainedStateStats = {
  adapters: number
  adapterListeners: number
  threadAgents: number
  agentThreads: number
  threadTurns: number
  queues: number
  sessionGenerations: number
  repoDiffRefreshedTurns: number
  turnStartProjections: number
}

export type CodexRetainedStateTestInput = {
  readonly agentId: string
  readonly threadId: string
  readonly turnId?: string
}

export function makeCodexRetainedState(input: {
  readonly maxRepoDiffRefreshedTurns?: number
  readonly maxTurnStartProjections?: number
} = {}) {
  const maxRepoDiffRefreshedTurns = input.maxRepoDiffRefreshedTurns ?? 1_000
  const maxTurnStartProjections = input.maxTurnStartProjections ?? 1_000
  const adapters = new Map<string, CodexAppServerAdapter>()
  const adapterListeners = new Set<string>()
  const threadAgents = new Map<string, string>()
  const agentThreads = new Map<string, string>()
  const threadTurns = new Map<string, string>()
  const queues = new Map<string, Promise<void>>()
  const sessionGenerations = new Map<string, number>()
  const repoDiffRefreshedTurns = new Set<string>()
  const turnStartProjections = new Set<string>()

  function pruneTurnKeysForThread(turnKeys: Set<string>, threadId: string) {
    const prefix = `${threadId}:`
    for (const turnKey of turnKeys) {
      if (turnKey.startsWith(prefix)) turnKeys.delete(turnKey)
    }
  }

  function pruneThreadTurnKeys(threadId: string) {
    pruneTurnKeysForThread(repoDiffRefreshedTurns, threadId)
    pruneTurnKeysForThread(turnStartProjections, threadId)
  }

  function rememberBoundedTurnKey(turnKeys: Set<string>, turnKey: string, maxTurnKeys: number) {
    if (!turnKey) return false
    if (turnKeys.has(turnKey)) return false
    turnKeys.add(turnKey)
    while (turnKeys.size > maxTurnKeys) {
      const oldest = turnKeys.values().next().value
      if (!oldest) break
      turnKeys.delete(oldest)
    }
    return true
  }

  function rememberRepoDiffRefreshedTurn(turnKey: string) {
    rememberBoundedTurnKey(repoDiffRefreshedTurns, turnKey, maxRepoDiffRefreshedTurns)
  }

  function rememberTurnStartProjection(turnKey: string) {
    return rememberBoundedTurnKey(turnStartProjections, turnKey, maxTurnStartProjections)
  }

  function forgetThread(agentId: string, threadId: string | undefined) {
    if (!threadId) return
    threadAgents.delete(threadId)
    threadTurns.delete(threadId)
    pruneThreadTurnKeys(threadId)
    if (agentThreads.get(agentId) === threadId) {
      agentThreads.delete(agentId)
    }
  }

  function forgetAgent(
    agentId: string,
    options: { readonly keepGeneration?: boolean } = {},
  ) {
    forgetThread(agentId, agentThreads.get(agentId))
    for (const [candidateThreadId, candidateAgentId] of threadAgents) {
      if (candidateAgentId !== agentId) continue
      threadAgents.delete(candidateThreadId)
      threadTurns.delete(candidateThreadId)
      pruneThreadTurnKeys(candidateThreadId)
    }
    agentThreads.delete(agentId)
    queues.delete(agentId)
    if (!options.keepGeneration) sessionGenerations.delete(agentId)
  }

  function rememberThread(agentId: string, threadId: string) {
    const previousThreadId = agentThreads.get(agentId)
    if (previousThreadId && previousThreadId !== threadId) {
      threadAgents.delete(previousThreadId)
      threadTurns.delete(previousThreadId)
      pruneThreadTurnKeys(previousThreadId)
    }
    threadAgents.set(threadId, agentId)
    agentThreads.set(agentId, threadId)
  }

  function retainForTest(testInput: CodexRetainedStateTestInput) {
    rememberThread(testInput.agentId, testInput.threadId)
    if (testInput.turnId) {
      threadTurns.set(testInput.threadId, testInput.turnId)
      rememberRepoDiffRefreshedTurn(codexRetainedTurnKey(testInput.threadId, testInput.turnId))
    }
  }

  function clearRuntimeStateForTest() {
    threadAgents.clear()
    agentThreads.clear()
    threadTurns.clear()
    queues.clear()
    sessionGenerations.clear()
    repoDiffRefreshedTurns.clear()
    turnStartProjections.clear()
  }

  function stats(): CodexRetainedStateStats {
    return {
      adapters: adapters.size,
      adapterListeners: adapterListeners.size,
      threadAgents: threadAgents.size,
      agentThreads: agentThreads.size,
      threadTurns: threadTurns.size,
      queues: queues.size,
      sessionGenerations: sessionGenerations.size,
      repoDiffRefreshedTurns: repoDiffRefreshedTurns.size,
      turnStartProjections: turnStartProjections.size,
    }
  }

  return {
    queues,
    getAdapter: (url: string) => adapters.get(url),
    rememberAdapter: (url: string, adapter: CodexAppServerAdapter) => {
      adapters.set(url, adapter)
    },
    hasAdapterListener: (url: string) => adapterListeners.has(url),
    rememberAdapterListener: (url: string) => {
      adapterListeners.add(url)
    },
    agentForThread: (threadId: string) => threadAgents.get(threadId),
    threadForAgent: (agentId: string) => agentThreads.get(agentId),
    turnForThread: (threadId: string) => threadTurns.get(threadId),
    rememberTurn: (threadId: string, turnId: string) => {
      threadTurns.set(threadId, turnId)
    },
    bumpGeneration: (agentId: string) => {
      const generation = (sessionGenerations.get(agentId) ?? 0) + 1
      sessionGenerations.set(agentId, generation)
      return generation
    },
    generation: (agentId: string) => sessionGenerations.get(agentId) ?? 0,
    isCurrentGeneration: (agentId: string, generation: number) =>
      (sessionGenerations.get(agentId) ?? 0) === generation,
    forgetThread,
    forgetAgent,
    rememberThread,
    hasRepoDiffRefreshedTurn: (turnKey: string) => repoDiffRefreshedTurns.has(turnKey),
    rememberRepoDiffRefreshedTurn,
    rememberTurnStartProjection,
    stats,
    retainForTest,
    clearRuntimeStateForTest,
  }
}

export function codexRetainedTurnKey(threadId: string, turnId: string) {
  return `${threadId}:${turnId}`
}
