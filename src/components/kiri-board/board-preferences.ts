'use client'

import * as React from 'react'
import type { WorkspaceSnapshot } from '~/lib/contracts'
import {
  applyKiriTheme,
  defaultThemeSelection,
  type ThemeSelection,
} from '~/theme/kiri-themes'
import { defaultKeymap, type KeymapSettings } from './navigation'
import {
  applyChatTypography,
  defaultChatTypography,
  readStoredAgentByProject,
  readStoredChatTypography,
  readStoredKeymap,
  readStoredThemeSelection,
  type ChatTypographySettings,
} from './storage'

type PersistPreference<T> = (input: { data: T }) => Promise<unknown>

type BoardPreferenceEffectsInput = {
  snapshot: WorkspaceSnapshot
  themeSelection: ThemeSelection
  chatTypography: ChatTypographySettings
  setHydrated: (hydrated: boolean) => void
  setThemeSelection: (selection: ThemeSelection) => void
  setKeymap: (keymap: KeymapSettings) => void
  setChatTypography: (settings: ChatTypographySettings) => void
  setAgentByProject: (selection: Record<string, string>) => void
  persistTheme: PersistPreference<ThemeSelection>
  persistKeymap: PersistPreference<KeymapSettings>
  persistChatTypography: PersistPreference<ChatTypographySettings>
  persistAgentByProject: PersistPreference<Record<string, string>>
}

export function useBoardPreferenceEffects({
  snapshot,
  themeSelection,
  chatTypography,
  setHydrated,
  setThemeSelection,
  setKeymap,
  setChatTypography,
  setAgentByProject,
  persistTheme,
  persistKeymap,
  persistChatTypography,
  persistAgentByProject,
}: BoardPreferenceEffectsInput) {
  const migrationAttemptedRef = React.useRef(false)

  React.useEffect(() => {
    if (migrationAttemptedRef.current) return
    migrationAttemptedRef.current = true
    setHydrated(true)

    const storedTheme = readStoredThemeSelection()
    if (shouldUseStoredPreference(snapshot.preferences.theme, defaultThemeSelection, storedTheme)) {
      setThemeSelection(storedTheme)
      void persistTheme({ data: storedTheme }).catch((error) => {
        console.error('Failed to migrate theme preference', error)
      })
    }

    const storedKeymap = readStoredKeymap()
    if (shouldUseStoredPreference(snapshot.preferences.keymap, defaultKeymap, storedKeymap)) {
      setKeymap(storedKeymap)
      void persistKeymap({ data: storedKeymap }).catch((error) => {
        console.error('Failed to migrate keymap preference', error)
      })
    }

    const storedTypography = readStoredChatTypography()
    if (
      shouldUseStoredPreference(
        snapshot.preferences.chatTypography,
        defaultChatTypography,
        storedTypography,
      )
    ) {
      setChatTypography(storedTypography)
      void persistChatTypography({ data: storedTypography }).catch((error) => {
        console.error('Failed to migrate chat typography preference', error)
      })
    }

    const storedAgentByProject = readStoredAgentByProject(snapshot)
    if (shouldUseStoredAgentByProject(snapshot.preferences.agentByProject, storedAgentByProject)) {
      setAgentByProject(storedAgentByProject)
      void persistAgentByProject({ data: storedAgentByProject }).catch((error) => {
        console.error('Failed to migrate selected session preference', error)
      })
    }
  }, [
    persistAgentByProject,
    persistChatTypography,
    persistKeymap,
    persistTheme,
    setAgentByProject,
    setChatTypography,
    setHydrated,
    setKeymap,
    setThemeSelection,
    snapshot,
  ])

  React.useEffect(() => {
    applyKiriTheme(document.documentElement, themeSelection)
  }, [themeSelection])

  React.useEffect(() => {
    applyChatTypography(document.documentElement, chatTypography)
  }, [chatTypography])
}

export function shouldUseStoredPreference<T>(
  serverValue: T,
  defaultValue: T,
  storedValue: T,
): boolean {
  return sameJson(serverValue, defaultValue) && !sameJson(storedValue, defaultValue)
}

export function shouldUseStoredAgentByProject(
  serverValue: Record<string, string>,
  storedValue: Record<string, string>,
): boolean {
  return Object.keys(serverValue).length === 0 && Object.keys(storedValue).length > 0
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
