'use client'

import * as React from 'react'
import type {
  RuntimeKind,
  WorkspaceSnapshot,
} from '~/lib/contracts'

import { AgentSwitcherSheet, MobileTopBar } from './kiri-board/board-navigation'
import { useBoardKeyboardShortcuts } from './kiri-board/board-keyboard-shortcuts'
import { useBoardPreferences } from './kiri-board/board-preferences'
import { useBoardProjectActions } from './kiri-board/board-project-actions'
import { useBoardScratchpadActions } from './kiri-board/board-scratchpad-actions'
import { useBoardSelection } from './kiri-board/board-selection'
import { useBoardServerActions } from './kiri-board/board-server-actions'
import { useBoardSessionActions } from './kiri-board/board-session-actions'
import { buildBoardCommandActions } from './kiri-board/command-actions'
import { useHostMenuActions } from './kiri-board/host-menu-actions'
import { CommandPalette } from './kiri-board/command-palette'
import { ConfirmDialog } from './kiri-board/confirm-dialog'
import { EmptyProjectState } from './kiri-board/empty-project-state'
import { ProjectManagerDialog } from './kiri-board/project-manager-dialog'
import { InlineSessionLauncher } from './kiri-board/session-launcher'
import { CornerPeekShell } from './kiri-board/corner-peek-shell'
import type { SidebarTab } from './kiri-board/board-types'
import { useBoardSurfaces } from './kiri-board/board-surfaces'
import { useBoardWorkspace } from './kiri-board/board-workspace'
import { useProjectResources } from './kiri-board/use-project-resources'
import { agentResourceId, selectAdjacentResource, type ResourceId } from './kiri-board/resource-tabs'

const SettingsScreen = React.lazy(() =>
  import('./kiri-board/settings-screen').then((module) => ({ default: module.SettingsScreen })))

export function KiriBoard({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [tab, setTab] = React.useState<SidebarTab>('chat')
  const [cornerPeekHeld, setCornerPeekHeld] = React.useState(false)
  const [scratchpadOpen, setScratchpadOpen] = React.useState(false)
  const projectManagerReturnFocusRef = React.useRef<HTMLElement | null>(null)
  const previousProjectManagerOpenRef = React.useRef(false)
  const {
    settingsOpen,
    projectManagerOpen,
    sessionLauncherOpen,
    sessionLauncherPreset,
    agentSwitcherOpen,
    commandPaletteOpen,
    setSettingsOpen,
    setProjectManagerOpen,
    setSessionLauncherOpen,
    setAgentSwitcherOpen,
    setCommandPaletteOpen,
    closeSettings,
    closeProjectManager,
    closeSessionLauncher,
    closeAgentSwitcher,
    closeCommandPalette,
    openSessionLauncher: openSessionLauncherSurface,
    openSettings,
    openProjectManager,
  } = useBoardSurfaces()
  const [chatFocusRequest, setChatFocusRequest] = React.useState(0)
  const [terminalFocusRequest, setTerminalFocusRequest] = React.useState(0)
  const {
    workspaceQueries: {
      refreshWorkspace,
      refreshWorkspaceRevision,
    },
    preferenceMutations: {
      setAgentByProjectPreference,
      setChatTypographyPreference,
      setKeymapPreference,
      setThemePreference,
    },
    sessionMutations,
    projectMutations,
    scratchpadMutations,
  } = useBoardServerActions()
  const {
    workspace,
    applyWorkspace,
    runWorkspaceMutation,
    withWorkspacePolling,
  } = useBoardWorkspace({
    snapshot,
    refreshWorkspace,
    refreshWorkspaceRevision,
  })

  const {
    selectedProject,
    selectedAgent,
    selection,
    setAgentByProject,
    selectProject: selectBoardProject,
    selectAgent: selectBoardAgent,
    forgetProject,
    activateProject,
    activateProjectIfCurrent,
  } = useBoardSelection({
    snapshot,
    workspace,
    persistAgentByProject: setAgentByProjectPreference,
  })
  const {
    hydrated,
    keymap,
    themeSelection,
    chatTypography,
    changeThemePreference,
    changeKeymapPreference,
    resetKeymapPreference,
    changeChatTypographyPreference,
  } = useBoardPreferences({
    snapshot,
    setAgentByProject,
    persistTheme: setThemePreference,
    persistKeymap: setKeymapPreference,
    persistChatTypography: setChatTypographyPreference,
    persistAgentByProject: setAgentByProjectPreference,
  })
  const projectResources = useProjectResources({
    workspace,
    activeProjectId: selection.projectId,
  })

  React.useEffect(() => {
    const wasOpen = previousProjectManagerOpenRef.current
    previousProjectManagerOpenRef.current = projectManagerOpen
    if (!wasOpen || projectManagerOpen) return
    window.requestAnimationFrame(() => {
      const returnTarget = projectManagerReturnFocusRef.current?.isConnected
        ? projectManagerReturnFocusRef.current
        : document.querySelector<HTMLElement>('[data-testid="corner-peek-anchor"]')
      returnTarget?.focus()
      projectManagerReturnFocusRef.current = null
    })
  }, [projectManagerOpen])

  const openProjectManagerWithReturnFocus = React.useCallback((element?: HTMLElement | null) => {
    projectManagerReturnFocusRef.current = element ?? null
    openProjectManager()
  }, [openProjectManager])

  const selectAgent = React.useCallback((projectId: string, agentId: string) => {
    selectBoardAgent(projectId, agentId)
    projectResources.insertAgent(projectId, agentId)
    setChatFocusRequest(0)
    closeAgentSwitcher()
  }, [closeAgentSwitcher, projectResources, selectBoardAgent])

  const selectProject = React.useCallback((projectId: string) => {
    selectBoardProject(projectId)
    setChatFocusRequest(0)
  }, [selectBoardProject])

  React.useEffect(() => {
    const storedProjectId = projectResources.layout.activeProjectId
    if (!projectResources.hydrated || !storedProjectId || storedProjectId === selection.projectId) return
    if (!workspace.projects.some((project) => project.id === storedProjectId)) return
    selectProject(storedProjectId)
  }, [
    projectResources.hydrated,
    projectResources.layout.activeProjectId,
    selectProject,
    selection.projectId,
    workspace.projects,
  ])

  const activeResourceId = projectResources.activeProjectResources?.activeResourceId ?? null
  const activeResource = projectResources.activeProjectResources?.resources.find((resource) =>
    resource.id === activeResourceId)
  const visibleTerminalSelected = Boolean(
    selectedAgent && (
      activeResource?.kind === 'terminal' ||
      (activeResource?.kind === 'agent' && tab === 'chat' && selectedAgent.interfaceMode === 'terminal')
    ),
  )

  const selectResource = React.useCallback((projectId: string, resourceId: ResourceId) => {
    const project = workspace.projects.find((item) => item.id === projectId)
    const resource = projectResources.resourcesByProject[projectId]?.resources.find((item) =>
      item.id === resourceId)
    if (resource?.kind === 'agent') {
      selectBoardAgent(projectId, resource.agentId)
      setTab('chat')
    } else if (project && project.id !== selection.projectId) {
      selectBoardProject(project.id)
    }
    projectResources.selectResource(projectId, resourceId)
    setChatFocusRequest(0)
  }, [
    projectResources,
    selectBoardAgent,
    selectBoardProject,
    selection.projectId,
    workspace.projects,
  ])

  const resetChatFocus = React.useCallback(() => {
    setChatFocusRequest(0)
  }, [])

  const {
    pendingDelete,
    deleteInFlight,
    cancelDeleteSession,
    confirmDeleteSession,
    handleRenameSession,
    handleDeleteSession,
    handleSendMessage,
    handleSteerMessage,
    handleInterruptMessage,
    handleThinkingCommand,
    handleResetSession,
    handleForkSession,
    handleReviewSession,
    handleAnswerQuestion,
    handleStartSession,
    handleResumeSession,
  } = useBoardSessionActions({
    selectedProject,
    mutations: sessionMutations,
    applyWorkspace,
    runWorkspaceMutation,
    withWorkspacePolling,
    selectAgent,
    forgetProject,
    activateProject,
    resetChatFocus,
    setTab,
    closeSessionLauncher,
  })

  const {
    pendingProjectDelete,
    projectDeleteInFlight,
    requestDeleteProject,
    cancelDeleteProject,
    confirmDeleteProject,
    handleAddProject,
    handleDeleteProject,
    handleHideProject,
    handleUnhideProject,
    handleReorderProjects,
    handleChooseProjectDirectory,
  } = useBoardProjectActions({
    selectedProjectId: selection.projectId,
    mutations: projectMutations,
    applyWorkspace,
    runWorkspaceMutation,
    selectProject,
    forgetProject,
    activateProject,
    activateProjectIfCurrent,
  })

  const {
    handleCaptureBlock,
    handleDeleteBlock,
    handleTriggerBlock,
  } = useBoardScratchpadActions({
    selectedProjectId: selectedProject?.id,
    mutations: scratchpadMutations,
    applyWorkspace,
    runWorkspaceMutation,
    selectAgent,
    setTab,
  })

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
    onSelectAdjacentResource: (delta) => {
      if (!selectedProject || !projectResources.activeProjectResources) return
      const nextResourceId = selectAdjacentResource({
        resources: projectResources.activeProjectResources.resources,
        activeResourceId,
        delta,
      })
      if (!nextResourceId) return
      selectResource(selectedProject.id, nextResourceId)
    },
    onMoveActiveResource: (delta) => {
      if (!selectedProject || !projectResources.activeProjectResources || !activeResourceId) return
      const index = projectResources.activeProjectResources.resources.findIndex((resource) =>
        resource.id === activeResourceId)
      const nextIndex = index + delta
      if (index < 0 || nextIndex < 0 || nextIndex >= projectResources.activeProjectResources.resources.length) return
      projectResources.moveResource(selectedProject.id, activeResourceId, nextIndex)
    },
    onOpenAgentResource: () => {
      const agent = selectedAgent ?? selectedProject?.agents[0]
      if (!selectedProject || !agent) return
      projectResources.selectResource(selectedProject.id, agentResourceId(agent.id))
    },
    onOpenTerminalResource: () => {
      if (!selectedProject) return
      projectResources.ensureTerminal(selectedProject.id)
    },
    onToggleScratchpad: () => {
      setScratchpadOpen((open) => !open)
    },
    setCornerPeekHeld,
    setAgentSwitcherOpen,
    setChatFocusRequest,
    setCommandPaletteOpen,
    setProjectManagerOpen,
    setSessionLauncherOpen,
    setSettingsOpen,
    setTab,
    setTerminalFocusRequest,
  })

  function openSessionLauncher(projectId = selectedProject?.id, runtime?: RuntimeKind) {
    const project = workspace.projects.find((item) => item.id === projectId)
    if (project) {
      activateProject(project.id)
      openSessionLauncherSurface({ projectId: project.id, runtime })
    } else {
      openSessionLauncherSurface(null)
    }
  }

  const commandActions = React.useMemo(
    () => buildBoardCommandActions({
      workspace,
      selectedProject,
      selectedAgent,
      openSessionLauncher,
      requestDeleteSession: handleDeleteSession,
      openSettings,
      openProjectManager: openProjectManagerWithReturnFocus,
      hideProject: (projectId) => void handleHideProject(projectId),
      unhideProject: (projectId) => void handleUnhideProject(projectId),
      requestDeleteProject,
      selectProject,
      selectAgent,
      openTerminalResource: () => {
        if (!selectedProject) return
        projectResources.ensureTerminal(selectedProject.id)
      },
      openScratchpadResource: () => {
        setScratchpadOpen(true)
      },
      setTab,
      closeCommandPalette,
    }),
    [
      closeCommandPalette,
      handleDeleteSession,
      handleHideProject,
      handleUnhideProject,
      openProjectManagerWithReturnFocus,
      openSettings,
      projectResources,
      requestDeleteProject,
      selectAgent,
      selectProject,
      selectResource,
      selectedAgent,
      selectedProject,
      setTab,
      workspace,
    ],
  )

  useHostMenuActions(commandActions)
  if (projectManagerOpen) {
    return (
      <ProjectManagerDialog
        projects={workspace.projects}
        hiddenProjects={workspace.hiddenProjects}
        onAdd={handleAddProject}
        onChooseDirectory={handleChooseProjectDirectory}
        onDelete={handleDeleteProject}
        onHide={handleHideProject}
        onReorderProjects={handleReorderProjects}
        onUnhide={handleUnhideProject}
        onClose={closeProjectManager}
        returnFocusElement={projectManagerReturnFocusRef.current}
      />
    )
  }

  if (settingsOpen) {
    return (
      <React.Suspense fallback={<div className="empty-panel">Loading settings...</div>}>
        <SettingsScreen
          keymap={keymap}
          themeSelection={themeSelection}
          chatTypography={chatTypography}
          onKeymapChange={(action, value) => void changeKeymapPreference(action, value)}
          onKeymapReset={() => void resetKeymapPreference()}
          onThemeChange={(next) => void changeThemePreference(next)}
          onChatTypographyChange={(next) => void changeChatTypographyPreference(next)}
          onClose={closeSettings}
        />
      </React.Suspense>
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
        onCloseCommandPalette={closeCommandPalette}
        onCloseProjectManager={closeProjectManager}
        onDeleteProject={handleDeleteProject}
        onHideProject={handleHideProject}
        onOpenProjectManager={openProjectManager}
        onOpenSettings={openSettings}
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
          closeCommandPalette()
        }}
        onStartSession={() => openSessionLauncher()}
        onOpenProjects={openProjectManagerWithReturnFocus}
        onOpenSettings={openSettings}
      />

      {commandPaletteOpen ? (
        <CommandPalette
          actions={commandActions}
          onClose={closeCommandPalette}
        />
      ) : null}

      {agentSwitcherOpen ? (
        <AgentSwitcherSheet
          projects={workspace.projects}
          selectedProjectId={selection.projectId}
          selectedAgentId={selection.agentId}
          onSelectAgent={selectAgent}
          onStartSession={openSessionLauncher}
          onClose={closeAgentSwitcher}
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
            cancelDeleteSession()
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
            cancelDeleteProject()
          }}
        />
      ) : null}

      <CornerPeekShell
        projects={workspace.projects}
        hiddenProjects={workspace.hiddenProjects}
        selectedProject={selectedProject}
        selectedAgent={selectedAgent}
        resources={projectResources.activeProjectResources?.resources ?? []}
        activeResourceId={activeResourceId}
        scratchpadOpen={scratchpadOpen}
        hydrated={hydrated}
        resourcesByProject={projectResources.resourcesByProject}
        cornerPeekHeld={cornerPeekHeld}
        onAgentTabChange={setTab}
        onSelectProject={selectProject}
        onSelectAgent={selectAgent}
        onSelectResource={selectResource}
        onMoveResource={projectResources.moveResource}
        onCloseAgent={handleDeleteSession}
        onRenameAgent={handleRenameSession}
        onEnsureTerminal={projectResources.ensureTerminal}
        onOpenScratchpad={() => setScratchpadOpen(true)}
        onCloseScratchpad={() => setScratchpadOpen(false)}
        onStartSession={() => openSessionLauncher()}
        onOpenProjects={openProjectManagerWithReturnFocus}
        onOpenSettings={openSettings}
        chatFocusRequest={chatFocusRequest}
        terminalFocusRequest={terminalFocusRequest}
        themeMode={themeSelection.mode}
        keymap={keymap}
        chatTypography={chatTypography}
        startSessionKey={keymap.startSession}
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
        settings={workspace.settings}
        onCaptureBlock={handleCaptureBlock}
        onDeleteBlock={handleDeleteBlock}
        onTriggerBlock={handleTriggerBlock}
      />
    </main>
  )
}
