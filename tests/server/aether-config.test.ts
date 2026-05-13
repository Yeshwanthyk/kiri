import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  AetherConfigService,
  attachmentDirPath,
  resolveAetherConfig,
  runtimeSessionDirPath,
} from '~/server/aether-config'

describe('aether config', () => {
  it('preserves current web defaults from the process cwd', () => {
    const config = resolveAetherConfig({
      cwd: '/repo/aether',
      homeDir: '/Users/yesh',
      env: {},
    })

    expect(config).toMatchObject({
      hostMode: 'web',
      rootDir: '/repo/aether',
      homeDir: '/Users/yesh',
      aetherHome: '/Users/yesh/.aether',
      stateDir: '/Users/yesh/.aether/userdata',
      dbPath: '/Users/yesh/.aether/userdata/aether.sqlite',
      settingsPath: '/repo/aether/settings.json',
      piSessionsDir: '/Users/yesh/.aether/userdata/pi-sessions',
      runtimeSessionsDir: '/Users/yesh/.aether/userdata/runtime-sessions',
      attachmentsDir: '/Users/yesh/.aether/userdata/attachments',
      defaultProjectCwd: '/repo/aether',
    })
  })

  it('supports desktop Aether home overrides without changing call sites', () => {
    const config = resolveAetherConfig({
      cwd: '/repo/aether',
      homeDir: '/Users/yesh',
      env: {
        AETHER_HOST_MODE: 'desktop',
        AETHER_ROOT_DIR: '/Applications/Aether.app',
        AETHER_HOME: '/Users/yesh/.aether',
        AETHER_SETTINGS_PATH: '/Users/yesh/Library/Application Support/Aether/settings.json',
        AETHER_DEFAULT_PROJECT_CWD: '/Users/yesh/Documents',
      },
    })

    expect(config.hostMode).toBe('desktop')
    expect(config.dbPath).toBe('/Users/yesh/.aether/userdata/aether.sqlite')
    expect(config.defaultProjectCwd).toBe('/Users/yesh/Documents')
    expect(runtimeSessionDirPath(config, 'codex', 'aether', 'session-1')).toBe(
      '/Users/yesh/.aether/userdata/runtime-sessions/codex/aether/session-1',
    )
    expect(attachmentDirPath(config, 'agent/one')).toBe(
      '/Users/yesh/.aether/userdata/attachments/agent-one',
    )
  })

  it('treats empty env values as unset', () => {
    const config = resolveAetherConfig({
      cwd: '/repo/aether',
      homeDir: '/Users/yesh',
      env: {
        AETHER_ROOT_DIR: '',
        AETHER_HOME: '',
        AETHER_STATE_DIR: '',
        AETHER_DB_PATH: '',
        AETHER_SETTINGS_PATH: '',
        AETHER_PI_SESSIONS_DIR: '',
        AETHER_RUNTIME_SESSIONS_DIR: '',
        AETHER_ATTACHMENTS_DIR: '',
        AETHER_LOGS_DIR: '',
      },
    })

    expect(config.dbPath).toBe('/Users/yesh/.aether/userdata/aether.sqlite')
    expect(config.settingsPath).toBe('/repo/aether/settings.json')
    expect(config.logsDir).toBe('/Users/yesh/.aether/userdata/logs')
  })

  it('rejects invalid host modes at the env boundary', () => {
    expect(() =>
      resolveAetherConfig({
        cwd: '/repo/aether',
        homeDir: '/Users/yesh',
        env: { AETHER_HOST_MODE: 'native' },
      }),
    ).toThrow('Invalid AETHER_HOST_MODE: native')
  })

  it.effect('is available as an Effect service', () =>
    Effect.gen(function* () {
      const config = yield* AetherConfigService
      const value = yield* config.get

      expect(value.rootDir.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(AetherConfigService.layer)),
  )
})
