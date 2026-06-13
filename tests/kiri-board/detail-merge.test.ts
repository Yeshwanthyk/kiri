import { describe, expect, it } from 'vitest'
import type { AgentCell } from '~/lib/contracts'
import { mergeAgentDetail, prependAgentDetailPages } from '~/components/kiri-board/agent-detail'

const now = '2026-05-11T12:00:00.000Z'

function agent(overrides: Partial<AgentCell> = {}): AgentCell {
  return {
    id: 'agent-1',
    projectId: 'project-1',
    slot: 'session-1',
    title: 'Agent',
    runtime: 'codex',
    interfaceMode: 'gui',
    model: 'gpt-5.5',
    status: 'idle',
    sessionDir: '/tmp/session',
    sessionFile: null,
    preview: '',
    messageCount: 0,
    contextUsage: null,
    pendingQuestion: null,
    updatedAt: now,
    isSession: true,
    messages: [],
    timelineEvents: [],
    timeline: [],
    tasks: [],
    ...overrides,
  }
}

describe('mergeAgentDetail', () => {
  it('keeps task detail when merging a fetched agent detail into a summary', () => {
    const merged = mergeAgentDetail(agent(), agent({
      timelinePage: {
        limit: 500,
        offset: 0,
        returned: 0,
        total: 0,
        hasMore: false,
      },
      tasks: [{
        id: '1',
        title: 'Wire task strip',
        status: 'inProgress',
        source: 'codex',
        updatedAt: now,
      }],
    }))

    expect(merged?.tasks).toEqual([{
      id: '1',
      title: 'Wire task strip',
      status: 'inProgress',
      source: 'codex',
      updatedAt: now,
    }])
    expect(merged?.timelinePage).toEqual({
      limit: 500,
      offset: 0,
      returned: 0,
      total: 0,
      hasMore: false,
    })
  })
})

describe('prependAgentDetailPages', () => {
  it('prepends older detail pages in chronological page order', () => {
    const latest = agent({
      messages: [
        { id: 'message-3', role: 'assistant', text: 'three', timestamp: now },
      ],
      timeline: [{
        type: 'message',
        id: 'message:message-3',
        timestamp: now,
        message: { id: 'message-3', role: 'assistant', text: 'three', timestamp: now },
      }],
      timelinePage: {
        limit: 1,
        offset: 0,
        returned: 1,
        total: 3,
        hasMore: true,
      },
    })
    const older = agent({
      messages: [
        { id: 'message-2', role: 'user', text: 'two', timestamp: now },
      ],
      timeline: [{
        type: 'message',
        id: 'message:message-2',
        timestamp: now,
        message: { id: 'message-2', role: 'user', text: 'two', timestamp: now },
      }],
      timelinePage: {
        limit: 1,
        offset: 1,
        returned: 1,
        total: 3,
        hasMore: true,
      },
    })
    const oldest = agent({
      messages: [
        { id: 'message-1', role: 'assistant', text: 'one', timestamp: now },
      ],
      timeline: [{
        type: 'message',
        id: 'message:message-1',
        timestamp: now,
        message: { id: 'message-1', role: 'assistant', text: 'one', timestamp: now },
      }],
      timelinePage: {
        limit: 1,
        offset: 2,
        returned: 1,
        total: 3,
        hasMore: false,
      },
    })

    const merged = prependAgentDetailPages(latest, [older, oldest])

    expect(merged?.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
    ])
    expect(merged?.timelinePage).toMatchObject({
      returned: 3,
      total: 3,
      hasMore: false,
    })
  })
})
