import { describe, expect, it } from 'vitest'
import type { ProjectRow } from '~/lib/contracts'
import {
  actionForKey,
  defaultKeymap,
  formatKey,
  moveAgent,
  moveProject,
  updateKeymap,
} from '~/components/kiri-board/navigation'

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
      tasks: [],
    })),
  }
}

describe('board navigation', () => {
  it('moves between projects by id', () => {
    const projects = [
      project('alpha', ['a1', 'a2']),
      project('beta', ['b1', 'b2', 'b3']),
    ]

    expect(moveProject(projects, 'alpha', 1)).toBe('beta')
    expect(moveProject(projects, 'beta', -1)).toBe('alpha')
  })

  it('clamps project and agent movement at list edges', () => {
    const projects = [project('alpha', ['a1']), project('beta', ['b1'])]

    expect(moveProject(projects, 'alpha', -1)).toBe('alpha')
    expect(moveAgent(projects[0]!, 'a1', -1)).toBe('a1')
  })

  it('keeps current project when project list is empty', () => {
    expect(moveProject([], 'missing', 1)).toBe('missing')
  })

  it('returns null when moving agents in an empty project', () => {
    const empty = project('empty', [])
    expect(moveAgent(empty, '', 1)).toBeNull()
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
