import { describe, expect, it } from '@effect/vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultKeymap } from '~/components/kiri-board/navigation'
import { defaultChatTypography } from '~/components/kiri-board/storage'
import { defaultThemeSelection } from '~/theme/kiri-themes'
import {
  getUiPreferences,
  setAgentByProjectPreference,
  setChatTypographyPreference,
  setKeymapPreference,
  setThemePreference,
} from '~/server/preferences'

function withPreferencesPath(test: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'kiri-preferences-'))
  try {
    test(join(dir, 'preferences.json'))
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

describe('ui preferences', () => {
  it('defaults when preferences.json does not exist', () => {
    withPreferencesPath((path) => {
      expect(getUiPreferences(path)).toEqual({
        theme: defaultThemeSelection,
        keymap: defaultKeymap,
        chatTypography: defaultChatTypography,
        agentByProject: {},
      })
    })
  })

  it('writes narrow updates without losing other preferences', () => {
    withPreferencesPath((path) => {
      const theme = setThemePreference({ name: 'tokyonight', mode: 'dark' }, path)
      expect(theme.theme).toEqual({ name: 'tokyonight', mode: 'dark' })

      const keymap = setKeymapPreference({ ...defaultKeymap, projectPrev: 'arrowup' }, path)
      expect(keymap.theme).toEqual({ name: 'tokyonight', mode: 'dark' })
      expect(keymap.keymap.projectPrev).toBe('arrowup')

      const typography = setChatTypographyPreference({
        fontSize: 'xlarge',
        monoFont: 'berkeley',
      }, path)
      expect(typography.theme).toEqual({ name: 'tokyonight', mode: 'dark' })
      expect(typography.keymap.projectPrev).toBe('arrowup')
      expect(typography.chatTypography).toEqual({
        fontSize: 'xlarge',
        monoFont: 'berkeley',
      })

      const selected = setAgentByProjectPreference({ kiri: 'session-1' }, path)
      expect(selected.agentByProject).toEqual({ kiri: 'session-1' })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(selected)
    })
  })

  it('rejects invalid preference values', () => {
    withPreferencesPath((path) => {
      expect(() =>
        setChatTypographyPreference({ fontSize: 'large', monoFont: 'comic' } as never, path),
      ).toThrow()
    })
  })
})
