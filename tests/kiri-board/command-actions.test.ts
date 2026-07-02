import { describe, expect, it, vi } from 'vitest'
import type { AgentCell, ProjectRow, SessionInterfaceMode, WorkspaceSnapshot } from '~/lib/contracts'
import { buildBoardCommandActions } from '~/components/kiri-board/command-actions'

describe('buildBoardCommandActions', () => {
  it('builds project, session, hidden project, and runtime actions', () => {
    const workspace = workspaceWithProjects(
      [
        project('alpha', [agent('agent-a', 'alpha')]),
        project('beta', []),
      ],
      [project('hidden', [])],
    )

    const actions = buildBoardCommandActions({
      workspace,
      selectedProject: workspace.projects[0],
      selectedAgent: workspace.projects[0].agents[0],
      ...callbacks(),
    })

    expect(actions.map((action) => action.id)).toEqual([
      'start-session',
      'end-session',
      'settings',
      'terminal',
      'browser',
      'scratchpad',
      'add-project',
      'hide-project',
      'unhide-project-hidden',
      'delete-project-alpha',
      'delete-project-beta',
      'start-codex-alpha',
      'start-pi-alpha',
      'start-claude-alpha',
      'start-opencode-alpha',
      'switch-project-alpha',
      'switch-agent-agent-a',
      'start-codex-beta',
      'start-pi-beta',
      'start-claude-beta',
      'start-opencode-beta',
      'switch-project-beta',
    ])
    expect(actions.find((action) => action.id === 'scratchpad')?.detail).toBe('1 block')
    expect(actions.find((action) => action.id === 'hide-project')?.disabled).toBe(false)
  })

  it('disables actions that need a visible selected project or session', () => {
    const workspace = workspaceWithProjects([])
    const actions = buildBoardCommandActions({
      workspace,
      selectedProject: undefined,
      selectedAgent: undefined,
      ...callbacks(),
    })

    expect(actions.find((action) => action.id === 'start-session')?.disabled).toBe(true)
    expect(actions.find((action) => action.id === 'end-session')?.disabled).toBe(true)
    expect(actions.find((action) => action.id === 'terminal')?.disabled).toBe(true)
    expect(actions.find((action) => action.id === 'browser')?.disabled).toBe(true)
    expect(actions.find((action) => action.id === 'hide-project')?.disabled).toBe(true)
  })

  it('runs command callbacks with the selected project and agent ids', () => {
    const workspace = workspaceWithProjects([project('alpha', [agent('agent-a', 'alpha')])])
    const fns = callbacks()
    const actions = buildBoardCommandActions({
      workspace,
      selectedProject: workspace.projects[0],
      selectedAgent: workspace.projects[0].agents[0],
      ...fns,
    })

    actions.find((action) => action.id === 'end-session')?.run()
    actions.find((action) => action.id === 'start-codex-alpha')?.run()
    actions.find((action) => action.id === 'switch-agent-agent-a')?.run()

    expect(fns.closeCommandPalette).toHaveBeenCalledTimes(2)
    expect(fns.requestDeleteSession).toHaveBeenCalledWith('agent-a')
    expect(fns.openSessionLauncher).toHaveBeenCalledWith('alpha', 'codex')
    expect(fns.selectAgent).toHaveBeenCalledWith('alpha', 'agent-a')
  })
})

function callbacks() {
  return {
    openSessionLauncher: vi.fn(),
    requestDeleteSession: vi.fn(),
    openSettings: vi.fn(),
    openProjectManager: vi.fn(),
    hideProject: vi.fn(),
    unhideProject: vi.fn(),
    requestDeleteProject: vi.fn(),
    selectProject: vi.fn(),
    selectAgent: vi.fn(),
    openTerminalResource: vi.fn(),
    openBrowserResource: vi.fn(),
    browserAvailable: true,
    openScratchpadResource: vi.fn(),
    setTab: vi.fn(),
    closeCommandPalette: vi.fn(),
  }
}

function workspaceWithProjects(
  projects: ProjectRow[],
  hiddenProjects: ProjectRow[] = [],
): WorkspaceSnapshot {
  return {
    settings: {
      runtimes: {
        pi: runtimeSettings('pi-model'),
        codex: runtimeSettings('codex-model'),
        claude: runtimeSettings('claude-model'),
        opencode: runtimeSettings('opencode-model'),
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
        openBrowser: 'b',
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
      lastSelectedProjectId: null,
    },
    projects,
    hiddenProjects,
    archivedSessions: [],
    scratchpadBlocks: [{
      id: 'scratch-1',
      projectId: null,
      projectName: null,
      body: 'Draft',
      createdAt: '2026-01-01T00:00:00.000Z',
      triggeredAt: null,
      triggeredAgentId: null,
    }],
    selected: { projectId: '', agentId: '' },
  }
}

function runtimeSettings(model: string) {
  const interfaceModes: SessionInterfaceMode[] = ['gui', 'terminal']
  return { models: [model], defaultModel: model, interfaceModes }
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
