import { createServer, type Server } from 'node:http'
import { platform } from 'node:os'
import { parse } from 'node:url'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import * as pty from 'node-pty'
import { getAgentLaunchConfig } from './db'

type TerminalServerInfo = {
  host: string
  port: number
  path: string
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

export function ensureTerminalServer(): Promise<TerminalServerInfo> {
  if (terminalServer) return Promise.resolve(terminalServer)
  if (terminalServerPromise) return terminalServerPromise
  terminalServerPromise = startTerminalServer()
  return terminalServerPromise
}

async function startTerminalServer(): Promise<TerminalServerInfo> {
  const host = process.env.AETHER_TERMINAL_HOST ?? '127.0.0.1'
  const requestedPort = numberFromEnv(process.env.AETHER_TERMINAL_PORT, 0)
  const server = createServer()
  const wss = new WebSocketServer({ server, path: terminalPath })

  wss.on('connection', (socket, request) => {
    const agentId = parse(request.url ?? '', true).query.agentId
    if (typeof agentId !== 'string' || agentId.trim() === '') {
      closeWithReason(socket, 'Missing agent id')
      return
    }

    let proc: pty.IPty | null = null
    try {
      const config = getAgentLaunchConfig(agentId)
      const shell = defaultShell()
      const cols = positiveInt(parse(request.url ?? '', true).query.cols, 100)
      const rows = positiveInt(parse(request.url ?? '', true).query.rows, 30)
      proc = pty.spawn(shell.command, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: config.cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          AETHER_AGENT_ID: config.id,
          AETHER_PROJECT_CWD: config.cwd,
        },
      })

      proc.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data)
      })
      proc.onExit(({ exitCode, signal }) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(`\r\n[Aether terminal exited: ${exitCode}${signal ? ` ${signal}` : ''}]\r\n`)
          socket.close()
        }
      })
      socket.send(`\r\n[Aether terminal: ${config.cwd}]\r\n`)
    } catch (error) {
      closeWithReason(socket, error instanceof Error ? error.message : String(error))
      return
    }

    socket.on('message', (raw) => {
      if (!proc) return
      const message = parseClientMessage(raw)
      if (!message) return
      if (message.type === 'input') {
        proc.write(message.data)
        return
      }
      proc.resize(message.cols, message.rows)
    })

    socket.on('close', () => {
      proc?.kill()
      proc = null
    })
  })

  const port = await listen(server, requestedPort, host)
  httpServer = server
  terminalServer = { host, port, path: terminalPath }
  return terminalServer
}

export function closeTerminalServerForTests() {
  httpServer?.close()
  httpServer = null
  terminalServer = null
  terminalServerPromise = null
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
  if (socket.readyState === WebSocket.OPEN) socket.send(`\r\n[Aether terminal error: ${reason}]\r\n`)
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

function positiveInt(value: unknown, fallback: number) {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function numberFromEnv(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}
