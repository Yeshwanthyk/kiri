import { describe, expect, it } from 'vitest'
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
})
