import type * as React from 'react'
import type { WorkspaceSnapshot } from '~/lib/contracts'
import {
  chatFontSizes,
  defaultChatTypography,
  defaultKeymap,
  keyOptions,
  monoFonts,
  normalizeChatTypography,
  type ChatFontSize,
  type ChatTypographySettings,
  type KeymapSettings,
  type MonoFont,
} from '~/lib/ui-preferences'
import {
  defaultThemeSelection,
  normalizeThemeSelection,
  type ThemeSelection,
} from '~/theme/kiri-themes'

export {
  chatFontSizes,
  defaultChatTypography,
  monoFonts,
  normalizeChatTypography,
  type ChatFontSize,
  type ChatTypographySettings,
  type MonoFont,
} from '~/lib/ui-preferences'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

const keymapStorageKey = 'kiri:keymap:v1'
const themeStorageKey = 'kiri:theme:v1'
const chatTypographyStorageKey = 'kiri:chat-typography:v1'
const chatDraftStorageKey = 'kiri:chat-drafts:v1'
const agentByProjectStorageKey = 'kiri:agent-by-project:v1'

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
      values.some((value) => !(keyOptions as readonly string[]).includes(value))
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

export function readStoredAgentByProject(
  snapshot: WorkspaceSnapshot,
  storage?: StorageLike,
): Record<string, string> {
  const cleaned: Record<string, string> = {}
  try {
    const store = storage ?? window.localStorage
    const stored = store.getItem(agentByProjectStorageKey)
    const parsed = stored ? (JSON.parse(stored) as Record<string, unknown>) : {}
    for (const project of snapshot.projects) {
      const remembered = parsed[project.id]
      if (typeof remembered !== 'string') continue
      if (project.agents.some((agent) => agent.id === remembered)) {
        cleaned[project.id] = remembered
      }
    }
  } catch {
    // fall through to seeding below
  }
  if (!cleaned[snapshot.selected.projectId] && snapshot.selected.agentId) {
    cleaned[snapshot.selected.projectId] = snapshot.selected.agentId
  }
  return cleaned
}

export function writeStoredAgentByProject(
  map: Record<string, string>,
  storage?: StorageLike,
): void {
  try {
    const store = storage ?? window.localStorage
    store.setItem(agentByProjectStorageKey, JSON.stringify(map))
  } catch {
    // ignore quota / private-mode failures, same as other writers
  }
}

export function applyChatTypography(element: HTMLElement, settings: ChatTypographySettings): void {
  const tokens = chatFontSizes[settings.fontSize]
  element.style.setProperty('--chat-font-size', tokens.size)
  element.style.setProperty('--chat-line-height', tokens.lineHeight)
  element.style.setProperty('--chat-mono-font', monoFonts[settings.monoFont].stack)
}
