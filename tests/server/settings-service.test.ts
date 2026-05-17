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
