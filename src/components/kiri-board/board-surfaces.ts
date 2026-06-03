'use client'

import * as React from 'react'
import type { RuntimeKind } from '~/lib/contracts'

export type SessionLauncherPreset = {
  readonly projectId: string
  readonly runtime?: RuntimeKind
}

export function useBoardSurfaces() {
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [projectManagerOpen, setProjectManagerOpen] = React.useState(false)
  const [sessionLauncherOpen, setSessionLauncherOpen] = React.useState(false)
  const [sessionLauncherPreset, setSessionLauncherPreset] = React.useState<SessionLauncherPreset | null>(null)
  const [agentSwitcherOpen, setAgentSwitcherOpen] = React.useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false)

  const closeCommandPalette = React.useCallback(() => {
    setCommandPaletteOpen(false)
  }, [])

  const closeAgentSwitcher = React.useCallback(() => {
    setAgentSwitcherOpen(false)
  }, [])

  const closeProjectManager = React.useCallback(() => {
    setProjectManagerOpen(false)
  }, [])

  const closeSettings = React.useCallback(() => {
    setSettingsOpen(false)
  }, [])

  const closeSessionLauncher = React.useCallback(() => {
    setSessionLauncherOpen(false)
    setSessionLauncherPreset(null)
  }, [])

  const openSessionLauncher = React.useCallback((preset: SessionLauncherPreset | null) => {
    setSessionLauncherPreset(preset)
    setSettingsOpen(false)
    setCommandPaletteOpen(false)
    setAgentSwitcherOpen(false)
    setSessionLauncherOpen(true)
  }, [])

  const openSettings = React.useCallback(() => {
    setSessionLauncherOpen(false)
    setAgentSwitcherOpen(false)
    setCommandPaletteOpen(false)
    setProjectManagerOpen(false)
    setSettingsOpen(true)
  }, [])

  const openProjectManager = React.useCallback(() => {
    setSessionLauncherOpen(false)
    setAgentSwitcherOpen(false)
    setCommandPaletteOpen(false)
    setSettingsOpen(false)
    setProjectManagerOpen(true)
  }, [])

  const toggleProjectManager = React.useCallback(() => {
    setSettingsOpen(false)
    setProjectManagerOpen((open) => !open)
  }, [])

  const toggleSettings = React.useCallback(() => {
    setProjectManagerOpen(false)
    setSettingsOpen((open) => !open)
  }, [])

  return {
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
    openSessionLauncher,
    openSettings,
    openProjectManager,
    toggleProjectManager,
    toggleSettings,
  }
}
