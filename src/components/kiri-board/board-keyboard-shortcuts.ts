'use client'

import * as React from 'react'
import type { ProjectRow } from '~/lib/contracts'
import { getKiriBrowserBridge, type BrowserShortcutInput } from '~/lib/host-capabilities'
import { actionForKey, moveProject, type KeymapSettings } from './navigation'
import { isEditableTarget, type SidebarTab } from './board-types'

type BoardSelection = {
  projectId: string
  agentId: string
}

type ChordInput = Pick<
  KeyboardEvent | BrowserShortcutInput,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

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
  onOpenBrowserResource: () => void
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
  onOpenBrowserResource,
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

    function handleBoardChord(input: ChordInput) {
      const key = input.key.toLowerCase()
      if ((input.metaKey || input.ctrlKey) && key === 'k') {
        setSettingsOpen(false)
        setSessionLauncherOpen(false)
        setAgentSwitcherOpen(false)
        setCommandPaletteOpen((open) => !open)
        return true
      }
      if ((input.metaKey || input.ctrlKey) && input.shiftKey && !input.altKey && key === keymap.openBrowser) {
        onOpenBrowserResource()
        return true
      }

      const directProjectIndex = directProjectIndexForEvent(input)
      if (directProjectIndex !== null) {
        const project = projects[directProjectIndex]
        if (!project) return true
        onSelectProject(project.id)
        return true
      }

      const resourceMoveDelta = resourceMoveDeltaForEvent(input)
      if (resourceMoveDelta !== null) {
        onMoveActiveResource(resourceMoveDelta)
        return true
      }

      const projectDelta = projectDeltaForEvent(input)
      if (projectDelta !== null) {
        const nextProjectId = moveProject(projects, selection.projectId, projectDelta)
        if (nextProjectId === selection.projectId) return true
        onSelectProject(nextProjectId)
        return true
      }

      const resourceDelta = resourceDeltaForEvent(input)
      if (resourceDelta !== null) {
        onSelectAdjacentResource(resourceDelta)
        return true
      }
      return false
    }

    function onKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase()
      if (event.metaKey && isArrowKey(key)) setCornerPeekHeld(true)
      if (handleBoardChord(event)) {
        event.preventDefault()
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

      if (action === 'openBrowser' && !event.metaKey && !event.ctrlKey) return

      event.preventDefault()

      if (action === 'focusChat') {
        focusChat()
        return
      }

      if (action === 'openTerminal') {
        onOpenTerminalResource()
        return
      }

      if (action === 'openBrowser') {
        onOpenBrowserResource()
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
    const unsubscribeBrowserShortcut = getKiriBrowserBridge()?.onShortcut((input) => {
      if (input.release) {
        setCornerPeekHeld(false)
        return
      }
      handleBoardChord(input)
    })
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      unsubscribeBrowserShortcut?.()
    }
  }, [
    agentSwitcherOpen,
    commandPaletteOpen,
    keymap,
    onDeleteSession,
    onOpenAgentResource,
    onOpenBrowserResource,
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

function directProjectIndexForEvent(event: ChordInput) {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  if (!/^[1-9]$/.test(event.key)) return null
  return Number(event.key) - 1
}

function projectDeltaForEvent(event: ChordInput): 1 | -1 | null {
  const key = event.key.toLowerCase()
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (key === 'arrowup') return -1
    if (key === 'arrowdown') return 1
  }
  return null
}

function resourceDeltaForEvent(event: ChordInput): 1 | -1 | null {
  const key = event.key.toLowerCase()
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (key === 'arrowleft') return -1
    if (key === 'arrowright') return 1
  }
  return null
}

function resourceMoveDeltaForEvent(event: ChordInput): 1 | -1 | null {
  const key = event.key.toLowerCase()
  if (event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey) {
    if (key === 'arrowleft') return -1
    if (key === 'arrowright') return 1
  }
  return null
}
