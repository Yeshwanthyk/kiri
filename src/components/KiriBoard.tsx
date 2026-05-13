'use client'

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
import * as React from 'react'
import { useServerFn } from '@tanstack/react-start'
import type {
  AgentCell,
  ArchivedSessionSummary,
  ProjectRow,
  ReviewTarget,
  RuntimeKind,
  ScratchpadBlock,
  SendMessageImage,
  ThinkingLevel,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import { getKiriHostBridge, pickProjectDirectory } from '~/lib/host-capabilities'
import {
  applyKiriTheme,
  defaultThemeSelection,
  type ThemeSelection,
} from '~/theme/kiri-themes'
import {
  addProjectMutation,
  addScratchpadBlockMutation,
  answerQuestionMutation,
  chooseProjectDirectoryMutation,
  deleteProjectMutation,
  deleteScratchpadBlockMutation,
  deleteSessionMutation,
  agentDetailQueryOptions,
  fetchWorkspaceSnapshot,
  forkSessionMutation,
  hideProjectMutation,
  interruptMessageMutation,
  renameSessionMutation,
  reorderProjectsMutation,
  resetSessionMutation,
  restoreSessionMutation,
  reviewSessionMutation,
  sendMessageMutation,
  setThinkingLevelMutation,
  startSessionMutation,
  steerMessageMutation,
  terminalConfigQuery,
  triggerScratchpadBlockMutation,
  unhideProjectMutation,
} from '~/server/workspace'
import { errorMessage } from './kiri-board/format'
import {
  actionForKey,
  defaultKeymap,
  formatKey,
  keymapGroups,
  keyOptions,
  moveAgent,
  moveProject,
  updateKeymap,
  type KeymapAction,
  type KeymapSettings,
  type Selection,
} from './kiri-board/navigation'
import {
  applyChatTypography,
  defaultChatTypography,
  readStoredChatTypography,
  readStoredKeymap,
  readStoredThemeSelection,
  saveChatTypography,
  saveKeymap,
  saveThemeSelection,
  type ChatTypographySettings,
} from './kiri-board/storage'

export { mergeAgentDetail } from './kiri-board/agent-detail'
import { AgentSwitcherSheet, MobileTopBar } from './kiri-board/board-navigation'
import {
  CommandPalette,
  ConfirmDialog,
  InlineSessionLauncher,
  ProjectManagerDialog,
  SettingsScreen,
} from './kiri-board/dialogs'
import { ProjectLane } from './kiri-board/project-lane'
import { SelectedAgentPane } from './kiri-board/selected-agent-pane'
import {
  isEditableTarget,
  runtimeCopy,
  settingsRuntimeDetail,
  sessionRuntimeOrder,
  type CommandPaletteAction,
  type RefreshAgentDetail,
  type SidebarTab,
} from './kiri-board/board-types'

export function KiriBoard({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [workspace, setWorkspace] = React.useState(snapshot)
  const [selection, setSelection] = React.useState<Selection>(snapshot.selected)
  const [tab, setTab] = React.useState<SidebarTab>('chat')
  const [hydrated, setHydrated] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [projectManagerOpen, setProjectManagerOpen] = React.useState(false)
  const [sessionLauncherOpen, setSessionLauncherOpen] = React.useState(false)
  const [sessionLauncherPreset, setSessionLauncherPreset] = React.useState<{
    projectId: string
    runtime?: RuntimeKind
  } | null>(null)
  const [agentSwitcherOpen, setAgentSwitcherOpen] = React.useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false)
  const [pendingDelete, setPendingDelete] = React.useState<{ agentId: string; title: string } | null>(null)
  const [deleteInFlight, setDeleteInFlight] = React.useState(false)
  const [pendingProjectDelete, setPendingProjectDelete] = React.useState<ProjectRow | null>(null)
  const [projectDeleteInFlight, setProjectDeleteInFlight] = React.useState(false)
  const [keymap, setKeymap] = React.useState<KeymapSettings>(defaultKeymap)
  const [themeSelection, setThemeSelection] = React.useState<ThemeSelection>(defaultThemeSelection)
  const [chatTypography, setChatTypography] = React.useState<ChatTypographySettings>(defaultChatTypography)
  const [chatFocusRequest, setChatFocusRequest] = React.useState(0)
  const addProject = useServerFn(addProjectMutation)
  const addScratchpadBlock = useServerFn(addScratchpadBlockMutation)
  const answerQuestion = useServerFn(answerQuestionMutation)
  const chooseProjectDirectory = useServerFn(chooseProjectDirectoryMutation)
  const deleteProject = useServerFn(deleteProjectMutation)
  const deleteScratchpadBlock = useServerFn(deleteScratchpadBlockMutation)
  const deleteSession = useServerFn(deleteSessionMutation)
  const forkSession = useServerFn(forkSessionMutation)
  const hideProject = useServerFn(hideProjectMutation)
  const refreshWorkspace = useServerFn(fetchWorkspaceSnapshot)
  const resetSession = useServerFn(resetSessionMutation)
  const restoreSession = useServerFn(restoreSessionMutation)
  const reviewSession = useServerFn(reviewSessionMutation)
  const sendMessage = useServerFn(sendMessageMutation)
  const setThinkingLevel = useServerFn(setThinkingLevelMutation)
  const steerMessage = useServerFn(steerMessageMutation)
  const interruptMessage = useServerFn(interruptMessageMutation)
  const renameSession = useServerFn(renameSessionMutation)
  const reorderProjects = useServerFn(reorderProjectsMutation)
  const startSession = useServerFn(startSessionMutation)
  const triggerScratchpadBlock = useServerFn(triggerScratchpadBlockMutation)
  const unhideProject = useServerFn(unhideProjectMutation)

  const selectedProject =
    workspace.projects.find((project) => project.id === selection.projectId) ??
    workspace.projects[0]
  const selectedAgent =
    selectedProject?.agents.find((agent) => agent.id === selection.agentId) ??
    selectedProject?.agents[0]

  React.useEffect(() => {
    setWorkspace(snapshot)
  }, [snapshot])

  React.useEffect(() => {
    if (!selectedProject) return
    const agentId = selectedAgent?.id ?? ''
    if (selectedProject.id !== selection.projectId || agentId !== selection.agentId) {
      setSelection({ projectId: selectedProject.id, agentId })
    }
  }, [selectedAgent, selectedProject, selection.agentId, selection.projectId])

  React.useEffect(() => {
    setHydrated(true)
    setKeymap(readStoredKeymap())
    setThemeSelection(readStoredThemeSelection())
    setChatTypography(readStoredChatTypography())
  }, [])

  React.useEffect(() => {
    applyKiriTheme(document.documentElement, themeSelection)
  }, [themeSelection])

  React.useEffect(() => {
    applyChatTypography(document.documentElement, chatTypography)
  }, [chatTypography])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === 'k') {
        event.preventDefault()
        setSettingsOpen(false)
        setSessionLauncherOpen(false)
        setAgentSwitcherOpen(false)
        setCommandPaletteOpen((open) => !open)
        return
      }

      if (
        event.key === 'Escape' &&
        (commandPaletteOpen || agentSwitcherOpen || projectManagerOpen)
      ) {
        event.preventDefault()
        setCommandPaletteOpen(false)
        setAgentSwitcherOpen(false)
        setProjectManagerOpen(false)
        return
      }

      if (commandPaletteOpen || agentSwitcherOpen || !event.shiftKey || isEditableTarget(event.target)) return

      const action = actionForKey(keymap, key)
      if (!action) return
      event.preventDefault()

      if (action === 'focusChat') {
        setSettingsOpen(false)
        setSessionLauncherOpen(false)
        setAgentSwitcherOpen(false)
        setCommandPaletteOpen(false)
        setTab('chat')
        setChatFocusRequest((request) => request + 1)
        return
      }

      if (action === 'openDiffs') {
        setTab('diffs')
        return
      }

      if (action === 'openTerminal') {
        setTab('terminal')
        return
      }

      if (action === 'openScratchpad') {
        setTab('scratchpad')
        return
      }

      if (action === 'startSession') {
        if (!selectedProject) {
          setSettingsOpen(false)
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
          setProjectManagerOpen(true)
          return
        }
        openSessionLauncher()
        return
      }

      if (action === 'deleteSession') {
        const project =
          workspace.projects.find((row) => row.id === selection.projectId) ??
          workspace.projects[0]
        const agent = project?.agents.find((row) => row.id === selection.agentId)
        if (agent?.isSession) {
          void handleDeleteSession(agent.id)
        }
        return
      }

      if (action === 'projectPrev' || action === 'projectNext') {
        setChatFocusRequest(0)
        setSelection((current) =>
          moveProject(workspace.projects, current, action === 'projectNext' ? 1 : -1),
        )
        return
      }

      setChatFocusRequest(0)
      setSelection((current) => {
        const project =
          workspace.projects.find((row) => row.id === current.projectId) ??
          workspace.projects[0]
        if (!project) return current
        return moveAgent(project, current, action === 'agentNext' ? 1 : -1)
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    agentSwitcherOpen,
    commandPaletteOpen,
    projectManagerOpen,
    keymap,
    selectedProject,
    selection.agentId,
    selection.projectId,
    workspace.projects,
  ])

  async function handleAddProject(input: { id?: string; name: string; cwd: string }) {
    const next = await addProject({ data: input })
    setWorkspace(next)
    const project = next.projects.find((item) => item.cwd === input.cwd) ?? next.projects.at(-1)
    if (project) setSelection({ projectId: project.id, agentId: project.agents[0]?.id ?? '' })
  }

  async function handleDeleteProject(projectId: string) {
    const next = await deleteProject({ data: { id: projectId } })
    setWorkspace(next)
    if (selection.projectId === projectId) setSelection(next.selected)
  }

  async function confirmDeleteProject(projectId: string) {
    setProjectDeleteInFlight(true)
    try {
      await handleDeleteProject(projectId)
      setPendingProjectDelete(null)
    } finally {
      setProjectDeleteInFlight(false)
    }
  }

  async function handleHideProject(projectId: string) {
    const next = await hideProject({ data: { id: projectId } })
    setWorkspace(next)
    if (selection.projectId === projectId) setSelection(next.selected)
  }

  async function handleUnhideProject(projectId: string) {
    const next = await unhideProject({ data: { id: projectId } })
    setWorkspace(next)
    const project = next.projects.find((item) => item.id === projectId)
    if (project) setSelection({ projectId: project.id, agentId: project.agents[0]?.id ?? '' })
  }

  async function handleReorderProjects(projectIds: string[]) {
    const next = await reorderProjects({ data: { ids: projectIds } })
    setWorkspace(next)
  }

  async function handleChooseProjectDirectory() {
    return pickProjectDirectory(() => chooseProjectDirectory())
  }

  async function handleRenameSession(agentId: string, title: string) {
    const next = await renameSession({ data: { agentId, title } })
    setWorkspace(next)
  }

  function handleDeleteSession(agentId: string) {
    const agent = selectedProject?.agents.find((item) => item.id === agentId)
    if (!agent || !selectedProject) return
    setPendingDelete({ agentId, title: agent.title })
  }

  async function confirmDeleteSession() {
    if (!pendingDelete || !selectedProject) return
    const { agentId } = pendingDelete
    const currentProjectId = selectedProject.id
    const currentProject = selectedProject
    const currentIndex = currentProject.agents.findIndex((agent) => agent.id === agentId)
    setDeleteInFlight(true)
    try {
      const next = await deleteSession({ data: { agentId } })
      setWorkspace(next)
      const project =
        next.projects.find((item) => item.id === currentProjectId) ?? next.projects[0]
      if (!project) return
      const fallbackAgent =
        project.agents[Math.max(0, Math.min(currentIndex - 1, project.agents.length - 1))]
      setChatFocusRequest(0)
      if (fallbackAgent) {
        setSelection({ projectId: project.id, agentId: fallbackAgent.id })
      } else {
        setSelection({ projectId: project.id, agentId: '' })
      }
    } finally {
      setDeleteInFlight(false)
      setPendingDelete(null)
    }
  }

  async function withWorkspacePolling<T>(
    action: () => Promise<T>,
    onResult: (result: T) => void,
    onPoll?: RefreshAgentDetail,
  ) {
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      if (stopped) return
      try {
        const next = await refreshWorkspace()
        if (stopped) return
        setWorkspace(next)
        await onPoll?.()
      } finally {
        if (!stopped) {
          timer = window.setTimeout(poll, 750)
        }
      }
    }
    timer = window.setTimeout(poll, 250)
    try {
      const result = await action()
      onResult(result)
    } finally {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }

  async function handleSendMessage(
    agentId: string,
    text: string,
    images: SendMessageImage[] = [],
    onDetailRefresh?: RefreshAgentDetail,
  ) {
    await withWorkspacePolling(
      () => sendMessage({ data: { agentId, text, images } }),
      (next) => setWorkspace(next),
      onDetailRefresh,
    )
    await onDetailRefresh?.()
  }

  async function handleSteerMessage(
    agentId: string,
    text: string,
    images: SendMessageImage[] = [],
  ) {
    const next = await steerMessage({ data: { agentId, text, images } })
    setWorkspace(next)
  }

  async function handleInterruptMessage(agentId: string) {
    const next = await interruptMessage({ data: { agentId } })
    setWorkspace(next)
  }

  async function handleThinkingCommand(agentId: string, level?: ThinkingLevel) {
    const next = await setThinkingLevel({ data: { agentId, level } })
    setWorkspace(next)
  }

  async function handleResetSession(agentId: string) {
    const next = await resetSession({ data: { agentId } })
    setWorkspace(next)
  }

  async function handleForkSession(agentId: string) {
    const result = await forkSession({ data: { agentId } })
    setWorkspace(result.snapshot)
    const project = result.snapshot.projects.find((item) =>
      item.agents.some((agent) => agent.id === result.agentId),
    )
    if (project) {
      setSelection({ projectId: project.id, agentId: result.agentId })
      setChatFocusRequest(0)
    }
  }

  async function handleReviewSession(agentId: string, target: ReviewTarget) {
    const next = await reviewSession({ data: { agentId, target } })
    setWorkspace(next)
  }

  async function handleAnswerQuestion(
    agentId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ) {
    const next = await answerQuestion({ data: { agentId, requestId, answers } })
    setWorkspace(next)
  }

  async function handleStartSession(input: {
    projectId: string
    runtime: RuntimeKind
    model?: string
    title?: string
    thinkingLevel: ThinkingLevel
  }) {
    const next = await startSession({ data: input })
    setWorkspace(next)
    const project = next.projects.find((item) => item.id === input.projectId)
    const agent =
      (input.title
        ? project?.agents.find((item) => item.title === input.title)
        : undefined) ?? project?.agents[project.agents.length - 1]
    if (project && agent) {
      setChatFocusRequest(0)
      setSelection({ projectId: project.id, agentId: agent.id })
    }
    setAgentSwitcherOpen(false)
    setSessionLauncherOpen(false)
    setSessionLauncherPreset(null)
  }

  async function handleCaptureBlock(body: string, projectId: string | null) {
    const next = await addScratchpadBlock({ data: { body, projectId } })
    setWorkspace(next)
  }

  async function handleDeleteBlock(id: string) {
    const next = await deleteScratchpadBlock({ data: { id } })
    setWorkspace(next)
  }

  async function handleTriggerBlock(
    block: ScratchpadBlock,
    overrides?: { projectId?: string; runtime?: RuntimeKind; model?: string; thinkingLevel?: ThinkingLevel; title?: string },
  ) {
    const projectId = overrides?.projectId ?? block.projectId ?? selectedProject?.id
    if (!projectId) throw new Error('Pick a project before triggering a block')
    const result = await triggerScratchpadBlock({
      data: {
        id: block.id,
        projectId,
        runtime: overrides?.runtime,
        model: overrides?.model,
        title: overrides?.title,
        thinkingLevel: overrides?.thinkingLevel ?? 'medium',
      },
    })
    setWorkspace(result.snapshot)
    setSelection({ projectId, agentId: result.agentId })
    setChatFocusRequest(0)
    setTab('chat')
  }

  async function handleResumeSession(projectId: string, agentId: string, archived: boolean) {
    if (!archived) {
      selectAgent(projectId, agentId)
      setSessionLauncherOpen(false)
      return
    }
    const next = await restoreSession({ data: { agentId } })
    setWorkspace(next)
    setChatFocusRequest(0)
    setSelection({ projectId, agentId })
    setSessionLauncherOpen(false)
  }

  function selectAgent(projectId: string, agentId: string) {
    setChatFocusRequest(0)
    setSelection({ projectId, agentId })
    setAgentSwitcherOpen(false)
  }

  function openSessionLauncher(projectId = selectedProject?.id, runtime?: RuntimeKind) {
    const project = workspace.projects.find((item) => item.id === projectId)
    if (project) {
      setSelection({ projectId: project.id, agentId: project.agents[0]?.id ?? '' })
      setSessionLauncherPreset({ projectId: project.id, runtime })
    } else {
      setSessionLauncherPreset(null)
    }
    setSettingsOpen(false)
    setCommandPaletteOpen(false)
    setAgentSwitcherOpen(false)
    setSessionLauncherOpen(true)
  }

  function closeSessionLauncher() {
    setSessionLauncherOpen(false)
    setSessionLauncherPreset(null)
  }

  const commandActions = React.useMemo(
    () => [
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
          setCommandPaletteOpen(false)
          void handleDeleteSession(selectedAgent.id)
        },
      },
      {
        id: 'settings',
        title: 'Open settings',
        detail: 'Keymaps and theme',
        icon: Settings2,
        disabled: false,
        run: () => {
          setSessionLauncherOpen(false)
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
          setProjectManagerOpen(false)
          setSettingsOpen(true)
        },
      },
      {
        id: 'terminal',
        title: 'Open terminal',
        detail: selectedProject?.cwd ?? 'Selected project cwd',
        icon: TerminalSquare,
        disabled: !selectedAgent,
        run: () => {
          setCommandPaletteOpen(false)
          setTab('terminal')
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
          setCommandPaletteOpen(false)
          setTab('scratchpad')
        },
      },
      {
        id: 'add-project',
        title: 'Add project',
        detail: 'Choose or paste a directory',
        icon: FolderOpen,
        disabled: false,
        run: () => {
          setSessionLauncherOpen(false)
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
          setSettingsOpen(false)
          setProjectManagerOpen(true)
        },
      },
      {
        id: 'hide-project',
        title: `Hide ${selectedProject?.name ?? 'current project'}`,
        detail: 'Keep sessions, remove from board',
        icon: EyeOff,
        disabled: !selectedProject || workspace.projects.length <= 1,
        run: () => {
          if (!selectedProject) return
          setCommandPaletteOpen(false)
          void handleHideProject(selectedProject.id)
        },
      },
      ...workspace.hiddenProjects.map((project) => ({
        id: `unhide-project-${project.id}`,
        title: `Unhide ${project.name}`,
        detail: 'Hidden project',
        icon: Eye,
        disabled: false,
        run: () => {
          setCommandPaletteOpen(false)
          void handleUnhideProject(project.id)
        },
      })),
      ...workspace.projects.map((project) => ({

        id: `delete-project-${project.id}`,
        title: `Remove ${project.name}`,
        detail: 'Project',
        icon: Trash2,
        disabled: !selectedProject || workspace.projects.length <= 1,
        run: () => {
          setCommandPaletteOpen(false)
          setPendingProjectDelete(project)
        },
      })),
      ...workspace.projects.flatMap((project) => [
        ...sessionRuntimeOrder.map((runtime) => ({
          id: `start-${runtime}-${project.id}`,
          title: `Start ${runtimeCopy[runtime].label} in ${project.name}`,
          detail: settingsRuntimeDetail(workspace.settings, runtime),
          icon: Plus,
          disabled: false,
          run: () => openSessionLauncher(project.id, runtime),
        })),
        {
          id: `switch-project-${project.id}`,
          title: `Switch to ${project.name}`,
          detail: 'Project',
          icon: Shuffle,
          disabled: false,
          run: () => {
            const agentId = project.agents[0]?.id ?? ''
            setChatFocusRequest(0)
            setSelection({ projectId: project.id, agentId })
            setAgentSwitcherOpen(false)
            setCommandPaletteOpen(false)
          },
        },
        ...project.agents.map((agent) => ({
          id: `switch-agent-${agent.id}`,
          title: `Switch to ${agent.title}`,
          detail: project.name,
          icon: Bot,
          disabled: false,
          run: () => {
            setChatFocusRequest(0)
            setSelection({ projectId: project.id, agentId: agent.id })
            setAgentSwitcherOpen(false)
            setCommandPaletteOpen(false)
          },
        })),
      ]),
    ],
    [
      selectedAgent,
      selectedProject,
      workspace.hiddenProjects,
      workspace.projects,
      workspace.scratchpadBlocks,
      workspace.settings,
    ],
  )

  React.useEffect(() => {
    const unsubscribe = getKiriHostBridge()?.onMenuAction?.((actionId) => {
      const action = commandActions.find((item) => item.id === actionId)
      if (!action || action.disabled) return
      action.run()
    })
    return unsubscribe
  }, [commandActions])

  if (settingsOpen) {
    return (
      <SettingsScreen
        keymap={keymap}
        themeSelection={themeSelection}
        chatTypography={chatTypography}
        onKeymapChange={(action, value) =>
          setKeymap((current) => saveKeymap(updateKeymap(current, action, value)))
        }
        onKeymapReset={() => setKeymap(saveKeymap(defaultKeymap))}
        onThemeChange={(next) => setThemeSelection(saveThemeSelection(next))}
        onChatTypographyChange={(next) => setChatTypography(saveChatTypography(next))}
        onClose={() => setSettingsOpen(false)}
      />
    )
  }

  if (!selectedProject) {
    return (
      <main
        className="empty-project-shell"
        data-hydrated={hydrated ? 'true' : 'false'}
        data-testid="empty-project-state"
      >
        {commandPaletteOpen ? (
          <CommandPalette
            actions={commandActions}
            onClose={() => setCommandPaletteOpen(false)}
          />
        ) : null}

        {projectManagerOpen ? (
          <ProjectManagerDialog
            projects={workspace.projects}
            hiddenProjects={workspace.hiddenProjects}
            onAdd={handleAddProject}
            onChooseDirectory={handleChooseProjectDirectory}
            onDelete={handleDeleteProject}
            onHide={handleHideProject}
            onReorderProjects={handleReorderProjects}
            onUnhide={handleUnhideProject}
            onClose={() => setProjectManagerOpen(false)}
          />
        ) : null}

        <section className="empty-project-state" aria-label="No projects configured">
          <div className="empty-project-mark" aria-hidden="true">
            <FolderOpen size={22} />
          </div>
          <div>
            <p className="empty-project-kicker">kiri</p>
            <h1>No projects yet</h1>
            <p>Add a local repo to start sessions on this machine.</p>
          </div>
          <div className="empty-project-actions">
            <button
              type="button"
              className="project-add-button"
              onClick={() => setProjectManagerOpen(true)}
              data-testid="empty-add-project"
            >
              <Plus size={14} />
              Add project
            </button>
            <button
              type="button"
              className="empty-project-secondary"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={14} />
              Settings
            </button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="kiri-shell">
      <MobileTopBar
        project={selectedProject}
        agent={selectedAgent}
        tab={tab}
        onTabChange={setTab}
        onOpenAgentSwitcher={() => setAgentSwitcherOpen(true)}
        onSelectAgent={(agentId) => {
          setSelection({ projectId: selectedProject.id, agentId })
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
        }}
        onStartSession={() => openSessionLauncher()}
        onOpenProjects={() => {
          setSessionLauncherOpen(false)
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
          setSettingsOpen(false)
          setProjectManagerOpen(true)
        }}
        onOpenSettings={() => {
          setSessionLauncherOpen(false)
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
          setProjectManagerOpen(false)
          setSettingsOpen(true)
        }}
      />

      {commandPaletteOpen ? (
        <CommandPalette
          actions={commandActions}
          onClose={() => setCommandPaletteOpen(false)}
        />
      ) : null}

      {agentSwitcherOpen ? (
        <AgentSwitcherSheet
          projects={workspace.projects}
          selectedProjectId={selection.projectId}
          selectedAgentId={selection.agentId}
          onSelectAgent={selectAgent}
          onStartSession={openSessionLauncher}
          onClose={() => setAgentSwitcherOpen(false)}
        />
      ) : null}

      {sessionLauncherOpen ? (
        <InlineSessionLauncher
          project={selectedProject}
          projects={workspace.projects}
          archivedSessions={workspace.archivedSessions}
          selectedAgentId={selection.agentId}
          settings={workspace.settings}
          initialProjectId={sessionLauncherPreset?.projectId}
          initialRuntime={sessionLauncherPreset?.runtime}
          onStartSession={handleStartSession}
          onResumeSession={handleResumeSession}
          onCancel={closeSessionLauncher}
        />
      ) : null}

      {projectManagerOpen ? (
        <ProjectManagerDialog
          projects={workspace.projects}
          hiddenProjects={workspace.hiddenProjects}
          onAdd={handleAddProject}
          onChooseDirectory={handleChooseProjectDirectory}
          onDelete={handleDeleteProject}
          onHide={handleHideProject}
          onReorderProjects={handleReorderProjects}
          onUnhide={handleUnhideProject}
          onClose={() => setProjectManagerOpen(false)}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="Remove session?"
          body={
            <>
              <strong>{pendingDelete.title}</strong> will be hidden from the board. You can restore it from Resume.
            </>
          }
          confirmLabel="Remove session"
          cancelLabel="Keep"
          busy={deleteInFlight}
          onConfirm={() => void confirmDeleteSession()}
          onCancel={() => {
            if (deleteInFlight) return
            setPendingDelete(null)
          }}
        />
      ) : null}

      {pendingProjectDelete ? (
        <ConfirmDialog
          title="Remove project?"
          body={
            <>
              <strong>{pendingProjectDelete.name}</strong> will be removed from kiri. The project directory and files stay on disk.
            </>
          }
          confirmLabel="Remove project"
          cancelLabel="Keep"
          destructive
          busy={projectDeleteInFlight}
          onConfirm={() => void confirmDeleteProject(pendingProjectDelete.id)}
          onCancel={() => {
            if (projectDeleteInFlight) return
            setPendingProjectDelete(null)
          }}
        />
      ) : null}

      <section
        className="board-pane"
        aria-label="Projects and agents"
        data-hydrated={hydrated ? 'true' : 'false'}
        data-testid="board-pane"
      >
        <header className="topbar">
          <div className="topbar-actions">
            <button
              type="button"
              className="topbar-trigger"
              aria-label="Projects"
              aria-expanded={projectManagerOpen}
              onClick={() => {
                setSettingsOpen(false)
                setProjectManagerOpen((open) => !open)
              }}
            >
              <FolderOpen size={14} />
              <span>Projects</span>
            </button>
            <button
              type="button"
              className="topbar-trigger"
              aria-label="Settings"
              aria-expanded={settingsOpen}
              onClick={() => {
                setProjectManagerOpen(false)
                setSettingsOpen((open) => !open)
              }}
            >
              <Settings2 size={14} />
              <span>Settings</span>
            </button>
          </div>
        </header>

        <div className="board-grid" data-has-selection={selection.projectId ? 'true' : 'false'}>
          {workspace.projects.map((project) => (
            <ProjectLane
              key={project.id}
              project={project}
              selectedAgentId={selection.agentId}
              selectedProjectId={selection.projectId}
              startSessionKey={keymap.startSession}
              onSelect={(agentId) => {
                setChatFocusRequest(0)
                setSelection({ projectId: project.id, agentId })
              }}
            />
          ))}
        </div>
      </section>

      <SelectedAgentPane
        selectedProject={selectedProject}
        selectedAgent={selectedAgent}
        tab={tab}
        onTabChange={setTab}
        chatFocusRequest={chatFocusRequest}
        themeMode={themeSelection.mode}
        startSessionKey={keymap.startSession}
        onStartSession={() => openSessionLauncher()}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        onSend={handleSendMessage}
        onSteer={handleSteerMessage}
        onInterrupt={handleInterruptMessage}
        onThinkingCommand={handleThinkingCommand}
        onResetSession={handleResetSession}
        onForkSession={handleForkSession}
        onReviewSession={handleReviewSession}
        onAnswerQuestion={handleAnswerQuestion}
        scratchpadBlocks={workspace.scratchpadBlocks}
        projects={workspace.projects}
        settings={workspace.settings}
        onCaptureBlock={handleCaptureBlock}
        onDeleteBlock={handleDeleteBlock}
        onTriggerBlock={handleTriggerBlock}
      />
    </main>
  )
}
