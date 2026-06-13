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
import { useBoardSelection, useProjectSelectionScroll } from './kiri-board/board-selection'
import { useBoardServerActions } from './kiri-board/board-server-actions'
import { useBoardSessionActions } from './kiri-board/board-session-actions'
import { buildBoardCommandActions } from './kiri-board/command-actions'
import { useHostMenuActions } from './kiri-board/host-menu-actions'
import { CommandPalette } from './kiri-board/command-palette'
import { ConfirmDialog } from './kiri-board/confirm-dialog'
import { EmptyProjectState } from './kiri-board/empty-project-state'
import { ProjectManagerDialog } from './kiri-board/project-manager-dialog'
import { ProjectBoardPane } from './kiri-board/project-board-pane'
import { InlineSessionLauncher } from './kiri-board/session-launcher'
import { SelectedAgentPane } from './kiri-board/selected-agent-pane'
import type { SidebarTab } from './kiri-board/board-types'
import { useBoardSurfaces } from './kiri-board/board-surfaces'
import { useBoardWorkspace } from './kiri-board/board-workspace'

const SettingsScreen = React.lazy(() =>
  import('./kiri-board/settings-screen').then((module) => ({ default: module.SettingsScreen })))

export function KiriBoard({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const boardScrollRef = React.useRef<HTMLDivElement | null>(null)
  const [tab, setTab] = React.useState<SidebarTab>('chat')
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
    toggleProjectManager,
    toggleSettings,
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
  const visibleTerminalSelected = Boolean(
    selectedAgent && (tab === 'terminal' || (tab === 'chat' && selectedAgent.interfaceMode === 'terminal')),
  )

  const selectAgent = React.useCallback((projectId: string, agentId: string) => {
    selectBoardAgent(projectId, agentId)
    setChatFocusRequest(0)
    closeAgentSwitcher()
  }, [closeAgentSwitcher, selectBoardAgent])

  const selectProject = React.useCallback((projectId: string) => {
    selectBoardProject(projectId)
    setChatFocusRequest(0)
  }, [selectBoardProject])

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
    projectVisibilityPendingId,
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

  useProjectSelectionScroll(selection.projectId, boardScrollRef)

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
      openProjectManager,
      hideProject: (projectId) => void handleHideProject(projectId),
      unhideProject: (projectId) => void handleUnhideProject(projectId),
      requestDeleteProject,
      selectProject,
      selectAgent,
      setTab,
      closeCommandPalette,
    }),
    [
      selectedAgent,
      selectedProject,
      workspace,
    ],
  )

  useHostMenuActions(commandActions)
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
        onOpenProjects={openProjectManager}
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
          onClose={closeProjectManager}
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
        onToggleProjects={toggleProjectManager}
        onToggleSettings={toggleSettings}
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
