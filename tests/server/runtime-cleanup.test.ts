import { describe, expect, it } from 'vitest'
import { deleteProjectSummaryWithRuntimeCleanup } from '~/server/runtime-cleanup'

describe('runtime cleanup use-cases', () => {
  it('cleans every project session runtime only after project delete succeeds', () => {
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
      'delete:project-1',
      'forget:pi:agent-1',
      'terminal:agent-1',
      'forget:codex:agent-2',
      'terminal:agent-2',
    ])
  })

  it('does not stop runtimes when project delete validation fails', () => {
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

    expect(calls).toEqual(['list', 'delete'])
  })
})
