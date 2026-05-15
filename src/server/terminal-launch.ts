import { createHash } from 'node:crypto'
import type { RuntimeKind, TerminalMode } from '~/lib/contracts'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, Data, Effect, Either, Layer } from 'effect'
import {
  RuntimeBinariesService,
  type RuntimeBinariesApi,
} from './runtime-binaries'

export type TerminalAgentLaunchConfig = {
  id: string
  projectId: string
  runtime: RuntimeKind
  sessionDir: string
  sessionFile: string | null
  model: string
  cwd: string
  runtimeStateJson?: string | null
}

export type TerminalProcessLaunch = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  label: string
}

export class TerminalLaunchError extends Data.TaggedError('TerminalLaunchError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type TerminalLaunchServiceApi = {
  readonly buildProcessLaunch: (input: {
    readonly config: TerminalAgentLaunchConfig
    readonly mode: TerminalMode
    readonly shell: { readonly command: string; readonly args: string[] }
  }) => Effect.Effect<TerminalProcessLaunch, TerminalLaunchError>
}

export class TerminalLaunchService extends Context.Tag('@kiri/TerminalLaunch')<
  TerminalLaunchService,
  TerminalLaunchServiceApi
>() {
  static readonly layer = Layer.effect(
    TerminalLaunchService,
    Effect.gen(function* () {
      const runtimeBinaries = yield* RuntimeBinariesService
      return TerminalLaunchService.of(makeTerminalLaunchService({ runtimeBinaries }))
    }),
  )
}

type TerminalLaunchContext = {
  readonly env: NodeJS.ProcessEnv
  readonly homeDir: string
  readonly exists: (path: string) => boolean
  readonly processCwd: string
  readonly execPath: string
  readonly resourcesPath?: string
  readonly runtimeBinaries: RuntimeBinariesApi
}

export function makeTerminalLaunchService(input: {
  readonly runtimeBinaries: RuntimeBinariesApi
  readonly getEnv?: () => NodeJS.ProcessEnv
  readonly getHomeDir?: () => string
  readonly exists?: (path: string) => boolean
  readonly getProcessCwd?: () => string
  readonly getExecPath?: () => string
  readonly getResourcesPath?: () => string | undefined
}): TerminalLaunchServiceApi {
  const context = (): TerminalLaunchContext => ({
    env: input.getEnv?.() ?? process.env,
    homeDir: input.getHomeDir?.() ?? homedir(),
    exists: input.exists ?? existsSync,
    processCwd: input.getProcessCwd?.() ?? process.cwd(),
    execPath: input.getExecPath?.() ?? process.execPath,
    resourcesPath: input.getResourcesPath?.()
      ?? stringValue((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath),
    runtimeBinaries: input.runtimeBinaries,
  })

  return {
    buildProcessLaunch: Effect.fn('TerminalLaunch.buildProcessLaunch')(function* (request) {
      return yield* buildTerminalProcessLaunchEffect(
        request.config,
        request.mode,
        request.shell,
        context(),
      ).pipe(
        Effect.mapError((error) => error instanceof TerminalLaunchError
          ? error
          : new TerminalLaunchError({
            message: error instanceof Error ? error.message : 'Terminal launch resolution failed',
            cause: error,
          })),
      )
    }),
  }
}

export function buildTerminalProcessLaunch(
  config: TerminalAgentLaunchConfig,
  mode: TerminalMode,
  shell: { command: string; args: string[] },
): TerminalProcessLaunch {
  return runTerminalLaunch(Effect.gen(function* () {
    const service = yield* TerminalLaunchService
    return yield* service.buildProcessLaunch({ config, mode, shell })
  }))
}

function buildTerminalProcessLaunchEffect(
  config: TerminalAgentLaunchConfig,
  mode: TerminalMode,
  shell: { readonly command: string; readonly args: readonly string[] },
  context: TerminalLaunchContext,
) {
  return Effect.gen(function* () {
    if (mode === 'shell') {
      return {
        command: shell.command,
        args: [...shell.args],
        cwd: config.cwd,
        env: yield* shellTerminalEnv(config.cwd, context),
        label: 'shell',
      }
    }

    if (config.runtime === 'claude') return yield* claudeLaunch(config, context)
    if (config.runtime === 'codex') return yield* codexLaunch(config, context)
    return yield* piLaunch(config, context)
  })
}

function claudeLaunch(config: TerminalAgentLaunchConfig, context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const state = objectState(config.runtimeStateJson)
  const homePath = context.env.KIRI_CLAUDE_HOME ?? stringValue(state.homePath)
  const args = [
    '--dangerously-skip-permissions',
    '--mcp-config',
    yield* buildKiriMcpConfigJson(context),
    '--append-system-prompt',
    claudeKiriTerminalPrompt(config.id),
  ]
  if (config.model) args.push('--model', config.model)
  const resume = stringValue(state.resume)
  let sessionId: string | undefined
  if (resume) {
    args.push('--resume', resume)
  } else {
    sessionId = claudeTerminalSessionId(config.id, state)
    if (claudeSessionExists(config.cwd, sessionId, homePath, context)) {
      args.push('--resume', sessionId)
    } else {
      args.push('--session-id', sessionId)
    }
  }

  const env = yield* baseTerminalEnv(config, context)
  if (sessionId) env.KIRI_CLAUDE_SESSION_ID = sessionId
  if (context.env.KIRI_CLAUDE_USE_EXTERNAL_API_KEY !== '1') {
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.ANTHROPIC_OAUTH_TOKEN
  }
  if (homePath) env.HOME = homePath

  return {
    command: yield* resolveExecutable(context, 'claude', context.env.KIRI_CLAUDE_BIN ?? stringValue(state.binaryPath)),
    args,
    cwd: config.cwd,
    env,
    label: 'claude',
  }
  })
}

function buildKiriMcpConfigJson(context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  return JSON.stringify({
    mcpServers: {
      kiri: yield* buildKiriMcpServerConfig(context),
    },
  })
  })
}

function buildKiriMcpServerConfig(context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const override = context.env.KIRI_MCP_BIN?.trim()
  if (override) return { type: 'stdio', command: override }

  const packagedBin = context.resourcesPath ? join(context.resourcesPath, 'bin', 'kiri-mcp') : undefined
  if (packagedBin && context.exists(packagedBin)) return { type: 'stdio', command: packagedBin }

  const builtCli = resolve(context.processCwd, 'dist/cli/kirictl.mjs')
  if (context.exists(builtCli)) {
    return { type: 'stdio', command: context.execPath, args: [builtCli, 'mcp'] }
  }

  return {
    type: 'stdio',
    command: yield* resolveExecutable(context, 'pnpm'),
    args: ['exec', 'tsx', resolve(context.processCwd, 'src/cli/kirictl.ts'), 'mcp'],
  }
  })
}

function claudeKiriTerminalPrompt(agentId: string) {
  return [
    'Kiri integration:',
    `- This terminal Claude Code session is Kiri session ${agentId}.`,
    '- Keep TodoWrite current for multi-step work; Kiri projects TodoWrite into its Tasks view where supported.',
    `- Use the Kiri MCP server, especially kiri_rename_session with agentId "${agentId}", when the Kiri session title is generic, stale, or no longer matches the work.`,
  ].join('\n')
}

export function claudeTerminalSessionId(agentId: string, state: Record<string, unknown> = {}) {
  const configured = stringValue(state.sessionId)
  if (configured && isUuid(configured)) return configured
  return deterministicUuid(`kiri:claude:${agentId}`)
}

function deterministicUuid(input: string) {
  const bytes = Array.from(createHash('sha256').update(input).digest().subarray(0, 16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function claudeSessionExists(
  cwd: string,
  sessionId: string,
  homePath: string | undefined,
  context: TerminalLaunchContext,
) {
  const claudeHome = join(homePath ?? context.homeDir, '.claude')
  const projectDir = join(claudeHome, 'projects', claudeProjectKey(cwd))
  return context.exists(join(projectDir, `${sessionId}.jsonl`))
    || context.exists(join(projectDir, sessionId))
}

function claudeProjectKey(cwd: string) {
  return resolve(cwd).replace(/[\\/]/g, '-')
}

function codexLaunch(config: TerminalAgentLaunchConfig, context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const state = objectState(config.runtimeStateJson)
  const resume = stringValue(state.resume) ?? stringValue(state.codexSessionId)
  const args = resume
    ? ['resume', '--dangerously-bypass-approvals-and-sandbox']
    : ['--dangerously-bypass-approvals-and-sandbox']
  if (config.model) args.push('--model', config.model)
  if (resume) args.push(resume)
  const env = yield* baseTerminalEnv(
    config,
    context,
    context.env.KIRI_CODEX_HOME ? { CODEX_HOME: context.env.KIRI_CODEX_HOME } : undefined,
  )
  return {
    command: yield* resolveExecutable(context, 'codex', context.env.KIRI_CODEX_BIN),
    args,
    cwd: config.cwd,
    env,
    label: 'codex',
  }
  })
}

function piLaunch(config: TerminalAgentLaunchConfig, context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const args = ['--session-dir', config.sessionDir]
  if (config.sessionFile) args.push('--session', config.sessionFile)
  if (config.model) args.push('--model', config.model)
  return {
    command: yield* resolveExecutable(context, 'pi', context.env.KIRI_PI_BIN),
    args,
    cwd: config.cwd,
    env: yield* baseTerminalEnv(config, context),
    label: 'pi',
  }
  })
}

function baseTerminalEnv(
  config: TerminalAgentLaunchConfig,
  context: TerminalLaunchContext,
  extra?: NodeJS.ProcessEnv,
) {
  return Effect.gen(function* () {
  const env = yield* context.runtimeBinaries.processEnv({
    ...extra,
    ...commonTerminalEnv(),
    KIRI_AGENT_ID: config.id,
    KIRI_PROJECT_CWD: config.cwd,
    KIRI_RUNTIME: config.runtime,
    KIRI_MODEL: config.model,
    KIRI_SESSION_DIR: config.sessionDir,
    ...(config.sessionFile ? { KIRI_SESSION_FILE: config.sessionFile } : {}),
  })
  delete env.NO_COLOR
  delete env.NODE_DISABLE_COLORS
  return env
  })
}

function shellTerminalEnv(cwd: string, context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const env = yield* context.runtimeBinaries.processEnv({
    ...commonTerminalEnv(),
    KIRI_PROJECT_CWD: cwd,
  })
  delete env.NO_COLOR
  delete env.NODE_DISABLE_COLORS
  return env
  })
}

function commonTerminalEnv() {
  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
  }
}

function objectState(value: string | null | undefined) {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function resolveExecutable(
  context: TerminalLaunchContext,
  command: string,
  configuredPath?: string,
) {
  return context.runtimeBinaries.resolveExecutable({ command, configuredPath })
}

function runTerminalLaunch<A>(
  effect: Effect.Effect<A, TerminalLaunchError, TerminalLaunchService>,
) {
  const result = Effect.runSync(
    effect.pipe(
      Effect.provide(TerminalLaunchService.layer.pipe(
        Layer.provide(RuntimeBinariesService.layer),
      )),
      Effect.either,
    ),
  )
  if (Either.isRight(result)) return result.right
  throw result.left
}
