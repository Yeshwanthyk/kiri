import { describe, expect, it, vi } from 'vitest'
import { PiRpcProcessAdapter } from '~/server/pi-rpc'
import { makePiRetainedState } from '~/server/pi-retained-state'

function testAdapter() {
  return new PiRpcProcessAdapter({
    cwd: '/tmp',
    sessionDir: '/tmp/pi-session',
  })
}

describe('pi retained state', () => {
  it('reuses an adapter while the launch key is unchanged', () => {
    const state = makePiRetainedState()
    const adapter = testAdapter()

    const first = state.getOrCreateAdapter('agent-1', 'key-1', () => adapter)
    const second = state.getOrCreateAdapter('agent-1', 'key-1', () => testAdapter())

    expect(first).toBe(adapter)
    expect(second).toBe(adapter)
    expect(state.stats()).toMatchObject({
      adapters: 1,
      adapterKeys: 1,
    })
  })

  it('stops and replaces an adapter when launch identity changes', () => {
    const state = makePiRetainedState()
    const oldAdapter = testAdapter()
    const stop = vi.spyOn(oldAdapter, 'stop')
    const newAdapter = testAdapter()
    const oldGeneration = state.generation('agent-1')

    state.getOrCreateAdapter('agent-1', 'key-1', () => oldAdapter)
    const replacement = state.getOrCreateAdapter('agent-1', 'key-2', () => newAdapter)

    expect(replacement).toBe(newAdapter)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(state.getAdapter('agent-1')).toBe(newAdapter)
    expect(state.isCurrentGeneration('agent-1', oldGeneration)).toBe(false)
    expect(state.stats()).toMatchObject({
      adapters: 1,
      adapterKeys: 1,
      queues: 0,
      sessionGenerations: 1,
    })
  })

  it('forgets agent adapter, key, queue, and generation by default', () => {
    const state = makePiRetainedState()
    const adapter = testAdapter()
    const stop = vi.spyOn(adapter, 'stop')
    state.getOrCreateAdapter('agent-1', 'key-1', () => adapter)
    state.queues.set('agent-1', Promise.resolve())
    state.bumpGeneration('agent-1')

    state.forgetAgent('agent-1')

    expect(stop).toHaveBeenCalledTimes(1)
    expect(state.stats()).toMatchObject({
      adapters: 0,
      adapterKeys: 0,
      queues: 0,
      sessionGenerations: 0,
    })
  })

  it('can keep generation while clearing runtime state for reset', () => {
    const state = makePiRetainedState()
    const generation = state.bumpGeneration('agent-1')
    state.getOrCreateAdapter('agent-1', 'key-1', () => testAdapter())
    state.queues.set('agent-1', Promise.resolve())

    state.forgetAgent('agent-1', { keepGeneration: true })

    expect(state.isCurrentGeneration('agent-1', generation)).toBe(true)
    expect(state.stats()).toMatchObject({
      adapters: 0,
      adapterKeys: 0,
      queues: 0,
      sessionGenerations: 1,
    })
  })

  it('invalidates queued generation tokens after delete and agent recreation', () => {
    const state = makePiRetainedState()
    const staleGeneration = state.generation('agent-1')

    state.forgetAgent('agent-1')

    expect(state.isCurrentGeneration('agent-1', staleGeneration)).toBe(false)

    const recreatedGeneration = state.generation('agent-1')

    expect(recreatedGeneration).not.toBe(staleGeneration)
    expect(state.isCurrentGeneration('agent-1', staleGeneration)).toBe(false)
    expect(state.isCurrentGeneration('agent-1', recreatedGeneration)).toBe(true)
  })

  it('clears all retained runtime state for tests', () => {
    const state = makePiRetainedState()
    const adapter = testAdapter()
    const stop = vi.spyOn(adapter, 'stop')
    state.getOrCreateAdapter('agent-1', 'key-1', () => adapter)
    state.queues.set('agent-1', Promise.resolve())
    state.bumpGeneration('agent-1')

    state.clearRuntimeStateForTest()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(state.stats()).toMatchObject({
      adapters: 0,
      adapterKeys: 0,
      queues: 0,
      sessionGenerations: 0,
    })
  })
})
