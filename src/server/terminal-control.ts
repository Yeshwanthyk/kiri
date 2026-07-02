import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { encodeTerminalKeys } from '~/lib/terminal-keys'
import type { makeTerminalRegistry } from './terminal-registry'

// Session control routes shared by the kiriterm daemon and the embedded
// terminal server, so MCP/CLI terminal operations work identically against
// either owner. Routes are keyed as "<METHOD> <pathname>".

export type TerminalRegistryApi = ReturnType<typeof makeTerminalRegistry>

export type ControlRouteResult = {
  readonly status: number
  readonly body: unknown
}

const sessionKeySchema = z.object({ key: z.string().min(1) })
const sessionReadSchema = sessionKeySchema.extend({
  cursor: z.string().min(1).optional(),
})
const sessionKeyPrefixSchema = z.object({ keyPrefix: z.string().min(1) })

const sessionInputSchema = z.object({
  key: z.string().min(1),
  data: z.string().optional(),
  keys: z.array(z.string()).optional(),
})

const sessionResizeSchema = z.object({
  key: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

const waitForSchema = z.object({
  key: z.string().min(1),
  pattern: z.string().min(1),
  flags: z.string().regex(/^[gimsuy]*$/).default(''),
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
  scope: z.enum(['screen', 'output']).default('screen'),
  followReplacement: z.boolean().default(true),
})

export const waitTargetSchema = z.object({
  key: z.string().min(1),
  label: z.string().max(200).optional(),
  pattern: z.string().min(1).max(2_000).optional(),
  flags: z.string().regex(/^[gimsuy]*$/).default(''),
  scope: z.enum(['screen', 'output']).default('screen'),
  // Resolve when the session produces no output for this long.
  idleMs: z.number().int().min(250).max(600_000).optional(),
}).refine((value) => value.pattern !== undefined || value.idleMs !== undefined, {
  message: 'Each target needs pattern and/or idleMs',
})
export type WaitTarget = z.infer<typeof waitTargetSchema>

const waitAnySchema = z.object({
  targets: z.array(waitTargetSchema).min(1).max(32),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  quorum: z.enum(['any', 'all']).default('any'),
})

export type WaitTargetMatch = {
  readonly key: string
  readonly label?: string
  readonly match?: string
  readonly idle?: boolean
  readonly tail: string[]
}

export type WaitTargetsResult = {
  readonly matched: boolean
  readonly matches: WaitTargetMatch[]
  readonly missing: string[]
  readonly elapsedMs: number
}

export function readScreenTail(
  registry: TerminalRegistryApi,
  session: Parameters<TerminalRegistryApi['readScreen']>[0],
  lines = 5,
) {
  return registry.readScreen(session).lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-lines)
}

// The shared condition engine: each live target resolves on its regex match
// and/or output-idle settle (whichever first); 'any' aborts the losers as
// soon as one target wins; missing/exited sessions are reported, not fatal.
export async function runWaitTargets(
  registry: TerminalRegistryApi,
  targets: readonly WaitTarget[],
  options: { readonly timeoutMs: number; readonly quorum: 'any' | 'all' },
): Promise<WaitTargetsResult> {
  const startedAt = Date.now()
  const missing: string[] = []
  const live = targets.flatMap((target) => {
    const session = registry.sessions.get(target.key)
    if (!session || session.exited) {
      missing.push(target.key)
      return []
    }
    return [{ target, session }]
  })
  if (live.length === 0) {
    return { matched: false, matches: [], missing, elapsedMs: Date.now() - startedAt }
  }
  const controller = new AbortController()
  const waits = live.map(({ target, session }) => {
    const races: Array<Promise<WaitTargetMatch>> = []
    if (target.pattern !== undefined) {
      races.push(registry.waitForScreen(session, {
        pattern: new RegExp(target.pattern, target.flags),
        timeoutMs: options.timeoutMs,
        scope: target.scope,
        followReplacement: true,
        signal: controller.signal,
      }).then((result) => ({
        key: target.key,
        ...(target.label === undefined ? {} : { label: target.label }),
        match: result.match,
        tail: readScreenTail(registry, registry.sessions.get(target.key) ?? session),
      })))
    }
    if (target.idleMs !== undefined) {
      races.push(registry.waitForIdle(session, {
        settleMs: target.idleMs,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
      }).then(() => ({
        key: target.key,
        ...(target.label === undefined ? {} : { label: target.label }),
        idle: true,
        tail: readScreenTail(registry, session),
      })))
    }
    return Promise.race(races).then(
      (result): WaitTargetMatch | null => result,
      (): WaitTargetMatch | null => null,
    )
  })
  if (options.quorum === 'any') {
    const winner = await new Promise<WaitTargetMatch | null>((resolve) => {
      let pending = waits.length
      for (const wait of waits) {
        void wait.then((result) => {
          if (result) {
            resolve(result)
            return
          }
          pending -= 1
          if (pending === 0) resolve(null)
        })
      }
    })
    controller.abort()
    return {
      matched: winner !== null,
      matches: winner ? [winner] : [],
      missing,
      elapsedMs: Date.now() - startedAt,
    }
  }
  const results = await Promise.all(waits)
  const matches = results.filter((result): result is WaitTargetMatch => result !== null)
  return {
    matched: matches.length === live.length && missing.length === 0,
    matches,
    missing,
    elapsedMs: Date.now() - startedAt,
  }
}

export async function handleSessionControlRoute(
  route: string,
  body: unknown,
  registry: TerminalRegistryApi,
): Promise<ControlRouteResult | null> {
  if (route === 'GET /api/sessions') {
    const sessions = Array.from(registry.sessions.values()).map((session) => ({
      key: session.key,
      mode: session.mode,
      label: session.label,
      cwd: session.cwd,
      generation: session.generation,
      cols: session.cols,
      rows: session.rows,
      attachedClients: session.sockets.size,
      exited: session.exited,
    }))
    return { status: 200, body: { sessions } }
  }

  if (route === 'POST /api/sessions/read') {
    const input = sessionReadSchema.parse(body)
    const session = registry.sessions.get(input.key)
    if (!session) return { status: 404, body: { error: `No session ${input.key}` } }
    await drained(session)
    return {
      status: 200,
      body: {
        screen: registry.readScreen(session),
        generation: session.generation,
        cursor: registry.cursor(session),
        output: registry.outputSince(session, input.cursor),
      },
    }
  }

  if (route === 'POST /api/sessions/snapshot') {
    const input = sessionKeySchema.parse(body)
    const session = registry.sessions.get(input.key)
    if (!session) return { status: 404, body: { error: `No session ${input.key}` } }
    await drained(session)
    return {
      status: 200,
      body: { snapshot: registry.snapshot(session), generation: session.generation },
    }
  }

  if (route === 'POST /api/sessions/input') {
    const input = sessionInputSchema.parse(body)
    const session = registry.sessions.get(input.key)
    if (!session || session.exited) {
      return { status: 404, body: { error: `No live session ${input.key}` } }
    }
    const data = `${input.data ?? ''}${input.keys ? encodeTerminalKeys(input.keys) : ''}`
    if (data) session.proc.write(data)
    return { status: 200, body: { ok: true } }
  }

  if (route === 'POST /api/sessions/resize') {
    const input = sessionResizeSchema.parse(body)
    const session = registry.sessions.get(input.key)
    if (!session || session.exited) {
      return { status: 404, body: { error: `No live session ${input.key}` } }
    }
    registry.resize(session, input.cols, input.rows)
    return { status: 200, body: { ok: true } }
  }

  if (route === 'POST /api/sessions/wait-for') {
    const input = waitForSchema.parse(body)
    const session = registry.sessions.get(input.key)
    if (!session) return { status: 404, body: { error: `No session ${input.key}` } }
    const startedAt = Date.now()
    try {
      const result = await registry.waitForScreen(session, {
        pattern: new RegExp(input.pattern, input.flags),
        timeoutMs: input.timeoutMs,
        scope: input.scope,
        followReplacement: input.followReplacement,
      })
      return {
        status: 200,
        body: {
          matched: true,
          match: result.match,
          generation: registry.sessions.get(input.key)?.generation ?? session.generation,
          elapsedMs: Date.now() - startedAt,
        },
      }
    } catch {
      return { status: 200, body: { matched: false, elapsedMs: Date.now() - startedAt } }
    }
  }

  // Multiplexed wait: block until one ('any') or every ('all') live target
  // satisfies its condition (regex and/or output-idle). Targets whose
  // sessions are gone are reported as missing rather than failing the whole
  // wait — workers may legitimately have exited. This is the engine behind
  // workflow.await in both delivery modes.
  if (route === 'POST /api/sessions/wait-any') {
    const input = waitAnySchema.parse(body)
    const result = await runWaitTargets(registry, input.targets, {
      timeoutMs: input.timeoutMs,
      quorum: input.quorum,
    })
    return { status: 200, body: result }
  }

  if (route === 'POST /api/sessions/kill') {
    const input = sessionKeySchema.parse(body)
    const session = registry.sessions.get(input.key)
    if (session) registry.kill(session)
    return { status: 200, body: { ok: true } }
  }

  if (route === 'POST /api/sessions/kill-prefix') {
    const input = sessionKeyPrefixSchema.parse(body)
    let killed = 0
    for (const session of registry.sessions.values()) {
      if (session.key !== input.keyPrefix && !session.key.startsWith(`${input.keyPrefix}:`)) continue
      registry.kill(session)
      killed += 1
    }
    return { status: 200, body: { ok: true, killed } }
  }

  return null
}

export function isControlRequestAuthorized(request: IncomingMessage, token: string) {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const presented = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

export async function readControlRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer<ArrayBufferLike>[] = []
  let total = 0
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > 10_000_000) throw new Error('Request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function sendControlJson(response: ServerResponse, status: number, value: unknown) {
  if (response.headersSent) {
    response.end()
    return
  }
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

function drained(session: {
  readonly headless: { write: (data: string, callback?: () => void) => void }
}) {
  return new Promise<void>((resolve) => {
    session.headless.write('', () => {
      resolve()
    })
  })
}
