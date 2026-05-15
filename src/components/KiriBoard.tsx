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
  SessionInterfaceMode,
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
  refreshTerminalDiffsMutation,
  reorderProjectsMutation,
  resetSessionMutation,
  restoreSessionMutation,
  reviewSessionMutation,
  sendMessageMutation,
  setAgentByProjectPreferenceMutation,
  setChatTypographyPreferenceMutation,
  setKeymapPreferenceMutation,
  setThemePreferenceMutation,
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
  readStoredAgentByProject,
  readStoredChatTypography,
  readStoredKeymap,
  readStoredThemeSelection,
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

const workspacePollInitialDelayMs = 250
const workspacePollIntervalMs = 750
const workspacePollMaxDurationMs = 120_000

export function KiriBoard({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const migrationAttemptedRef = React.useRef(false)
  const boardScrollRef = React.useRef<HTMLDivElement | null>(null)
  const previousSelectedProjectIdRef = React.useRef<string | null>(null)
  const [workspace, setWorkspace] = React.useState(snapshot)
  const [activeProjectId, setActiveProjectId] = React.useState<string>(snapshot.selected.projectId)
  const [agentByProject, setAgentByProject] = React.useState<Record<string, string>>(() =>
    snapshot.preferences.agentByProject,
  )
  const agentByProjectRef = React.useRef(agentByProject)
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
  const [projectVisibilityPendingId, setProjectVisibilityPendingId] = React.useState<string | null>(null)
  const [keymap, setKeymap] = React.useState<KeymapSettings>(snapshot.preferences.keymap)
  const [themeSelection, setThemeSelection] = React.useState<ThemeSelection>(snapshot.preferences.theme)
  const [chatTypography, setChatTypography] = React.useState<ChatTypographySettings>(
    snapshot.preferences.chatTypography,
  )
  const [chatFocusRequest, setChatFocusRequest] = React.useState(0)
  const [terminalFocusRequest, setTerminalFocusRequest] = React.useState(0)
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
  const setAgentByProjectPreference = useServerFn(setAgentByProjectPreferenceMutation)
  const setChatTypographyPreference = useServerFn(setChatTypographyPreferenceMutation)
  const setKeymapPreference = useServerFn(setKeymapPreferenceMutation)
  const setThemePreference = useServerFn(setThemePreferenceMutation)
  const setThinkingLevel = useServerFn(setThinkingLevelMutation)
  const steerMessage = useServerFn(steerMessageMutation)
  const interruptMessage = useServerFn(interruptMessageMutation)
  const renameSession = useServerFn(renameSessionMutation)
  const refreshTerminalDiffs = useServerFn(refreshTerminalDiffsMutation)
  const reorderProjects = useServerFn(reorderProjectsMutation)
  const startSession = useServerFn(startSessionMutation)
  const triggerScratchpadBlock = useServerFn(triggerScratchpadBlockMutation)
  const unhideProject = useServerFn(unhideProjectMutation)

  const selectedProject =
    workspace.projects.find((project) => project.id === activeProjectId) ??
    workspace.projects[0]
  const rememberedAgentId = selectedProject ? agentByProject[selectedProject.id] : undefined
  const selectedAgent =
    (rememberedAgentId
      ? selectedProject?.agents.find((agent) => agent.id === rememberedAgentId)
      : undefined) ?? selectedProject?.agents[0]
  const selection = React.useMemo<Selection>(
    () => ({
      projectId: selectedProject?.id ?? '',
      agentId: selectedAgent?.id ?? '',
    }),
    [selectedAgent, selectedProject],
  )
  const visibleTerminalSelected = Boolean(
    selectedAgent && (tab === 'terminal' || (tab === 'chat' && selectedAgent.interfaceMode === 'terminal')),
  )

  const selectAgent = React.useCallback((projectId: string, agentId: string) => {
    setActiveProjectId(projectId)
    setChatFocusRequest(0)
    setAgentSwitcherOpen(false)
    const previous = agentByProjectRef.current
    if (previous[projectId] === agentId) return
    const next = { ...previous, [projectId]: agentId }
    persistAgentByProject(next, previous)
  }, [])

  const selectProject = (projectId: string) => {
    setActiveProjectId(projectId)
    setChatFocusRequest(0)
  }

  const forgetProject = React.useCallback((projectId: string) => {
    const previous = agentByProjectRef.current
    if (!(projectId in previous)) return
    const { [projectId]: _omitted, ...next } = previous
    persistAgentByProject(next, previous)
  }, [])

  function persistAgentByProject(next: Record<string, string>, previous: Record<string, string>) {
    agentByProjectRef.current = next
    setAgentByProject(next)
    void setAgentByProjectPreference({ data: next }).catch((error) => {
      console.error('Failed to save selected session preference', error)
      agentByProjectRef.current = previous
      setAgentByProject(previous)
    })
  }

  React.useEffect(() => {
    agentByProjectRef.current = agentByProject
  }, [agentByProject])

  React.useEffect(() => {
    setWorkspace(snapshot)
  }, [snapshot])

  React.useEffect(() => {
    if (migrationAttemptedRef.current) return
    migrationAttemptedRef.current = true
    setHydrated(true)
    const storedTheme = readStoredThemeSelection()
    if (sameJson(snapshot.preferences.theme, defaultThemeSelection) && !sameJson(storedTheme, defaultThemeSelection)) {
      setThemeSelection(storedTheme)
      void setThemePreference({ data: storedTheme }).catch((error) => {
        console.error('Failed to migrate theme preference', error)
      })
    }

    const storedKeymap = readStoredKeymap()
    if (sameJson(snapshot.preferences.keymap, defaultKeymap) && !sameJson(storedKeymap, defaultKeymap)) {
      setKeymap(storedKeymap)
      void setKeymapPreference({ data: storedKeymap }).catch((error) => {
        console.error('Failed to migrate keymap preference', error)
      })
    }

    const storedTypography = readStoredChatTypography()
    if (
      sameJson(snapshot.preferences.chatTypography, defaultChatTypography) &&
      !sameJson(storedTypography, defaultChatTypography)
    ) {
      setChatTypography(storedTypography)
      void setChatTypographyPreference({ data: storedTypography }).catch((error) => {
        console.error('Failed to migrate chat typography preference', error)
      })
    }

    const storedAgentByProject = readStoredAgentByProject(snapshot)
    if (
      Object.keys(snapshot.preferences.agentByProject).length === 0 &&
      Object.keys(storedAgentByProject).length > 0
    ) {
      setAgentByProject(storedAgentByProject)
      void setAgentByProjectPreference({ data: storedAgentByProject }).catch((error) => {
        console.error('Failed to migrate selected session preference', error)
      })
    }
  }, [
    setAgentByProjectPreference,
    setChatTypographyPreference,
    setKeymapPreference,
    setThemePreference,
    snapshot,
  ])

  React.useEffect(() => {
    applyKiriTheme(document.documentElement, themeSelection)
  }, [themeSelection])

  React.useEffect(() => {
    applyChatTypography(document.documentElement, chatTypography)
  }, [chatTypography])

  React.useEffect(() => {
    const previousProjectId = previousSelectedProjectIdRef.current
    previousSelectedProjectIdRef.current = selection.projectId
    if (!previousProjectId || previousProjectId === selection.projectId) return

    const pane = boardScrollRef.current
    if (!pane || !selection.projectId) return
    const target = pane.querySelector<HTMLElement>('[data-project-selected="true"]')
    if (!target) return

    const paneRect = pane.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const edgePadding = 18
    const delta =
      targetRect.top < paneRect.top + edgePadding
        ? targetRect.top - paneRect.top - edgePadding
        : targetRect.bottom > paneRect.bottom - edgePadding
          ? targetRect.bottom - paneRect.bottom + edgePadding
          : 0
    if (Math.abs(delta) > 8) {
      pane.scrollBy({ top: delta, behavior: 'auto' })
    }
  }, [selection.projectId])

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

      if (action === 'toggleTerminalFocus') {
        if (!visibleTerminalSelected) return
        event.preventDefault()
        setTerminalFocusRequest((request) => request + 1)
        return
      }

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
        const nextProjectId = moveProject(
          workspace.projects,
          selection.projectId,
          action === 'projectNext' ? 1 : -1,
        )
        if (nextProjectId !== selection.projectId) selectProject(nextProjectId)
        return
      }

      const project =
        workspace.projects.find((row) => row.id === selection.projectId) ??
        workspace.projects[0]
      if (!project) return
      const nextAgentId = moveAgent(
        project,
        selection.agentId,
        action === 'agentNext' ? 1 : -1,
      )
      if (nextAgentId && nextAgentId !== selection.agentId) {
        selectAgent(project.id, nextAgentId)
      }
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
    visibleTerminalSelected,
    workspace.projects,
  ])

  async function handleAddProject(input: { id?: string; name: string; cwd: string }) {
    const next = await addProject({ data: input })
    setWorkspace(next)
    const project = next.projects.find((item) => item.cwd === input.cwd) ?? next.projects.at(-1)
    if (project) selectProject(project.id)
  }

  async function handleDeleteProject(projectId: string) {
    const next = await deleteProject({ data: { id: projectId } })
    setWorkspace(next)
    forgetProject(projectId)
    if (selection.projectId === projectId) setActiveProjectId(next.selected.projectId)
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

  const handleHideProject = React.useCallback(async (projectId: string) => {
    setProjectVisibilityPendingId(projectId)
    try {
      const next = await hideProject({ data: { id: projectId } })
      setWorkspace(next)
      forgetProject(projectId)
      setActiveProjectId((current) => current === projectId ? next.selected.projectId : current)
    } finally {
      setProjectVisibilityPendingId((current) => current === projectId ? null : current)
    }
  }, [forgetProject, hideProject])

  async function handleUnhideProject(projectId: string) {
    setProjectVisibilityPendingId(projectId)
    try {
      const next = await unhideProject({ data: { id: projectId } })
      setWorkspace(next)
      const project = next.projects.find((item) => item.id === projectId)
      if (project) selectProject(project.id)
    } finally {
      setProjectVisibilityPendingId((current) => current === projectId ? null : current)
    }
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
      if (fallbackAgent) {
        selectAgent(project.id, fallbackAgent.id)
      } else {
        forgetProject(project.id)
        setActiveProjectId(project.id)
        setChatFocusRequest(0)
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
    const startedAt = Date.now()
    const poll = async () => {
      if (stopped) return
      if (Date.now() - startedAt >= workspacePollMaxDurationMs) {
        stopped = true
        return
      }
      try {
        const next = await refreshWorkspace()
        if (stopped) return
        setWorkspace(next)
        await onPoll?.()
      } finally {
        if (!stopped) {
          timer = window.setTimeout(poll, workspacePollIntervalMs)
        }
      }
    }
    timer = window.setTimeout(poll, workspacePollInitialDelayMs)
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

  async function handleRefreshTerminalDiffs(
    agentId: string,
    onDetailRefresh?: RefreshAgentDetail,
  ) {
    const next = await refreshTerminalDiffs({ data: { agentId } })
    setWorkspace(next)
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
      selectAgent(project.id, result.agentId)
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
    interfaceMode: SessionInterfaceMode
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
      selectAgent(project.id, agent.id)
    }
    setTab('chat')
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
    overrides?: {
      projectId?: string
      runtime?: RuntimeKind
      interfaceMode?: SessionInterfaceMode
      model?: string
      thinkingLevel?: ThinkingLevel
      title?: string
    },
  ) {
    const projectId = overrides?.projectId ?? block.projectId ?? selectedProject?.id
    if (!projectId) throw new Error('Pick a project before triggering a block')
    const result = await triggerScratchpadBlock({
      data: {
        id: block.id,
        projectId,
        runtime: overrides?.runtime,
        interfaceMode: overrides?.interfaceMode,
        model: overrides?.model,
        title: overrides?.title,
        thinkingLevel: overrides?.thinkingLevel ?? 'medium',
      },
    })
    setWorkspace(result.snapshot)
    selectAgent(projectId, result.agentId)
    setTab('chat')
  }

  async function handleResumeSession(projectId: string, agentId: string, archived: boolean) {
    if (!archived) {
      selectAgent(projectId, agentId)
      setTab('chat')
      setSessionLauncherOpen(false)
      return
    }
    const next = await restoreSession({ data: { agentId } })
    setWorkspace(next)
    selectAgent(projectId, agentId)
    setTab('chat')
    setSessionLauncherOpen(false)
  }

  function openSessionLauncher(projectId = selectedProject?.id, runtime?: RuntimeKind) {
    const project = workspace.projects.find((item) => item.id === projectId)
    if (project) {
      setActiveProjectId(project.id)
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
            selectProject(project.id)
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
            selectAgent(project.id, agent.id)
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

  async function handleThemePreferenceChange(next: ThemeSelection) {
    const previous = themeSelection
    setThemeSelection(next)
    try {
      const preferences = await setThemePreference({ data: next })
      setThemeSelection(preferences.theme)
    } catch (error) {
      console.error('Failed to save theme preference', error)
      setThemeSelection(previous)
    }
  }

  async function handleKeymapPreferenceChange(action: KeymapAction, value: string) {
    const previous = keymap
    const next = updateKeymap(keymap, action, value)
    setKeymap(next)
    try {
      const preferences = await setKeymapPreference({ data: next })
      setKeymap(preferences.keymap)
    } catch (error) {
      console.error('Failed to save keymap preference', error)
      setKeymap(previous)
    }
  }

  async function handleKeymapPreferenceReset() {
    const previous = keymap
    setKeymap(defaultKeymap)
    try {
      const preferences = await setKeymapPreference({ data: defaultKeymap })
      setKeymap(preferences.keymap)
    } catch (error) {
      console.error('Failed to reset keymap preference', error)
      setKeymap(previous)
    }
  }

  async function handleChatTypographyPreferenceChange(next: ChatTypographySettings) {
    const previous = chatTypography
    setChatTypography(next)
    try {
      const preferences = await setChatTypographyPreference({ data: next })
      setChatTypography(preferences.chatTypography)
    } catch (error) {
      console.error('Failed to save chat typography preference', error)
      setChatTypography(previous)
    }
  }

  if (settingsOpen) {
    return (
      <SettingsScreen
        keymap={keymap}
        themeSelection={themeSelection}
        chatTypography={chatTypography}
        onKeymapChange={(action, value) => void handleKeymapPreferenceChange(action, value)}
        onKeymapReset={() => void handleKeymapPreferenceReset()}
        onThemeChange={(next) => void handleThemePreferenceChange(next)}
        onChatTypographyChange={(next) => void handleChatTypographyPreferenceChange(next)}
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
          selectAgent(selectedProject.id, agentId)
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

        <div className="board-scroll" ref={boardScrollRef}>
          <div
            className="board-grid"
            data-has-selection={selection.projectId ? 'true' : 'false'}
            data-testid="board-grid"
          >
            {workspace.projects.map((project) => (
              <ProjectLane
                key={project.id}
                project={project}
                selectedAgentId={selection.agentId}
                selectedProjectId={selection.projectId}
                startSessionKey={keymap.startSession}
                hideDisabled={workspace.projects.length <= 1 || projectVisibilityPendingId === project.id}
                onHide={handleHideProject}
                onSelect={selectAgent}
              />
            ))}
          </div>
        </div>

        {workspace.hiddenProjects.length > 0 ? (
          <HiddenProjectDock
            projects={workspace.hiddenProjects}
            pendingProjectId={projectVisibilityPendingId}
            onUnhide={(projectId) => void handleUnhideProject(projectId)}
          />
        ) : null}
      </section>

      <SelectedAgentPane
        selectedProject={selectedProject}
        selectedAgent={selectedAgent}
        tab={tab}
        onTabChange={setTab}
        chatFocusRequest={chatFocusRequest}
        terminalFocusRequest={terminalFocusRequest}
        themeMode={themeSelection.mode}
        keymap={keymap}
        startSessionKey={keymap.startSession}
        onStartSession={() => openSessionLauncher()}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        onSend={handleSendMessage}
        onRefreshTerminalDiffs={handleRefreshTerminalDiffs}
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

function HiddenProjectDock({
  projects,
  pendingProjectId,
  onUnhide,
}: {
  projects: ProjectRow[]
  pendingProjectId: string | null
  onUnhide: (projectId: string) => void
}) {
  return (
    <section className="hidden-project-dock" aria-label="Hidden projects" data-testid="hidden-project-shelf">
      <div className="hidden-project-dock-head">
        <span>Hidden</span>
        <small>{projects.length}</small>
      </div>
      <div className="hidden-project-chips">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className="hidden-project-chip"
            disabled={pendingProjectId === project.id}
            onClick={() => onUnhide(project.id)}
            aria-label={`Restore ${project.name}`}
            title={`Restore ${project.name}`}
          >
            <span>{project.name}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}
