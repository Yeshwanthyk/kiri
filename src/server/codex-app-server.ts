import { spawn, type ChildProcess } from 'node:child_process'
import type { RuntimeKind } from '~/lib/contracts'

type JsonRpcId = string | number

type JsonRpcRequest = {
  id: JsonRpcId
  method: string
  params?: unknown
}

type JsonRpcNotification = {
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  id: JsonRpcId
  result?: unknown
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}

export type CodexServerMessage = JsonRpcRequest | JsonRpcNotification

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type PendingTurnCompletion = {
  reject: (error: Error) => void
}

const defaultCodexPort = 8390
const requestTimeoutMs = 30_000
const turnTimeoutMs = 30 * 60_000

export class CodexAppServerAdapter {
  private socket: WebSocket | null = null
  private child: ChildProcess | null = null
  private requestId = 0
  private pending = new Map<JsonRpcId, PendingRequest>()
  private turnCompletions = new Set<PendingTurnCompletion>()
  private notifications = new Set<(message: CodexServerMessage) => void>()
  private completedTurns = new Map<string, unknown>()
  private connectPromise: Promise<void> | null = null
  private closed = false

  constructor(
    private readonly options: {
      websocketUrl: string
      spawnIfMissing?: boolean
      codexHome?: string
    },
  ) {}

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = this.connectInner().finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  close() {
    this.closed = true
    this.rejectPending(new Error('Codex app-server adapter closed'))
    this.rejectTurnCompletions(new Error('Codex app-server adapter closed'))
    this.completedTurns.clear()
    this.socket?.close()
    this.socket = null
    this.child?.kill('SIGTERM')
    this.child = null
  }

  onMessage(listener: (message: CodexServerMessage) => void) {
    this.notifications.add(listener)
    return () => this.notifications.delete(listener)
  }

  async request(method: string, params?: unknown, timeoutMs = requestTimeoutMs) {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is not connected')
    }

    const id = `pican-codex-${++this.requestId}`
    const payload = JSON.stringify({ id, method, params })
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for Codex app-server ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      try {
        socket.send(payload)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown) {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is not connected')
    }
    socket.send(JSON.stringify({ method, params }))
  }

  respond(id: JsonRpcId, result: unknown) {
    this.sendMessage({ id, result })
  }

  reject(id: JsonRpcId, message: string, code = -32000, data?: unknown) {
    this.sendMessage({ id, error: { code, message, data } })
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: {
        name: 'Pican',
        version: '0.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    })
    this.notify('initialized')
    return result
  }

  waitForTurnCompleted(input: { threadId: string; turnId?: string }) {
    const cached = this.completedTurn(input)
    if (cached) return cachedTurnResult(cached)

    return new Promise<unknown>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>
      let unsubscribe = () => {}
      let cleanedUp = false
      let pending: PendingTurnCompletion
      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        clearTimeout(timeout)
        unsubscribe()
        this.turnCompletions.delete(pending)
      }
      pending = {
        reject: (error) => {
          cleanup()
          reject(error)
        },
      }
      timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for Codex turn completion'))
      }, turnTimeoutMs)
      unsubscribe = this.onMessage((message) => {
        if (!('method' in message) || message.method !== 'turn/completed') return
        const params = objectValue(message.params)
        if (stringValue(params.threadId) !== input.threadId) return
        const turn = objectValue(params.turn)
        if (input.turnId && stringValue(turn.id) !== input.turnId) return
        const turnId = stringValue(turn.id)
        if (turnId) {
          this.completedTurns.delete(completedTurnKey(input.threadId, turnId))
        }
        cleanup()
        if (turn.status === 'failed' || turn.status === 'interrupted') {
          reject(new Error(`Codex turn ${turn.status}`))
          return
        }
        resolve(turn)
      })
      this.turnCompletions.add(pending)
    })
  }

  private sendMessage(message: unknown) {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is not connected')
    }
    socket.send(JSON.stringify(message))
  }

  private async connectInner() {
    this.closed = false
    try {
      await this.openWebSocket()
    } catch (error) {
      if (!this.options.spawnIfMissing) throw error
      await this.spawnLocalAppServer()
      await this.openWebSocket()
    }
    await this.initialize()
  }

  private openWebSocket() {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.options.websocketUrl)
      const failTimer = setTimeout(() => {
        socket.close()
        reject(new Error(`Timed out connecting to ${this.options.websocketUrl}`))
      }, 5_000)

      socket.addEventListener('open', () => {
        clearTimeout(failTimer)
        this.socket = socket
        resolve()
      }, { once: true })

      socket.addEventListener('error', () => {
        clearTimeout(failTimer)
        reject(new Error(`Failed to connect to ${this.options.websocketUrl}`))
      }, { once: true })

      socket.addEventListener('message', (event) => this.handleMessage(event.data))
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = null
        if (!this.closed) {
          this.rejectPending(new Error('Codex app-server websocket closed'))
          this.rejectTurnCompletions(new Error('Codex app-server websocket closed'))
        }
      })
    })
  }

  private async spawnLocalAppServer() {
    const port = portFromWebsocketUrl(this.options.websocketUrl)
    if (!port) throw new Error(`Cannot spawn Codex app-server for ${this.options.websocketUrl}`)

    const child = spawn('codex', [
      'app-server',
      '--listen',
      this.options.websocketUrl,
    ], {
      env: this.options.codexHome
        ? { ...process.env, CODEX_HOME: this.options.codexHome }
        : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8000)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.rejectPending(
        new Error(
          `Codex app-server exited${code === null ? '' : ` with code ${code}`}${
            signal ? ` from ${signal}` : ''
          }. ${stderr}`,
        ),
      )
    })

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250)
      try {
        const socket = new WebSocket(this.options.websocketUrl)
        await waitForProbe(socket)
        return
      } catch {
        // Keep polling until the child binds.
      }
    }

    child.kill('SIGTERM')
    throw new Error(`Codex app-server did not become ready on port ${port}. ${stderr}`)
  }

  private handleMessage(data: unknown) {
    const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : ''
    if (!text) return

    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }

    const response = parseResponse(message)
    if (response && this.pending.has(response.id)) {
      const pending = this.pending.get(response.id)
      this.pending.delete(response.id)
      if (pending) clearTimeout(pending.timeout)
      if (response.error) {
        pending?.reject(new Error(response.error.message ?? 'Codex app-server request failed'))
      } else {
        pending?.resolve(response.result)
      }
      return
    }

    const serverMessage = parseServerMessage(message)
    if (!serverMessage) return
    this.cacheCompletedTurn(serverMessage)
    for (const listener of this.notifications) {
      listener(serverMessage)
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private rejectTurnCompletions(error: Error) {
    for (const pending of [...this.turnCompletions]) {
      pending.reject(error)
    }
    this.turnCompletions.clear()
  }

  private cacheCompletedTurn(message: CodexServerMessage) {
    if (!('method' in message) || message.method !== 'turn/completed') return
    const params = objectValue(message.params)
    const threadId = stringValue(params.threadId)
    const turn = objectValue(params.turn)
    const turnId = stringValue(turn.id)
    if (!threadId || !turnId) return
    this.completedTurns.set(completedTurnKey(threadId, turnId), turn)
  }

  private completedTurn(input: { threadId: string; turnId?: string }) {
    if (input.turnId) {
      const key = completedTurnKey(input.threadId, input.turnId)
      const turn = this.completedTurns.get(key)
      if (turn) this.completedTurns.delete(key)
      return turn
    }
    for (const [key, turn] of this.completedTurns.entries()) {
      if (key.startsWith(`${input.threadId}:`)) {
        this.completedTurns.delete(key)
        return turn
      }
    }
    return undefined
  }
}

export function defaultCodexWebsocketUrl() {
  return process.env.PICAN_CODEX_APP_SERVER_URL ?? `ws://127.0.0.1:${defaultCodexPort}`
}

export function runtimeSupportsManagedAppServer(runtime: RuntimeKind) {
  return runtime === 'codex'
}

function parseResponse(value: unknown): JsonRpcResponse | null {
  const object = objectValue(value)
  const id = idValue(object.id)
  if (id === null) return null
  if (!('result' in object) && !('error' in object)) return null
  const error = objectValue(object.error)
  return {
    id,
    result: object.result,
    error: object.error
      ? {
          code: numberValue(error.code),
          message: stringValue(error.message),
          data: error.data,
        }
      : undefined,
  }
}

function parseServerMessage(value: unknown): CodexServerMessage | null {
  const object = objectValue(value)
  const method = stringValue(object.method)
  if (!method) return null
  const id = idValue(object.id)
  if (id === null) return { method, params: object.params }
  return { id, method, params: object.params }
}

function idValue(value: unknown): JsonRpcId | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === 'number' ? value : undefined
}

function portFromWebsocketUrl(value: string) {
  try {
    const url = new URL(value)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
      ? Number(url.port)
      : null
  } catch {
    return null
  }
}

function waitForProbe(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('probe timed out'))
    }, 500)
    socket.addEventListener('open', () => {
      clearTimeout(timeout)
      socket.close()
      resolve()
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('probe failed'))
    }, { once: true })
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cachedTurnResult(turn: unknown) {
  const object = objectValue(turn)
  if (object.status === 'failed' || object.status === 'interrupted') {
    return Promise.reject(new Error(`Codex turn ${object.status}`))
  }
  return Promise.resolve(turn)
}

function completedTurnKey(threadId: string, turnId: string) {
  return `${threadId}:${turnId}`
}
