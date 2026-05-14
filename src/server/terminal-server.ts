import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { parse } from 'node:url'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import * as pty from 'node-pty'
import { terminalModeSchema, type TerminalMode } from '~/lib/contracts'
import { getAgentLaunchConfig } from './db'
import { buildTerminalProcessLaunch, type TerminalAgentLaunchConfig } from './terminal-launch'

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

type TerminalSession = {
  key: string
  cwd: string
  mode: TerminalMode
  label: string
  proc: pty.IPty
  sockets: Set<WebSocket>
  buffer: string
  idleTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
}

let terminalServer: TerminalServerInfo | null = null
let httpServer: Server | null = null
let terminalServerPromise: Promise<TerminalServerInfo> | null = null
const terminalSessions = new Map<string, TerminalSession>()

const terminalPath = '/terminal'
const terminalToken = randomBytes(32).toString('base64url')
const maxReplayBytes = 32_000
const idleKillMs = 5 * 60 * 1000

export function ensureTerminalServer(): Promise<TerminalServerInfo> {
  if (terminalServer) return Promise.resolve(terminalServer)
  if (terminalServerPromise) return terminalServerPromise
  terminalServerPromise = startTerminalServer()
  return terminalServerPromise
}

async function startTerminalServer(): Promise<TerminalServerInfo> {
  const host = process.env.KIRI_TERMINAL_HOST ?? '127.0.0.1'
  const requestedPort = numberFromEnv(process.env.KIRI_TERMINAL_PORT, 0)
  const server = createServer()
  const wss = new WebSocketServer({ server, path: terminalPath })

  wss.on('connection', (socket, request) => {
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

    let session: TerminalSession
    try {
      const config = getAgentLaunchConfig(agentId)
      const mode = parseTerminalMode(query.mode)
      const cols = positiveInt(query.cols, 100)
      const rows = positiveInt(query.rows, 30)
      session = getOrCreateTerminalSession(config, mode, cols, rows)
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
  })

  const port = await listen(server, requestedPort, host)
  httpServer = server
  terminalServer = { host, port, path: terminalPath, token: terminalToken }
  return terminalServer
}

function closeTerminalServerForTests() {
  for (const session of Array.from(terminalSessions.values())) {
    killTerminalSession(session)
  }
  terminalSessions.clear()
  httpServer?.close()
  httpServer = null
  terminalServer = null
  terminalServerPromise = null
}

function getOrCreateTerminalSession(
  config: TerminalAgentLaunchConfig,
  mode: TerminalMode,
  cols: number,
  rows: number,
) {
  const key = terminalSessionKey(config, mode)
  const existing = terminalSessions.get(key)
  if (existing && existing.cwd === config.cwd) {
    existing.proc.resize(cols, rows)
    return existing
  }
  if (existing) {
    killTerminalSession(existing)
  }

  const launch = buildTerminalProcessLaunch(config, mode, defaultShell())
  cleanupStaleClaudeSession(launch)
  const proc = pty.spawn(launch.command, launch.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: launch.cwd,
    env: launch.env,
  })
  const session: TerminalSession = {
    key,
    cwd: config.cwd,
    mode,
    label: launch.label,
    proc,
    sockets: new Set(),
    buffer: `\r\n[kiri terminal: ${launch.label} @ ${config.cwd}]\r\n`,
    idleTimer: null,
    exited: false,
  }
  terminalSessions.set(key, session)

  proc.onData((data) => {
    appendTerminalBuffer(session, data)
    broadcastTerminalData(session, data)
  })
  proc.onExit(({ exitCode, signal }) => {
    session.exited = true
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    const message = `\r\n[kiri terminal exited: ${exitCode}${signal ? ` ${signal}` : ''}]\r\n`
    appendTerminalBuffer(session, message)
    broadcastTerminalData(session, message)
    for (const socket of session.sockets) {
      socket.close()
    }
    terminalSessions.delete(key)
  })

  return session
}

function attachTerminalSocket(session: TerminalSession, socket: WebSocket) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer)
    session.idleTimer = null
  }
  session.sockets.add(socket)
  if (session.buffer) socket.send(session.buffer)
}

function detachTerminalSocket(session: TerminalSession, socket: WebSocket) {
  session.sockets.delete(socket)
  if (session.exited) return
  if (session.sockets.size > 0 || session.idleTimer) return
  session.idleTimer = setTimeout(() => {
    if (session.sockets.size === 0) killTerminalSession(session)
  }, idleKillMs)
}

function killTerminalSession(session: TerminalSession) {
  if (session.exited) return
  session.exited = true
  if (session.idleTimer) {
    clearTimeout(session.idleTimer)
    session.idleTimer = null
  }
  terminalSessions.delete(session.key)
  session.proc.kill()
}

function appendTerminalBuffer(session: TerminalSession, data: string) {
  session.buffer = `${session.buffer}${data}`.slice(-maxReplayBytes)
}

function broadcastTerminalData(session: TerminalSession, data: string) {
  for (const socket of session.sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data)
  }
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

function terminalSessionKey(config: TerminalAgentLaunchConfig, mode: TerminalMode) {
  return mode === 'shell'
    ? `${config.projectId}:shell`
    : `${config.id}:runtime`
}

function cleanupStaleClaudeSession(launch: ReturnType<typeof buildTerminalProcessLaunch>) {
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
  waitForClaudeSessionExit(sessionId, 800)
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
        if (!command.includes('claude') || !command.includes('--session-id') || !command.includes(sessionId)) return []
        return [pid]
      })
  } catch {
    return []
  }
}

function waitForClaudeSessionExit(sessionId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (findClaudeSessionPids(sessionId).length === 0) return
    sleepSync(50)
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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
