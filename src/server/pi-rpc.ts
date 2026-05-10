import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import type { AgentRuntimeState } from '~/lib/contracts'

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

const piRpcEventSchema = z
  .object({
    type: z.string(),
  })
  .passthrough()
export type PiRpcEvent = z.infer<typeof piRpcEventSchema>

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
    const child = spawn('pi', args, {
      cwd: this.options.cwd,
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
  }

  stop() {
    if (!this.child) return
    const child = this.child
    this.stopping.add(child)
    child.kill('SIGTERM')
    this.child = null
    this.rejectPending(new Error('Pi RPC process stopped'))
  }

  onEvent(listener: (event: PiRpcEvent) => void) {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }

  async getState(): Promise<AgentRuntimeState> {
    const response = await this.send('get_state', {})
    const data = getResponseData(response)
    return {
      kind: 'pi',
      sessionId: stringValue(data.sessionId),
      sessionFile: stringValue(data.sessionFile),
      isStreaming: data.isStreaming === true,
      messageCount: numberValue(data.messageCount),
      pendingMessageCount: numberValue(data.pendingMessageCount),
    }
  }

  prompt(message: string) {
    return this.send('prompt', { message })
  }

  async promptAndWait(message: string): Promise<PiRpcMessage[]> {
    const completion = new Promise<PiRpcMessage[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for Pi assistant response'))
      }, 120_000)
      const cleanup = this.onEvent((event) => {
        const result = piRpcAgentEndEventSchema.safeParse(event)
        if (!result.success) return
        clearTimeout(timeout)
        cleanup()
        resolve(result.data.messages ?? [])
      })
    })

    await this.prompt(message)
    return completion
  }

  abort() {
    return this.send('abort', {})
  }

  private send(type: string, body: Record<string, unknown>) {
    if (!this.child) {
      throw new Error('Pi RPC process is not started')
    }
    if (this.stopping.has(this.child)) {
      throw new Error('Pi RPC process is stopping')
    }

    const id = `pican-${++this.requestId}`
    const command = JSON.stringify({ id, type, ...body }) + '\n'

    return new Promise<unknown>((resolve, reject) => {
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
    })
  }

  private attachJsonlReader(child: ChildProcessWithoutNullStreams) {
    const decoder = new StringDecoder('utf8')
    let buffer = ''

    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk)
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        this.handleLine(child, line)
        index = buffer.indexOf('\n')
      }
    })
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string) {
    if (this.child !== child || this.stopping.has(child)) return

    let payload: PiRpcEvent
    try {
      payload = piRpcEventSchema.parse(JSON.parse(line))
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
