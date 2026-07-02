import { describe, expect, it, vi } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'
import type { AgentStatus } from '../../src/lib/contracts'
import {
  enqueueAgentTurn,
  inMemoryRuntimeProjectorLayer,
  nextThinkingLevel,
  projectRuntimeEvent,
  runAgentTurnLifecycle,
  runRuntimeLifecyclePromise,
  runRuntimeLifecycleSync,
  RuntimeProjector,
  RuntimeLifecycleError,
  runtimeStateWithoutUndefined,
  setRuntimeState,
  type RuntimeLifecycleProjection,
  type RuntimeProjectionEvent,
} from '../../src/server/runtime-lifecycle'

function projection() {
  const calls: Array<{ type: string; value: unknown }> = []
  const fake: RuntimeLifecycleProjection = {
    project: vi.fn((event: RuntimeProjectionEvent) => {
      if (event.type === 'status') calls.push({ type: 'status', value: event })
      else if (event.type === 'userMessage') calls.push({ type: 'message', value: event })
      else if (event.type === 'timelineEvent') calls.push({ type: 'timeline', value: event.value })
      else if (event.type === 'runtimeState') calls.push({ type: 'state', value: event })
      else calls.push({ type: event.type, value: event })
      return Effect.void
    }),
  }
  return { calls, fake, layer: Layer.succeed(RuntimeProjector, fake) }
}

describe('runtime lifecycle', () => {
  it.effect('keeps an agent queue usable after a failed turn', () =>
    Effect.gen(function* () {
    const queues = new Map<string, Promise<void>>()
    const order: string[] = []
    const { fake } = projection()

    const first = yield* Effect.exit(enqueueAgentTurn('agent-1', queues, () => {
      order.push('first')
      return Promise.reject(new Error('boom'))
    }, fake))
    expect(Exit.isFailure(first)).toBe(true)

    yield* enqueueAgentTurn('agent-1', queues, () => {
      order.push('second')
      return Promise.resolve()
    }, fake)

    expect(order).toEqual(['first', 'second'])
  }))

  it('projects queued while waiting and running when the queued turn starts', async () => {
    const queues = new Map<string, Promise<void>>()
    const { calls, fake } = projection()
    const firstGate = deferred()
    const order: string[] = []

    const first = Effect.runPromise(enqueueAgentTurn('agent-1', queues, async () => {
      order.push('first-start')
      await firstGate.promise
      order.push('first-end')
    }, fake))
    await eventually(() => {
      expect(order).toEqual(['first-start'])
    })

    const second = Effect.runPromise(enqueueAgentTurn('agent-1', queues, () => {
      order.push('second')
      return Promise.resolve()
    }, fake))
    await Promise.resolve()
    expect(statuses(calls)).toEqual(['queued'])

    firstGate.resolve()
    await Promise.all([first, second])

    expect(order).toEqual(['first-start', 'first-end', 'second'])
    expect(statuses(calls)).toEqual(['queued', 'running'])
    expect(queues.has('agent-1')).toBe(false)
  })

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

  it.effect('has an in-memory projector layer for headless tests', () =>
    Effect.gen(function* () {
      const { projector, layer } = inMemoryRuntimeProjectorLayer()

      yield* projectRuntimeEvent({
        type: 'fileOperationStarted',
        agentId: 'agent-1',
        toolName: 'Write',
        path: 'notes.md',
      }).pipe(Effect.provide(layer))

      expect(projector.events).toEqual([{
        type: 'fileOperationStarted',
        agentId: 'agent-1',
        toolName: 'Write',
        path: 'notes.md',
      }])
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
    expect(calls.find((call) => call.type === 'timeline')?.value).toMatchObject({
      agentId: 'agent-1',
      kind: 'runtime_error',
      label: 'Runtime error',
      detail: 'failed turn',
      tone: 'error',
    })
  }))

  it.effect('preserves original turn errors at the Promise boundary', () =>
    Effect.gen(function* () {
      const { calls, layer } = projection()
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
      expect(calls.find((call) => call.type === 'timeline')?.value).toMatchObject({
        detail: 'provider exploded',
      })
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
      yield* enqueueAgentTurn('agent-1', queues, () => Promise.resolve(), projection().fake)
    }))

  it.effect('preserves non-Error failures and legacy timeline detail formatting', () =>
    Effect.gen(function* () {
      const { calls, layer } = projection()
      const objectFailure = { reason: 'plain object' }

      const promiseResult = yield* Effect.promise(() => runRuntimeLifecyclePromise(
        runAgentTurnLifecycle({
          agentId: 'agent-1',
          displayText: 'hello',
          errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
          // Deliberately pin legacy non-Error rejection behavior.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          run: () => Promise.reject('raw rejection'),
        }).pipe(Effect.provide(layer)),
      ).then(
        () => 'resolved' as const,
        (error: unknown) => error,
      ))

      const objectResult = yield* Effect.exit(runAgentTurnLifecycle({
        agentId: 'agent-2',
        displayText: 'again',
        errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
        projection: projection().fake,
        // Deliberately pin legacy non-Error rejection behavior.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        run: () => Promise.reject(objectFailure),
      }))

      expect(promiseResult).toBe('raw rejection')
      expect(Exit.isFailure(objectResult)).toBe(true)
      expect(calls.find((call) => call.type === 'timeline')?.value).toMatchObject({
        detail: 'raw rejection',
      })
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
    expect(fake.project).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'timelineEvent',
    }))
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
    expect(fake.project).toHaveBeenCalledWith({
      type: 'runtimeState',
      agentId: 'agent-1',
      state: {
      websocketUrl: 'ws://local',
      },
    })
  }))

  it.effect('projects file operation events through the projector boundary', () =>
    Effect.gen(function* () {
      const { calls, fake } = projection()

      yield* projectRuntimeEvent({
        type: 'fileOperationStarted',
        agentId: 'agent-1',
        toolName: 'Edit',
        path: 'src/file.ts',
        summary: 'Editing src/file.ts',
      }, fake)
      yield* projectRuntimeEvent({
        type: 'fileOperationCompleted',
        agentId: 'agent-1',
        toolName: 'Edit',
        status: 'completed',
        path: 'src/file.ts',
      }, fake)

      expect(calls.map((call) => call.type)).toEqual([
        'fileOperationStarted',
        'fileOperationCompleted',
      ])
    }))

  it('cycles thinking levels in contract order', () => {
    expect(nextThinkingLevel(null)).toBe('off')
    expect(nextThinkingLevel('off')).toBe('minimal')
    expect(nextThinkingLevel('xhigh')).toBe('off')
  })

})

function statuses(calls: Array<{ type: string; value: unknown }>) {
  return calls.flatMap((call) => {
    if (call.type !== 'status') return []
    return (call.value as { status: AgentStatus }).status
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function eventually(assertion: () => void) {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('Expectation did not pass')
}
