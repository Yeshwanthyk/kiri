import { Context, Effect, Layer } from 'effect'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

type KiriHostMode = 'web' | 'desktop'

export type KiriConfig = {
  readonly hostMode: KiriHostMode
  readonly rootDir: string
  readonly homeDir: string
  readonly kiriHome: string
  readonly stateDir: string
  readonly dbPath: string
  readonly settingsPath: string
  readonly preferencesPath: string
  readonly piSessionsDir: string
  readonly runtimeSessionsDir: string
  readonly attachmentsDir: string
  readonly logsDir: string
  readonly defaultProjectCwd: string
}

export class KiriConfigService extends Context.Tag('@kiri/KiriConfig')<
  KiriConfigService,
  {
    readonly get: Effect.Effect<KiriConfig>
  }
>() {
  static readonly layer = Layer.sync(KiriConfigService, () =>
    KiriConfigService.of({
      get: Effect.sync(() => getKiriConfig()),
    }),
  )
}

export function getKiriConfig(): KiriConfig {
  return resolveKiriConfig({
    env: process.env,
    cwd: process.cwd(),
    homeDir: homedir(),
  })
}

export function resolveKiriConfig(input: {
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly homeDir?: string
}): KiriConfig {
  const homeDir = resolve(input.homeDir ?? homedir())
  const rootDir = resolve(envValue(input.env.KIRI_ROOT_DIR) ?? input.cwd)
  const hostMode = parseHostMode(envValue(input.env.KIRI_HOST_MODE))
  const kiriHome = resolve(envValue(input.env.KIRI_HOME) ?? join(homeDir, '.kiri'))
  const stateDir = resolve(envValue(input.env.KIRI_STATE_DIR) ?? join(kiriHome, 'userdata'))
  const dbPath = resolve(envValue(input.env.KIRI_DB_PATH) ?? join(stateDir, 'kiri.sqlite'))
  const settingsPath = resolve(
    envValue(input.env.KIRI_SETTINGS_PATH) ?? join(rootDir, 'settings.json'),
  )
  const preferencesPath = resolve(
    envValue(input.env.KIRI_PREFERENCES_PATH) ?? join(stateDir, 'preferences.json'),
  )
  const defaultProjectCwd = resolve(envValue(input.env.KIRI_DEFAULT_PROJECT_CWD) ?? rootDir)

  return {
    hostMode,
    rootDir,
    homeDir,
    kiriHome,
    stateDir,
    dbPath,
    settingsPath,
    preferencesPath,
    piSessionsDir: resolve(envValue(input.env.KIRI_PI_SESSIONS_DIR) ?? join(stateDir, 'pi-sessions')),
    runtimeSessionsDir: resolve(
      envValue(input.env.KIRI_RUNTIME_SESSIONS_DIR) ?? join(stateDir, 'runtime-sessions'),
    ),
    attachmentsDir: resolve(envValue(input.env.KIRI_ATTACHMENTS_DIR) ?? join(stateDir, 'attachments')),
    logsDir: resolve(envValue(input.env.KIRI_LOGS_DIR) ?? join(stateDir, 'logs')),
    defaultProjectCwd,
  }
}

export function runtimeSessionDirPath(
  config: KiriConfig,
  runtime: string,
  projectId: string,
  slot: string,
) {
  if (runtime === 'pi') return join(config.piSessionsDir, projectId, slot)
  return join(config.runtimeSessionsDir, runtime, projectId, slot)
}

export function attachmentDirPath(config: KiriConfig, agentId: string) {
  return join(config.attachmentsDir, safePathSegment(agentId))
}

function parseHostMode(value: string | undefined): KiriHostMode {
  if (value === undefined || value === 'web') return 'web'
  if (value === 'desktop') return 'desktop'
  throw new Error(`Invalid KIRI_HOST_MODE: ${value}`)
}

function envValue(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-')
}
