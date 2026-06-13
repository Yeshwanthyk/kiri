import { describe, expect, it } from 'vitest'
import type { AgentCell, ProjectRow, WorkspaceSnapshot } from '~/lib/contracts'
import { resolveBoardSelection } from '~/components/kiri-board/board-selection'

describe('resolveBoardSelection', () => {
  it('uses the active project and remembered agent when both still exist', () => {
    const workspace = workspaceWithProjects([
      project('alpha', [agent('alpha-a', 'alpha'), agent('alpha-b', 'alpha')]),
      project('beta', [agent('beta-a', 'beta')]),
    ])

    expect(resolveBoardSelection(workspace, 'alpha', { alpha: 'alpha-b' })).toMatchObject({
      selectedProject: { id: 'alpha' },
      selectedAgent: { id: 'alpha-b' },
      selection: { projectId: 'alpha', agentId: 'alpha-b' },
    })
  })

  it('falls back to the first project and first agent for stale selections', () => {
    const workspace = workspaceWithProjects([
      project('alpha', [agent('alpha-a', 'alpha')]),
      project('beta', [agent('beta-a', 'beta')]),
    ])

    expect(resolveBoardSelection(workspace, 'missing', { alpha: 'missing-agent' })).toMatchObject({
      selectedProject: { id: 'alpha' },
      selectedAgent: { id: 'alpha-a' },
      selection: { projectId: 'alpha', agentId: 'alpha-a' },
    })
  })

  it('returns an empty selection when there are no visible projects', () => {
    expect(resolveBoardSelection(workspaceWithProjects([]), 'missing', {})).toEqual({
      selectedProject: undefined,
      selectedAgent: undefined,
      selection: { projectId: '', agentId: '' },
    })
  })
})

function workspaceWithProjects(projects: ProjectRow[]): WorkspaceSnapshot {
  return {
    settings: {
      runtimes: {
        pi: { models: ['pi-model'], defaultModel: 'pi-model' },
        codex: { models: ['codex-model'], defaultModel: 'codex-model' },
        claude: { models: ['claude-model'], defaultModel: 'claude-model' },
        opencode: { models: ['opencode-model'], defaultModel: 'opencode-model' },
      },
    },
    preferences: {
      theme: { mode: 'dark', name: 'kiri' },
      keymap: {
        projectPrev: 'k',
        projectNext: 'j',
        agentPrev: 'h',
        agentNext: 'l',
        focusChat: 'i',
        openTerminal: 't',
        openScratchpad: 's',
        startSession: 'n',
        deleteSession: 'backspace',
        toggleTerminalFocus: 'f',
      },
      chatTypography: {
        fontSize: 'comfortable',
        monoFont: 'fira',
      },
      agentByProject: {},
    },
    projects,
    hiddenProjects: [],
    archivedSessions: [],
    scratchpadBlocks: [],
    selected: { projectId: '', agentId: '' },
  }
}

function project(id: string, agents: AgentCell[]): ProjectRow {
  return {
    id,
    name: id,
    cwd: `/tmp/${id}`,
    position: 0,
    hiddenAt: null,
    agents,
  }
}

function agent(id: string, projectId: string): AgentCell {
  return {
    id,
    projectId,
    slot: id,
    title: id,
    runtime: 'pi',
    interfaceMode: 'gui',
    model: 'pi-model',
    status: 'idle',
    sessionDir: `/tmp/${projectId}`,
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
