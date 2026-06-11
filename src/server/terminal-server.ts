import { createServer, type IncomingMessage, type Server } from 'node:http'
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
  type TerminalClientFrame,
  type TerminalMode,
  type TerminalServerFrame,
} from '~/lib/contracts'
import { rememberCodexTerminalSession } from './codex-cli-sessions'
import {
  getAgentLaunchConfig,
  requeueAgentTerminalInputs,
  takeAgentTerminalInputs,
} from './db'
import {
  buildTerminalProcessLaunch,
  type TerminalAgentLaunchConfig,
  type TerminalProcessLaunch,
} from './terminal-launch'
import { makeTerminalRegistry, type TerminalRegistrySession } from './terminal-registry'

type TerminalServerInfo = {
  host: string
  port: number
  path: string
  token: string
}

export type TerminalServerApi = {
  readonly ensure: () => Promise<TerminalServerInfo>
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

type TerminalServerRuntime = {
  readonly token: string
  readonly registry: ReturnType<typeof makeTerminalRegistry>
  readonly dependencies: TerminalServerDependencies
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

const defaultTerminalServerService = makeTerminalServerService()

export function ensureTerminalServer(): Promise<TerminalServerInfo> {
  return defaultTerminalServerService.ensure()
}

export function closeAgentRuntimeTerminal(agentId: string) {
  defaultTerminalServerService.closeAgentRuntime(agentId)
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
): TerminalServerApi {
  let terminalServer: TerminalServerInfo | null = null
  let httpServer: Server | null = null
  let webSocketServer: WebSocketServer | null = null
  let terminalServerPromise: Promise<TerminalServerInfo> | null = null
  const runtime: TerminalServerRuntime = {
    token: randomBytes(32).toString('base64url'),
    registry: makeTerminalRegistry({
      idleKillMs,
      socketOpenState: WebSocket.OPEN,
    }),
    dependencies: {
      getAgentLaunchConfig,
      buildTerminalProcessLaunch,
      spawnPty: (command, args, options) => pty.spawn(command, [...args], options),
      rememberCodexTerminalSession,
      takeAgentTerminalInputs,
      requeueAgentTerminalInputs,
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

  return {
    ensure: () => {
      if (terminalServer) return Promise.resolve(terminalServer)
      if (terminalServerPromise) return terminalServerPromise
      terminalServerPromise = startTerminalServer(runtime).catch((error) => {
        terminalServerPromise = null
        throw error
      })
      return terminalServerPromise
    },
    spawnAgentRuntime: async (input) => {
      await ensureRuntimeTerminalServer(runtime)
      const config = runtime.dependencies.getAgentLaunchConfig(input.agentId)
      const session = await getOrCreateTerminalSession(
        runtime,
        config,
        'runtime',
        input.cols ?? 100,
        input.rows ?? 30,
      )
      scheduleHeadlessIdleKill(runtime, session)
      return {
        agentId: input.agentId,
        mode: 'runtime',
      }
    },
    closeAgentRuntime: (agentId) => {
      runtime.registry.closeAgentRuntime(agentId)
    },
    close: async () => {
      const wss = webSocketServer
      const server = httpServer
      runtime.registry.closeAll()
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
  const server = createServer()
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

  let session: TerminalRegistrySession
  try {
    const config = runtime.dependencies.getAgentLaunchConfig(agentId)
    const mode = parseTerminalMode(query.mode)
    const cols = positiveInt(query.cols, 100)
    const rows = positiveInt(query.rows, 30)
    session = await getOrCreateTerminalSession(runtime, config, mode, cols, rows)
    attachTerminalSocket(runtime, session, socket)
  } catch (error) {
    closeWithReason(socket, error instanceof Error ? error.message : String(error))
    return
  }

  socket.on('message', (raw) => {
    const message = parseClientMessage(raw)
    if (!message) return
    if (message.type === 'input') {
      session.proc.write(message.data)
      return
    }
    if (message.type === 'ack') {
      runtime.registry.ack(session, socket, message.bytes)
      return
    }
    runtime.registry.resize(session, message.cols, message.rows)
  })

  socket.on('close', () => {
    detachTerminalSocket(runtime, session, socket)
  })
}

async function getOrCreateTerminalSession(
  runtime: TerminalServerRuntime,
  config: TerminalAgentLaunchConfig,
  mode: TerminalMode,
  cols: number,
  rows: number,
) {
  const key = runtime.registry.sessionKey(config, mode)
  const existing = runtime.registry.getReusable(config, mode, cols, rows)
  if (existing) {
    writePendingTerminalInputs(runtime, config.id, existing, mode)
    return existing
  }

  const launch = runtime.dependencies.buildTerminalProcessLaunch(config, mode, defaultShell())
  await cleanupStaleClaudeSession(launch)
  const launchedAtMs = Date.now()
  const launchToken = `${launchedAtMs}:${randomBytes(8).toString('hex')}`
  const proc = runtime.dependencies.spawnPty(launch.command, launch.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: launch.cwd,
    env: launch.env,
  })
  const session = runtime.registry.register({
    key,
    cwd: config.cwd,
    mode,
    label: launch.label,
    proc,
    cols,
    rows,
    banner: `\r\n[kiri terminal: ${launch.label} @ ${config.cwd}]\r\n`,
  })
  if (mode === 'runtime' && launch.label === 'codex') {
    void runtime.dependencies.rememberCodexTerminalSession(config, launch.env, {
      launchedAtMs,
      launchToken,
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

function attachTerminalSocket(
  runtime: TerminalServerRuntime,
  session: TerminalRegistrySession,
  socket: WebSocket,
) {
  runtime.registry.attach(session, socket)
}

function detachTerminalSocket(
  runtime: TerminalServerRuntime,
  session: TerminalRegistrySession,
  socket: WebSocket,
) {
  runtime.registry.detach(session, socket)
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

function scheduleHeadlessIdleKill(
  runtime: TerminalServerRuntime,
  session: TerminalRegistrySession,
) {
  if (session.exited || session.sockets.size > 0 || session.idleTimer) return
  session.idleTimer = setTimeout(() => {
    if (session.sockets.size === 0) runtime.registry.kill(session)
  }, idleKillMs)
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
