import type { RuntimeKind, TerminalMode } from '~/lib/contracts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, Data, Effect, Either, Layer } from 'effect'
import {
  RuntimeBinariesService,
  type RuntimeBinaryError,
  type RuntimeBinariesApi,
} from './runtime-binaries'
export { claudeProjectKey, claudeTerminalSessionId } from './claude-session-path'
import { claudeProjectKey, claudeTerminalSessionId } from './claude-session-path'
import { commonTerminalEnv, removeColorDisablingEnv, withTerminalShimPath } from './terminal-env'
import { readCodexTerminalResumeId } from './codex-terminal-session'
import {
  claudeHookSettings,
  codexKiriConfigArgs,
  codexSessionStartHookArgs,
  type KiriMcpServerConfig,
  type KirictlInvocation,
} from './terminal-shim'

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
  initialTerminalInput?: TerminalLaunchInitialInput | null
  codexResumeSessionId?: string
}

export type TerminalLaunchInitialInput = {
  readonly text: string
  readonly submit: boolean
  readonly createdAt: string
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

class TerminalLaunchService extends Context.Tag('@kiri/TerminalLaunch')<
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

const codexHookSupportTtlMs = 60 * 60_000
const codexHookSupportByCommand = new Map<string, {
  readonly supported: boolean
  readonly checkedAtMs: number
}>()

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

    switch (config.runtime) {
      case 'claude':
        return yield* claudeLaunch(config, context)
      case 'codex':
        return yield* codexLaunch(config, context)
      case 'opencode':
        return yield* opencodeLaunch(config, context)
      case 'pi':
        return yield* piLaunch(config, context)
      default:
        return yield* unsupportedRuntime(config.runtime)
    }
  })
}

function unsupportedRuntime(runtime: never) {
  return Effect.fail(new TerminalLaunchError({
    message: `Unsupported terminal runtime: ${String(runtime)}`,
  }))
}

function claudeLaunch(config: TerminalAgentLaunchConfig, context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const state = yield* parseRuntimeState(config.runtimeStateJson)
  const initialTerminalInput = firstPendingTerminalInput(state)
  const homePath = stringValue(context.env.KIRI_CLAUDE_HOME) ?? stringValue(state.homePath)
  const args = [
    '--dangerously-skip-permissions',
    '--mcp-config',
    yield* buildKiriMcpConfigJson(context),
    '--settings',
    yield* writeClaudeHookSettings(config, context),
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
  if (initialTerminalInput) args.push(initialTerminalInput.text)

  const env = yield* baseTerminalEnv(config, context)
  if (sessionId) env.KIRI_CLAUDE_SESSION_ID = sessionId
  if (context.env.KIRI_CLAUDE_USE_EXTERNAL_API_KEY !== '1') {
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.ANTHROPIC_OAUTH_TOKEN
  }
  delete env.CLAUDECODE
  if (homePath) {
    env.HOME = homePath
    env.CLAUDE_CONFIG_DIR = join(homePath, '.claude')
  } else {
    delete env.CLAUDE_CONFIG_DIR
  }

  return {
    command: yield* resolveExecutable(context, 'claude', context.env.KIRI_CLAUDE_BIN ?? stringValue(state.binaryPath)),
    args,
    cwd: config.cwd,
    env,
    label: 'claude',
    initialTerminalInput,
  }
  })
}

function writeClaudeHookSettings(config: TerminalAgentLaunchConfig, context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const hookInvocations = {
    'session-start': yield* resolveKirictlInvocation(context, ['claude-hook', 'session-start']),
    'user-prompt-submit': yield* resolveKirictlInvocation(context, ['claude-hook', 'user-prompt-submit']),
    stop: yield* resolveKirictlInvocation(context, ['claude-hook', 'stop']),
    'session-end': yield* resolveKirictlInvocation(context, ['claude-hook', 'session-end']),
    'pre-tool-use': yield* resolveKirictlInvocation(context, ['claude-hook', 'pre-tool-use']),
    'permission-request': yield* resolveKirictlInvocation(context, ['claude-hook', 'permission-request']),
    'post-tool-use': yield* resolveKirictlInvocation(context, ['claude-hook', 'post-tool-use']),
  }
  const settings = claudeHookSettings((event) => hookInvocations[event])
  const settingsPath = join(config.sessionDir, 'claude-hooks-settings.json')
  return yield* Effect.try({
    try: () => {
      mkdirSync(config.sessionDir, { recursive: true })
      writeFileSync(settingsPath, `${globalThis.JSON.stringify(settings, null, 2)}\n`)
      return settingsPath
    },
    catch: (error) => new TerminalLaunchError({
      message: 'Failed to write Claude hook settings',
      cause: error,
    }),
  })
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

function buildKiriMcpServerConfig(context: TerminalLaunchContext): Effect.Effect<KiriMcpServerConfig, RuntimeBinaryError> {
  return Effect.gen(function* () {
  const invocation = yield* resolveKirictlInvocation(context, ['mcp'])
  return invocation.args.length > 0
    ? { type: 'stdio', command: invocation.command, args: invocation.args }
    : { type: 'stdio', command: invocation.command }
  })
}

function resolveKirictlInvocation(
  context: TerminalLaunchContext,
  args: readonly string[],
): Effect.Effect<KirictlInvocation, RuntimeBinaryError> {
  return Effect.gen(function* () {
  const override = context.env.KIRI_MCP_BIN?.trim()
  if (override) {
    return {
      command: override,
      args: args.length === 1 && args[0] === 'mcp' ? [] : [...args],
    }
  }

  const packagedBin = context.resourcesPath ? join(context.resourcesPath, 'bin', 'kiri-mcp') : undefined
  if (packagedBin && context.exists(packagedBin)) {
    return {
      command: packagedBin,
      args: args.length === 1 && args[0] === 'mcp' ? [] : [...args],
    }
  }

  const builtCli = resolve(context.processCwd, 'dist/cli/kirictl.mjs')
  if (!preferSourceKirictl(context) && context.exists(builtCli)) {
    return { command: context.execPath, args: [builtCli, ...args] }
  }

  return {
    command: yield* resolveExecutable(context, 'pnpm'),
    args: ['--dir', context.processCwd, 'exec', 'tsx', resolve(context.processCwd, 'src/cli/kirictl.ts'), ...args],
  }
  })
}

function claudeKiriTerminalPrompt(agentId: string) {
  return [
    'Kiri integration:',
    `- This terminal Claude Code session is Kiri session ${agentId}.`,
    '- Keep TodoWrite current for multi-step work; Kiri projects TodoWrite into its Tasks view where supported.',
    `- Use the Kiri MCP server, especially kiri_do with operation "session.rename" and agentId "${agentId}", when the Kiri session title is generic, stale, or no longer matches the work.`,
    '- When stuck, try kiri_get "knowledge.search"; save reusable answers with kiri_do "knowledge.add", then mark helpful ones with "knowledge.markSeen".',
    `- Kiri terminals are fully drivable over MCP: kiri_get "terminal.read" and "terminal.wait-for" read/wait on this session's shell (mode "shell") or another agent's terminal; kiri_do "terminal.input" and "terminal.keys" (enter, up, c-c, ...) let you type and press keys like a human would.`,
  ].join('\n')
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

function codexLaunch(config: TerminalAgentLaunchConfig, context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const state = yield* parseRuntimeState(config.runtimeStateJson)
  const initialTerminalInput = firstPendingTerminalInput(state)
  const command = yield* resolveExecutable(context, 'codex', context.env.KIRI_CODEX_BIN)
  // No launchedAtMs exists pre-spawn, so the binding staleness guard is skipped here.
  // Plan 013 keeps stale/wrong bindings from existing by unlinking resets and rejecting subagents.
  const resume = readCodexTerminalResumeId({
    agentId: config.id,
    cwd: config.cwd,
    sessionDir: config.sessionDir,
    state,
  })
  const args = resume
    ? ['resume']
    : []
  args.push(...codexKiriConfigArgs(config.id, yield* buildKiriMcpServerConfig(context)))
  if (codexHooksSupported(command, context)) {
    args.push(...codexSessionStartHookArgs(yield* resolveKirictlInvocation(context, ['codex-hook', 'session-start'])))
  }
  args.push('--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen')
  if (config.model) args.push('--model', config.model)
  if (resume) args.push(resume)
  if (!resume && initialTerminalInput) args.push(initialTerminalInput.text)
  const env = yield* baseTerminalEnv(
    config,
    context,
    context.env.KIRI_CODEX_HOME ? { CODEX_HOME: context.env.KIRI_CODEX_HOME } : undefined,
  )
  return {
    command,
    args,
    cwd: config.cwd,
    env,
    label: 'codex',
    initialTerminalInput: resume ? null : initialTerminalInput,
    codexResumeSessionId: resume,
  }
  })
}


function preferSourceKirictl(context: TerminalLaunchContext) {
  return context.env.KIRI_PREFER_SOURCE_CLI === '1' || context.env.NODE_ENV === 'test'
}

function codexHooksSupported(command: string, context: TerminalLaunchContext) {
  if (context.env.KIRI_CODEX_HOOKS === '0') return false
  if (context.env.KIRI_CODEX_HOOKS === '1') return true

  const cached = codexHookSupportByCommand.get(command)
  const now = Date.now()
  if (cached !== undefined && now - cached.checkedAtMs < codexHookSupportTtlMs) {
    return cached.supported
  }

  const result = spawnSync(command, ['--help'], {
    encoding: 'utf8',
    env: context.env,
    timeout: 5_000,
  })
  const supported = result.status === 0
    && `${result.stdout ?? ''}\n${result.stderr ?? ''}`.includes('dangerously-bypass-hook-trust')
  codexHookSupportByCommand.set(command, { supported, checkedAtMs: now })
  return supported
}

function piLaunch(config: TerminalAgentLaunchConfig, context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const args = ['--session-dir', config.sessionDir]
  if (config.sessionFile) args.push('--session', config.sessionFile)
  if (config.model) args.push('--model', config.model)
  const env = yield* baseTerminalEnv(config, context)
  removeAnthropicOauthEnv(env)
  return {
    command: yield* resolveExecutable(context, 'pi', context.env.KIRI_PI_BIN),
    args,
    cwd: config.cwd,
    env,
    label: 'pi',
  }
  })
}

function removeAnthropicOauthEnv(env: NodeJS.ProcessEnv) {
  if (env.KIRI_PI_ALLOW_ANTHROPIC_OAUTH === '1') return
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_OAUTH_TOKEN
}

function opencodeLaunch(config: TerminalAgentLaunchConfig, context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const state = yield* parseRuntimeState(config.runtimeStateJson)
  const args = [config.cwd]
  const resume = stringValue(state.resume) ?? stringValue(state.opencodeSessionId)
  if (config.model) args.push('--model', config.model)
  if (resume) args.push('--session', resume)
  const env = yield* baseTerminalEnv(config, context)
  const homePath = context.env.KIRI_OPENCODE_HOME ?? stringValue(state.homePath)
  if (homePath) env.HOME = homePath
  return {
    command: yield* resolveExecutable(context, 'opencode', context.env.KIRI_OPENCODE_BIN ?? stringValue(state.binaryPath)),
    args,
    cwd: config.cwd,
    env,
    label: 'opencode',
  }
  })
}

function baseTerminalEnv(
  config: TerminalAgentLaunchConfig,
  context: TerminalLaunchContext,
  extra?: NodeJS.ProcessEnv,
) {
  return Effect.gen(function* () {
  return removeColorDisablingEnv(yield* context.runtimeBinaries.processEnv({
    ...extra,
    ...commonTerminalEnv(),
    KIRI_AGENT_ID: config.id,
    KIRI_PROJECT_CWD: config.cwd,
    KIRI_RUNTIME: config.runtime,
    KIRI_MODEL: config.model,
    KIRI_SESSION_DIR: config.sessionDir,
    ...(config.sessionFile ? { KIRI_SESSION_FILE: config.sessionFile } : {}),
  }))
  })
}

function shellTerminalEnv(cwd: string, context: TerminalLaunchContext) {
  return Effect.gen(function* () {
  const env = removeColorDisablingEnv(yield* context.runtimeBinaries.processEnv({
    ...commonTerminalEnv(),
    KIRI_PROJECT_CWD: cwd,
  }))
  return withTerminalShimPath(env, {
    homeDir: context.homeDir,
    baseInvocation: yield* resolveKirictlInvocation(context, []),
    mcpConfig: yield* buildKiriMcpServerConfig(context),
  })
  })
}

function parseRuntimeState(value: string | null | undefined) {
  return Effect.try({
    try: () => objectState(value),
    catch: (error) => new TerminalLaunchError({
      message: 'Invalid runtime state JSON',
      cause: error,
    }),
  })
}

function objectState(value: string | null | undefined) {
  if (!value) return {}
  const parsed: unknown = JSON.parse(value)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  throw new Error('Runtime state JSON must be an object')
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function firstPendingTerminalInput(state: Record<string, unknown>): TerminalLaunchInitialInput | null {
  const value = state.pendingTerminalInputs
  if (!isUnknownArray(value)) return null
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const textValue = objectProperty(item, 'text')
    const text = typeof textValue === 'string' ? textValue : null
    if (!text) continue
    const submitValue = objectProperty(item, 'submit')
    const createdAtValue = objectProperty(item, 'createdAt')
    return {
      text,
      submit: typeof submitValue === 'boolean' ? submitValue : true,
      createdAt: typeof createdAtValue === 'string'
        ? createdAtValue
        : new Date(0).toISOString(),
    }
  }
  return null
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function objectProperty(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined
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
