import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { parse } from 'node:url'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import * as pty from 'node-pty'
import { terminalModeSchema, type TerminalMode } from '~/lib/contracts'
import { getAgentLaunchConfig } from './db'
import { buildTerminalProcessLaunch, type TerminalAgentLaunchConfig } from './terminal-launch'
import { makeTerminalRegistry, type TerminalRegistrySession } from './terminal-registry'

type TerminalServerInfo = {
  host: string
  port: number
  path: string
  token: string
}

type TerminalClientMessage =
  | {
      type: 'input'
      data: string
    }
  | {
      type: 'resize'
      cols: number
      rows: number
    }

let terminalServer: TerminalServerInfo | null = null
let httpServer: Server | null = null
let terminalServerPromise: Promise<TerminalServerInfo> | null = null

const terminalPath = '/terminal'
const terminalToken = randomBytes(32).toString('base64url')
const maxReplayBytes = 32_000
const idleKillMs = 5 * 60 * 1000
const terminalRegistry = makeTerminalRegistry({
  maxReplayBytes,
  idleKillMs,
  socketOpenState: WebSocket.OPEN,
})

export function ensureTerminalServer(): Promise<TerminalServerInfo> {
  if (terminalServer) return Promise.resolve(terminalServer)
  if (terminalServerPromise) return terminalServerPromise
  terminalServerPromise = startTerminalServer()
  return terminalServerPromise
}

export function closeAgentRuntimeTerminal(agentId: string) {
  terminalRegistry.closeAgentRuntime(agentId)
}

async function startTerminalServer(): Promise<TerminalServerInfo> {
  const host = process.env.KIRI_TERMINAL_HOST ?? '127.0.0.1'
  const requestedPort = numberFromEnv(process.env.KIRI_TERMINAL_PORT, 0)
  const server = createServer()
  const wss = new WebSocketServer({ server, path: terminalPath })

  wss.on('connection', (socket, request) => {
    void handleTerminalConnection(socket, request).catch((error) => {
      closeWithReason(socket, error instanceof Error ? error.message : String(error))
    })
  })

  const port = await listen(server, requestedPort, host)
  httpServer = server
  terminalServer = { host, port, path: terminalPath, token: terminalToken }
  return terminalServer
}

async function handleTerminalConnection(socket: WebSocket, request: IncomingMessage) {
  const query = parse(request.url ?? '', true).query
  if (query.token !== terminalToken) {
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
    const config = getAgentLaunchConfig(agentId)
    const mode = parseTerminalMode(query.mode)
    const cols = positiveInt(query.cols, 100)
    const rows = positiveInt(query.rows, 30)
    session = await getOrCreateTerminalSession(config, mode, cols, rows)
    attachTerminalSocket(session, socket)
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
    session.proc.resize(message.cols, message.rows)
  })

  socket.on('close', () => {
    detachTerminalSocket(session, socket)
  })
}

export function closeTerminalServerForTests() {
  terminalRegistry.closeAll()
  httpServer?.close()
  httpServer = null
  terminalServer = null
  terminalServerPromise = null
}

async function getOrCreateTerminalSession(
  config: TerminalAgentLaunchConfig,
  mode: TerminalMode,
  cols: number,
  rows: number,
) {
  const key = terminalRegistry.sessionKey(config, mode)
  const existing = terminalRegistry.getReusable(config, mode, cols, rows)
  if (existing) return existing

  const launch = buildTerminalProcessLaunch(config, mode, defaultShell())
  await cleanupStaleClaudeSession(launch)
  const proc = pty.spawn(launch.command, launch.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: launch.cwd,
    env: launch.env,
  })
  const session = terminalRegistry.register({
    key,
    cwd: config.cwd,
    mode,
    label: launch.label,
    proc,
    initialBuffer: `\r\n[kiri terminal: ${launch.label} @ ${config.cwd}]\r\n`,
  })

  proc.onData((data) => {
    terminalRegistry.append(session, data)
    terminalRegistry.broadcast(session, data)
  })
  proc.onExit(({ exitCode, signal }) => {
    const message = `\r\n[kiri terminal exited: ${exitCode}${signal ? ` ${signal}` : ''}]\r\n`
    terminalRegistry.exit(session, message)
  })

  return session
}

function attachTerminalSocket(session: TerminalRegistrySession, socket: WebSocket) {
  terminalRegistry.attach(session, socket)
}

function detachTerminalSocket(session: TerminalRegistrySession, socket: WebSocket) {
  terminalRegistry.detach(session, socket)
}

function listen(server: Server, port: number, host: string) {
  return new Promise<number>((resolve, reject) => {
    function onError(error: Error) {
      server.off('listening', onListening)
      reject(error)
    }
    function onListening() {
      server.off('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeWithReason(socket: WebSocket, reason: string) {
  if (socket.readyState === WebSocket.OPEN) socket.send(`\r\n[kiri terminal error: ${reason}]\r\n`)
  socket.close()
}

function parseClientMessage(raw: RawData): TerminalClientMessage | null {
  try {
    const message: unknown = JSON.parse(rawDataToString(raw))
    if (!message || typeof message !== 'object') return null
    if ('type' in message && message.type === 'input' && 'data' in message && typeof message.data === 'string') {
      return { type: 'input', data: message.data }
    }
    if ('type' in message && message.type === 'resize') {
      const cols = positiveInt('cols' in message ? message.cols : undefined, 100)
      const rows = positiveInt('rows' in message ? message.rows : undefined, 30)
      return { type: 'resize', cols, rows }
    }
  } catch {
    return null
  }
  return null
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
