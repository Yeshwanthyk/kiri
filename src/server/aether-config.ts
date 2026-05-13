import { Context, Effect, Layer } from 'effect'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type AetherHostMode = 'web' | 'desktop'

export type AetherConfig = {
  readonly hostMode: AetherHostMode
  readonly rootDir: string
  readonly homeDir: string
  readonly aetherHome: string
  readonly stateDir: string
  readonly dbPath: string
  readonly settingsPath: string
  readonly piSessionsDir: string
  readonly runtimeSessionsDir: string
  readonly attachmentsDir: string
  readonly logsDir: string
  readonly defaultProjectCwd: string
}

export class AetherConfigService extends Context.Tag('@aether/AetherConfig')<
  AetherConfigService,
  {
    readonly get: Effect.Effect<AetherConfig>
  }
>() {
  static readonly layer = Layer.sync(AetherConfigService, () =>
    AetherConfigService.of({
      get: Effect.sync(() => getAetherConfig()),
    }),
  )
}

export function getAetherConfig(): AetherConfig {
  return resolveAetherConfig({
    env: process.env,
    cwd: process.cwd(),
    homeDir: homedir(),
  })
}

export function resolveAetherConfig(input: {
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly homeDir?: string
}): AetherConfig {
  const homeDir = resolve(input.homeDir ?? homedir())
  const rootDir = resolve(envValue(input.env.AETHER_ROOT_DIR) ?? input.cwd)
  const hostMode = parseHostMode(envValue(input.env.AETHER_HOST_MODE))
  const aetherHome = resolve(envValue(input.env.AETHER_HOME) ?? join(homeDir, '.aether'))
  const stateDir = resolve(envValue(input.env.AETHER_STATE_DIR) ?? join(aetherHome, 'userdata'))
  const dbPath = resolve(envValue(input.env.AETHER_DB_PATH) ?? join(stateDir, 'aether.sqlite'))
  const settingsPath = resolve(
    envValue(input.env.AETHER_SETTINGS_PATH) ?? join(rootDir, 'settings.json'),
  )
  const defaultProjectCwd = resolve(envValue(input.env.AETHER_DEFAULT_PROJECT_CWD) ?? rootDir)

  return {
    hostMode,
    rootDir,
    homeDir,
    aetherHome,
    stateDir,
    dbPath,
    settingsPath,
    piSessionsDir: resolve(envValue(input.env.AETHER_PI_SESSIONS_DIR) ?? join(stateDir, 'pi-sessions')),
    runtimeSessionsDir: resolve(
      envValue(input.env.AETHER_RUNTIME_SESSIONS_DIR) ?? join(stateDir, 'runtime-sessions'),
    ),
    attachmentsDir: resolve(envValue(input.env.AETHER_ATTACHMENTS_DIR) ?? join(stateDir, 'attachments')),
    logsDir: resolve(envValue(input.env.AETHER_LOGS_DIR) ?? join(stateDir, 'logs')),
    defaultProjectCwd,
  }
}

export function runtimeSessionDirPath(
  config: AetherConfig,
  runtime: string,
  projectId: string,
  slot: string,
) {
  if (runtime === 'pi') return join(config.piSessionsDir, projectId, slot)
  return join(config.runtimeSessionsDir, runtime, projectId, slot)
}

export function attachmentDirPath(config: AetherConfig, agentId: string) {
  return join(config.attachmentsDir, safePathSegment(agentId))
}

function parseHostMode(value: string | undefined): AetherHostMode {
  if (value === undefined || value === 'web') return 'web'
  if (value === 'desktop') return 'desktop'
  throw new Error(`Invalid AETHER_HOST_MODE: ${value}`)
}

function envValue(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-')
}
