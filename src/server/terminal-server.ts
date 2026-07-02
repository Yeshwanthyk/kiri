import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { parse } from 'node:url'
import { Context, Effect, Layer } from 'effect'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import * as pty from 'node-pty'
import {
  terminalClientFrameSchema,
  terminalModeSchema,
  type AgentStatus,
  type TerminalClientFrame,
  type TerminalMode,
  type TerminalServerFrame,
} from '~/lib/contracts'
import type { AgentPresenceEvent, AgentPresenceStatus } from './agent-presence'
import { rememberCodexTerminalSession } from './codex-cli-sessions'
import { writeCodexHookSessionBinding } from './codex-terminal-session'
import {
  getAgentLaunchConfig,
  requeueAgentTerminalInputs,
  setAgentStatus,
  takeAgentTerminalInputs,
} from './db'
import {
  handleSessionControlRoute,
  isControlRequestAuthorized,
  readControlRequestBody,
  sendControlJson,
} from './terminal-control'
import {
  handleSubscriptionControlRoute,
  makeTerminalSubscriptions,
  type TerminalSubscriptionsApi,
} from './terminal-subscriptions'
import {
  buildTerminalProcessLaunch,
  type TerminalAgentLaunchConfig,
  type TerminalProcessLaunch,
} from './terminal-launch'
import { makeTerminalRegistry, type TerminalRegistrySession } from './terminal-registry'
import {
  resolveZmxBinary,
  zmxAttachArgv,
  zmxKillSession,
  zmxSessionName,
} from './zmx'

export type TerminalServerInfo = {
  host: string
  port: number
  path: string
  token: string
}

export type TerminalServerApi = {
  readonly ensure: () => Promise<TerminalServerInfo>
  // Pushes the freshest launch config to the session owner before a client
  // attaches. The embedded server resolves configs itself, so this is a no-op
  // there; the kiriterm daemon depends on it (it has no database access).
  readonly prepareAgent: (input: {
    readonly config: TerminalAgentLaunchConfig
    readonly mode: TerminalMode
  }) => Promise<void>
  readonly spawnAgentRuntime: (input: {
    readonly agentId: string
    readonly cols?: number
    readonly rows?: number
  }) => Promise<{
    readonly agentId: string
    readonly mode: 'runtime'
  }>
  readonly closeAgentRuntime: (agentId: string) => void
  readonly close: () => Promise<void>
}

export type TerminalServerControlContext = {
  readonly token: string
  readonly registry: ReturnType<typeof makeTerminalRegistry>
  readonly subscriptions: TerminalSubscriptionsApi
}

export type TerminalServerOptions = {
  // Session modes that may be reclaimed after the idle window with no clients.
  readonly idleKillModes?: readonly TerminalMode[]
  // Daemon control API hook; return true when the request was handled.
  readonly handleHttpRequest?: (
    request: IncomingMessage,
    response: ServerResponse,
    context: TerminalServerControlContext,
  ) => boolean
  // Content written into a freshly spawned session's emulator before the
  // banner (the daemon restores previous scrollback for shells this way).
  readonly restoreContent?: (key: string, mode: TerminalMode) => string | null
  // Pending wake subscriptions are journaled here so a restarted owner can
  // re-arm them (daemon only).
  readonly subscriptionsJournalPath?: string
}

type TerminalServerRuntime = {
  readonly token: string
  readonly registry: ReturnType<typeof makeTerminalRegistry>
  readonly spawnInFlight: Map<string, Promise<TerminalRegistrySession>>
  readonly dependencies: TerminalServerDependencies
  readonly options: TerminalServerOptions
  subscriptions: TerminalSubscriptionsApi
  setInfo: (info: TerminalServerInfo | null) => void
  setHttpServer: (server: Server | null) => void
  setWebSocketServer: (server: WebSocketServer | null) => void
}

type TerminalPtyProcess = ReturnType<typeof pty.spawn>

export type TerminalServerDependencies = {
  readonly getAgentLaunchConfig: (agentId: string) => TerminalAgentLaunchConfig
  readonly buildTerminalProcessLaunch: (
    config: TerminalAgentLaunchConfig,
    mode: TerminalMode,
    shell: { readonly command: string; readonly args: string[] },
  ) => TerminalProcessLaunch
  readonly spawnPty: (
    command: string,
    args: readonly string[],
    options: Parameters<typeof pty.spawn>[2],
  ) => TerminalPtyProcess
  readonly rememberCodexTerminalSession: typeof rememberCodexTerminalSession
  readonly takeAgentTerminalInputs: typeof takeAgentTerminalInputs
  readonly requeueAgentTerminalInputs: typeof requeueAgentTerminalInputs
  readonly setAgentStatus: typeof setAgentStatus
}

const terminalPath = '/terminal'
const idleKillMs = 5 * 60 * 1000

export class TerminalServerService extends Context.Tag('@kiri/TerminalServer')<
  TerminalServerService,
  TerminalServerApi
>() {
  static readonly liveLayer = Layer.sync(TerminalServerService, () =>
    TerminalServerService.of(defaultTerminalServerService))

  static readonly layer = Layer.scoped(
    TerminalServerService,
    Effect.acquireRelease(
      Effect.sync(() => makeTerminalServerService()),
      (service) => Effect.promise(() => service.close()),
    ),
  )
}

// Default service facade: prefers the detached kiriterm daemon (sessions
// survive backend/UI restarts) when KIRI_TERMINAL_DAEMON=1, falling back to
// the embedded in-process server. The choice is sticky for the process so
// sessions never split across two owners.
const defaultTerminalServerService = makeTerminalServerFacade()

function makeTerminalServerFacade(): TerminalServerApi {
  let chosen: TerminalServerApi | null = null
  let choosing: Promise<TerminalServerApi> | null = null
  let embedded: TerminalServerApi | null = null

  const embeddedService = () => {
    // Embedded PTYs are owned by this backend process. Runtime PTYs survive
    // project/resource switches, but not a backend restart; use the daemon (or
    // a future durable host) when cross-process reattach is required.
    embedded ??= makeTerminalServerService({}, { idleKillModes: ['shell'] })
    return embedded
  }

  function choose(): Promise<TerminalServerApi> {
    if (chosen) return Promise.resolve(chosen)
    if (choosing) return choosing
    choosing = (async () => {
      if (process.env.KIRI_TERMINAL_DAEMON === '1') {
        try {
          const { makeKiritermDaemonClient } = await import('./kiriterm-daemon-client')
          const client = makeKiritermDaemonClient()
          await client.ensure()
          chosen = client
          return client
        } catch (error) {
          console.error(
            'kiriterm daemon unavailable; falling back to embedded terminal server',
            error,
          )
        }
      }
      chosen = embeddedService()
      return chosen
    })().finally(() => {
      choosing = null
    })
    return choosing
  }

  return {
    ensure: () => choose().then((service) => service.ensure()),
    prepareAgent: (input) => choose().then((service) => service.prepareAgent(input)),
    spawnAgentRuntime: (input) => choose().then((service) => service.spawnAgentRuntime(input)),
    closeAgentRuntime: (agentId) => {
      choose()
        .then((service) => service.closeAgentRuntime(agentId))
        .catch((error) => {
          console.error('Kiri terminal close failed', error)
        })
    },
    close: async () => {
      if (embedded) await embedded.close()
      chosen = null
      embedded = null
    },
  }
}

export function ensureTerminalServer(): Promise<TerminalServerInfo> {
  return defaultTerminalServerService.ensure()
}

export function closeAgentRuntimeTerminal(agentId: string) {
  defaultTerminalServerService.closeAgentRuntime(agentId)
}

export function closeProjectShellTerminals(projectId: string) {
  void terminalControlRequest('sessions/kill-prefix', { keyPrefix: `${projectId}:shell` })
    .catch((error) => {
      console.error('Kiri project shell cleanup failed', error)
    })
}

export function pasteAgentRuntimeTerminal(input: {
  readonly agentId: string
}) {
  return defaultTerminalServerService.spawnAgentRuntime(input)
}

export function closeTerminalServerForTests() {
  return defaultTerminalServerService.close()
}

export function makeTerminalServerService(
  dependencies: Partial<TerminalServerDependencies> = {},
  options: TerminalServerOptions = {},
): TerminalServerApi & {
  readonly registry: ReturnType<typeof makeTerminalRegistry>
  readonly subscriptions: TerminalSubscriptionsApi
} {
  let terminalServer: TerminalServerInfo | null = null
  let httpServer: Server | null = null
  let webSocketServer: WebSocketServer | null = null
  let terminalServerPromise: Promise<TerminalServerInfo> | null = null
  const spawnInFlight = new Map<string, Promise<TerminalRegistrySession>>()
  const registry = makeTerminalRegistry({
    idleKillMs,
    socketOpenState: WebSocket.OPEN,
    idleKillModes: options.idleKillModes,
    onPresenceEvent: (key, mode, event) => {
      projectPresenceEvent(runtime, key, mode, event)
    },
  })
  const subscriptions = makeTerminalSubscriptions({
    registry,
    spawnForDelivery: (agentId) => service.spawnAgentRuntime({ agentId }),
    journalPath: options.subscriptionsJournalPath,
  })
  const runtime: TerminalServerRuntime = {
    token: randomBytes(32).toString('base64url'),
    registry,
    spawnInFlight,
    options,
    subscriptions,
    dependencies: {
      getAgentLaunchConfig,
      buildTerminalProcessLaunch,
      spawnPty: (command, args, options) => pty.spawn(command, [...args], options),
      rememberCodexTerminalSession,
      takeAgentTerminalInputs,
      requeueAgentTerminalInputs,
      setAgentStatus,
      ...dependencies,
    },
    setInfo: (info) => {
      terminalServer = info
    },
    setHttpServer: (server) => {
      httpServer = server
    },
    setWebSocketServer: (server) => {
      webSocketServer = server
    },
  }

  const service = {
    registry,
    subscriptions,
    ensure: () => {
      if (terminalServer) return Promise.resolve(terminalServer)
      if (terminalServerPromise) return terminalServerPromise
      terminalServerPromise = startTerminalServer(runtime).catch((error) => {
        terminalServerPromise = null
        throw error
      })
      return terminalServerPromise
    },
    prepareAgent: () => Promise.resolve(),
    spawnAgentRuntime: async (input: {
      readonly agentId: string
      readonly cols?: number
      readonly rows?: number
    }) => {
      await ensureRuntimeTerminalServer(runtime)
      const config = runtime.dependencies.getAgentLaunchConfig(input.agentId)
      const session = await dedupedGetOrCreateTerminalSession(
        runtime,
        config,
        'runtime',
        input.cols ?? 100,
        input.rows ?? 30,
      )
      runtime.registry.scheduleIdleKill(session)
      return {
        agentId: input.agentId,
        mode: 'runtime' as const,
      }
    },
    closeAgentRuntime: (agentId: string) => {
      killZmxRuntimeSession(agentId)
      runtime.registry.closeAgentRuntime(agentId)
    },
    close: async () => {
      const wss = webSocketServer
      const server = httpServer
      runtime.registry.closeAll()
      runtime.spawnInFlight.clear()
      webSocketServer = null
      httpServer = null
      terminalServer = null
      terminalServerPromise = null
      wss?.off('error', logTerminalServerError)
      server?.off('error', logTerminalServerError)
      await Promise.all([
        closeWebSocketServer(wss),
        closeHttpServer(server),
      ])
    },
  }

  return service

  function ensureRuntimeTerminalServer(runtime: TerminalServerRuntime) {
    if (terminalServer) return Promise.resolve(terminalServer)
    if (terminalServerPromise) return terminalServerPromise
    terminalServerPromise = startTerminalServer(runtime).catch((error) => {
      terminalServerPromise = null
      throw error
    })
    return terminalServerPromise
  }
}

function projectPresenceEvent(
  runtime: TerminalServerRuntime,
  key: string,
  mode: TerminalMode,
  event: AgentPresenceEvent,
) {
  if (mode !== 'runtime' || !('event' in event)) return
  const agentId = runtimeAgentIdFromKey(key)
  if (!agentId) return
  const status = agentStatusFromPresenceEvent(event.event)
  if (!status) return
  runtime.dependencies.setAgentStatus(agentId, status)
}

function runtimeAgentIdFromKey(key: string) {
  const suffix = ':runtime'
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) : null
}

function agentStatusFromPresenceEvent(event: AgentPresenceStatus): AgentStatus | null {
  switch (event) {
    case 'busy':
      return 'running'
    case 'awaiting_input':
      return 'blocked'
    case 'session_start':
    case 'idle':
    case 'session_end':
      return 'idle'
    default:
      return null
  }
}

function closeWebSocketServer(server: WebSocketServer | null) {
  if (!server) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function closeHttpServer(server: Server | null) {
  if (!server || !server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function startTerminalServer(runtime: TerminalServerRuntime): Promise<TerminalServerInfo> {
  const host = process.env.KIRI_TERMINAL_HOST ?? '127.0.0.1'
  const requestedPort = numberFromEnv(process.env.KIRI_TERMINAL_PORT, 0)
  const server = createServer((request, response) => {
    const handler = runtime.options.handleHttpRequest ?? defaultControlHandler
    const handled = handler(request, response, {
      token: runtime.token,
      registry: runtime.registry,
      subscriptions: runtime.subscriptions,
    })
    if (handled) return
    response.statusCode = 404
    response.end()
  })
  const wss = new WebSocketServer({ server, path: terminalPath })

  wss.on('connection', (socket, request) => {
    void handleTerminalConnection(runtime, socket, request).catch((error) => {
      closeWithReason(socket, error instanceof Error ? error.message : String(error))
    })
  })

  let port: number
  try {
    port = await listen(server, requestedPort, host, wss)
  } catch (error) {
    wss.close()
    server.close()
    throw error
  }
  server.on('error', logTerminalServerError)
  wss.on('error', logTerminalServerError)
  runtime.setHttpServer(server)
  runtime.setWebSocketServer(wss)
  const info = { host, port, path: terminalPath, token: runtime.token }
  runtime.setInfo(info)
  return info
}

async function handleTerminalConnection(
  runtime: TerminalServerRuntime,
  socket: WebSocket,
  request: IncomingMessage,
) {
  const query = parse(request.url ?? '', true).query
  if (query.token !== runtime.token) {
    closeWithReason(socket, 'Invalid terminal token')
    return
  }

  const agentId = query.agentId
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    closeWithReason(socket, 'Missing agent id')
    return
  }

  let key: string
  try {
    const config = runtime.dependencies.getAgentLaunchConfig(agentId)
    const mode = parseTerminalMode(query.mode)
    const cols = positiveInt(query.cols, 100)
    const rows = positiveInt(query.rows, 30)
    const termId = parseTermId(query.termId)
    key = runtime.registry.sessionKey(config, mode, termId)
    const session = await dedupedGetOrCreateTerminalSession(runtime, config, mode, cols, rows, termId)
    attachTerminalSocket(runtime, session, socket)
  } catch (error) {
    closeWithReason(socket, error instanceof Error ? error.message : String(error))
    return
  }

  socket.on('message', (raw) => {
    const message = parseClientMessage(raw)
    if (!message) return
    const session = runtime.registry.sessions.get(key)
    if (message.type === 'input') {
      if (session && !session.exited) session.proc.write(message.data)
      return
    }
    if (message.type === 'ack') {
      runtime.registry.ackKey(key, socket, message.bytes)
      return
    }
    if (session && !session.exited) runtime.registry.resize(session, message.cols, message.rows)
  })

  socket.on('close', () => {
    detachTerminalSocket(runtime, key, socket)
  })
}

async function dedupedGetOrCreateTerminalSession(
  runtime: TerminalServerRuntime,
  config: TerminalAgentLaunchConfig,
  mode: TerminalMode,
  cols: number,
  rows: number,
  termId = 'main',
) {
  const existing = runtime.registry.getReusable(config, mode, cols, rows, termId)
  if (existing) {
    writePendingTerminalInputs(runtime, config.id, existing, mode)
    return existing
  }

  const key = runtime.registry.sessionKey(config, mode, termId)
  let inflight = runtime.spawnInFlight.get(key)
  const joinedInFlight = Boolean(inflight)
  if (!inflight) {
    inflight = getOrCreateTerminalSession(runtime, config, mode, cols, rows, termId)
      .finally(() => {
        runtime.spawnInFlight.delete(key)
      })
    runtime.spawnInFlight.set(key, inflight)
  }

  const session = await inflight
  if (!session.exited && (session.cols !== cols || session.rows !== rows)) {
    runtime.registry.resize(session, cols, rows)
  }
  if (joinedInFlight && !session.exited) writePendingTerminalInputs(runtime, config.id, session, mode)
  return session
}

async function getOrCreateTerminalSession(
  runtime: TerminalServerRuntime,
  config: TerminalAgentLaunchConfig,
  mode: TerminalMode,
  cols: number,
  rows: number,
  termId = 'main',
) {
  const key = runtime.registry.sessionKey(config, mode, termId)
  const existing = runtime.registry.getReusable(config, mode, cols, rows, termId)
  if (existing) {
    writePendingTerminalInputs(runtime, config.id, existing, mode)
    return existing
  }

  const launch = runtime.dependencies.buildTerminalProcessLaunch(config, mode, defaultShell())
  await cleanupStaleClaudeSession(launch)
  const launchedAtMs = Date.now()
  const launchToken = `${launchedAtMs}:${randomBytes(8).toString('hex')}`
  const spawnedLaunch = wrapZmxLaunch(key, launch)
  const proc = runtime.dependencies.spawnPty(spawnedLaunch.command, spawnedLaunch.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: launch.cwd,
    env: launch.env,
  })
  if (mode === 'runtime' && launch.label === 'codex' && launch.codexResumeSessionId) {
    writeCodexHookSessionBinding(config.sessionDir, {
      agentId: config.id,
      sessionId: launch.codexResumeSessionId,
      cwd: config.cwd,
      pid: proc.pid,
      hookEventName: 'SessionStart',
      writtenAtMs: Date.now(),
    })
  }
  const restored = runtime.options.restoreContent?.(key, mode)
  const session = runtime.registry.register({
    key,
    cwd: config.cwd,
    mode,
    label: launch.label,
    proc,
    cols,
    rows,
    banner: `${restored ?? ''}\r\n[kiri terminal: ${launch.label} @ ${config.cwd}]\r\n`,
  })
  if (mode === 'runtime' && launch.label === 'codex') {
    void runtime.dependencies.rememberCodexTerminalSession(config, launch.env, {
      launchedAtMs,
      launchToken,
      pid: proc.pid,
    }).catch((error) => {
      console.error('Failed to remember Codex terminal session', error)
    })
  }

  proc.onData((data) => {
    runtime.registry.append(session, data)
    runtime.registry.broadcast(session, data)
  })
  proc.onExit(({ exitCode, signal }) => {
    const message = `\r\n[kiri terminal exited: ${exitCode}${signal ? ` ${signal}` : ''}]\r\n`
    runtime.registry.exit(session, message)
  })

  try {
    if (mode === 'runtime' && launch.initialTerminalInput) {
      consumeInitialTerminalInput(runtime, config.id, launch.initialTerminalInput)
      scheduleInitialTerminalInputSubmit(session, launch.initialTerminalInput)
    } else {
      writePendingTerminalInputs(runtime, config.id, session, mode)
    }
  } catch (error) {
    runtime.registry.kill(session)
    throw error
  }
  return session
}

function wrapZmxLaunch(
  key: string,
  launch: TerminalProcessLaunch,
): { readonly command: string; readonly args: readonly string[] } {
  const binary = resolveZmxBinary()
  if (!binary) return launch
  return {
    command: binary,
    args: zmxAttachArgv(zmxSessionName(key), launch.command, launch.args),
  }
}

function killZmxRuntimeSession(agentId: string) {
  const binary = resolveZmxBinary()
  if (!binary) return
  void zmxKillSession({
    binary,
    name: zmxSessionName(`${agentId}:runtime`),
    env: process.env,
  }).catch((error) => {
    console.error('zmx runtime kill failed', error)
  })
}

function attachTerminalSocket(
  runtime: TerminalServerRuntime,
  session: TerminalRegistrySession,
  socket: WebSocket,
) {
  runtime.registry.attach(session, socket)
}

function detachTerminalSocket(
  runtime: TerminalServerRuntime,
  key: string,
  socket: WebSocket,
) {
  runtime.registry.detachKey(key, socket)
}

function listen(server: Server, port: number, host: string, wss: WebSocketServer) {
  return new Promise<number>((resolve, reject) => {
    let settled = false
    function cleanup() {
      server.off('error', onError)
      server.off('listening', onListening)
      wss.off('error', onError)
    }
    function onError(error: Error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    function onListening() {
      if (settled) return
      settled = true
      cleanup()
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    wss.once('error', onError)
    server.listen(port, host)
  })
}

// The embedded server exposes the same session-control routes the kiriterm
// daemon serves, so MCP/CLI terminal operations work against either owner.
function defaultControlHandler(
  request: IncomingMessage,
  response: ServerResponse,
  context: TerminalServerControlContext,
): boolean {
  const url = new URL(request.url ?? '/', 'http://kiriterm.invalid')
  if (!url.pathname.startsWith('/api/')) return false
  void (async () => {
    if (!isControlRequestAuthorized(request, context.token)) {
      sendControlJson(response, 401, { error: 'Unauthorized' })
      return
    }
    const route = `${request.method ?? 'GET'} ${url.pathname}`
    if (route === 'GET /api/health') {
      sendControlJson(response, 200, {
        ok: true,
        pid: process.pid,
        version: 'embedded',
        sessions: context.registry.sessions.size,
      })
      return
    }
    const body = request.method === 'GET' ? {} : await readControlRequestBody(request)
    const result = await handleSessionControlRoute(route, body, context.registry)
    if (result) {
      sendControlJson(response, result.status, result.body)
      return
    }
    const subscriptionResult = await handleSubscriptionControlRoute(
      route,
      body,
      context.subscriptions,
    )
    if (subscriptionResult) {
      sendControlJson(response, subscriptionResult.status, subscriptionResult.body)
      return
    }
    sendControlJson(response, 404, { error: `Unknown route ${route}` })
  })().catch((error) => {
    sendControlJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  return true
}

// Runs a control-API request against whichever terminal owner this process
// uses (kiriterm daemon or embedded server). Backbone of the MCP/CLI
// terminal.read / wait-for / keys operations.
export async function terminalControlRequest(route: string, body?: unknown): Promise<unknown> {
  const info = await defaultTerminalServerService.ensure()
  const response = await fetch(`http://${info.host}:${info.port}/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${info.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(630_000),
  })
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String(payload.error)
        : `Terminal control request failed: ${route} (${response.status})`
    throw new Error(message)
  }
  return payload
}

function closeWithReason(socket: WebSocket, reason: string) {
  if (socket.readyState === WebSocket.OPEN) {
    const frame: TerminalServerFrame = {
      type: 'exit',
      message: `\r\n[kiri terminal error: ${reason}]\r\n`,
    }
    socket.send(JSON.stringify(frame))
  }
  socket.close()
}

function logTerminalServerError(error: Error) {
  console.error('Kiri terminal server error', error)
}

function parseClientMessage(raw: RawData): TerminalClientFrame | null {
  try {
    const parsed = terminalClientFrameSchema.safeParse(JSON.parse(rawDataToString(raw)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function rawDataToString(raw: RawData) {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  return Buffer.from(new Uint8Array(raw)).toString('utf8')
}

function defaultShell() {
  if (platform() === 'win32') return { command: 'powershell.exe', args: [] }
  const command = process.env.SHELL ?? '/bin/zsh'
  if (command.endsWith('/bash') || command === 'bash') return { command, args: ['--login', '-i'] }
  return { command, args: ['-l', '-i'] }
}

function parseTerminalMode(value: unknown): TerminalMode {
  return terminalModeSchema.catch('shell').parse(value)
}

function parseTermId(value: unknown) {
  return typeof value === 'string' && /^[a-z0-9-]{1,32}$/i.test(value) ? value : 'main'
}

function terminalPasteData(text: string, submit: boolean) {
  return submit ? `${text}\r` : text
}

function writePendingTerminalInputs(
  runtime: TerminalServerRuntime,
  agentId: string,
  session: TerminalRegistrySession,
  mode: TerminalMode,
) {
  if (mode !== 'runtime') return
  const inputs = runtime.dependencies.takeAgentTerminalInputs(agentId)
  const unwritten: typeof inputs = []
  for (const [index, input] of inputs.entries()) {
    const data = terminalPasteData(input.text, input.submit)
    try {
      if (data) session.proc.write(data)
    } catch (error) {
      unwritten.push(input, ...inputs.slice(index + 1))
      runtime.dependencies.requeueAgentTerminalInputs(agentId, unwritten)
      throw error
    }
  }
}

function consumeInitialTerminalInput(
  runtime: TerminalServerRuntime,
  agentId: string,
  input: NonNullable<TerminalProcessLaunch['initialTerminalInput']>,
) {
  const inputs = runtime.dependencies.takeAgentTerminalInputs(agentId)
  const [first, ...rest] = inputs
  const remaining = first && sameTerminalInput(first, input) ? rest : inputs
  if (remaining.length > 0) runtime.dependencies.requeueAgentTerminalInputs(agentId, remaining)
}

function scheduleInitialTerminalInputSubmit(
  session: TerminalRegistrySession,
  input: NonNullable<TerminalProcessLaunch['initialTerminalInput']>,
) {
  if (!input.submit) return
  const timer = setTimeout(() => {
    if (!session.exited) session.proc.write('\r')
  }, 8_000)
  timer.unref?.()
}

function sameTerminalInput(
  left: { readonly text: string; readonly submit: boolean; readonly createdAt: string },
  right: { readonly text: string; readonly submit: boolean; readonly createdAt: string },
) {
  return left.text === right.text && left.submit === right.submit && left.createdAt === right.createdAt
}

async function cleanupStaleClaudeSession(launch: ReturnType<typeof buildTerminalProcessLaunch>) {
  if (launch.label !== 'claude') return
  if (process.env.KIRI_TERMINAL_CLEANUP_STALE_CLAUDE === '0') return
  const sessionId = launch.env.KIRI_CLAUDE_SESSION_ID
  if (!sessionId) return
  const pids = findClaudeSessionPids(sessionId)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  if (pids.length === 0) return
  await waitForClaudeSessionExit(sessionId, 800)
}

function findClaudeSessionPids(sessionId: string) {
  if (platform() === 'win32') return []
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line)
        if (!match) return []
        const pid = Number(match[1])
        const command = match[2] ?? ''
        if (!Number.isInteger(pid) || pid === process.pid) return []
        if (!command.includes('claude') || !sessionIdPattern(sessionId).test(command)) return []
        return [pid]
      })
  } catch {
    return []
  }
}

async function waitForClaudeSessionExit(sessionId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (findClaudeSessionPids(sessionId).length === 0) return
    await sleep(50)
  }
}

function sessionIdPattern(sessionId: string) {
  return new RegExp(`(?:^|\\s)--(?:session-id|resume)(?:=|\\s+)${escapeRegExp(sessionId)}(?:\\s|$)`)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function positiveInt(value: unknown, fallback: number) {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function numberFromEnv(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}
