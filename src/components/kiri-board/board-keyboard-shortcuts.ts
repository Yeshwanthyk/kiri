'use client'

import * as React from 'react'
import type { ProjectRow } from '~/lib/contracts'
import { actionForKey, moveProject, type KeymapSettings } from './navigation'
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
  onSelectAdjacentResource: (delta: 1 | -1) => void
  onMoveActiveResource: (delta: 1 | -1) => void
  onOpenAgentResource: () => void
  onOpenTerminalResource: () => void
  onToggleScratchpad: () => void
  setCornerPeekHeld: (held: boolean) => void
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
  onSelectAdjacentResource,
  onMoveActiveResource,
  onOpenAgentResource,
  onOpenTerminalResource,
  onToggleScratchpad,
  setCornerPeekHeld,
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
      onOpenAgentResource()
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
      if (event.metaKey && isArrowKey(key)) setCornerPeekHeld(true)
      if ((event.metaKey || event.ctrlKey) && key === 'k') {
        event.preventDefault()
        setSettingsOpen(false)
        setSessionLauncherOpen(false)
        setAgentSwitcherOpen(false)
        setCommandPaletteOpen((open) => !open)
        return
      }

      const directProjectIndex = directProjectIndexForEvent(event)
      if (directProjectIndex !== null) {
        event.preventDefault()
        const project = projects[directProjectIndex]
        if (!project) return
        onSelectProject(project.id)
        return
      }

      const resourceMoveDelta = resourceMoveDeltaForEvent(event)
      if (resourceMoveDelta !== null) {
        event.preventDefault()
        onMoveActiveResource(resourceMoveDelta)
        return
      }

      const projectDelta = projectDeltaForEvent(event)
      if (projectDelta !== null) {
        event.preventDefault()
        const nextProjectId = moveProject(projects, selection.projectId, projectDelta)
        if (nextProjectId === selection.projectId) return
        onSelectProject(nextProjectId)
        return
      }

      const resourceDelta = resourceDeltaForEvent(event)
      if (resourceDelta !== null) {
        event.preventDefault()
        onSelectAdjacentResource(resourceDelta)
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

      if (action === 'openTerminal') {
        onOpenTerminalResource()
        return
      }

      if (action === 'openScratchpad') {
        onToggleScratchpad()
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

      if (action === 'agentPrev' || action === 'agentNext') {
        onSelectAdjacentResource(action === 'agentNext' ? 1 : -1)
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key === 'Meta') setCornerPeekHeld(false)
    }

    function onBlur() {
      setCornerPeekHeld(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [
    agentSwitcherOpen,
    commandPaletteOpen,
    keymap,
    onDeleteSession,
    onOpenAgentResource,
    onToggleScratchpad,
    onOpenSessionLauncher,
    onOpenTerminalResource,
    onMoveActiveResource,
    onSelectAdjacentResource,
    onSelectProject,
    projectManagerOpen,
    projects,
    selectedProject,
    selection.agentId,
    selection.projectId,
    setCornerPeekHeld,
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

function isArrowKey(key: string) {
  return key === 'arrowup' || key === 'arrowdown' || key === 'arrowleft' || key === 'arrowright'
}

function isTerminalHelperTarget(target: EventTarget | null) {
  return target instanceof HTMLElement &&
    target.classList.contains('xterm-helper-textarea')
}

function directProjectIndexForEvent(event: KeyboardEvent) {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  if (!/^[1-9]$/.test(event.key)) return null
  return Number(event.key) - 1
}

function projectDeltaForEvent(event: KeyboardEvent): 1 | -1 | null {
  const key = event.key.toLowerCase()
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (key === 'arrowup') return -1
    if (key === 'arrowdown') return 1
  }
  return null
}

function resourceDeltaForEvent(event: KeyboardEvent): 1 | -1 | null {
  const key = event.key.toLowerCase()
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (key === 'arrowleft') return -1
    if (key === 'arrowright') return 1
  }
  return null
}

function resourceMoveDeltaForEvent(event: KeyboardEvent): 1 | -1 | null {
  const key = event.key.toLowerCase()
  if (event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey) {
    if (key === 'arrowleft') return -1
    if (key === 'arrowright') return 1
  }
  return null
}
