'use client'

import * as React from 'react'
import type { ProjectRow } from '~/lib/contracts'
import { actionForKey, moveAgent, moveProject, type KeymapSettings } from './navigation'
import { isEditableTarget, type SidebarTab } from './board-types'

type BoardSelection = {
  projectId: string
  agentId: string
}

type BoardKeyboardShortcutsInput = {
  agentSwitcherOpen: boolean
  commandPaletteOpen: boolean
  projectManagerOpen: boolean
  keymap: KeymapSettings
  projects: ProjectRow[]
  selectedProject: ProjectRow | undefined
  selection: BoardSelection
  visibleTerminalSelected: boolean
  onOpenSessionLauncher: () => void
  onDeleteSession: (agentId: string) => void
  onSelectProject: (projectId: string) => void
  onSelectAgent: (projectId: string, agentId: string) => void
  setAgentSwitcherOpen: (open: boolean) => void
  setChatFocusRequest: React.Dispatch<React.SetStateAction<number>>
  setCommandPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>
  setProjectManagerOpen: (open: boolean) => void
  setSessionLauncherOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setTab: (tab: SidebarTab) => void
  setTerminalFocusRequest: React.Dispatch<React.SetStateAction<number>>
}

export function useBoardKeyboardShortcuts({
  agentSwitcherOpen,
  commandPaletteOpen,
  projectManagerOpen,
  keymap,
  projects,
  selectedProject,
  selection,
  visibleTerminalSelected,
  onOpenSessionLauncher,
  onDeleteSession,
  onSelectProject,
  onSelectAgent,
  setAgentSwitcherOpen,
  setChatFocusRequest,
  setCommandPaletteOpen,
  setProjectManagerOpen,
  setSessionLauncherOpen,
  setSettingsOpen,
  setTab,
  setTerminalFocusRequest,
}: BoardKeyboardShortcutsInput) {
  React.useEffect(() => {
    function closeTransientPanels() {
      setCommandPaletteOpen(false)
      setAgentSwitcherOpen(false)
      setProjectManagerOpen(false)
    }

    function focusChat() {
      setSettingsOpen(false)
      setSessionLauncherOpen(false)
      setAgentSwitcherOpen(false)
      setCommandPaletteOpen(false)
      setTab('chat')
      setChatFocusRequest((request) => request + 1)
    }

    function openProjectManager() {
      setSettingsOpen(false)
      setAgentSwitcherOpen(false)
      setCommandPaletteOpen(false)
      setProjectManagerOpen(true)
    }

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
        closeTransientPanels()
        return
      }

      if (commandPaletteOpen || agentSwitcherOpen || !event.shiftKey) return

      const action = actionForKey(keymap, key)
      if (!action) return
      const editableTarget = isEditableTarget(event.target)
      if (editableTarget && (
        action !== 'toggleTerminalFocus' ||
        !isTerminalHelperTarget(event.target) ||
        document.activeElement === event.target
      )) return

      if (action === 'toggleTerminalFocus') {
        if (!visibleTerminalSelected) return
        event.preventDefault()
        setTerminalFocusRequest((request) => request + 1)
        return
      }

      event.preventDefault()

      if (action === 'focusChat') {
        focusChat()
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
        if (selectedProject) {
          onOpenSessionLauncher()
        } else {
          openProjectManager()
        }
        return
      }

      if (action === 'deleteSession') {
        const project = projects.find((row) => row.id === selection.projectId) ?? projects[0]
        const agent = project?.agents.find((row) => row.id === selection.agentId)
        if (agent?.isSession) onDeleteSession(agent.id)
        return
      }

      if (action === 'projectPrev' || action === 'projectNext') {
        const nextProjectId = moveProject(
          projects,
          selection.projectId,
          action === 'projectNext' ? 1 : -1,
        )
        if (nextProjectId !== selection.projectId) onSelectProject(nextProjectId)
        return
      }

      const project = projects.find((row) => row.id === selection.projectId) ?? projects[0]
      if (!project) return
      const nextAgentId = moveAgent(
        project,
        selection.agentId,
        action === 'agentNext' ? 1 : -1,
      )
      if (nextAgentId && nextAgentId !== selection.agentId) {
        onSelectAgent(project.id, nextAgentId)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    agentSwitcherOpen,
    commandPaletteOpen,
    keymap,
    onDeleteSession,
    onOpenSessionLauncher,
    onSelectAgent,
    onSelectProject,
    projectManagerOpen,
    projects,
    selectedProject,
    selection.agentId,
    selection.projectId,
    setAgentSwitcherOpen,
    setChatFocusRequest,
    setCommandPaletteOpen,
    setProjectManagerOpen,
    setSessionLauncherOpen,
    setSettingsOpen,
    setTab,
    setTerminalFocusRequest,
    visibleTerminalSelected,
  ])
}

function isTerminalHelperTarget(target: EventTarget | null) {
  return target instanceof HTMLElement &&
    target.classList.contains('xterm-helper-textarea')
}
