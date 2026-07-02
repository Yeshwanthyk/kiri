import { afterEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({
  appendUserMessage: vi.fn(),
  clearRuntimeContextUsage: vi.fn(),
  isAgentArchived: vi.fn(() => false),
  recordRuntimeContextUsage: vi.fn(),
  recordRuntimeMessage: vi.fn(),
  recordRuntimeTimelineEvent: vi.fn(),
  replaceAgentTasks: vi.fn(),
  setAgentPendingQuestion: vi.fn(),
  setAgentRuntimeState: vi.fn(),
  setAgentStatus: vi.fn(),
}))

vi.mock('~/server/db', () => dbMock)

describe('runtime projection', () => {
  afterEach(() => {
    for (const mock of Object.values(dbMock)) {
      mock.mockClear()
    }
    dbMock.isAgentArchived.mockReturnValue(false)
  })

  it('does not project archived-agent events into database writers', async () => {
    dbMock.isAgentArchived.mockReturnValue(true)
    const { projectRuntimeEventToDb } = await import('~/server/runtime-projection')

    projectRuntimeEventToDb({ type: 'status', agentId: 'agent-1', status: 'running' })
    projectRuntimeEventToDb({
      type: 'runtimeMessage',
      agentId: 'agent-1',
      id: 'message-1',
      role: 'assistant',
      text: 'Late message',
    })
    projectRuntimeEventToDb({
      type: 'timelineEvent',
      value: {
        agentId: 'agent-1',
        kind: 'tool',
        tone: 'tool',
        label: 'Ran command',
      },
    })
    projectRuntimeEventToDb({
      type: 'fileOperationCompleted',
      agentId: 'agent-1',
      toolName: 'apply_patch',
      status: 'completed',
    })

    expect(dbMock.isAgentArchived).toHaveBeenCalledWith('agent-1')
    expect(dbMock.setAgentStatus).not.toHaveBeenCalled()
    expect(dbMock.recordRuntimeMessage).not.toHaveBeenCalled()
    expect(dbMock.recordRuntimeTimelineEvent).not.toHaveBeenCalled()
  })

  it('projects active-agent events normally', async () => {
    const { projectRuntimeEventToDb } = await import('~/server/runtime-projection')

    projectRuntimeEventToDb({ type: 'status', agentId: 'agent-1', status: 'running' })
    projectRuntimeEventToDb({
      type: 'runtimeState',
      agentId: 'agent-1',
      state: { threadId: 'thread-1', dropped: undefined },
    })

    expect(dbMock.setAgentStatus).toHaveBeenCalledWith('agent-1', 'running')
    expect(dbMock.setAgentRuntimeState).toHaveBeenCalledWith('agent-1', {
      threadId: 'thread-1',
    })
  })
})
