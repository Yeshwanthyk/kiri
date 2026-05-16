'use client'

import * as React from 'react'
import type { ThemeSelection } from '~/theme/kiri-themes'
import { defaultKeymap, updateKeymap, type KeymapAction, type KeymapSettings } from './navigation'
import type { ChatTypographySettings } from './storage'

type PersistThemePreference = (input: { data: ThemeSelection }) => Promise<{ theme: ThemeSelection }>
type PersistKeymapPreference = (input: { data: KeymapSettings }) => Promise<{ keymap: KeymapSettings }>
type PersistChatTypographyPreference = (
  input: { data: ChatTypographySettings },
) => Promise<{ chatTypography: ChatTypographySettings }>

export function useSettingsPreferenceActions({
  keymap,
  themeSelection,
  chatTypography,
  setKeymap,
  setThemeSelection,
  setChatTypography,
  persistKeymap,
  persistTheme,
  persistChatTypography,
}: {
  keymap: KeymapSettings
  themeSelection: ThemeSelection
  chatTypography: ChatTypographySettings
  setKeymap: (keymap: KeymapSettings) => void
  setThemeSelection: (selection: ThemeSelection) => void
  setChatTypography: (settings: ChatTypographySettings) => void
  persistKeymap: PersistKeymapPreference
  persistTheme: PersistThemePreference
  persistChatTypography: PersistChatTypographyPreference
}) {
  const changeThemePreference = React.useCallback(async (next: ThemeSelection) => {
    const previous = themeSelection
    setThemeSelection(next)
    try {
      const preferences = await persistTheme({ data: next })
      setThemeSelection(preferences.theme)
    } catch (error) {
      console.error('Failed to save theme preference', error)
      setThemeSelection(previous)
    }
  }, [persistTheme, setThemeSelection, themeSelection])

  const changeKeymapPreference = React.useCallback(async (
    action: KeymapAction,
    value: string,
  ) => {
    const previous = keymap
    const next = updateKeymap(keymap, action, value)
    setKeymap(next)
    try {
      const preferences = await persistKeymap({ data: next })
      setKeymap(preferences.keymap)
    } catch (error) {
      console.error('Failed to save keymap preference', error)
      setKeymap(previous)
    }
  }, [keymap, persistKeymap, setKeymap])

  const resetKeymapPreference = React.useCallback(async () => {
    const previous = keymap
    setKeymap(defaultKeymap)
    try {
      const preferences = await persistKeymap({ data: defaultKeymap })
      setKeymap(preferences.keymap)
    } catch (error) {
      console.error('Failed to reset keymap preference', error)
      setKeymap(previous)
    }
  }, [keymap, persistKeymap, setKeymap])

  const changeChatTypographyPreference = React.useCallback(async (
    next: ChatTypographySettings,
  ) => {
    const previous = chatTypography
    setChatTypography(next)
    try {
      const preferences = await persistChatTypography({ data: next })
      setChatTypography(preferences.chatTypography)
    } catch (error) {
      console.error('Failed to save chat typography preference', error)
      setChatTypography(previous)
    }
  }, [chatTypography, persistChatTypography, setChatTypography])

  return {
    changeThemePreference,
    changeKeymapPreference,
    resetKeymapPreference,
    changeChatTypographyPreference,
  }
}
