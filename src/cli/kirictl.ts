#!/usr/bin/env tsx

import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Args, Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Console, Effect, Layer, Option } from 'effect'
import { KiriControl, type KiriControlApi } from '~/server/kiri-control'
import { runKiriMcpServer } from '~/server/kiri-mcp'
import { runKiriOperation } from '~/server/kiri-router'
import { knownTerminalKeys } from '~/lib/terminal-keys'
import {
  kiriOperationSchema,
  kiriOperationResponseSchema,
  kiriWriteOperations,
  type KiriOperation,
  type KiriOperationResponse,
} from '~/lib/contracts'
import { kiriVersion } from '~/lib/version'
import {
  defaultKiritermStateDir,
  readKiritermDaemonRecord,
  runKiritermDaemon,
} from '~/server/kiriterm-daemon'
import { handleCodexSessionStartHook } from '~/server/codex-hook-handler'
import {
  handleClaudeHook,
  type ClaudeHookEvent,
} from '~/server/claude-hook-handler'
import {
  buildTerminalShimArgsScript,
  parseTerminalShimRuntime,
} from '~/server/terminal-shim'

const version = kiriVersion

const fileOption = Options.text('file').pipe(
  Options.withDescription('Read operation request JSON from file'),
  Options.optional,
)
const requestArg = Args.text({ name: 'request' }).pipe(
  Args.withDescription('Operation request JSON. If omitted, stdin is read.'),
  Args.optional,
)

const callCommand = Command.make(
  'call',
  { file: fileOption, request: requestArg },
  ({ file, request }) =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      const input = parseRequest(readRequest(optionValue(file), optionValue(request)))
      if (!input.ok) {
        yield* Console.log(globalThis.JSON.stringify(input.response))
        return
      }
      const response = yield* Effect.promise(() => runKiriOperationWithBackendFallback(control, input.value))
      yield* Console.log(globalThis.JSON.stringify(response))
    }),
).pipe(Command.withDescription('Run one JSON Kiri operation'))

const mcpCommand = Command.make('mcp', {}, () =>
  Effect.gen(function* () {
    const control = yield* KiriControl
    yield* Effect.promise(() => runKiriMcpServer(
      control,
      (request) => runKiriOperationWithBackendFallback(control, request),
    ))
  }),
).pipe(Command.withDescription('Run the Kiri MCP server over stdio'))

const stdinFileOption = Options.text('stdin-file').pipe(
  Options.withDescription('Read hook stdin from a file and unlink it'),
  Options.optional,
)

const codexHookSessionStartCommand = Command.make('session-start', { stdinFile: stdinFileOption }, ({ stdinFile }) =>
  Effect.sync(() => {
    const watchdog = setTimeout(() => process.exit(0), 5_000)
    watchdog.unref?.()
    try {
      const file = optionValue(stdinFile)
      const stdin = file ? readHookStdinFile(file) : readFileSync(0, 'utf8')
      const result = handleCodexSessionStartHook({
        stdin,
        env: process.env,
      })
      if (!result.ok) {
        console.error(`codex SessionStart hook failed: ${result.reason ?? 'unknown error'}`)
      } else if (result.reason) {
        console.error(`codex SessionStart hook: ${result.reason}`)
      }
    } finally {
      clearTimeout(watchdog)
    }
  }),
).pipe(Command.withDescription('Record a Codex SessionStart hook binding'))

const codexHookCommand = Command.make('codex-hook', {}).pipe(
  Command.withDescription('Internal Codex lifecycle hook handlers'),
  Command.withSubcommands([codexHookSessionStartCommand]),
)

function claudeHookEventCommand(event: ClaudeHookEvent) {
  return Command.make(event, {}, () =>
    Effect.gen(function* () {
      const control = yield* KiriControl
      yield* Effect.promise(() => runClaudeHook(event, control))
    })).pipe(Command.withDescription(`Record a Claude ${event} hook event`))
}

const claudeHookCommand = Command.make('claude-hook', {}).pipe(
  Command.withDescription('Internal Claude lifecycle hook handlers'),
  Command.withSubcommands([
    claudeHookEventCommand('session-start'),
    claudeHookEventCommand('user-prompt-submit'),
    claudeHookEventCommand('stop'),
    claudeHookEventCommand('session-end'),
    claudeHookEventCommand('pre-tool-use'),
    claudeHookEventCommand('permission-request'),
    claudeHookEventCommand('post-tool-use'),
  ]),
)

const termDaemonCommand = Command.make('daemon', {}, () =>
  Effect.promise(() => runKiritermDaemon()),
).pipe(Command.withDescription('Run the kiriterm session daemon (detached terminal sessions)'))

const termStopCommand = Command.make('stop', {}, () =>
  Effect.gen(function* () {
    const record = readKiritermDaemonRecord(defaultKiritermStateDir())
    if (!record) {
      yield* Console.log('kiriterm daemon is not running')
      return
    }
    const message = yield* Effect.promise(() =>
      fetch(`http://${record.host}:${record.port}/api/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${record.token}` },
        signal: AbortSignal.timeout(3_000),
      }).then(
        () => `kiriterm daemon (pid ${record.pid}) asked to shut down`,
        () => 'kiriterm daemon did not respond; it may already be stopped',
      ))
    yield* Console.log(message)
  }),
).pipe(Command.withDescription('Stop the kiriterm session daemon'))

const termModeOption = Options.text('mode').pipe(
  Options.withDescription('Terminal mode: runtime (agent) or shell'),
  Options.withDefault('runtime'),
)
const termAgentArg = Args.text({ name: 'agentId' })

const termListCommand = Command.make('ls', {}, () =>
  runTermOperation('terminal.list', {}),
).pipe(Command.withDescription('List live terminal sessions'))

const termReadCommand = Command.make(
  'read',
  { agentId: termAgentArg, mode: termModeOption },
  ({ agentId, mode }) => runTermOperation('terminal.read', { agentId, mode }),
).pipe(Command.withDescription('Read the current terminal screen'))

const termInputCommand = Command.make(
  'input',
  {
    agentId: termAgentArg,
    text: Args.text({ name: 'text' }),
    noSubmit: Options.boolean('no-submit').pipe(
      Options.withDescription('Do not press enter after the text'),
    ),
  },
  ({ agentId, text, noSubmit }) =>
    runTermOperation('terminal.input', { agentId, text, submit: !noSubmit }),
).pipe(Command.withDescription('Type text into an agent runtime terminal'))

const termKeysCommand = Command.make(
  'keys',
  {
    agentId: termAgentArg,
    mode: termModeOption,
    keys: Args.text({ name: 'keys' }).pipe(Args.repeated),
  },
  ({ agentId, mode, keys }) => runTermOperation('terminal.keys', { agentId, mode, keys }),
).pipe(Command.withDescription(`Press named keys in a terminal: ${knownTerminalKeys().join(', ')}`))

const termWaitForCommand = Command.make(
  'wait-for',
  {
    agentId: termAgentArg,
    pattern: Args.text({ name: 'pattern' }),
    mode: termModeOption,
    timeout: Options.integer('timeout-ms').pipe(Options.withDefault(30_000)),
    scope: Options.text('scope').pipe(
      Options.withDescription('Match against the visible screen or recent raw output'),
      Options.withDefault('screen'),
    ),
  },
  ({ agentId, pattern, mode, timeout, scope }) =>
    runTermOperation('terminal.wait-for', { agentId, mode, pattern, timeoutMs: timeout, scope }),
).pipe(Command.withDescription('Wait until a regex matches the terminal'))

const termShimArgsCommand = Command.make(
  'shim-args',
  { runtime: Args.text({ name: 'runtime' }) },
  ({ runtime }) =>
    Effect.sync(() => {
      const parsed = parseTerminalShimRuntime(runtime)
      if (!parsed) throw new Error(`Unsupported shim runtime: ${runtime}`)
      console.log(buildTerminalShimArgsScript({ runtime: parsed, env: process.env }))
    }),
).pipe(Command.withDescription('Internal argv injection for shell PATH shims'))

function runTermOperation(operation: string, params: Record<string, unknown>) {
  return Effect.gen(function* () {
    const control = yield* KiriControl
    const response = yield* Effect.promise(() =>
      runKiriOperationWithBackendFallback(control, { operation, params }))
    yield* Console.log(globalThis.JSON.stringify(response))
  })
}

const termCommand = Command.make('term', {}).pipe(
  Command.withDescription('Kiriterm terminal sessions: daemon lifecycle and human-parity control'),
  Command.withSubcommands([
    termDaemonCommand,
    termStopCommand,
    termListCommand,
    termReadCommand,
    termInputCommand,
    termKeysCommand,
    termWaitForCommand,
    termShimArgsCommand,
  ]),
)

export const kirictlCommand = Command.make('kirictl', {}).pipe(
  Command.withDescription('Agent-first JSON control surface for Kiri'),
  Command.withSubcommands([
    callCommand,
    claudeHookCommand,
    codexHookCommand,
    mcpCommand,
    termCommand,
  ]),
)

const MainLayer = Layer.merge(KiriControl.layer, NodeContext.layer)

export async function runKiriOperationRequest(request: unknown) {
  return Effect.runPromise(Effect.gen(function* () {
    const control = yield* KiriControl
    return yield* Effect.promise(() => runKiriOperation(control, request))
  }).pipe(Effect.provide(MainLayer)))
}

export async function runKiriOperationWithBackendFallback(
  control: KiriControlApi,
  request: unknown,
): Promise<KiriOperationResponse> {
  const backend = await tryRunBackendOperation(request)
  if (backend.kind === 'handled') return backend.response
  return runKiriOperation(control, request)
}

if (isMainModule()) {
  const cli = Command.run(kirictlCommand, {
    name: 'kirictl',
    version,
  })

  cli(process.argv).pipe(
    Effect.provide(MainLayer),
    NodeRuntime.runMain,
  )
}

function optionValue<A>(value: Option.Option<A>): A | undefined {
  return Option.getOrUndefined(value)
}

function readRequest(file: string | undefined, request: string | undefined) {
  if (file) return readFileSync(file, 'utf8')
  if (request) return request
  return readFileSync(0, 'utf8')
}

function readHookStdinFile(file: string) {
  try {
    return readFileSync(file, 'utf8')
  } finally {
    rmSync(file, { force: true })
  }
}

async function runClaudeHook(event: ClaudeHookEvent, control: KiriControlApi) {
  const watchdog = setTimeout(() => process.exit(0), 5_000)
  watchdog.unref?.()
  try {
    const result = await handleClaudeHook({
      event,
      stdin: readFileSync(0, 'utf8'),
      env: process.env,
      runOperation: (request) => runKiriOperationWithBackendFallback(control, request),
    })
    if (!result.ok) {
      console.error(`claude ${event} hook failed: ${result.reason ?? 'unknown error'}`)
    } else if (result.reason) {
      console.error(`claude ${event} hook: ${result.reason}`)
    }
  } finally {
    clearTimeout(watchdog)
  }
}

function parseRequest(input: string) {
  try {
    return { ok: true as const, value: globalThis.JSON.parse(input) as unknown }
  } catch (error) {
    return {
      ok: false as const,
      response: {
        ok: false,
        operation: 'operations.list',
        error: {
          code: 'INVALID_JSON',
          message: error instanceof Error ? error.message : 'Invalid JSON',
        },
      },
    }
  }
}

type BackendOperationResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'handled'; readonly response: KiriOperationResponse }

async function tryRunBackendOperation(request: unknown): Promise<BackendOperationResult> {
  const info = readBackendControlInfo()
  if (!info) return { kind: 'none' as const }
  if (info.pid !== null && !isProcessAlive(info.pid)) {
    removeStaleBackendControlFile(info.path)
    return { kind: 'none' as const }
  }
  const timeoutMs = backendControlTimeoutMs(request)
  try {
    const response = await fetch(new URL('/.well-known/kiri/control', info.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${info.token}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) {
      const parsed = await parseBackendResponseBody(response)
      if (!parsed) {
        return {
          kind: 'handled' as const,
          response: backendInvalidResponse(request),
        }
      }
      return {
        kind: 'handled' as const,
        response: parsed,
      }
    }
    return {
      kind: 'handled' as const,
      response: await backendErrorResponse(response, request),
    }
  } catch (error) {
    if (isTimeoutAbort(error)) {
      return {
        kind: 'handled' as const,
        response: {
          ok: false,
          operation: operationName(request),
          error: {
            code: 'BACKEND_CONTROL_TIMEOUT',
            message: `Kiri backend did not respond within ${timeoutMs}ms; the operation may still be running (set KIRI_BACKEND_CONTROL_TIMEOUT_MS to wait longer)`,
          },
        },
      }
    }
    if (isLocalWriteRefused(request, info)) {
      return {
        kind: 'handled' as const,
        response: {
          ok: false,
          operation: operationName(request),
          error: {
            code: 'BACKEND_ALIVE_LOCAL_WRITE_REFUSED',
            message: backendAliveLocalWriteRefusedMessage(info),
          },
        },
      }
    }
    return {
      kind: 'none' as const,
    }
  }
}

function isTimeoutAbort(error: unknown) {
  if (!error || typeof error !== 'object') return false
  return 'name' in error && error.name === 'TimeoutError'
}

export function backendControlTimeoutMsForTests(request: unknown) {
  return backendControlTimeoutMs(request)
}

function backendControlTimeoutMs(request: unknown) {
  const value = Number.parseInt(process.env.KIRI_BACKEND_CONTROL_TIMEOUT_MS ?? '', 10)
  if (Number.isFinite(value) && value > 0) return value
  const waitTimeoutMs = operationWaitTimeoutMs(request)
  return waitTimeoutMs === null ? 15_000 : waitTimeoutMs + 5_000
}

function operationWaitTimeoutMs(request: unknown) {
  if (!request || typeof request !== 'object') return null
  const operation = 'operation' in request && typeof request.operation === 'string'
    ? request.operation
    : null
  if (operation !== 'terminal.wait-for' && operation !== 'workflow.await') return null
  const params = 'params' in request && request.params && typeof request.params === 'object'
    ? request.params
    : null
  if (!params || !('timeoutMs' in params)) return null
  const timeoutMs = params.timeoutMs
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : null
}

async function backendErrorResponse(response: Response, request: unknown): Promise<KiriOperationResponse> {
  const parsed = await parseBackendErrorBody(response)
  if (parsed) return parsed
  return {
    ok: false,
    operation: operationName(request),
    error: {
      code: response.status === 401 || response.status === 403
        ? 'BACKEND_CONTROL_UNAUTHORIZED'
        : 'BACKEND_CONTROL_FAILED',
      message: `Kiri backend control endpoint rejected the operation: ${response.status} ${response.statusText}`.trim(),
    },
  }
}

async function parseBackendErrorBody(response: Response) {
  try {
    const value: unknown = await response.json()
    const parsed = kiriOperationResponseSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  } catch {
    // Fall through to a normalized control error.
  }
  return null
}

async function parseBackendResponseBody(response: Response) {
  try {
    const value: unknown = await response.json()
    const parsed = kiriOperationResponseSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function backendInvalidResponse(request: unknown): KiriOperationResponse {
  return {
    ok: false,
    operation: operationName(request),
    error: {
      code: 'BACKEND_CONTROL_FAILED',
      message: 'Kiri backend control endpoint returned an invalid operation response',
    },
  }
}

function operationName(request: unknown): KiriOperation {
  if (request && typeof request === 'object' && 'operation' in request && typeof request.operation === 'string') {
    const parsed = kiriOperationSchema.safeParse(request.operation)
    if (parsed.success) return parsed.data
  }
  return 'operations.list'
}

function readBackendControlInfo() {
  if (process.env.KIRI_DISABLE_BACKEND_PROXY === '1') return null
  const path = backendControlPath()
  if (!path || !existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const url = 'url' in parsed && typeof parsed.url === 'string' ? parsed.url : null
    const token = 'token' in parsed && typeof parsed.token === 'string' ? parsed.token : null
    const pid = 'pid' in parsed && typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null
    if (!url || !token) return null
    return { path, url, token, pid }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
  }
}

function removeStaleBackendControlFile(path: string) {
  try {
    unlinkSync(path)
  } catch {
    // Best effort: stale control files should not block local fallback.
  }
}

function isLocalWriteRefused(request: unknown, info: { readonly pid: number | null }) {
  if (!(kiriWriteOperations as readonly string[]).includes(operationName(request))) return false
  return info.pid === null || isProcessAlive(info.pid)
}

function backendAliveLocalWriteRefusedMessage(info: { readonly pid: number | null }) {
  if (info.pid !== null) {
    return `Kiri backend pid ${info.pid} is alive, but its control endpoint was unavailable; refusing local write execution`
  }
  return 'Kiri backend control file has no pid and its endpoint was unavailable; refusing local write execution'
}

function backendControlPath() {
  const explicit = process.env.KIRI_BACKEND_CONTROL_PATH?.trim()
  if (explicit) return resolve(explicit)
  const stateDir = process.env.KIRI_STATE_DIR?.trim()
    ? resolve(process.env.KIRI_STATE_DIR)
    : resolve(process.env.KIRI_HOME?.trim() || join(homedir(), '.kiri'), 'userdata')
  return join(stateDir, 'backend-control.json')
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
}
