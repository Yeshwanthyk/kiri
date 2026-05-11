import { describe, expect, it, vi } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'
import type { AgentStatus } from '../../src/lib/contracts'
import type { RuntimeDiffArtifact } from '../../src/server/git-diff'
import {
  captureRuntimeDiffs,
  enqueueAgentTurn,
  nextThinkingLevel,
  runAgentTurnLifecycle,
  runRuntimeLifecyclePromise,
  runRuntimeLifecycleSync,
  RuntimeProjection,
  RuntimeLifecycleError,
  runtimeStateWithoutUndefined,
  setRuntimeState,
  type RuntimeLifecycleProjection,
} from '../../src/server/runtime-lifecycle'

function projection() {
  const calls: Array<{ type: string; value: unknown }> = []
  const fake: RuntimeLifecycleProjection = {
    appendUserMessage: vi.fn((value: { agentId: string; text: string }) => {
      calls.push({ type: 'message', value })
    }),
    recordRuntimeTimelineEvent: vi.fn((value: Parameters<RuntimeLifecycleProjection['recordRuntimeTimelineEvent']>[0]) => {
      calls.push({ type: 'timeline', value })
    }),
    replaceAgentDiffArtifacts: vi.fn((value: { agentId: string; diffs: RuntimeDiffArtifact[] }) => {
      calls.push({ type: 'diffs', value })
    }),
    setAgentRuntimeState: vi.fn((agentId: string, state: Record<string, unknown>) => {
      calls.push({ type: 'state', value: { agentId, state } })
    }),
    setAgentStatus: vi.fn((agentId: string, status: AgentStatus) => {
      calls.push({ type: 'status', value: { agentId, status } })
    }),
  }
  return { calls, fake, layer: Layer.succeed(RuntimeProjection, fake) }
}

describe('runtime lifecycle', () => {
  it.effect('keeps an agent queue usable after a failed turn', () =>
    Effect.gen(function* () {
    const queues = new Map<string, Promise<void>>()
    const order: string[] = []

    const first = yield* Effect.exit(enqueueAgentTurn('agent-1', queues, () => {
      order.push('first')
      return Promise.reject(new Error('boom'))
    }))
    expect(Exit.isFailure(first)).toBe(true)

    yield* enqueueAgentTurn('agent-1', queues, () => {
      order.push('second')
      return Promise.resolve()
    })

    expect(order).toEqual(['first', 'second'])
  }))

  it.effect('marks running then idle for successful current turns', () =>
    Effect.gen(function* () {
    const { calls, fake } = projection()

    const result = yield* runAgentTurnLifecycle({
      agentId: 'agent-1',
      displayText: 'hello',
      errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
      projection: fake,
      run: () => Promise.resolve('ok'),
      onSuccess: (result) => {
        calls.push({ type: 'success', value: result })
      },
    })

    expect(result).toBe('ok')
    expect(statuses(calls)).toEqual(['running', 'idle'])
    expect(calls.map((call) => call.type)).toEqual(['status', 'message', 'success', 'status'])
  }))

  it.effect('can replace the runtime projection through an Effect layer', () =>
    Effect.gen(function* () {
      const { calls, layer } = projection()

      yield* runAgentTurnLifecycle({
        agentId: 'agent-1',
        displayText: 'layered',
        errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
        run: () => Promise.resolve('ok'),
      }).pipe(Effect.provide(layer))

      expect(calls.map((call) => call.type)).toEqual(['status', 'message', 'status'])
      expect(statuses(calls)).toEqual(['running', 'idle'])
    }))

  it.effect('marks running then failed and records timeline errors on current turn failure', () =>
    Effect.gen(function* () {
    const { calls, fake } = projection()

    const result = yield* Effect.exit(runAgentTurnLifecycle({
      agentId: 'agent-1',
      displayText: 'hello',
      errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
      projection: fake,
      run: () => Promise.reject(new Error('failed turn')),
      onError: (error) => {
        calls.push({ type: 'cleanup', value: error })
      },
    }))

    expect(result).toStrictEqual(Exit.fail(expect.any(Error)))
    expect(statuses(calls)).toEqual(['running', 'failed'])
    expect(fake.recordRuntimeTimelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      kind: 'runtime_error',
      label: 'Runtime error',
      detail: 'failed turn',
      tone: 'error',
    }))
  }))

  it.effect('preserves original turn errors at the Promise boundary', () =>
    Effect.gen(function* () {
      const { fake, layer } = projection()
      const turnError = new Error('provider exploded')
      const result = yield* Effect.promise(() => runRuntimeLifecyclePromise(
        runAgentTurnLifecycle({
          agentId: 'agent-1',
          displayText: 'hello',
          errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
          run: () => Promise.reject(turnError),
        }).pipe(Effect.provide(layer)),
      ).then(
        () => 'resolved' as const,
        (error: unknown) => error,
      ))

      expect(result).toBe(turnError)
      expect(fake.recordRuntimeTimelineEvent).toHaveBeenCalledWith(expect.objectContaining({
        detail: 'provider exploded',
      }))
    }))

  it.effect('preserves original queue errors at the Promise boundary', () =>
    Effect.gen(function* () {
      const queues = new Map<string, Promise<void>>()
      const turnError = new Error('queued provider exploded')
      const result = yield* Effect.promise(() => runRuntimeLifecyclePromise(enqueueAgentTurn(
        'agent-1',
        queues,
        () => Promise.reject(turnError),
      )).then(
        () => 'resolved' as const,
        (error: unknown) => error,
      ))

      expect(result).toBe(turnError)
      yield* enqueueAgentTurn('agent-1', queues, () => Promise.resolve())
    }))

  it('preserves original runtime turn errors at the sync boundary', () => {
    const turnError = new Error('sync provider exploded')

    expect(() => runRuntimeLifecycleSync(Effect.fail(new RuntimeLifecycleError({
      message: 'Runtime turn failed',
      cause: turnError,
    })))).toThrow(turnError)
  })

  it.effect('does not overwrite reset sessions when a stale generation completes or fails', () =>
    Effect.gen(function* () {
    const { calls, fake } = projection()
    const current = vi.fn(() => false)

    const success = yield* runAgentTurnLifecycle({
      agentId: 'agent-1',
      displayText: 'hello',
      errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
      projection: fake,
      isCurrent: current,
      run: () => Promise.resolve('ok'),
      onSuccess: () => {
        calls.push({ type: 'success', value: null })
      },
    })

    const failure = yield* Effect.exit(runAgentTurnLifecycle({
      agentId: 'agent-1',
      displayText: 'again',
      errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
      projection: fake,
      isCurrent: current,
      run: () => Promise.reject(new Error('stale failure')),
      onError: () => {
        calls.push({ type: 'cleanup', value: null })
      },
    }))

    expect(success).toBe('ok')
    expect(failure).toStrictEqual(Exit.succeed(undefined))
    expect(statuses(calls)).toEqual(['running', 'running'])
    expect(calls.some((call) => call.type === 'success' || call.type === 'cleanup')).toBe(false)
    expect(fake.recordRuntimeTimelineEvent).not.toHaveBeenCalled()
  }))

  it.effect('filters undefined runtime state values before persistence', () =>
    Effect.gen(function* () {
    const { fake } = projection()

    expect(runtimeStateWithoutUndefined({
      keep: 'yes',
      clear: undefined,
      zero: 0,
      nope: null,
    })).toEqual({
      keep: 'yes',
      zero: 0,
      nope: null,
    })

    yield* setRuntimeState('agent-1', { threadId: undefined, websocketUrl: 'ws://local' }, fake)
    expect(fake.setAgentRuntimeState).toHaveBeenCalledWith('agent-1', {
      websocketUrl: 'ws://local',
    })
  }))

  it('cycles thinking levels in contract order', () => {
    expect(nextThinkingLevel(null)).toBe('off')
    expect(nextThinkingLevel('off')).toBe('minimal')
    expect(nextThinkingLevel('xhigh')).toBe('off')
  })

  it.effect('swallows diff capture projection failures', () =>
    Effect.gen(function* () {
    const { fake } = projection()
    fake.replaceAgentDiffArtifacts = vi.fn(() => {
      throw new Error('db unavailable')
    })

    yield* captureRuntimeDiffs('agent-1', () => [{
      title: 'file.ts',
      path: 'file.ts',
      patch: 'diff --git a/file.ts b/file.ts',
    }], fake)
  }))
})

function statuses(calls: Array<{ type: string; value: unknown }>) {
  return calls.flatMap((call) => {
    if (call.type !== 'status') return []
    return (call.value as { status: AgentStatus }).status
  })
}
