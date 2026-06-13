import { describe, expect, it } from 'vitest'
import { CodexAppServerAdapter } from '~/server/codex-app-server'
import { codexRetainedTurnKey, makeCodexRetainedState } from '~/server/codex-retained-state'

function testAdapter() {
  return new CodexAppServerAdapter({
    websocketUrl: 'ws://127.0.0.1:65535',
    spawnIfMissing: false,
  })
}

describe('codex retained state', () => {
  it('tracks adapters and listener registration without duplicating listeners', () => {
    const state = makeCodexRetainedState()
    const adapter = testAdapter()

    state.rememberAdapter('ws://codex', adapter)
    state.rememberAdapterListener('ws://codex')
    state.rememberAdapterListener('ws://codex')

    expect(state.getAdapter('ws://codex')).toBe(adapter)
    expect(state.hasAdapterListener('ws://codex')).toBe(true)
    expect(state.stats()).toMatchObject({
      adapters: 1,
      adapterListeners: 1,
    })
  })

  it('remembers one active thread per agent and prunes stale turn guards on replacement', () => {
    const state = makeCodexRetainedState()

    state.rememberThread('agent-1', 'thread-old')
    state.rememberTurn('thread-old', 'turn-old')
    state.rememberTurnStartProjection(codexRetainedTurnKey('thread-old', 'turn-old'))

    state.rememberThread('agent-1', 'thread-new')

    expect(state.threadForAgent('agent-1')).toBe('thread-new')
    expect(state.agentForThread('thread-old')).toBeUndefined()
    expect(state.turnForThread('thread-old')).toBeUndefined()
    expect(state.stats()).toMatchObject({
      threadAgents: 1,
      agentThreads: 1,
      threadTurns: 0,
      turnStartProjections: 0,
    })
  })

  it('does not let stale thread cleanup remove the current thread alias', () => {
    const state = makeCodexRetainedState()
    state.rememberThread('agent-1', 'thread-old')
    state.rememberThread('agent-1', 'thread-new')

    state.forgetThread('agent-1', 'thread-old')

    expect(state.threadForAgent('agent-1')).toBe('thread-new')
    expect(state.agentForThread('thread-new')).toBe('agent-1')
    expect(state.agentForThread('thread-old')).toBeUndefined()
  })

  it('forgets all retained agent aliases, queues, turns, and generations', () => {
    const state = makeCodexRetainedState()
    state.rememberThread('agent-1', 'thread-1')
    state.rememberThread('agent-1', 'thread-2')
    state.rememberTurn('thread-2', 'turn-2')
    state.queues.set('agent-1', Promise.resolve())
    state.bumpGeneration('agent-1')
    state.rememberTurnStartProjection(codexRetainedTurnKey('thread-2', 'turn-2'))

    state.forgetAgent('agent-1')

    expect(state.stats()).toMatchObject({
      threadAgents: 0,
      agentThreads: 0,
      threadTurns: 0,
      queues: 0,
      sessionGenerations: 0,
      turnStartProjections: 0,
    })
  })

  it('can keep generation during reset while clearing active runtime state', () => {
    const state = makeCodexRetainedState()
    const generation = state.bumpGeneration('agent-1')
    state.rememberThread('agent-1', 'thread-1')
    state.queues.set('agent-1', Promise.resolve())

    state.forgetAgent('agent-1', { keepGeneration: true })

    expect(state.isCurrentGeneration('agent-1', generation)).toBe(true)
    expect(state.stats()).toMatchObject({
      threadAgents: 0,
      agentThreads: 0,
      queues: 0,
      sessionGenerations: 1,
    })
  })

  it('dedupes turn-start projection guards and evicts oldest turn keys', () => {
    const state = makeCodexRetainedState({ maxTurnStartProjections: 2 })

    expect(state.rememberTurnStartProjection(codexRetainedTurnKey('thread-1', 'turn-1'))).toBe(true)
    expect(state.rememberTurnStartProjection(codexRetainedTurnKey('thread-1', 'turn-1'))).toBe(false)
    expect(state.rememberTurnStartProjection(codexRetainedTurnKey('thread-2', 'turn-2'))).toBe(true)
    expect(state.rememberTurnStartProjection(codexRetainedTurnKey('thread-3', 'turn-3'))).toBe(true)

    expect(state.rememberTurnStartProjection(codexRetainedTurnKey('thread-1', 'turn-1'))).toBe(true)
    expect(state.stats().turnStartProjections).toBe(2)
  })

  it('clears runtime maps for tests without clearing adapter ownership', () => {
    const state = makeCodexRetainedState()
    state.rememberAdapter('ws://codex', testAdapter())
    state.rememberAdapterListener('ws://codex')
    state.retainForTest({
      agentId: 'agent-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
    })

    state.clearRuntimeStateForTest()

    expect(state.stats()).toMatchObject({
      adapters: 1,
      adapterListeners: 1,
      threadAgents: 0,
      agentThreads: 0,
      threadTurns: 0,
      turnStartProjections: 0,
    })
  })
})
