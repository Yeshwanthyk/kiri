import { describe, expect, it } from 'vitest'
import type { ProjectRow } from '~/lib/contracts'
import {
  actionForKey,
  defaultKeymap,
  formatKey,
  moveAgent,
  moveProject,
  updateKeymap,
  type Selection,
} from '~/components/aether-board/navigation'

function project(id: string, agentIds: string[]): ProjectRow {
  return {
    id,
    name: id,
    cwd: `/repo/${id}`,
    position: 0,
    hiddenAt: null,
    agents: agentIds.map((agentId) => ({
      id: agentId,
      projectId: id,
      slot: `session-${agentId}`,
      title: agentId,
      runtime: 'codex',
      model: 'gpt-5.5',
      status: 'idle',
      sessionDir: `/tmp/${agentId}`,
      sessionFile: null,
      preview: '',
      messageCount: 0,
      diffCount: 0,
      contextUsage: null,
      pendingQuestion: null,
      updatedAt: '2026-05-11T12:00:00.000Z',
      isSession: true,
      messages: [],
      timelineEvents: [],
      timeline: [],
      diffs: [],
    })),
  }
}

describe('board navigation', () => {
  it('moves between projects while preserving the agent column when possible', () => {
    const projects = [
      project('alpha', ['a1', 'a2']),
      project('beta', ['b1', 'b2', 'b3']),
    ]
    const current: Selection = { projectId: 'alpha', agentId: 'a2' }

    expect(moveProject(projects, current, 1)).toEqual({
      projectId: 'beta',
      agentId: 'b2',
    })
  })

  it('clamps project and agent movement at list edges', () => {
    const projects = [project('alpha', ['a1']), project('beta', ['b1'])]

    expect(moveProject(projects, { projectId: 'alpha', agentId: 'a1' }, -1)).toEqual({
      projectId: 'alpha',
      agentId: 'a1',
    })
    expect(moveAgent(projects[0]!, { projectId: 'alpha', agentId: 'a1' }, -1)).toEqual({
      projectId: 'alpha',
      agentId: 'a1',
    })
  })

  it('keeps current selection when project list is empty or missing', () => {
    const current: Selection = { projectId: 'missing', agentId: 'agent' }

    expect(moveProject([], current, 1)).toEqual(current)
  })
})

describe('keymap helpers', () => {
  it('finds actions by key', () => {
    expect(actionForKey(defaultKeymap, 'k')).toBe('projectPrev')
    expect(actionForKey(defaultKeymap, '?')).toBeUndefined()
  })

  it('swaps displaced bindings when updating a key', () => {
    const updated = updateKeymap(defaultKeymap, 'projectPrev', 'j')

    expect(updated.projectPrev).toBe('j')
    expect(updated.projectNext).toBe('k')
    expect(defaultKeymap.projectPrev).toBe('k')
  })

  it('formats display labels for regular and arrow keys', () => {
    expect(formatKey('c')).toBe('C')
    expect(formatKey('arrowleft')).toBe('Arrow left')
  })
})
