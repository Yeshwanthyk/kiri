'use client'

import * as React from 'react'
import { useServerFn } from '@tanstack/react-start'
import type {
  ProjectRow,
  ReviewTarget,
  RuntimeKind,
  ScratchpadBlock,
  SessionInterfaceMode,
  SendMessageImage,
  ThinkingLevel,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import { pickProjectDirectory } from '~/lib/host-capabilities'
import type { ThemeSelection } from '~/theme/kiri-themes'
import {
  addProjectMutation,
  addScratchpadBlockMutation,
  answerQuestionMutation,
  chooseProjectDirectoryMutation,
  deleteProjectMutation,
  deleteScratchpadBlockMutation,
  deleteSessionMutation,
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
  triggerScratchpadBlockMutation,
  unhideProjectMutation,
} from '~/server/workspace'
import type { KeymapSettings } from './kiri-board/navigation'
import type { ChatTypographySettings } from './kiri-board/storage'

import { AgentSwitcherSheet, MobileTopBar } from './kiri-board/board-navigation'
import { useBoardKeyboardShortcuts } from './kiri-board/board-keyboard-shortcuts'
import { useBoardPreferenceEffects } from './kiri-board/board-preferences'
import { resolveBoardSelection } from './kiri-board/board-selection'
import { fallbackAgentAfterSessionDelete } from './kiri-board/board-session-actions'
import { buildBoardCommandActions } from './kiri-board/command-actions'
import { useHostMenuActions } from './kiri-board/host-menu-actions'
import { CommandPalette } from './kiri-board/command-palette'
import { ConfirmDialog } from './kiri-board/confirm-dialog'
import { EmptyProjectState } from './kiri-board/empty-project-state'
import { ProjectManagerDialog } from './kiri-board/project-manager-dialog'
import { ProjectBoardPane } from './kiri-board/project-board-pane'
import { InlineSessionLauncher } from './kiri-board/session-launcher'
import { useSettingsPreferenceActions } from './kiri-board/settings-preference-actions'
import { SettingsScreen } from './kiri-board/settings-screen'
import { SelectedAgentPane } from './kiri-board/selected-agent-pane'
import {
  type RefreshAgentDetail,
  type SidebarTab,
} from './kiri-board/board-types'
import { pollWorkspaceDuringAction, pollWorkspaceInBackground } from './kiri-board/workspace-polling'
import { createWorkspaceDedupe } from './kiri-board/workspace-fingerprint'

export function KiriBoard({ snapshot }: { snapshot: WorkspaceSnapshot }) {
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
  const refreshWorkspaceRef = React.useRef(refreshWorkspace)
  const activeWorkspaceMutationsRef = React.useRef(0)
  const workspaceActivityEpochRef = React.useRef(0)
  const workspaceDedupeRef = React.useRef(createWorkspaceDedupe(snapshot))
  const applyWorkspace = React.useCallback((next: WorkspaceSnapshot) => {
    workspaceDedupeRef.current.apply(next, setWorkspace)
  }, [])
  const beginWorkspaceMutation = React.useCallback(() => {
    activeWorkspaceMutationsRef.current += 1
    workspaceActivityEpochRef.current += 1
    let ended = false
    return () => {
      if (ended) return
      ended = true
      activeWorkspaceMutationsRef.current -= 1
      workspaceActivityEpochRef.current += 1
    }
  }, [])
  const runWorkspaceMutation = React.useCallback(async <T,>(
    action: () => Promise<T>,
    onResult: (result: T) => void,
  ) => {
    const endWorkspaceMutation = beginWorkspaceMutation()
    try {
      const result = await action()
      onResult(result)
      return result
    } finally {
      endWorkspaceMutation()
    }
  }, [beginWorkspaceMutation])

  const { selectedProject, selectedAgent, selection } = React.useMemo(
    () => resolveBoardSelection(workspace, activeProjectId, agentByProject),
    [activeProjectId, agentByProject, workspace],
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
    const next = { ...previous }
    delete next[projectId]
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
    applyWorkspace(snapshot)
  }, [applyWorkspace, snapshot])

  React.useEffect(() => {
    refreshWorkspaceRef.current = refreshWorkspace
  }, [refreshWorkspace])

  React.useEffect(() =>
    pollWorkspaceInBackground({
      refreshWorkspace: () => refreshWorkspaceRef.current(),
      onWorkspace: applyWorkspace,
      isIdle: () => activeWorkspaceMutationsRef.current === 0,
      idleToken: () => workspaceActivityEpochRef.current,
    }),
  [applyWorkspace])

  useBoardPreferenceEffects({
    snapshot,
    themeSelection,
    chatTypography,
    setHydrated,
    setThemeSelection,
    setKeymap,
    setChatTypography,
    setAgentByProject,
    persistTheme: setThemePreference,
    persistKeymap: setKeymapPreference,
    persistChatTypography: setChatTypographyPreference,
    persistAgentByProject: setAgentByProjectPreference,
  })

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

  useBoardKeyboardShortcuts({
    agentSwitcherOpen,
    commandPaletteOpen,
    projectManagerOpen,
    keymap,
    projects: workspace.projects,
    selectedProject,
    selection,
    visibleTerminalSelected,
    onOpenSessionLauncher: openSessionLauncher,
    onDeleteSession: handleDeleteSession,
    onSelectProject: selectProject,
    onSelectAgent: selectAgent,
    setAgentSwitcherOpen,
    setChatFocusRequest,
    setCommandPaletteOpen,
    setProjectManagerOpen,
    setSessionLauncherOpen,
    setSettingsOpen,
    setTab,
    setTerminalFocusRequest,
  })

  async function handleAddProject(input: { id?: string; name: string; cwd: string }) {
    const next = await runWorkspaceMutation(() => addProject({ data: input }), applyWorkspace)
    const project = next.projects.find((item) => item.cwd === input.cwd) ?? next.projects.at(-1)
    if (project) selectProject(project.id)
  }

  async function handleDeleteProject(projectId: string) {
    const next = await runWorkspaceMutation(
      () => deleteProject({ data: { id: projectId } }),
      applyWorkspace,
    )
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
      const next = await runWorkspaceMutation(
        () => hideProject({ data: { id: projectId } }),
        applyWorkspace,
      )
      forgetProject(projectId)
      setActiveProjectId((current) => current === projectId ? next.selected.projectId : current)
    } finally {
      setProjectVisibilityPendingId((current) => current === projectId ? null : current)
    }
  }, [applyWorkspace, forgetProject, hideProject, runWorkspaceMutation])

  async function handleUnhideProject(projectId: string) {
    setProjectVisibilityPendingId(projectId)
    try {
      const next = await runWorkspaceMutation(
        () => unhideProject({ data: { id: projectId } }),
        applyWorkspace,
      )
      const project = next.projects.find((item) => item.id === projectId)
      if (project) selectProject(project.id)
    } finally {
      setProjectVisibilityPendingId((current) => current === projectId ? null : current)
    }
  }

  async function handleReorderProjects(projectIds: string[]) {
    await runWorkspaceMutation(
      () => reorderProjects({ data: { ids: projectIds } }),
      applyWorkspace,
    )
  }

  async function handleChooseProjectDirectory() {
    return pickProjectDirectory(() => chooseProjectDirectory())
  }

  async function handleRenameSession(agentId: string, title: string) {
    await runWorkspaceMutation(
      () => renameSession({ data: { agentId, title } }),
      applyWorkspace,
    )
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
      const next = await runWorkspaceMutation(
        () => deleteSession({ data: { agentId } }),
        applyWorkspace,
      )
      const project =
        next.projects.find((item) => item.id === currentProjectId) ?? next.projects[0]
      if (!project) return
      const fallbackAgent = fallbackAgentAfterSessionDelete(project, currentIndex)
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

  async function withWorkspacePolling(
    action: () => Promise<WorkspaceSnapshot>,
    onResult: (result: WorkspaceSnapshot) => void,
    onPoll?: RefreshAgentDetail,
  ) {
    const endWorkspaceMutation = beginWorkspaceMutation()
    const gatedOnPoll = onPoll
      ? async () => {
          if (workspaceDedupeRef.current.didChange()) await onPoll()
        }
      : undefined
    try {
      await pollWorkspaceDuringAction({
        action,
        refreshWorkspace,
        onResult,
        onWorkspace: applyWorkspace,
        onPoll: gatedOnPoll,
      })
    } finally {
      endWorkspaceMutation()
    }
  }

  async function refreshDetailAfterSend(onDetailRefresh?: RefreshAgentDetail) {
    await onDetailRefresh?.()
  }

  async function handleSendMessage(
    agentId: string,
    text: string,
    images: SendMessageImage[] = [],
    onDetailRefresh?: RefreshAgentDetail,
  ) {
    await withWorkspacePolling(
      () => sendMessage({ data: { agentId, text, images } }),
      (next) => applyWorkspace(next),
      onDetailRefresh,
    )
    await refreshDetailAfterSend(onDetailRefresh)
  }

  async function handleRefreshTerminalDiffs(
    agentId: string,
    onDetailRefresh?: RefreshAgentDetail,
  ) {
    await runWorkspaceMutation(
      () => refreshTerminalDiffs({ data: { agentId } }),
      applyWorkspace,
    )
    await onDetailRefresh?.()
  }

  async function handleSteerMessage(
    agentId: string,
    text: string,
    images: SendMessageImage[] = [],
  ) {
    await runWorkspaceMutation(
      () => steerMessage({ data: { agentId, text, images } }),
      applyWorkspace,
    )
  }

  async function handleInterruptMessage(agentId: string) {
    await runWorkspaceMutation(
      () => interruptMessage({ data: { agentId } }),
      applyWorkspace,
    )
  }

  async function handleThinkingCommand(agentId: string, level?: ThinkingLevel) {
    await runWorkspaceMutation(
      () => setThinkingLevel({ data: { agentId, level } }),
      applyWorkspace,
    )
  }

  async function handleResetSession(agentId: string) {
    await runWorkspaceMutation(
      () => resetSession({ data: { agentId } }),
      applyWorkspace,
    )
  }

  async function handleForkSession(agentId: string) {
    const result = await runWorkspaceMutation(
      () => forkSession({ data: { agentId } }),
      (next) => applyWorkspace(next.snapshot),
    )
    const project = result.snapshot.projects.find((item) =>
      item.agents.some((agent) => agent.id === result.agentId),
    )
    if (project) {
      selectAgent(project.id, result.agentId)
    }
  }

  async function handleReviewSession(agentId: string, target: ReviewTarget) {
    await runWorkspaceMutation(
      () => reviewSession({ data: { agentId, target } }),
      applyWorkspace,
    )
  }

  async function handleAnswerQuestion(
    agentId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ) {
    await runWorkspaceMutation(
      () => answerQuestion({ data: { agentId, requestId, answers } }),
      applyWorkspace,
    )
  }

  async function handleStartSession(input: {
    projectId: string
    runtime: RuntimeKind
    interfaceMode: SessionInterfaceMode
    model?: string
    title?: string
    thinkingLevel: ThinkingLevel
  }) {
    const next = await runWorkspaceMutation(
      () => startSession({ data: input }),
      applyWorkspace,
    )
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
    await runWorkspaceMutation(
      () => addScratchpadBlock({ data: { body, projectId } }),
      applyWorkspace,
    )
  }

  async function handleDeleteBlock(id: string) {
    await runWorkspaceMutation(
      () => deleteScratchpadBlock({ data: { id } }),
      applyWorkspace,
    )
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
    const result = await runWorkspaceMutation(
      () => triggerScratchpadBlock({
        data: {
          id: block.id,
          projectId,
          runtime: overrides?.runtime,
          interfaceMode: overrides?.interfaceMode,
          model: overrides?.model,
          title: overrides?.title,
          thinkingLevel: overrides?.thinkingLevel ?? 'medium',
        },
      }),
      (next) => applyWorkspace(next.snapshot),
    )
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
    await runWorkspaceMutation(
      () => restoreSession({ data: { agentId } }),
      applyWorkspace,
    )
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
    () => buildBoardCommandActions({
      workspace,
      selectedProject,
      selectedAgent,
      openSessionLauncher,
      requestDeleteSession: handleDeleteSession,
      openSettings: () => {
        setSessionLauncherOpen(false)
        setAgentSwitcherOpen(false)
        setCommandPaletteOpen(false)
        setProjectManagerOpen(false)
        setSettingsOpen(true)
      },
      openProjectManager: () => {
        setSessionLauncherOpen(false)
        setAgentSwitcherOpen(false)
        setCommandPaletteOpen(false)
        setSettingsOpen(false)
        setProjectManagerOpen(true)
      },
      hideProject: (projectId) => void handleHideProject(projectId),
      unhideProject: (projectId) => void handleUnhideProject(projectId),
      requestDeleteProject: setPendingProjectDelete,
      selectProject,
      selectAgent,
      setTab,
      closeCommandPalette: () => setCommandPaletteOpen(false),
    }),
    [
      selectedAgent,
      selectedProject,
      workspace,
    ],
  )

  useHostMenuActions(commandActions)
  const {
    changeThemePreference,
    changeKeymapPreference,
    resetKeymapPreference,
    changeChatTypographyPreference,
  } = useSettingsPreferenceActions({
    keymap,
    themeSelection,
    chatTypography,
    setKeymap,
    setThemeSelection,
    setChatTypography,
    persistKeymap: setKeymapPreference,
    persistTheme: setThemePreference,
    persistChatTypography: setChatTypographyPreference,
  })

  if (settingsOpen) {
    return (
      <SettingsScreen
        keymap={keymap}
        themeSelection={themeSelection}
        chatTypography={chatTypography}
        onKeymapChange={(action, value) => void changeKeymapPreference(action, value)}
        onKeymapReset={() => void resetKeymapPreference()}
        onThemeChange={(next) => void changeThemePreference(next)}
        onChatTypographyChange={(next) => void changeChatTypographyPreference(next)}
        onClose={() => setSettingsOpen(false)}
      />
    )
  }

  if (!selectedProject) {
    return (
      <EmptyProjectState
        commandPaletteOpen={commandPaletteOpen}
        commandActions={commandActions}
        projectManagerOpen={projectManagerOpen}
        projects={workspace.projects}
        hiddenProjects={workspace.hiddenProjects}
        hydrated={hydrated}
        onAddProject={handleAddProject}
        onChooseDirectory={handleChooseProjectDirectory}
        onCloseCommandPalette={() => setCommandPaletteOpen(false)}
        onCloseProjectManager={() => setProjectManagerOpen(false)}
        onDeleteProject={handleDeleteProject}
        onHideProject={handleHideProject}
        onOpenProjectManager={() => setProjectManagerOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onReorderProjects={handleReorderProjects}
        onUnhideProject={handleUnhideProject}
      />
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

      <ProjectBoardPane
        projects={workspace.projects}
        hiddenProjects={workspace.hiddenProjects}
        hydrated={hydrated}
        selection={selection}
        startSessionKey={keymap.startSession}
        projectManagerOpen={projectManagerOpen}
        settingsOpen={settingsOpen}
        projectVisibilityPendingId={projectVisibilityPendingId}
        boardScrollRef={boardScrollRef}
        onToggleProjects={() => {
          setSettingsOpen(false)
          setProjectManagerOpen((open) => !open)
        }}
        onToggleSettings={() => {
          setProjectManagerOpen(false)
          setSettingsOpen((open) => !open)
        }}
        onHideProject={(projectId) => void handleHideProject(projectId)}
        onSelectAgent={selectAgent}
        onUnhideProject={(projectId) => void handleUnhideProject(projectId)}
      />

      <SelectedAgentPane
        selectedProject={selectedProject}
        selectedAgent={selectedAgent}
        tab={tab}
        onTabChange={setTab}
        chatFocusRequest={chatFocusRequest}
        terminalFocusRequest={terminalFocusRequest}
        themeMode={themeSelection.mode}
        keymap={keymap}
        chatTypography={chatTypography}
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
