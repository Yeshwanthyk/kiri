import { describe, expect, it } from '@effect/vitest'
import { delimiter, join } from 'node:path'
import { Effect } from 'effect'
import {
  RuntimeBinariesService,
  makeRuntimeBinariesService,
  resolveRuntimeExecutable,
  runtimeProcessEnv,
} from '../../src/server/runtime-binaries'

describe('runtime binaries', () => {
  it.effect('resolves explicit configured paths before probing PATH', () =>
    Effect.gen(function* () {
      const binaries = makeRuntimeBinariesService({
        getEnv: () => ({ PATH: '/usr/bin' }),
        getHomeDir: () => '/Users/yesh',
        exists: () => true,
      })

      const command = yield* binaries.resolveExecutable({
        command: 'codex',
        configuredPath: ' /custom/codex ',
      })

      expect(command).toBe('/custom/codex')
    }),
  )

  it.effect('resolves configured paths from service-owned env', () =>
    Effect.gen(function* () {
      const binaries = makeRuntimeBinariesService({
        getEnv: () => ({ PATH: '/usr/bin', KIRI_CODEX_BIN: ' /env/codex ' }),
        getHomeDir: () => '/Users/yesh',
        exists: () => false,
      })

      const command = yield* binaries.resolveExecutable({
        command: 'codex',
        configuredPathEnvKey: 'KIRI_CODEX_BIN',
      })

      expect(command).toBe('/env/codex')
    }),
  )

  it.effect('keeps PATH lookup ahead of desktop fallback paths', () =>
    Effect.gen(function* () {
      const binaries = makeRuntimeBinariesService({
        getEnv: () => ({ PATH: ['/tool/bin', '/usr/bin'].join(delimiter) }),
        getHomeDir: () => '/Users/yesh',
        exists: (path) => path === join('/tool/bin', 'pi')
          || path === join('/opt/homebrew/bin', 'pi'),
      })

      const command = yield* binaries.resolveExecutable({ command: 'pi' })

      expect(command).toBe(join('/tool/bin', 'pi'))
    }),
  )

  it.effect('falls back to desktop path entries before bare command names', () =>
    Effect.gen(function* () {
      const binaries = makeRuntimeBinariesService({
        getEnv: () => ({ PATH: '/missing/bin' }),
        getHomeDir: () => '/Users/yesh',
        exists: (path) => [
          join('/opt/homebrew/bin', 'claude'),
          join('/usr/local/bin', 'claude'),
          join('/Users/yesh/.bun/bin', 'claude'),
        ].includes(path),
      })

      const command = yield* binaries.resolveExecutable({ command: 'claude' })

      expect(command).toBe(join('/opt/homebrew/bin', 'claude'))
    }),
  )

  it.effect('builds de-duplicated runtime process env through the service layer', () =>
    Effect.gen(function* () {
      const binaries = makeRuntimeBinariesService({
        getEnv: () => ({
          PATH: [
            '/usr/local/bin',
            '/custom/bin',
            '/Users/yesh/.bun/bin',
          ].join(delimiter),
        }),
        getHomeDir: () => '/Users/yesh',
      })
      const env = yield* binaries.processEnv({ FORCE_COLOR: '3' })
      const entries = env.PATH?.split(delimiter) ?? []

      expect(env.FORCE_COLOR).toBe('3')
      expect(entries).toEqual([
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/Users/yesh/.local/bin',
        '/Users/yesh/.bun/bin',
        '/Users/yesh/.npm-global/bin',
        '/custom/bin',
      ])
    }),
  )

  it.effect('exposes runtime process env through the service layer', () =>
    Effect.gen(function* () {
      const binaries = yield* RuntimeBinariesService
      const env = yield* binaries.processEnv({ FORCE_COLOR: '3' })

      expect(env.FORCE_COLOR).toBe('3')
      expect(env.PATH?.split(delimiter)[0]).toBe('/opt/homebrew/bin')
    }).pipe(Effect.provide(RuntimeBinariesService.layer)),
  )

  it('preserves compatibility wrappers', () => {
    expect(resolveRuntimeExecutable('kiri-test-command', ' /tmp/kiri-test-command '))
      .toBe('/tmp/kiri-test-command')
    expect(runtimeProcessEnv({ KIRI_TEST: '1' }).KIRI_TEST).toBe('1')
  })
})
