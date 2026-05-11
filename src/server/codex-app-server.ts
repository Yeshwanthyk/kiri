import { spawn, type ChildProcess } from 'node:child_process'
import { Cause, Data, Effect, Exit, Option, Schema } from 'effect'
import type { RuntimeKind } from '~/lib/contracts'

const JsonRpcIdSchema = Schema.Union(Schema.String, Schema.Number)
type JsonRpcId = typeof JsonRpcIdSchema.Type

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

const UnknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

const CodexTurnSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  items: Schema.optional(Schema.Array(Schema.Unknown)),
})

export type CodexTurn = typeof CodexTurnSchema.Type

const CodexThreadSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  status: Schema.optional(UnknownRecord),
  turns: Schema.optional(Schema.Array(CodexTurnSchema)),
})

export type CodexThread = typeof CodexThreadSchema.Type

const ThreadResponseSchema = Schema.Struct({
  thread: CodexThreadSchema,
})

const TurnStartResponseSchema = Schema.Struct({
  turn: CodexTurnSchema,
})

const TokenUsageSchema = Schema.Struct({
  total: UnknownRecord,
  last: UnknownRecord,
  modelContextWindow: Schema.optional(Schema.Number),
})

export const ThreadTokenUsageUpdatedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  tokenUsage: TokenUsageSchema,
})

export const ThreadCompactedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.NullOr(Schema.String)),
})

export const TurnDiffUpdatedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  diff: Schema.optional(Schema.String),
})

export const TurnCompletedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  turn: CodexTurnSchema,
})

export const TurnStartedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  turn: Schema.optional(CodexTurnSchema),
})

export const ItemCompletedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  item: Schema.Unknown,
  completedAtMs: Schema.optional(Schema.Number),
})

export type ThreadTokenUsageUpdatedParams =
  typeof ThreadTokenUsageUpdatedParamsSchema.Type
export type ThreadCompactedParams = typeof ThreadCompactedParamsSchema.Type
export type TurnDiffUpdatedParams = typeof TurnDiffUpdatedParamsSchema.Type
export type TurnCompletedParams = typeof TurnCompletedParamsSchema.Type
export type TurnStartedParams = typeof TurnStartedParamsSchema.Type
export type ItemCompletedParams = typeof ItemCompletedParamsSchema.Type
type DecodableSchema<A> = Schema.Schema<A, A, never>

export type CodexServerMessage = JsonRpcRequest | JsonRpcNotification

type PendingRequest = {
  resume: (effect: Effect.Effect<unknown, CodexAppServerError>) => void
  timeout: ReturnType<typeof setTimeout>
}

type PendingTurnCompletion = {
  resume: (effect: Effect.Effect<CodexTurn, CodexAppServerError>) => void
  cleanup: () => void
}

class CodexAppServerError extends Data.TaggedError('CodexAppServerError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

async function runCodexEffect<A>(
  effect: Effect.Effect<A, CodexAppServerError>,
) {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
  if (failure) throw failure
  throw Cause.squash(exit.cause)
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
    this.rejectPending(codexAppServerError('Codex app-server adapter closed'))
    this.rejectTurnCompletions(codexAppServerError('Codex app-server adapter closed'))
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

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = requestTimeoutMs,
  ): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is not connected')
    }

    const id = `aether-codex-${++this.requestId}`
    const payload = JSON.stringify({ id, method, params })
    const result = await runCodexEffect(Effect.async<unknown, CodexAppServerError>((resume) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        resume(Effect.fail(codexAppServerError(
          `Timed out waiting for Codex app-server ${method}`,
        )))
      }, timeoutMs)
      this.pending.set(id, { resume, timeout })
      try {
        socket.send(payload)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timeout)
        resume(Effect.fail(codexAppServerError('Failed to send Codex app-server request', error)))
      }
      return Effect.sync(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pending.delete(id)
      })
    }))
    return result as T
  }

  private async requestDecoded<A>(
    method: string,
    params: unknown,
    schema: DecodableSchema<A>,
    timeoutMs = requestTimeoutMs,
  ): Promise<A> {
    const result = await this.request<unknown>(method, params, timeoutMs)
    return runCodexEffect(decodeUnknown(schema, result, `Invalid Codex app-server ${method} response`))
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
        name: 'Aether',
        version: '0.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    })
    this.notify('initialized')
    return result
  }

  readThread(input: { threadId: string; includeTurns?: boolean }) {
    return this.requestDecoded('thread/read', {
      threadId: input.threadId,
      includeTurns: input.includeTurns ?? true,
    }, ThreadResponseSchema)
  }

  listThreads(input: {
    cursor?: string | null
    limit?: number | null
    cwd?: string | string[] | null
    archived?: boolean | null
  } = {}) {
    return this.request<Record<string, unknown>>('thread/list', input)
  }

  resumeThread(input: {
    threadId: string
    cwd: string
    model: string
    approvalPolicy: string
    sandbox: string
  }) {
    return this.requestDecoded('thread/resume', input, ThreadResponseSchema)
  }

  startThread(input: {
    cwd: string
    model: string
    approvalPolicy: string
    sandbox: string
  }) {
    return this.requestDecoded('thread/start', input, ThreadResponseSchema)
  }

  forkThread(input: {
    threadId: string
    cwd?: string | null
    model?: string | null
    approvalPolicy?: string | null
    sandbox?: string | null
  }) {
    return this.request<Record<string, unknown>>('thread/fork', input)
  }

  rollbackThread(input: { threadId: string; numTurns: number }) {
    return this.request<Record<string, unknown>>('thread/rollback', input)
  }

  compactThread(input: { threadId: string }) {
    return this.request<Record<string, unknown>>('thread/compact/start', input)
  }

  setThreadName(input: { threadId: string; name: string }) {
    return this.request<Record<string, unknown>>('thread/name/set', input)
  }

  archiveThread(input: { threadId: string }) {
    return this.request<Record<string, unknown>>('thread/archive', input)
  }

  unarchiveThread(input: { threadId: string }) {
    return this.request<Record<string, unknown>>('thread/unarchive', input)
  }

  updateThreadMetadata(input: {
    threadId: string
    gitInfo?: Record<string, string | null | undefined> | null
  }) {
    return this.request<Record<string, unknown>>('thread/metadata/update', input)
  }

  startTurn(input: Record<string, unknown>) {
    return this.requestDecoded('turn/start', input, TurnStartResponseSchema)
  }

  steerTurn(input: {
    threadId: string
    expectedTurnId: string
    input: unknown
  }) {
    return this.request<Record<string, unknown>>('turn/steer', input)
  }

  interruptTurn(input: { threadId: string; turnId: string }) {
    return this.request<Record<string, unknown>>('turn/interrupt', input)
  }

  waitForTurnCompleted(input: { threadId: string; turnId?: string }) {
    const cached = this.completedTurn(input)
    if (cached) return cachedTurnResult(cached)

    return runCodexEffect(Effect.async<CodexTurn, CodexAppServerError>((resume) => {
      let unsubscribe = () => {}
      let cleanedUp = false
      const timeout = setTimeout(() => {
        cleanup()
        resume(Effect.fail(codexAppServerError('Timed out waiting for Codex turn completion')))
      }, turnTimeoutMs)
      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        clearTimeout(timeout)
        unsubscribe()
        this.turnCompletions.delete(pending)
      }
      const pending: PendingTurnCompletion = {
        resume,
        cleanup,
      }
      unsubscribe = this.onMessage((message) => {
        if (!('method' in message) || message.method !== 'turn/completed') return
        const params = decodeServerParams(message, TurnCompletedParamsSchema)
        if (!params || params.threadId !== input.threadId) return
        const turn = params.turn
        if (input.turnId && turn.id !== input.turnId) return
        const turnId = turn.id
        if (turnId) {
          this.completedTurns.delete(completedTurnKey(input.threadId, turnId))
        }
        cleanup()
        if (turn.status === 'failed' || turn.status === 'interrupted') {
          resume(Effect.fail(codexAppServerError(`Codex turn ${turn.status}`)))
          return
        }
        resume(Effect.succeed(turn))
      })
      this.turnCompletions.add(pending)
      return Effect.sync(cleanup)
    }))
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
    return runCodexEffect(Effect.async<void, CodexAppServerError>((resume) => {
      const socket = new WebSocket(this.options.websocketUrl)
      let settled = false
      const cleanup = () => {
        clearTimeout(failTimer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
      }
      const settle = (effect: Effect.Effect<void, CodexAppServerError>) => {
        if (settled) return
        settled = true
        cleanup()
        resume(effect)
      }
      const failTimer = setTimeout(() => {
        socket.close()
        settle(Effect.fail(codexAppServerError(
          `Timed out connecting to ${this.options.websocketUrl}`,
        )))
      }, 5_000)

      const onOpen = () => {
        this.socket = socket
        settle(Effect.void)
      }

      const onError = () => {
        settle(Effect.fail(codexAppServerError(
          `Failed to connect to ${this.options.websocketUrl}`,
        )))
      }

      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })

      socket.addEventListener('message', (event) => this.handleMessage(event.data))
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = null
        if (!this.closed) {
          this.rejectPending(codexAppServerError('Codex app-server websocket closed'))
          this.rejectTurnCompletions(codexAppServerError('Codex app-server websocket closed'))
        }
      })
      return Effect.sync(() => {
        cleanup()
        if (!settled) socket.close()
      })
    }))
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
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk}`.slice(-8000)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.rejectPending(
        codexAppServerError(
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
        pending?.resume(Effect.fail(codexAppServerError(
          response.error.message ?? 'Codex app-server request failed',
          response.error,
        )))
      } else {
        pending?.resume(Effect.succeed(response.result))
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

  private rejectPending(error: CodexAppServerError) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.resume(Effect.fail(error))
    }
    this.pending.clear()
  }

  private rejectTurnCompletions(error: CodexAppServerError) {
    for (const pending of [...this.turnCompletions]) {
      pending.cleanup()
      pending.resume(Effect.fail(error))
    }
    this.turnCompletions.clear()
  }

  private cacheCompletedTurn(message: CodexServerMessage) {
    if (!('method' in message) || message.method !== 'turn/completed') return
    const params = decodeServerParams(message, TurnCompletedParamsSchema)
    if (!params?.turn.id) return
    this.completedTurns.set(completedTurnKey(params.threadId, params.turn.id), params.turn)
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
  return process.env.AETHER_CODEX_APP_SERVER_URL ?? `ws://127.0.0.1:${defaultCodexPort}`
}

export function runtimeSupportsManagedAppServer(runtime: RuntimeKind) {
  return runtime === 'codex'
}

function parseResponse(value: unknown): JsonRpcResponse | null {
  const object = objectValue(value)
  const id = decodeUnknownOption(JsonRpcIdSchema, object.id)
  if (id === undefined) return null
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
  const id = decodeUnknownOption(JsonRpcIdSchema, object.id)
  if (id === undefined) return { method, params: object.params }
  return { id, method, params: object.params }
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

function cachedTurnResult(turn: CodexTurn) {
  if (turn.status === 'failed' || turn.status === 'interrupted') {
    return Promise.reject(codexAppServerError(`Codex turn ${turn.status}`))
  }
  return Promise.resolve(turn)
}

function codexAppServerError(message: string, cause?: unknown) {
  return new CodexAppServerError(
    cause === undefined ? { message } : { message, cause },
  )
}

function completedTurnKey(threadId: string, turnId: string) {
  return `${threadId}:${turnId}`
}

function decodeUnknown<A>(
  schema: DecodableSchema<A>,
  value: unknown,
  message: string,
) {
  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((cause) => codexAppServerError(message, cause)),
  )
}

function decodeUnknownOption<A>(schema: DecodableSchema<A>, value: unknown) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value))
}

export function decodeServerParams<A>(
  message: CodexServerMessage,
  schema: DecodableSchema<A>,
) {
  return decodeUnknownOption(schema, message.params)
}
