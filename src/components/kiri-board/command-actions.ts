import {
  Bot,
  Eye,
  EyeOff,
  FolderOpen,
  NotebookPen,
  Plus,
  Settings2,
  Shuffle,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import type { AgentCell, ProjectRow, RuntimeKind, WorkspaceSnapshot } from '~/lib/contracts'
import type { CommandPaletteAction } from './board-types'
import { runtimeOptions } from './runtime-options'

type BoardCommandActionsInput = {
  workspace: WorkspaceSnapshot
  selectedProject: ProjectRow | undefined
  selectedAgent: AgentCell | undefined
  openSessionLauncher: (projectId?: string, runtime?: RuntimeKind) => void
  requestDeleteSession: (agentId: string) => void
  openSettings: () => void
  openProjectManager: () => void
  hideProject: (projectId: string) => void
  unhideProject: (projectId: string) => void
  requestDeleteProject: (project: ProjectRow) => void
  selectProject: (projectId: string) => void
  selectAgent: (projectId: string, agentId: string) => void
  openTerminalResource: () => void
  openScratchpadResource: () => void
  closeCommandPalette: () => void
}

export function buildBoardCommandActions(input: BoardCommandActionsInput): CommandPaletteAction[] {
  const {
    workspace,
    selectedProject,
    selectedAgent,
    openSessionLauncher,
    requestDeleteSession,
    openSettings,
    openProjectManager,
    hideProject,
    unhideProject,
    requestDeleteProject,
    selectProject,
    selectAgent,
    openTerminalResource,
    openScratchpadResource,
    closeCommandPalette,
  } = input

  return [
    {
      id: 'start-session',
      title: 'Start session',
      detail: selectedProject?.name ?? 'Current project',
      icon: Plus,
      disabled: !selectedProject,
      run: () => openSessionLauncher(),
    },
    {
      id: 'end-session',
      title: 'End selected session',
      detail: selectedAgent?.isSession ? selectedAgent.title : 'No selected session',
      icon: Trash2,
      disabled: !selectedAgent?.isSession,
      run: () => {
        if (!selectedAgent?.isSession) return
        closeCommandPalette()
        requestDeleteSession(selectedAgent.id)
      },
    },
    {
      id: 'settings',
      title: 'Open settings',
      detail: 'Keymaps and theme',
      icon: Settings2,
      disabled: false,
      run: openSettings,
    },
    {
      id: 'terminal',
      title: 'Open terminal',
      detail: selectedProject?.cwd ?? 'Selected project cwd',
      icon: TerminalSquare,
      disabled: !selectedAgent,
      run: () => {
        closeCommandPalette()
        openTerminalResource()
      },
    },
    {
      id: 'scratchpad',
      title: 'Open scratchpad',
      detail:
        workspace.scratchpadBlocks.length > 0
          ? `${workspace.scratchpadBlocks.length} block${workspace.scratchpadBlocks.length === 1 ? '' : 's'}`
          : 'No blocks yet',
      icon: NotebookPen,
      disabled: false,
      run: () => {
        closeCommandPalette()
        openScratchpadResource()
      },
    },
    {
      id: 'add-project',
      title: 'Add project',
      detail: 'Choose or paste a directory',
      icon: FolderOpen,
      disabled: false,
      run: openProjectManager,
    },
    {
      id: 'hide-project',
      title: `Hide ${selectedProject?.name ?? 'current project'}`,
      detail: 'Keep sessions, remove from board',
      icon: EyeOff,
      disabled: !selectedProject || workspace.projects.length <= 1,
      run: () => {
        if (!selectedProject) return
        closeCommandPalette()
        hideProject(selectedProject.id)
      },
    },
    ...workspace.hiddenProjects.map((project) => ({
      id: `unhide-project-${project.id}`,
      title: `Unhide ${project.name}`,
      detail: 'Hidden project',
      icon: Eye,
      disabled: false,
      run: () => {
        closeCommandPalette()
        unhideProject(project.id)
      },
    })),
    ...workspace.projects.map((project) => ({
      id: `delete-project-${project.id}`,
      title: `Remove ${project.name}`,
      detail: 'Project',
      icon: Trash2,
      disabled: !selectedProject || workspace.projects.length <= 1,
      run: () => {
        closeCommandPalette()
        requestDeleteProject(project)
      },
    })),
    ...workspace.projects.flatMap((project) => [
      ...runtimeOptions(workspace.settings).map((option) => ({
        id: `start-${option.runtime}-${project.id}`,
        title: `Start ${option.label} in ${project.name}`,
        detail: option.meta,
        icon: Plus,
        disabled: false,
        run: () => openSessionLauncher(project.id, option.runtime),
      })),
      {
        id: `switch-project-${project.id}`,
        title: `Switch to ${project.name}`,
        detail: 'Project',
        icon: Shuffle,
        disabled: false,
        run: () => {
          selectProject(project.id)
          closeCommandPalette()
        },
      },
      ...project.agents.map((agent) => ({
        id: `switch-agent-${agent.id}`,
        title: `Switch to ${agent.title}`,
        detail: project.name,
        icon: Bot,
        disabled: false,
        run: () => {
          selectAgent(project.id, agent.id)
          closeCommandPalette()
        },
      })),
    ]),
  ]
}
