import { describe, expect, it } from 'vitest'
import type { AgentCell } from '~/lib/contracts'
import { mergeAgentDetail } from '~/components/AetherBoard'

const now = '2026-05-11T12:00:00.000Z'

function agent(overrides: Partial<AgentCell> = {}): AgentCell {
  return {
    id: 'agent-1',
    projectId: 'project-1',
    slot: 'session-1',
    title: 'Agent',
    runtime: 'codex',
    model: 'gpt-5.5',
    status: 'idle',
    sessionDir: '/tmp/session',
    sessionFile: null,
    preview: '',
    messageCount: 0,
    diffCount: 0,
    contextUsage: null,
    pendingQuestion: null,
    updatedAt: now,
    isSession: true,
    messages: [],
    timelineEvents: [],
    timeline: [],
    diffs: [],
    tasks: [],
    ...overrides,
  }
}

describe('mergeAgentDetail', () => {
  it('keeps task detail when merging a fetched agent detail into a summary', () => {
    const merged = mergeAgentDetail(agent(), agent({
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
  })
})
