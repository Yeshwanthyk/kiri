import { existsSync, readFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Data, Effect, Layer } from 'effect'

export class RuntimeBinaryError extends Data.TaggedError('RuntimeBinaryError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type RuntimeBinariesApi = {
  readonly resolveExecutable: (input: {
    readonly command: string
    readonly configuredPath?: string
    readonly configuredPathEnvKey?: string
  }) => Effect.Effect<string, RuntimeBinaryError>
  readonly processEnv: (extra?: NodeJS.ProcessEnv) => Effect.Effect<NodeJS.ProcessEnv, RuntimeBinaryError>
}

type RuntimeBinariesServiceInput = {
  readonly getEnv?: () => NodeJS.ProcessEnv
  readonly getHomeDir?: () => string
  readonly exists?: (path: string) => boolean
  readonly readTextFile?: (path: string) => string
}

type RuntimeBinariesContext = {
  readonly env: NodeJS.ProcessEnv
  readonly homeDir: string
  readonly exists: (path: string) => boolean
  readonly readTextFile: (path: string) => string
}

export class RuntimeBinariesService extends Context.Tag('@kiri/RuntimeBinaries')<
  RuntimeBinariesService,
  RuntimeBinariesApi
>() {
  static readonly layer = Layer.succeed(
    RuntimeBinariesService,
    RuntimeBinariesService.of(makeRuntimeBinariesService()),
  )
}

export function makeRuntimeBinariesService(
  input: RuntimeBinariesServiceInput = {},
): RuntimeBinariesApi {
  const context = (): RuntimeBinariesContext => ({
    env: input.getEnv?.() ?? process.env,
    homeDir: input.getHomeDir?.() ?? homedir(),
    exists: input.exists ?? existsSync,
    readTextFile: input.readTextFile ?? ((path) => readFileSync(path, 'utf8')),
  })

  return {
    resolveExecutable: (request) => Effect.try({
      try: () => {
        const current = context()
        return resolveRuntimeExecutableWith(
          current,
          request.command,
          request.configuredPath ?? envValue(current.env, request.configuredPathEnvKey),
        )
      },
      catch: toRuntimeBinaryError,
    }),
    processEnv: (extra) => Effect.try({
      try: () => runtimeProcessEnvWith(context(), extra),
      catch: toRuntimeBinaryError,
    }),
  }
}

function desktopPathEntries(homeDir: string) {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homeDir, '.local', 'bin'),
    join(homeDir, '.opencode', 'bin'),
    join(homeDir, '.bun', 'bin'),
    join(homeDir, '.npm-global', 'bin'),
  ]
}

export function resolveRuntimeExecutable(command: string, configuredPath?: string) {
  return resolveRuntimeExecutableWith(
    { env: process.env, homeDir: homedir(), exists: existsSync, readTextFile: (path) => readFileSync(path, 'utf8') },
    command,
    configuredPath,
  )
}

function resolveRuntimeExecutableWith(
  context: RuntimeBinariesContext,
  command: string,
  configuredPath?: string,
) {
  const explicit = configuredPath?.trim()
  if (explicit) return explicit
  const desktopPaths = desktopPathEntries(context.homeDir).map((entry) => join(entry, command))
  return executableOnPath(context, command) ?? firstExistingPath(context, desktopPaths) ?? command
}

export function runtimeProcessEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return runtimeProcessEnvWith(
    { env: process.env, homeDir: homedir(), exists: existsSync, readTextFile: (path) => readFileSync(path, 'utf8') },
    extra,
  )
}

function runtimeProcessEnvWith(
  context: RuntimeBinariesContext,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const homeEnv = loadHomeEnv(context)
  const mergedEnv = {
    ...homeEnv,
    ...context.env,
    ...extra,
  }
  const path = mergedEnv.PATH ?? ''
  const entries = [...desktopPathEntries(context.homeDir), ...path.split(delimiter).filter(Boolean)]
  return {
    ...mergedEnv,
    PATH: Array.from(new Set(entries)).join(delimiter),
  }
}

function loadHomeEnv(context: RuntimeBinariesContext): NodeJS.ProcessEnv {
  if (context.env.KIRI_LOAD_HOME_ENV === '0') return {}
  const envPath = envValue(context.env, 'KIRI_RUNTIME_ENV_PATH') ?? join(context.homeDir, '.env')
  if (!context.exists(envPath)) return {}
  return parseEnvFile(context.readTextFile(envPath))
}

function parseEnvFile(contents: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const assignment = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const equals = assignment.indexOf('=')
    if (equals <= 0) continue
    const key = assignment.slice(0, equals).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    values[key] = parseEnvValue(assignment.slice(equals + 1).trim())
  }
  return values
}

function parseEnvValue(value: string) {
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      return value.slice(1, -1)
    }
  }
  return value
}

function executableOnPath(context: RuntimeBinariesContext, command: string) {
  for (const entry of context.env.PATH?.split(delimiter) ?? []) {
    if (!entry) continue
    const candidate = join(entry, command)
    if (context.exists(candidate)) return candidate
  }
  return undefined
}

function firstExistingPath(context: RuntimeBinariesContext, paths: ReadonlyArray<string>) {
  return paths.find((path) => context.exists(path))
}

function envValue(env: NodeJS.ProcessEnv, key: string | undefined) {
  return key ? env[key] : undefined
}

function toRuntimeBinaryError(error: unknown) {
  return new RuntimeBinaryError({
    message: error instanceof Error ? error.message : 'Runtime binary resolution failed',
    cause: error,
  })
}
