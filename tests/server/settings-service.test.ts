import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { KiriConfigApi } from '../../src/server/kiri-config'
import {
  KiriSettingsError,
  loadSettings,
  makeKiriSettingsService,
} from '../../src/server/settings'

const validSettingsJson = JSON.stringify({
  runtimes: {
    pi: {
      models: ['pi-default', 'pi-alt'],
      defaultModel: 'pi-default',
      contextWindows: { 'pi-default': 1000 },
    },
    codex: {
      models: ['codex-default'],
      defaultModel: 'codex-default',
    },
    claude: {
      models: ['claude-default'],
      defaultModel: 'claude-default',
    },
    opencode: {
      models: ['opencode-default'],
      defaultModel: 'opencode-default',
    },
  },
})

const configFor = (settingsPath: string): KiriConfigApi => ({
  get: Effect.succeed({
    hostMode: 'web',
    rootDir: '/repo/kiri',
    homeDir: '/Users/yesh',
    kiriHome: '/Users/yesh/.kiri',
    stateDir: '/Users/yesh/.kiri/userdata',
    dbPath: '/Users/yesh/.kiri/userdata/kiri.sqlite',
    settingsPath,
    userSettingsPath: '/Users/yesh/.kiri/userdata/settings.json',
    preferencesPath: '/Users/yesh/.kiri/userdata/preferences.json',
    piSessionsDir: '/Users/yesh/.kiri/userdata/pi-sessions',
    runtimeSessionsDir: '/Users/yesh/.kiri/userdata/runtime-sessions',
    attachmentsDir: '/Users/yesh/.kiri/userdata/attachments',
    logsDir: '/Users/yesh/.kiri/userdata/logs',
    defaultProjectCwd: '/repo/kiri',
  }),
})

describe('settings service', () => {
  it('loads settings through injected config and file reader services', () => {
    const settings = loadSettings('/repo/settings.json', (path) => {
      expect(path).toBe('/repo/settings.json')
      return validSettingsJson
    })

    expect(settings.runtimes.pi.defaultModel).toBe('pi-default')
  })

  it('fills runtime defaults missing from older desktop settings files', () => {
    const settings = loadSettings('/repo/settings.json', () => JSON.stringify({
      runtimes: {
        pi: {
          models: ['pi-default'],
          defaultModel: 'pi-default',
        },
        codex: {
          models: ['codex-default'],
          defaultModel: 'codex-default',
        },
        claude: {
          models: ['claude-default'],
          defaultModel: 'claude-default',
        },
      },
    }))

    expect(settings.runtimes.opencode.defaultModel).toBe('opencode/gpt-5.5')
  })

  it.effect('returns runtime settings from injected readers', () =>
    Effect.gen(function* () {
      const service = makeKiriSettingsService({
        config: configFor('/repo/settings.json'),
        readTextFile: () => validSettingsJson,
      })

      const runtime = yield* service.getRuntime('pi')

      expect(runtime.models).toEqual(['pi-default', 'pi-alt'])
    }),
  )

  it('merges user runtime settings additively over bundled settings', () => {
    const files = new Map([
      ['/repo/settings.json', validSettingsJson],
      ['/state/settings.json', JSON.stringify({
        runtimes: {
          pi: {
            models: ['deepseek/deepseek-v4-flash'],
            contextWindows: { 'deepseek/deepseek-v4-flash': 1_000_000 },
          },
        },
      })],
    ])

    const settings = loadSettings(
      '/repo/settings.json',
      (path) => {
        const value = files.get(path)
        if (value === undefined) throw new Error(`missing ${path}`)
        return value
      },
      '/state/settings.json',
      (path) => files.has(path),
    )

    expect(settings.runtimes.pi.defaultModel).toBe('pi-default')
    expect(settings.runtimes.pi.models).toEqual([
      'pi-default',
      'pi-alt',
      'deepseek/deepseek-v4-flash',
    ])
    expect(settings.runtimes.pi.contextWindows?.['deepseek/deepseek-v4-flash']).toBe(1_000_000)
    expect(settings.runtimes.pi.interfaceModes).toEqual(['terminal'])
    expect(settings.runtimes.pi.defaultInterfaceMode).toBe('terminal')
  })

  it('allows user settings to opt Pi back into GUI launches', () => {
    const files = new Map([
      ['/repo/settings.json', validSettingsJson],
      ['/state/settings.json', JSON.stringify({
        runtimes: {
          pi: {
            interfaceModes: ['gui', 'terminal'],
            defaultInterfaceMode: 'gui',
          },
        },
      })],
    ])

    const settings = loadSettings(
      '/repo/settings.json',
      (path) => {
        const value = files.get(path)
        if (value === undefined) throw new Error(`missing ${path}`)
        return value
      },
      '/state/settings.json',
      (path) => files.has(path),
    )

    expect(settings.runtimes.pi.interfaceModes).toEqual(['gui', 'terminal'])
    expect(settings.runtimes.pi.defaultInterfaceMode).toBe('gui')
  })

  it.effect('fails invalid default models with typed settings errors', () =>
    Effect.gen(function* () {
      const service = makeKiriSettingsService({
        config: configFor('/repo/settings.json'),
        readTextFile: () => JSON.stringify({
          runtimes: {
            pi: { models: ['pi-alt'], defaultModel: 'pi-default' },
            codex: { models: ['codex-default'], defaultModel: 'codex-default' },
            claude: { models: ['claude-default'], defaultModel: 'claude-default' },
            opencode: { models: ['opencode-default'], defaultModel: 'opencode-default' },
          },
        }),
      })

      const error = yield* service.get.pipe(Effect.flip)

      expect(error).toBeInstanceOf(KiriSettingsError)
      expect(error.path).toBe('/repo/settings.json')
      expect(error.message).toBe(
        'settings.json pi.defaultModel must be listed in pi.models',
      )
    }),
  )

  it.effect('validates configured models through the Effect service', () =>
    Effect.gen(function* () {
      const service = makeKiriSettingsService({
        config: configFor('/repo/settings.json'),
        readTextFile: () => validSettingsJson,
      })

      yield* service.assertConfiguredModel('pi', 'pi-alt')
      const error = yield* service.assertConfiguredModel('pi', 'missing').pipe(Effect.flip)

      expect(error).toBeInstanceOf(KiriSettingsError)
      expect(error.message).toBe('Model missing is not configured for pi')
    }),
  )
})
