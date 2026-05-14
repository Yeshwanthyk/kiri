import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ChatTypographySettings,
  KeymapSettings,
  UiPreferences,
} from '~/lib/ui-preferences'
import {
  defaultUiPreferences,
  uiPreferencesSchema,
} from '~/lib/ui-preferences'
import type { ThemeSelection } from '~/theme/kiri-themes'
import { getKiriConfig } from './kiri-config'

export function getUiPreferences(preferencesPath = getKiriConfig().preferencesPath): UiPreferences {
  if (!existsSync(preferencesPath)) return defaultUiPreferences
  const parsed = JSON.parse(readFileSync(preferencesPath, 'utf8')) as unknown
  return uiPreferencesSchema.parse(parsed)
}

export function setThemePreference(
  theme: ThemeSelection,
  preferencesPath = getKiriConfig().preferencesPath,
): UiPreferences {
  return updateUiPreferences((current) => ({ ...current, theme }), preferencesPath)
}

export function setKeymapPreference(
  keymap: KeymapSettings,
  preferencesPath = getKiriConfig().preferencesPath,
): UiPreferences {
  return updateUiPreferences((current) => ({ ...current, keymap }), preferencesPath)
}

export function setChatTypographyPreference(
  chatTypography: ChatTypographySettings,
  preferencesPath = getKiriConfig().preferencesPath,
): UiPreferences {
  return updateUiPreferences((current) => ({ ...current, chatTypography }), preferencesPath)
}

export function setAgentByProjectPreference(
  agentByProject: Record<string, string>,
  preferencesPath = getKiriConfig().preferencesPath,
): UiPreferences {
  return updateUiPreferences((current) => ({ ...current, agentByProject }), preferencesPath)
}

function updateUiPreferences(
  update: (current: UiPreferences) => UiPreferences,
  preferencesPath: string,
): UiPreferences {
  const current = getUiPreferences(preferencesPath)
  const next = uiPreferencesSchema.parse(update(current))
  writeUiPreferences(next, preferencesPath)
  return next
}

function writeUiPreferences(preferences: UiPreferences, preferencesPath: string) {
  const next = uiPreferencesSchema.parse(preferences)
  mkdirSync(dirname(preferencesPath), { recursive: true })
  const tempPath = `${preferencesPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(tempPath, preferencesPath)
}
