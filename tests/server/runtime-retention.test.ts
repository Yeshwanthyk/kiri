import { describe, expect, it } from 'vitest'
import {
  __unsafeClearCodexRuntimeStateForTest,
  __unsafeRetainCodexRuntimeStateForTest,
  codexRuntimeRetainedStateStats,
  forgetCodexRuntimeAgent,
} from '~/server/codex-runtime'
import { forgetPiRuntimeAgent, piRuntimeRetainedStateStats } from '~/server/pi-runtime'

describe('runtime retained state', () => {
  it('clears Codex per-agent maps on close/delete cleanup', () => {
    __unsafeClearCodexRuntimeStateForTest()
    __unsafeRetainCodexRuntimeStateForTest({
      agentId: 'agent-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
    })

    expect(codexRuntimeRetainedStateStats()).toMatchObject({
      threadAgents: 1,
      agentThreads: 1,
      threadTurns: 1,
    })

    forgetCodexRuntimeAgent('agent-1')

    expect(codexRuntimeRetainedStateStats()).toMatchObject({
      threadAgents: 0,
      agentThreads: 0,
      threadTurns: 0,
      queues: 0,
      sessionGenerations: 0,
    })
  })

  it('exposes Pi cleanup as an idempotent retained-state operation', () => {
    forgetPiRuntimeAgent('missing-agent')
    expect(piRuntimeRetainedStateStats()).toMatchObject({
      adapters: 0,
      adapterKeys: 0,
      queues: 0,
    })
  })
})
