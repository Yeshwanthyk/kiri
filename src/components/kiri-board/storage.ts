import type * as React from 'react'
import {
  defaultThemeSelection,
  normalizeThemeSelection,
  type ThemeSelection,
} from '~/theme/kiri-themes'
import {
  defaultKeymap,
  keyOptions,
  type KeymapSettings,
} from './navigation'

export type ChatFontSize = 'compact' | 'comfortable' | 'large' | 'xlarge'

export type MonoFont = 'jetbrains' | 'fira' | 'plex' | 'system'

export type ChatTypographySettings = {
  fontSize: ChatFontSize
  monoFont: MonoFont
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export const chatFontSizes: Record<ChatFontSize, { label: string; size: string; lineHeight: string }> = {
  compact: { label: 'Compact · 13px', size: '13px', lineHeight: '1.5' },
  comfortable: { label: 'Comfortable · 14px', size: '14px', lineHeight: '1.58' },
  large: { label: 'Large · 16px', size: '16px', lineHeight: '1.62' },
  xlarge: { label: 'Extra large · 18px', size: '18px', lineHeight: '1.66' },
}

export const monoFonts: Record<MonoFont, { label: string; stack: string }> = {
  jetbrains: {
    label: 'JetBrains Mono',
    stack: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  fira: {
    label: 'Fira Code',
    stack: '"Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  plex: {
    label: 'IBM Plex Mono',
    stack: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  system: {
    label: 'System Mono',
    stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
}

export const defaultChatTypography: ChatTypographySettings = {
  fontSize: 'comfortable',
  monoFont: 'jetbrains',
}

const keymapStorageKey = 'kiri:keymap:v1'
const themeStorageKey = 'kiri:theme:v1'
const chatTypographyStorageKey = 'kiri:chat-typography:v1'
const chatDraftStorageKey = 'kiri:chat-drafts:v1'

export function readStoredKeymap(storage?: StorageLike): KeymapSettings {
  try {
    const store = storage ?? window.localStorage
    const stored = store.getItem(keymapStorageKey)
    if (!stored) return defaultKeymap
    const parsed = JSON.parse(stored) as Partial<KeymapSettings>
    const next = { ...defaultKeymap, ...parsed }
    const values = Object.values(next)
    if (
      values.length !== new Set(values).size ||
      values.some((value) => !keyOptions.includes(value))
    ) {
      return defaultKeymap
    }
    return next
  } catch {
    return defaultKeymap
  }
}

export function saveKeymap(
  keymap: KeymapSettings,
  storage?: StorageLike,
): KeymapSettings {
  const store = storage ?? window.localStorage
  store.setItem(keymapStorageKey, JSON.stringify(keymap))
  return keymap
}

export function readStoredThemeSelection(storage?: StorageLike): ThemeSelection {
  try {
    const store = storage ?? window.localStorage
    const stored = store.getItem(themeStorageKey)
    if (!stored) return defaultThemeSelection
    return normalizeThemeSelection(JSON.parse(stored))
  } catch {
    return defaultThemeSelection
  }
}

export function saveThemeSelection(
  selection: ThemeSelection,
  storage?: StorageLike,
): ThemeSelection {
  const store = storage ?? window.localStorage
  store.setItem(themeStorageKey, JSON.stringify(selection))
  return selection
}

export function readStoredChatTypography(
  storage?: StorageLike,
): ChatTypographySettings {
  try {
    const store = storage ?? window.localStorage
    const stored = store.getItem(chatTypographyStorageKey)
    if (!stored) return defaultChatTypography
    const record = JSON.parse(stored) as Record<string, unknown>
    return normalizeChatTypography(record)
  } catch {
    return defaultChatTypography
  }
}

export function saveChatTypography(
  settings: ChatTypographySettings,
  storage?: StorageLike,
): ChatTypographySettings {
  const store = storage ?? window.localStorage
  store.setItem(chatTypographyStorageKey, JSON.stringify(settings))
  return settings
}

export function readStoredChatDraft(
  agentId: string,
  storage?: StorageLike,
) {
  return readStoredChatDrafts(storage)[agentId] ?? ''
}

export function updateChatDraft(
  agentId: string,
  value: string,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
  storage?: StorageLike,
) {
  setDraft(value)
  const store = storage ?? window.sessionStorage
  const drafts = readStoredChatDrafts(store)
  if (value) {
    drafts[agentId] = value
  } else {
    delete drafts[agentId]
  }
  store.setItem(chatDraftStorageKey, JSON.stringify(drafts))
}

export function readStoredChatDrafts(
  storage?: StorageLike,
): Record<string, string> {
  try {
    const store = storage ?? window.sessionStorage
    const stored = store.getItem(chatDraftStorageKey)
    if (!stored) return {}
    const parsed = JSON.parse(stored) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => (
        typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )),
    )
  } catch {
    return {}
  }
}

export function normalizeChatTypography(value: Record<string, unknown>): ChatTypographySettings {
  const fontSize = typeof value.fontSize === 'string' && value.fontSize in chatFontSizes
    ? value.fontSize as ChatFontSize
    : defaultChatTypography.fontSize
  const monoFont = typeof value.monoFont === 'string' && value.monoFont in monoFonts
    ? value.monoFont as MonoFont
    : defaultChatTypography.monoFont
  return { fontSize, monoFont }
}

export function applyChatTypography(element: HTMLElement, settings: ChatTypographySettings): void {
  const tokens = chatFontSizes[settings.fontSize]
  element.style.setProperty('--chat-font-size', tokens.size)
  element.style.setProperty('--chat-line-height', tokens.lineHeight)
  element.style.setProperty('--font-mono', monoFonts[settings.monoFont].stack)
}
