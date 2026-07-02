import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSnapshot } from '~/lib/contracts'
import { defaultUiPreferences } from '~/lib/ui-preferences'
import {
  deleteProjectSummaryWithRuntimeCleanup,
  deleteSessionWithRuntimeCleanup,
  deleteSessionSummaryWithRuntimeCleanup,
} from '~/server/runtime-cleanup'

const emptyWorkspaceSnapshot: WorkspaceSnapshot = {
  settings: {
    runtimes: {
      pi: { models: ['sonnet'], defaultModel: 'sonnet' },
      codex: { models: ['gpt-5.3-codex'], defaultModel: 'gpt-5.3-codex' },
      claude: { models: ['sonnet'], defaultModel: 'sonnet' },
      opencode: { models: ['opencode/gpt-5.5'], defaultModel: 'opencode/gpt-5.5' },
    },
  },
  preferences: defaultUiPreferences,
  projects: [],
  hiddenProjects: [],
  archivedSessions: [],
  scratchpadBlocks: [],
  selected: { projectId: '', agentId: '' },
}

describe('runtime cleanup use-cases', () => {
  it('cleans every project session runtime before deleting the project', () => {
    const calls: string[] = []

    const result = deleteProjectSummaryWithRuntimeCleanup('project-1', {
      listSessions: (projectId) => {
        calls.push(`list:${projectId}`)
        return [
          { id: 'agent-1', runtime: 'pi' },
          { id: 'agent-2', runtime: 'codex' },
        ]
      },
      deleteProject: (projectId) => {
        calls.push(`delete:${projectId}`)
        return {
          id: projectId,
          name: 'Project',
          cwd: '/tmp/project',
          hidden: false,
          sessionCount: 2,
        }
      },
      forgetRuntime: (runtime, agentId) => {
        calls.push(`forget:${runtime}:${agentId}`)
      },
      closeTerminal: (agentId) => {
        calls.push(`terminal:${agentId}`)
      },
    })

    expect(result).toMatchObject({ id: 'project-1', name: 'Project' })
    expect(calls).toEqual([
      'list:project-1',
      'forget:pi:agent-1',
      'terminal:agent-1',
      'forget:codex:agent-2',
      'terminal:agent-2',
      'delete:project-1',
    ])
  })

  it('closes project-scoped shell terminals before deleting the project', () => {
    const calls: string[] = []

    deleteProjectSummaryWithRuntimeCleanup('project-1', {
      listSessions: (projectId) => {
        calls.push(`list:${projectId}`)
        return []
      },
      deleteProject: (projectId) => {
        calls.push(`delete:${projectId}`)
        return {
          id: projectId,
          name: 'Project',
          cwd: '/tmp/project',
          hidden: false,
          sessionCount: 0,
        }
      },
      forgetRuntime: (runtime, agentId) => {
        calls.push(`forget:${runtime}:${agentId}`)
      },
      closeTerminal: (agentId) => {
        calls.push(`terminal:${agentId}`)
      },
      closeProjectTerminals: (projectId) => {
        calls.push(`project-terminal:${projectId}`)
      },
    })

    expect(calls).toEqual([
      'list:project-1',
      'project-terminal:project-1',
      'delete:project-1',
    ])
  })

  it('cleans live runtimes before surfacing project delete validation failures', () => {
    const calls: string[] = []

    expect(() =>
      deleteProjectSummaryWithRuntimeCleanup('project-1', {
        listSessions: () => {
          calls.push('list')
          return [{ id: 'agent-1', runtime: 'pi' }]
        },
        deleteProject: () => {
          calls.push('delete')
          throw new Error('Cannot delete the last project')
        },
        forgetRuntime: (runtime, agentId) => {
          calls.push(`forget:${runtime}:${agentId}`)
        },
        closeTerminal: (agentId) => {
          calls.push(`terminal:${agentId}`)
        },
      }),
    ).toThrow('Cannot delete the last project')

    expect(calls).toEqual(['list', 'forget:pi:agent-1', 'terminal:agent-1', 'delete'])
  })

  it('attempts every project runtime and shell cleanup before logging cleanup failures', () => {
    const calls: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const result = deleteProjectSummaryWithRuntimeCleanup('project-1', {
        listSessions: () => [
          { id: 'agent-1', runtime: 'pi' },
          { id: 'agent-2', runtime: 'codex' },
        ],
        deleteProject: (projectId) => {
          calls.push(`delete:${projectId}`)
          return {
            id: projectId,
            name: 'Project',
            cwd: '/tmp/project',
            hidden: false,
            sessionCount: 2,
          }
        },
        forgetRuntime: (runtime, agentId) => {
          calls.push(`forget:${runtime}:${agentId}`)
          if (agentId === 'agent-1') throw new Error('Runtime cleanup failed')
        },
        closeTerminal: (agentId) => {
          calls.push(`terminal:${agentId}`)
        },
        closeProjectTerminals: (projectId) => {
          calls.push(`project-terminal:${projectId}`)
        },
      })

      expect(result.id).toBe('project-1')
      expect(calls).toEqual([
        'forget:pi:agent-1',
        'terminal:agent-1',
        'forget:codex:agent-2',
        'terminal:agent-2',
        'project-terminal:project-1',
        'delete:project-1',
      ])
      expect(consoleError).toHaveBeenCalledTimes(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('cleans a session runtime only after session delete succeeds', () => {
    const calls: string[] = []

    const result = deleteSessionSummaryWithRuntimeCleanup({ agentId: 'agent-1' }, {
      findSession: (agentId) => {
        calls.push(`find:${agentId}`)
        return { id: agentId, runtime: 'codex' }
      },
      deleteSession: (input) => {
        calls.push(`delete:${input.agentId}`)
        return {
          id: input.agentId,
          projectId: 'project-1',
          projectName: 'Project',
          title: 'Session',
          runtime: 'codex',
          interfaceMode: 'gui',
          model: 'gpt-5.3-codex',
          status: 'idle',
          preview: '',
          messageCount: 0,
          updatedAt: '2026-01-01T00:00:00.000Z',
          archivedAt: '2026-01-01T00:00:01.000Z',
        }
      },
      forgetRuntime: (runtime, agentId) => {
        calls.push(`forget:${runtime}:${agentId}`)
      },
      closeTerminal: (agentId) => {
        calls.push(`terminal:${agentId}`)
      },
    })

    expect(result.id).toBe('agent-1')
    expect(result.archivedAt).toBe('2026-01-01T00:00:01.000Z')
    expect(calls).toEqual([
      'find:agent-1',
      'delete:agent-1',
      'forget:codex:agent-1',
      'terminal:agent-1',
    ])
  })

  it('returns workspace delete results from the workspace session cleanup helper', () => {
    const calls: string[] = []

    const result = deleteSessionWithRuntimeCleanup({ agentId: 'agent-1' }, {
      findSession: (agentId) => {
        calls.push(`find:${agentId}`)
        return { id: agentId, runtime: 'pi' }
      },
      deleteSession: (input) => {
        calls.push(`delete:${input.agentId}`)
        return emptyWorkspaceSnapshot
      },
      forgetRuntime: (runtime, agentId) => {
        calls.push(`forget:${runtime}:${agentId}`)
      },
      closeTerminal: (agentId) => {
        calls.push(`terminal:${agentId}`)
      },
    })

    expect(result).toBe(emptyWorkspaceSnapshot)
    expect(calls).toEqual([
      'find:agent-1',
      'delete:agent-1',
      'forget:pi:agent-1',
      'terminal:agent-1',
    ])
  })

  it('surfaces cleanup failures after session delete has succeeded', () => {
    const calls: string[] = []

    expect(() =>
      deleteSessionSummaryWithRuntimeCleanup({ agentId: 'agent-1' }, {
        findSession: (agentId) => {
          calls.push(`find:${agentId}`)
          return { id: agentId, runtime: 'codex' }
        },
        deleteSession: (input) => {
          calls.push(`delete:${input.agentId}`)
          return {
            id: input.agentId,
            projectId: 'project-1',
            projectName: 'Project',
            title: 'Session',
            runtime: 'codex',
            interfaceMode: 'gui',
            model: 'gpt-5.3-codex',
            status: 'idle',
            preview: '',
            messageCount: 0,
            updatedAt: '2026-01-01T00:00:00.000Z',
            archivedAt: '2026-01-01T00:00:01.000Z',
          }
        },
        forgetRuntime: (runtime, agentId) => {
          calls.push(`forget:${runtime}:${agentId}`)
          throw new Error('Runtime cleanup failed')
        },
        closeTerminal: (agentId) => {
          calls.push(`terminal:${agentId}`)
        },
      }),
    ).toThrow('Runtime cleanup failed')

    expect(calls).toEqual([
      'find:agent-1',
      'delete:agent-1',
      'forget:codex:agent-1',
      'terminal:agent-1',
    ])
  })

  it('does not stop a session runtime when session delete fails', () => {
    const calls: string[] = []

    expect(() =>
      deleteSessionSummaryWithRuntimeCleanup({ agentId: 'agent-1' }, {
        findSession: (agentId) => {
          calls.push(`find:${agentId}`)
          return { id: agentId, runtime: 'pi' }
        },
        deleteSession: (input) => {
          calls.push(`delete:${input.agentId}`)
          throw new Error('Archive failed')
        },
        forgetRuntime: (runtime, agentId) => {
          calls.push(`forget:${runtime}:${agentId}`)
        },
        closeTerminal: (agentId) => {
          calls.push(`terminal:${agentId}`)
        },
      }),
    ).toThrow('Archive failed')

    expect(calls).toEqual(['find:agent-1', 'delete:agent-1'])
  })

  it('does not stop a runtime when the session cannot be found', () => {
    const calls: string[] = []

    expect(() =>
      deleteSessionSummaryWithRuntimeCleanup({ agentId: 'agent-1' }, {
        findSession: (agentId) => {
          calls.push(`find:${agentId}`)
          return undefined
        },
        deleteSession: (input) => {
          calls.push(`delete:${input.agentId}`)
          return {
            id: input.agentId,
            projectId: 'project-1',
            projectName: 'Project',
            title: 'Session',
            runtime: 'pi',
            interfaceMode: 'gui',
            model: 'sonnet',
            status: 'idle',
            preview: '',
            messageCount: 0,
            updatedAt: '2026-01-01T00:00:00.000Z',
            archivedAt: '2026-01-01T00:00:01.000Z',
          }
        },
        forgetRuntime: (runtime, agentId) => {
          calls.push(`forget:${runtime}:${agentId}`)
        },
        closeTerminal: (agentId) => {
          calls.push(`terminal:${agentId}`)
        },
      }),
    ).toThrow('Session not found: agent-1')

    expect(calls).toEqual(['find:agent-1'])
  })
})
