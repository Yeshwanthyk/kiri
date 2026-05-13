import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  KiriConfigService,
  attachmentDirPath,
  resolveKiriConfig,
  runtimeSessionDirPath,
} from '~/server/kiri-config'

describe('kiri config', () => {
  it('preserves current web defaults from the process cwd', () => {
    const config = resolveKiriConfig({
      cwd: '/repo/kiri',
      homeDir: '/Users/yesh',
      env: {},
    })

    expect(config).toMatchObject({
      hostMode: 'web',
      rootDir: '/repo/kiri',
      homeDir: '/Users/yesh',
      kiriHome: '/Users/yesh/.kiri',
      stateDir: '/Users/yesh/.kiri/userdata',
      dbPath: '/Users/yesh/.kiri/userdata/kiri.sqlite',
      settingsPath: '/repo/kiri/settings.json',
      piSessionsDir: '/Users/yesh/.kiri/userdata/pi-sessions',
      runtimeSessionsDir: '/Users/yesh/.kiri/userdata/runtime-sessions',
      attachmentsDir: '/Users/yesh/.kiri/userdata/attachments',
      defaultProjectCwd: '/repo/kiri',
    })
  })

  it('supports desktop Kiri home overrides without changing call sites', () => {
    const config = resolveKiriConfig({
      cwd: '/repo/kiri',
      homeDir: '/Users/yesh',
      env: {
        KIRI_HOST_MODE: 'desktop',
        KIRI_ROOT_DIR: '/Applications/Kiri.app',
        KIRI_HOME: '/Users/yesh/.kiri',
        KIRI_SETTINGS_PATH: '/Users/yesh/Library/Application Support/Kiri/settings.json',
        KIRI_DEFAULT_PROJECT_CWD: '/Users/yesh/Documents',
      },
    })

    expect(config.hostMode).toBe('desktop')
    expect(config.dbPath).toBe('/Users/yesh/.kiri/userdata/kiri.sqlite')
    expect(config.defaultProjectCwd).toBe('/Users/yesh/Documents')
    expect(runtimeSessionDirPath(config, 'codex', 'kiri', 'session-1')).toBe(
      '/Users/yesh/.kiri/userdata/runtime-sessions/codex/kiri/session-1',
    )
    expect(attachmentDirPath(config, 'agent/one')).toBe(
      '/Users/yesh/.kiri/userdata/attachments/agent-one',
    )
  })

  it('treats empty env values as unset', () => {
    const config = resolveKiriConfig({
      cwd: '/repo/kiri',
      homeDir: '/Users/yesh',
      env: {
        KIRI_ROOT_DIR: '',
        KIRI_HOME: '',
        KIRI_STATE_DIR: '',
        KIRI_DB_PATH: '',
        KIRI_SETTINGS_PATH: '',
        KIRI_PI_SESSIONS_DIR: '',
        KIRI_RUNTIME_SESSIONS_DIR: '',
        KIRI_ATTACHMENTS_DIR: '',
        KIRI_LOGS_DIR: '',
      },
    })

    expect(config.dbPath).toBe('/Users/yesh/.kiri/userdata/kiri.sqlite')
    expect(config.settingsPath).toBe('/repo/kiri/settings.json')
    expect(config.logsDir).toBe('/Users/yesh/.kiri/userdata/logs')
  })

  it('rejects invalid host modes at the env boundary', () => {
    expect(() =>
      resolveKiriConfig({
        cwd: '/repo/kiri',
        homeDir: '/Users/yesh',
        env: { KIRI_HOST_MODE: 'native' },
      }),
    ).toThrow('Invalid KIRI_HOST_MODE: native')
  })

  it.effect('is available as an Effect service', () =>
    Effect.gen(function* () {
      const config = yield* KiriConfigService
      const value = yield* config.get

      expect(value.rootDir.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(KiriConfigService.layer)),
  )
})
