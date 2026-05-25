import { describe, expect, it } from '@effect/vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { defaultKeymap } from '~/components/kiri-board/navigation'
import { defaultChatTypography } from '~/components/kiri-board/storage'
import { defaultThemeSelection } from '~/theme/kiri-themes'
import { KiriConfigService, type KiriConfigApi } from '~/server/kiri-config'
import type { PreferencesFileSystem } from '~/server/preferences'
import {
  UiPreferencesError,
  UiPreferencesService,
  getUiPreferences,
  makeUiPreferencesService,
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

function configFor(preferencesPath: string): KiriConfigApi {
  return {
    get: Effect.succeed({
      hostMode: 'web',
      rootDir: '/repo/kiri',
      homeDir: '/Users/yesh',
      kiriHome: '/Users/yesh/.kiri',
      stateDir: '/Users/yesh/.kiri/userdata',
      dbPath: '/Users/yesh/.kiri/userdata/kiri.sqlite',
      settingsPath: '/repo/kiri/settings.json',
      userSettingsPath: '/Users/yesh/.kiri/userdata/settings.json',
      preferencesPath,
      piSessionsDir: '/Users/yesh/.kiri/userdata/pi-sessions',
      runtimeSessionsDir: '/Users/yesh/.kiri/userdata/runtime-sessions',
      attachmentsDir: '/Users/yesh/.kiri/userdata/attachments',
      logsDir: '/Users/yesh/.kiri/userdata/logs',
      defaultProjectCwd: '/repo/kiri',
    }),
  }
}

function memoryPreferencesFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const directories: string[] = []
  const fs: PreferencesFileSystem = {
    exists: (path) => files.has(path),
    readTextFile: (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`missing file ${path}`)
      return value
    },
    mkdirp: (path) => {
      directories.push(path)
    },
    writeTextFile: (path, value) => {
      files.set(path, value)
    },
    rename: (from, to) => {
      const value = files.get(from)
      if (value === undefined) throw new Error(`missing file ${from}`)
      files.delete(from)
      files.set(to, value)
    },
    tempSuffix: () => 'test',
  }
  return { fs, files, directories }
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

  it('fills new keymap defaults when reading older preference files', () => {
    withPreferencesPath((path) => {
      const oldKeymap: Partial<typeof defaultKeymap> = { ...defaultKeymap }
      delete oldKeymap.toggleTerminalFocus
      writeFileSync(path, JSON.stringify({
        theme: defaultThemeSelection,
        keymap: oldKeymap,
        chatTypography: defaultChatTypography,
        agentByProject: {},
      }))

      expect(getUiPreferences(path).keymap.toggleTerminalFocus).toBe(defaultKeymap.toggleTerminalFocus)
    })
  })

  it('rejects invalid preference values', () => {
    withPreferencesPath((path) => {
      expect(() =>
        setChatTypographyPreference({ fontSize: 'large', monoFont: 'comic' } as never, path),
      ).toThrow()
    })
  })

  it.effect('loads defaults and writes updates through the Effect service', () =>
    Effect.gen(function* () {
      const { fs, files, directories } = memoryPreferencesFs()
      const service = makeUiPreferencesService({
        config: configFor('/tmp/preferences.json'),
        fs,
      })

      const defaults = yield* service.get
      const updated = yield* service.setTheme({ name: 'rosepine', mode: 'light' })

      expect(defaults).toEqual({
        theme: defaultThemeSelection,
        keymap: defaultKeymap,
        chatTypography: defaultChatTypography,
        agentByProject: {},
      })
      expect(updated.theme).toEqual({ name: 'rosepine', mode: 'light' })
      expect(directories).toEqual(['/tmp'])
      expect(files.has('/tmp/preferences.json.test.tmp')).toBe(false)
      const persisted = yield* service.get
      expect(persisted).toEqual(updated)
    }),
  )

  it.effect('wraps invalid preference files in typed service errors', () =>
    Effect.gen(function* () {
      const { fs } = memoryPreferencesFs({
        '/tmp/preferences.json': '{"chatTypography":{"fontSize":"large","monoFont":"comic"}}',
      })
      const service = makeUiPreferencesService({
        config: configFor('/tmp/preferences.json'),
        fs,
      })

      const error = yield* service.get.pipe(Effect.flip)

      expect(error).toBeInstanceOf(UiPreferencesError)
      expect(error.path).toBe('/tmp/preferences.json')
    }),
  )

  it('wires the service layer from the config layer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiri-preferences-layer-'))
    const preferencesPath = join(dir, 'preferences.json')
    const configLayer = Layer.succeed(
      KiriConfigService,
      KiriConfigService.of(configFor(preferencesPath)),
    )
    const layer = UiPreferencesService.layerFromConfig.pipe(Layer.provide(configLayer))
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const preferences = yield* UiPreferencesService
        const updated = yield* preferences.setAgentByProject({ kiri: 'session-1' })

        expect(updated.agentByProject).toEqual({ kiri: 'session-1' })
        expect(getUiPreferences(preferencesPath).agentByProject).toEqual({
          kiri: 'session-1',
        })
      }).pipe(Effect.provide(layer)))
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})
