import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { Cause, Data, Effect, Exit, Option, Schema } from 'effect'
import { z } from 'zod'
import type { AgentRuntimeState, ThinkingLevel } from '~/lib/contracts'
import { resolveRuntimeExecutable, runtimeProcessEnv } from './runtime-binaries'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const piRpcMessageSchema = z.object({
  role: z.string(),
  content: z.unknown(),
  timestamp: z.number().optional(),
})
export type PiRpcMessage = z.infer<typeof piRpcMessageSchema>

const jsonUnknownSchema = Schema.parseJson(Schema.Unknown)

const piRpcEventSchema = z
  .object({
    type: z.string(),
  })
  .passthrough()
export type PiRpcEvent = z.infer<typeof piRpcEventSchema>

export class PiRpcProcessError extends Data.TaggedError('PiRpcProcessError')<{
  operation: string
  cause: unknown
}> {}

const piRpcResponseSchema = z
  .object({
    type: z.literal('response'),
    id: z.string(),
    success: z.boolean().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
  })
  .passthrough()

const piRpcAgentEndEventSchema = piRpcEventSchema.extend({
  type: z.literal('agent_end'),
  messages: z.array(piRpcMessageSchema).optional(),
})

export class PiRpcProcessAdapter {
  private child: ChildProcessWithoutNullStreams | null = null
  private stopping = new Set<ChildProcessWithoutNullStreams>()
  private requestId = 0
  private pending = new Map<string, PendingRequest>()
  private events = new Set<(event: PiRpcEvent) => void>()
  private stderr = ''

  constructor(
    private readonly options: {
      cwd: string
      sessionDir: string
      sessionFile?: string
      model?: string
      models?: string[]
    },
  ) {}

  start() {
    runPiRpcSync(this.startEffect())
  }

  startEffect() {
    return piRpcSync('start', () => {
      if (this.child) return

      const args = ['--mode', 'rpc', '--session-dir', this.options.sessionDir]
      if (this.options.sessionFile) {
        args.push('--session', this.options.sessionFile)
      }
      if (this.options.models?.length) {
        args.push('--models', this.options.models.join(','))
      }
      if (this.options.model) {
        args.push('--model', this.options.model)
      }

      this.stderr = ''
      const child = spawn(resolveRuntimeExecutable('pi', process.env.KIRI_PI_BIN), args, {
        cwd: this.options.cwd,
        env: runtimeProcessEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child

      child.on('error', (error) => {
        if (this.child !== child) {
          this.stopping.delete(child)
          return
        }
        this.rejectPending(error)
        this.stopping.delete(child)
        this.child = null
      })

      child.on('exit', (code, signal) => {
        if (this.child !== child) {
          this.stopping.delete(child)
          return
        }
        if (!this.stopping.has(child)) {
          this.rejectPending(
            new Error(
              `Pi RPC exited${code === null ? '' : ` with code ${code}`}${
                signal ? ` from ${signal}` : ''
              }. ${this.stderr}`,
            ),
          )
        }
        this.stopping.delete(child)
        this.child = null
      })

      child.stderr.on('data', (chunk) => {
        if (this.child !== child || this.stopping.has(child)) return
        this.stderr += chunk.toString()
        this.stderr = this.stderr.slice(-8000)
      })

      this.attachJsonlReader(child)
    })
  }

  stop() {
    runPiRpcSync(this.stopEffect())
  }

  stopEffect() {
    return piRpcSync('stop', () => {
      if (!this.child) return
      const child = this.child
      this.stopping.add(child)
      child.kill('SIGTERM')
      this.child = null
      this.rejectPending(new Error('Pi RPC process stopped'))
    })
  }

  onEvent(listener: (event: PiRpcEvent) => void) {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }

  async getState(): Promise<AgentRuntimeState> {
    return runPiRpcPromise(this.getStateEffect())
  }

  getStateEffect(): Effect.Effect<AgentRuntimeState, PiRpcProcessError, never> {
    return Effect.gen(this, function* () {
      const response = yield* this.sendEffect('get_state', {})
      const data = yield* piRpcSync('get_state', () => getResponseData(response))
      return {
        kind: 'pi',
        sessionId: stringValue(data.sessionId),
        sessionFile: stringValue(data.sessionFile),
        isStreaming: data.isStreaming === true,
        messageCount: numberValue(data.messageCount),
        pendingMessageCount: numberValue(data.pendingMessageCount),
      }
    })
  }

  prompt(message: string) {
    return runPiRpcPromise(this.promptEffect(message))
  }

  promptEffect(message: string) {
    return this.sendEffect('prompt', { message })
  }

  steer(message: string) {
    return runPiRpcPromise(this.steerEffect(message))
  }

  steerEffect(message: string) {
    return this.sendEffect('steer', { message })
  }

  async promptAndWait(message: string): Promise<PiRpcMessage[]> {
    return runPiRpcPromise(this.promptAndWaitEffect(message))
  }

  promptAndWaitEffect(message: string) {
    return Effect.gen(this, function* () {
      let cleanup = () => {}
      const completion = new Promise<PiRpcMessage[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup()
          reject(new Error('Timed out waiting for Pi assistant response'))
        }, 120_000)
        const stopListening = this.onEvent((event) => {
          const result = piRpcAgentEndEventSchema.safeParse(event)
          if (!result.success) return
          cleanup()
          resolve(result.data.messages ?? [])
        })
        cleanup = () => {
          clearTimeout(timeout)
          stopListening()
        }
      })

      yield* this.promptEffect(message).pipe(
        Effect.tapError(() => Effect.sync(cleanup)),
      )
      return yield* piRpcPromise('promptAndWait', () => completion)
    })
  }

  abort() {
    return runPiRpcPromise(this.abortEffect())
  }

  abortEffect() {
    return this.sendEffect('abort', {})
  }

  async newSession() {
    return runPiRpcPromise(this.newSessionEffect())
  }

  newSessionEffect() {
    return Effect.gen(this, function* () {
      const response = yield* this.sendEffect('new_session', {})
      yield* piRpcSync('new_session', () => getResponseData(response))
    })
  }

  async clone() {
    return runPiRpcPromise(this.cloneEffect())
  }

  cloneEffect() {
    return Effect.gen(this, function* () {
      const response = yield* this.sendEffect('clone', {})
      yield* piRpcSync('clone', () => getResponseData(response))
    })
  }

  async setThinkingLevel(level: ThinkingLevel) {
    return runPiRpcPromise(this.setThinkingLevelEffect(level))
  }

  setThinkingLevelEffect(level: ThinkingLevel) {
    return Effect.gen(this, function* () {
      const response = yield* this.sendEffect('set_thinking_level', { level })
      yield* piRpcSync('set_thinking_level', () => getResponseData(response))
    })
  }

  async cycleThinkingLevel(): Promise<ThinkingLevel | null> {
    return runPiRpcPromise(this.cycleThinkingLevelEffect())
  }

  cycleThinkingLevelEffect(): Effect.Effect<ThinkingLevel | null, PiRpcProcessError, never> {
    return Effect.gen(this, function* () {
      const response = yield* this.sendEffect('cycle_thinking_level', {})
      const data = yield* piRpcSync('cycle_thinking_level', () => getResponseData(response))
      const level = stringValue(data.level)
      return level === 'off' ||
        level === 'minimal' ||
        level === 'low' ||
        level === 'medium' ||
        level === 'high' ||
        level === 'xhigh'
        ? level
        : null
    })
  }

  private sendEffect(type: string, body: Record<string, unknown>) {
    return Effect.suspend(() => {
      if (!this.child) {
        return Effect.fail(new PiRpcProcessError({
          operation: type,
          cause: new Error('Pi RPC process is not started'),
        }))
      }
      if (this.stopping.has(this.child)) {
        return Effect.fail(new PiRpcProcessError({
          operation: type,
          cause: new Error('Pi RPC process is stopping'),
        }))
      }

      const id = `kiri-${++this.requestId}`
      const command = encodeJson({ id, type, ...body }) + '\n'

      return piRpcPromise(type, () => new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!this.pending.has(id)) return
          this.pending.delete(id)
          reject(new Error(`Timed out waiting for ${type}. ${this.stderr}`))
        }, 30_000)
        this.pending.set(id, { resolve, reject, timeout })
        this.child?.stdin.write(command, (error) => {
          if (!error) return
          const pending = this.pending.get(id)
          this.pending.delete(id)
          if (pending) {
            clearTimeout(pending.timeout)
            pending.reject(error)
          }
        })
      }))
    })
  }

  private attachJsonlReader(child: ChildProcessWithoutNullStreams) {
    const decoder = new StringDecoder('utf8')
    let buffer = ''

    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk)
      let index = buffer.search(/\n/)
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        this.handleLine(child, line)
        index = buffer.search(/\n/)
      }
    })
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string) {
    if (this.child !== child || this.stopping.has(child)) return

    let payload: PiRpcEvent
    try {
      payload = piRpcEventSchema.parse(decodeJson(line))
    } catch {
      return
    }

    if (
      payload.type === 'response' &&
      typeof payload.id === 'string' &&
      this.pending.has(payload.id)
    ) {
      const pending = this.pending.get(payload.id)
      this.pending.delete(payload.id)
      if (pending) clearTimeout(pending.timeout)
      pending?.resolve(payload)
      return
    }

    for (const listener of this.events) {
      listener(payload)
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

async function runPiRpcPromise<A>(
  effect: Effect.Effect<A, PiRpcProcessError, never>,
) {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  throw piRpcCause(exit.cause)
}

function runPiRpcSync<A>(
  effect: Effect.Effect<A, PiRpcProcessError, never>,
) {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  throw piRpcCause(exit.cause)
}

function piRpcCause(cause: Cause.Cause<PiRpcProcessError>) {
  const failure = Option.getOrUndefined(Cause.failureOption(cause))
  const causeValue = failure instanceof PiRpcProcessError ? failure.cause : failure
  if (causeValue instanceof Error) return causeValue
  if (failure) return failure
  return Cause.squash(cause)
}

function piRpcError(operation: string, cause: unknown) {
  if (cause instanceof PiRpcProcessError) return cause
  return new PiRpcProcessError({ operation, cause })
}

function piRpcSync<A>(operation: string, run: () => A) {
  return Effect.try({
    try: run,
    catch: (cause) => piRpcError(operation, cause),
  })
}

function piRpcPromise<A>(operation: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => piRpcError(operation, cause),
  })
}

function encodeJson(value: unknown) {
  return Schema.encodeSync(jsonUnknownSchema)(value)
}

function decodeJson(value: string) {
  return Schema.decodeUnknownSync(jsonUnknownSchema)(value)
}

function getResponseData(response: unknown): Record<string, unknown> {
  const result = piRpcResponseSchema.safeParse(response)
  if (!result.success) return {}
  if (result.data.success === false) {
    throw new Error(
      result.data.error
        ? result.data.error
        : 'Pi RPC command failed',
    )
  }
  return result.data.data ?? {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === 'number' ? value : 0
}
