import { describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '../../src/lib/contracts'
import type { RuntimeDiffArtifact } from '../../src/server/git-diff'
import {
  captureRuntimeDiffs,
  enqueueAgentTurn,
  nextThinkingLevel,
  runAgentTurnLifecycle,
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
  return { calls, fake }
}

describe('runtime lifecycle', () => {
  it('keeps an agent queue usable after a failed turn', async () => {
    const queues = new Map<string, Promise<void>>()
    const order: string[] = []

    await expect(enqueueAgentTurn('agent-1', queues, () => {
      order.push('first')
      return Promise.reject(new Error('boom'))
    })).rejects.toThrow('boom')

    await enqueueAgentTurn('agent-1', queues, () => {
      order.push('second')
      return Promise.resolve()
    })

    expect(order).toEqual(['first', 'second'])
  })

  it('marks running then idle for successful current turns', async () => {
    const { calls, fake } = projection()

    await expect(runAgentTurnLifecycle({
      agentId: 'agent-1',
      displayText: 'hello',
      errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
      projection: fake,
      run: () => Promise.resolve('ok'),
      onSuccess: (result) => {
        calls.push({ type: 'success', value: result })
      },
    })).resolves.toBe('ok')

    expect(statuses(calls)).toEqual(['running', 'idle'])
    expect(calls.map((call) => call.type)).toEqual(['status', 'message', 'success', 'status'])
  })

  it('marks running then failed and records timeline errors on current turn failure', async () => {
    const { calls, fake } = projection()

    await expect(runAgentTurnLifecycle({
      agentId: 'agent-1',
      displayText: 'hello',
      errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
      projection: fake,
      run: () => Promise.reject(new Error('failed turn')),
      onError: (error) => {
        calls.push({ type: 'cleanup', value: error })
      },
    })).rejects.toThrow('failed turn')

    expect(statuses(calls)).toEqual(['running', 'failed'])
    expect(fake.recordRuntimeTimelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      kind: 'runtime_error',
      label: 'Runtime error',
      detail: 'failed turn',
      tone: 'error',
    }))
  })

  it('does not overwrite reset sessions when a stale generation completes or fails', async () => {
    const { calls, fake } = projection()
    const current = vi.fn(() => false)

    await expect(runAgentTurnLifecycle({
      agentId: 'agent-1',
      displayText: 'hello',
      errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
      projection: fake,
      isCurrent: current,
      run: () => Promise.resolve('ok'),
      onSuccess: () => {
        calls.push({ type: 'success', value: null })
      },
    })).resolves.toBe('ok')

    await expect(runAgentTurnLifecycle({
      agentId: 'agent-1',
      displayText: 'again',
      errorEvent: { kind: 'runtime_error', label: 'Runtime error' },
      projection: fake,
      isCurrent: current,
      run: () => Promise.reject(new Error('stale failure')),
      onError: () => {
        calls.push({ type: 'cleanup', value: null })
      },
    })).resolves.toBeUndefined()

    expect(statuses(calls)).toEqual(['running', 'running'])
    expect(calls.some((call) => call.type === 'success' || call.type === 'cleanup')).toBe(false)
    expect(fake.recordRuntimeTimelineEvent).not.toHaveBeenCalled()
  })

  it('filters undefined runtime state values before persistence', () => {
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

    setRuntimeState('agent-1', { threadId: undefined, websocketUrl: 'ws://local' }, fake)
    expect(fake.setAgentRuntimeState).toHaveBeenCalledWith('agent-1', {
      websocketUrl: 'ws://local',
    })
  })

  it('cycles thinking levels in contract order', () => {
    expect(nextThinkingLevel(null)).toBe('off')
    expect(nextThinkingLevel('off')).toBe('minimal')
    expect(nextThinkingLevel('xhigh')).toBe('off')
  })

  it('swallows diff capture projection failures', () => {
    const { fake } = projection()
    fake.replaceAgentDiffArtifacts = vi.fn(() => {
      throw new Error('db unavailable')
    })

    expect(() => captureRuntimeDiffs('agent-1', () => [{
      title: 'file.ts',
      path: 'file.ts',
      patch: 'diff --git a/file.ts b/file.ts',
    }], fake)).not.toThrow()
  })
})

function statuses(calls: Array<{ type: string; value: unknown }>) {
  return calls.flatMap((call) => {
    if (call.type !== 'status') return []
    return (call.value as { status: AgentStatus }).status
  })
}
