import { describe, expect, it, vi } from 'vitest'
import { Cause, Effect, Exit, Option } from 'effect'
import { PiRpcProcessAdapter, PiRpcProcessError } from '../../src/server/pi-rpc'

function adapter() {
  return new PiRpcProcessAdapter({
    cwd: process.cwd(),
    sessionDir: '.kiri/pi-rpc-test',
  })
}

function failure(exit: Exit.Exit<unknown, PiRpcProcessError>) {
  if (Exit.isSuccess(exit)) throw new Error('Expected failed exit')
  return Option.getOrThrow(Cause.failureOption(exit.cause))
}

describe('PiRpcProcessAdapter', () => {
  it('fails effect commands with typed process errors before start', async () => {
    const rpc = adapter()

    const exit = await Effect.runPromiseExit(rpc.promptEffect('hello'))

    expect(failure(exit)).toMatchObject({
      _tag: 'PiRpcProcessError',
      operation: 'prompt',
    })
  })

  it('preserves public Promise rejection messages at the RPC boundary', async () => {
    const rpc = adapter()

    await expect(rpc.steer('hello')).rejects.toThrow('Pi RPC process is not started')
  })

  it('cleans prompt completion listeners when prompt submission fails', async () => {
    const rpc = adapter()

    await Effect.runPromiseExit(rpc.promptAndWaitEffect('hello'))

    expect((rpc as unknown as { events: Set<unknown> }).events.size).toBe(0)
  })

  it('rejects prompt completion waiters when the process stops after prompt submission', async () => {
    const rpc = adapter()
    const child = {
      stdin: {
        write: vi.fn((_command: string, callback: (error?: Error) => void) => {
          callback()
        }),
      },
      kill: vi.fn(),
    }
    const unsafeRpc = rpc as unknown as {
      child: unknown
      pending: Map<string, unknown>
      events: Set<unknown>
      promptCompletions: Set<unknown>
      handleLine: (child: unknown, line: string) => void
    }
    unsafeRpc.child = child

    const exitPromise = Effect.runPromiseExit(rpc.promptAndWaitEffect('hello'))
    await waitFor(() => unsafeRpc.pending.size === 1)

    unsafeRpc.handleLine(child, JSON.stringify({
      type: 'response',
      id: 'kiri-1',
      success: true,
      data: {},
    }))
    await waitFor(() => unsafeRpc.promptCompletions.size === 1)

    rpc.stop()
    const exit = await exitPromise
    const error = failure(exit)

    expect(error.cause).toBeInstanceOf(Error)
    expect(error.cause).toMatchObject({ message: 'Pi RPC process stopped' })
    expect(unsafeRpc.events.size).toBe(0)
    expect(unsafeRpc.promptCompletions.size).toBe(0)
  })
})

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for test condition')
}
