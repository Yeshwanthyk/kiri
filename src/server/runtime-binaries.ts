import { existsSync } from 'node:fs'
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
}

type RuntimeBinariesContext = {
  readonly env: NodeJS.ProcessEnv
  readonly homeDir: string
  readonly exists: (path: string) => boolean
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
    { env: process.env, homeDir: homedir(), exists: existsSync },
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
    { env: process.env, homeDir: homedir(), exists: existsSync },
    extra,
  )
}

function runtimeProcessEnvWith(
  context: RuntimeBinariesContext,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const path = context.env.PATH ?? ''
  const entries = [...desktopPathEntries(context.homeDir), ...path.split(delimiter).filter(Boolean)]
  return {
    ...context.env,
    ...extra,
    PATH: Array.from(new Set(entries)).join(delimiter),
  }
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
