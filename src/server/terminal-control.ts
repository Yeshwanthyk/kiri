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
})

const waitAnySchema = z.object({
  targets: z.array(z.object({
    key: z.string().min(1),
    pattern: z.string().min(1),
    flags: z.string().regex(/^[gimsuy]*$/).default(''),
    scope: z.enum(['screen', 'output']).default('screen'),
  })).min(1).max(32),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  quorum: z.enum(['any', 'all']).default('any'),
})

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
      cols: session.cols,
      rows: session.rows,
      attachedClients: session.sockets.size,
      exited: session.exited,
    }))
    return { status: 200, body: { sessions } }
  }

  if (route === 'POST /api/sessions/read') {
    const input = sessionKeySchema.parse(body)
    const session = registry.sessions.get(input.key)
    if (!session) return { status: 404, body: { error: `No session ${input.key}` } }
    await drained(session)
    return { status: 200, body: { screen: registry.readScreen(session) } }
  }

  if (route === 'POST /api/sessions/snapshot') {
    const input = sessionKeySchema.parse(body)
    const session = registry.sessions.get(input.key)
    if (!session) return { status: 404, body: { error: `No session ${input.key}` } }
    await drained(session)
    return { status: 200, body: { snapshot: registry.snapshot(session) } }
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
      })
      return {
        status: 200,
        body: { matched: true, match: result.match, elapsedMs: Date.now() - startedAt },
      }
    } catch {
      return { status: 200, body: { matched: false, elapsedMs: Date.now() - startedAt } }
    }
  }

  // Multiplexed wait: block until one ('any') or every ('all') live target
  // matches its pattern. Targets whose sessions are gone are reported as
  // missing rather than failing the whole wait — workers may legitimately
  // have exited. This is the primitive behind workflow.await: orchestrating
  // agents sleep in one call instead of polling each worker.
  if (route === 'POST /api/sessions/wait-any') {
    const input = waitAnySchema.parse(body)
    const startedAt = Date.now()
    const missing: string[] = []
    const live = input.targets.flatMap((target) => {
      const session = registry.sessions.get(target.key)
      if (!session || session.exited) {
        missing.push(target.key)
        return []
      }
      return [{ target, session }]
    })
    if (live.length === 0) {
      return { status: 200, body: { matched: false, matches: [], missing, elapsedMs: 0 } }
    }
    const controller = new AbortController()
    type WaitMatch = { key: string; match: string }
    const waits = live.map(({ target, session }) =>
      registry.waitForScreen(session, {
        pattern: new RegExp(target.pattern, target.flags),
        timeoutMs: input.timeoutMs,
        scope: target.scope,
        signal: controller.signal,
      }).then(
        (result): WaitMatch | null => ({ key: target.key, match: result.match }),
        (): WaitMatch | null => null,
      ))
    let matches: WaitMatch[]
    if (input.quorum === 'any') {
      const winner = await new Promise<WaitMatch | null>((resolve) => {
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
      matches = winner ? [winner] : []
      return {
        status: 200,
        body: {
          matched: winner !== null,
          matches,
          missing,
          elapsedMs: Date.now() - startedAt,
        },
      }
    }
    const results = await Promise.all(waits)
    matches = results.filter((result): result is WaitMatch => result !== null)
    return {
      status: 200,
      body: {
        matched: matches.length === live.length && missing.length === 0,
        matches,
        missing,
        elapsedMs: Date.now() - startedAt,
      },
    }
  }

  if (route === 'POST /api/sessions/kill') {
    const input = sessionKeySchema.parse(body)
    const session = registry.sessions.get(input.key)
    if (session) registry.kill(session)
    return { status: 200, body: { ok: true } }
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
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
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
