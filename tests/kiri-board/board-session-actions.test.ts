import { describe, expect, it } from 'vitest'
import type { AgentCell, ProjectRow } from '~/lib/contracts'
import { fallbackAgentAfterSessionDelete } from '~/components/kiri-board/board-session-actions'

describe('fallbackAgentAfterSessionDelete', () => {
  it('selects the previous remaining session when deleting from the middle or end', () => {
    const project = projectWithAgents(['a', 'b', 'c'])

    expect(fallbackAgentAfterSessionDelete(project, 2)?.id).toBe('b')
    expect(fallbackAgentAfterSessionDelete(project, 1)?.id).toBe('a')
  })

  it('selects the first remaining session when deleting the first session', () => {
    expect(fallbackAgentAfterSessionDelete(projectWithAgents(['b', 'c']), 0)?.id).toBe('b')
  })

  it('returns undefined when no sessions remain', () => {
    expect(fallbackAgentAfterSessionDelete(projectWithAgents([]), 0)).toBeUndefined()
  })
})

function projectWithAgents(agentIds: string[]): ProjectRow {
  return {
    id: 'project',
    name: 'Project',
    cwd: '/tmp/project',
    position: 0,
    hiddenAt: null,
    agents: agentIds.map((id) => agent(id)),
  }
}

function agent(id: string): AgentCell {
  return {
    id,
    projectId: 'project',
    slot: id,
    title: id,
    runtime: 'pi',
    interfaceMode: 'gui',
    model: 'pi-model',
    status: 'idle',
    sessionDir: '/tmp/project',
    sessionFile: null,
    preview: '',
    messageCount: 0,
    contextUsage: null,
    pendingQuestion: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    isSession: true,
    messages: [],
    timelineEvents: [],
    timeline: [],
    tasks: [],
  }
}
