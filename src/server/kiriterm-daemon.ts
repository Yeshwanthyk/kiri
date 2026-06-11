import { timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { TerminalMode } from '~/lib/contracts'
import { encodeTerminalKeys } from '~/lib/terminal-keys'
import type { makeTerminalRegistry } from './terminal-registry'
import {
  makeTerminalServerService,
  type TerminalServerInfo,
} from './terminal-server'
import type { TerminalAgentLaunchConfig } from './terminal-launch'

// The kiriterm daemon owns PTY sessions independently of the kiri backend and
// UI: it hosts the terminal WebSocket server plus an HTTP control API, and
// persists scrollback snapshots so shell history survives restarts. It has no
// database access — the backend pushes launch configs in via /agents/upsert.

export type KiritermDaemonRecord = {
  readonly pid: number
  readonly host: string
  readonly port: number
  readonly path: string
  readonly token: string
  readonly version: string
  readonly startedAt: string
}

export type KiritermCodexLaunch = {
  readonly agentId: string
  readonly codexHome: string | null
  readonly launchedAtMs: number
  readonly launchToken: string
}

const pendingInputSchema = z.object({
  text: z.string(),
  submit: z.boolean(),
  createdAt: z.string(),
})

const launchConfigSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  runtime: z.enum(['claude', 'codex', 'opencode', 'pi']),
  sessionDir: z.string(),
  sessionFile: z.string().nullable(),
  model: z.string(),
  cwd: z.string().min(1),
  runtimeStateJson: z.string().nullable().optional(),
})

const upsertAgentSchema = z.object({
  config: launchConfigSchema,
  pendingInputs: z.array(pendingInputSchema).optional(),
})

const spawnAgentSchema = z.object({
  agentId: z.string().min(1),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
})

const agentIdSchema = z.object({ agentId: z.string().min(1) })

const agentInputSchema = z.object({
  agentId: z.string().min(1),
  text: z.string().min(1),
  submit: z.boolean().default(true),
})

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

type AgentEntry = {
  config: TerminalAgentLaunchConfig
  pendingInputs: Array<z.infer<typeof pendingInputSchema>>
}

type PersistedSession = {
  readonly key: string
  readonly mode: TerminalMode
  readonly label: string
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly snapshot: string
  readonly savedAt: string
}

const persistedSessionSchema = z.object({
  key: z.string(),
  mode: z.enum(['shell', 'runtime']),
  label: z.string(),
  cwd: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  snapshot: z.string(),
  savedAt: z.string(),
})

export type KiritermDaemonOptions = {
  readonly stateDir?: string
  readonly version?: string
  readonly dumpIntervalMs?: number
  readonly onRequestShutdown?: () => void
}

export type KiritermDaemonHandle = {
  readonly info: TerminalServerInfo
  readonly record: KiritermDaemonRecord
  readonly stateDir: string
  readonly close: () => Promise<void>
}

export function defaultKiritermStateDir() {
  return process.env.KIRI_TERM_STATE_DIR ?? join(homedir(), '.kiri', 'kiriterm')
}

export function readKiritermDaemonRecord(stateDir: string): KiritermDaemonRecord | null {
  const recordPath = join(stateDir, 'daemon.json')
  if (!existsSync(recordPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordPath, 'utf8'))
    const schema = z.object({
      pid: z.number().int().positive(),
      host: z.string().min(1),
      port: z.number().int().positive(),
      path: z.string().min(1),
      token: z.string().min(1),
      version: z.string(),
      startedAt: z.string(),
    })
    const result = schema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export async function checkKiritermDaemonHealth(record: KiritermDaemonRecord) {
  try {
    const response = await fetch(`http://${record.host}:${record.port}/api/health`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(700),
    })
    if (!response.ok) return false
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && 'ok' in body && body.ok === true
  } catch {
    return false
  }
}

export async function startKiritermDaemon(
  options: KiritermDaemonOptions = {},
): Promise<KiritermDaemonHandle> {
  const stateDir = options.stateDir ?? defaultKiritermStateDir()
  const sessionsDir = join(stateDir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 })

  const existing = readKiritermDaemonRecord(stateDir)
  if (existing && (await checkKiritermDaemonHealth(existing))) {
    throw new Error(`kiriterm daemon already running (pid ${existing.pid}, port ${existing.port})`)
  }

  const agents = new Map<string, AgentEntry>()
  const codexLaunches: KiritermCodexLaunch[] = []
  const restoredSessions = loadPersistedSessions(sessionsDir)
  const lastDumpByKey = new Map<string, string>()

  const service = makeTerminalServerService(
    {
      getAgentLaunchConfig: (agentId) => {
        const entry = agents.get(agentId)
        if (!entry) throw new Error(`No launch config registered for agent ${agentId}`)
        return entry.config
      },
      takeAgentTerminalInputs: (agentId) => {
        const entry = agents.get(agentId)
        if (!entry) return []
        const inputs = entry.pendingInputs
        entry.pendingInputs = []
        return inputs
      },
      requeueAgentTerminalInputs: (agentId, inputs) => {
        const entry = agents.get(agentId)
        if (!entry) return
        entry.pendingInputs = [...inputs, ...entry.pendingInputs]
      },
      rememberCodexTerminalSession: (config, env, input) => {
        codexLaunches.push({
          agentId: config.id,
          codexHome: typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME : null,
          launchedAtMs: input.launchedAtMs,
          launchToken: input.launchToken,
        })
        return Promise.resolve()
      },
    },
    {
      idleKillModes: ['shell'],
      handleHttpRequest: (request, response, context) =>
        handleControlRequest(request, response, context),
      restoreContent: (key, mode) => {
        if (mode !== 'shell') return null
        const persisted = restoredSessions.get(key)
        if (!persisted) return null
        restoredSessions.delete(key)
        return `${persisted.snapshot}\r\n\x1b[2m[kiriterm: restored scrollback from previous session]\x1b[0m\r\n`
      },
    },
  )

  const info = await service.ensure()
  const record: KiritermDaemonRecord = {
    pid: process.pid,
    host: info.host,
    port: info.port,
    path: info.path,
    token: info.token,
    version: options.version ?? process.env.KIRI_TERM_DAEMON_VERSION ?? 'dev',
    startedAt: new Date().toISOString(),
  }
  writeFileAtomic(join(stateDir, 'daemon.json'), JSON.stringify(record, null, 2))

  const dumpInterval = setInterval(() => {
    dumpSessions()
  }, options.dumpIntervalMs ?? 30_000)
  dumpInterval.unref?.()

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    clearInterval(dumpInterval)
    dumpSessions()
    await service.close()
    const current = readKiritermDaemonRecord(stateDir)
    if (current && current.pid === process.pid) {
      rmSync(join(stateDir, 'daemon.json'), { force: true })
    }
  }

  return { info, record, stateDir, close }

  function dumpSessions() {
    for (const session of service.registry.sessions.values()) {
      if (session.exited) continue
      try {
        const snapshot = service.registry.snapshot(session)
        if (lastDumpByKey.get(session.key) === snapshot) continue
        lastDumpByKey.set(session.key, snapshot)
        const persisted: PersistedSession = {
          key: session.key,
          mode: session.mode,
          label: session.label,
          cwd: session.cwd,
          cols: session.cols,
          rows: session.rows,
          snapshot,
          savedAt: new Date().toISOString(),
        }
        writeFileAtomic(
          join(sessionsDir, `${encodeURIComponent(session.key)}.json`),
          JSON.stringify(persisted),
        )
      } catch (error) {
        console.error('kiriterm: failed to persist session snapshot', session.key, error)
      }
    }
  }

  function handleControlRequest(
    request: IncomingMessage,
    response: ServerResponse,
    context: { readonly token: string; readonly registry: ReturnType<typeof makeTerminalRegistry> },
  ): boolean {
    const url = new URL(request.url ?? '/', 'http://kiriterm.invalid')
    if (!url.pathname.startsWith('/api/')) return false
    void dispatchControlRequest(request, response, context, url).catch((error) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
    return true
  }

  async function dispatchControlRequest(
    request: IncomingMessage,
    response: ServerResponse,
    context: { readonly token: string; readonly registry: ReturnType<typeof makeTerminalRegistry> },
    url: URL,
  ) {
    if (!isAuthorized(request, context.token)) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    const registry = context.registry
    const route = `${request.method ?? 'GET'} ${url.pathname}`

    if (route === 'GET /api/health') {
      sendJson(response, 200, {
        ok: true,
        pid: process.pid,
        version: record.version,
        sessions: registry.sessions.size,
      })
      return
    }

    if (route === 'POST /api/agents/upsert') {
      const body = upsertAgentSchema.parse(await readJsonBody(request))
      const entry = agents.get(body.config.id)
      agents.set(body.config.id, {
        config: {
          ...body.config,
          sessionFile: body.config.sessionFile,
          runtimeStateJson: body.config.runtimeStateJson ?? null,
        },
        pendingInputs: [...(entry?.pendingInputs ?? []), ...(body.pendingInputs ?? [])],
      })
      sendJson(response, 200, { ok: true })
      return
    }

    if (route === 'POST /api/agents/spawn') {
      const body = spawnAgentSchema.parse(await readJsonBody(request))
      await service.spawnAgentRuntime(body)
      sendJson(response, 200, { ok: true, codexLaunches: codexLaunches.splice(0) })
      return
    }

    if (route === 'POST /api/agents/close-runtime') {
      const body = agentIdSchema.parse(await readJsonBody(request))
      service.closeAgentRuntime(body.agentId)
      sendJson(response, 200, { ok: true })
      return
    }

    if (route === 'POST /api/agents/input') {
      const body = agentInputSchema.parse(await readJsonBody(request))
      const session = registry.sessions.get(`${body.agentId}:runtime`)
      const data = body.submit ? `${body.text}\r` : body.text
      if (session && !session.exited) {
        session.proc.write(data)
        sendJson(response, 200, { ok: true, delivered: true })
        return
      }
      const entry = agents.get(body.agentId)
      if (!entry) {
        sendJson(response, 404, { error: `Unknown agent ${body.agentId}` })
        return
      }
      entry.pendingInputs.push({
        text: body.text,
        submit: body.submit,
        createdAt: new Date().toISOString(),
      })
      sendJson(response, 200, { ok: true, delivered: false, queued: true })
      return
    }

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
      sendJson(response, 200, { sessions })
      return
    }

    if (route === 'POST /api/sessions/read') {
      const body = sessionKeySchema.parse(await readJsonBody(request))
      const session = registry.sessions.get(body.key)
      if (!session) {
        sendJson(response, 404, { error: `No session ${body.key}` })
        return
      }
      await drained(session)
      sendJson(response, 200, { screen: registry.readScreen(session) })
      return
    }

    if (route === 'POST /api/sessions/snapshot') {
      const body = sessionKeySchema.parse(await readJsonBody(request))
      const session = registry.sessions.get(body.key)
      if (!session) {
        sendJson(response, 404, { error: `No session ${body.key}` })
        return
      }
      await drained(session)
      sendJson(response, 200, { snapshot: registry.snapshot(session) })
      return
    }

    if (route === 'POST /api/sessions/input') {
      const body = sessionInputSchema.parse(await readJsonBody(request))
      const session = registry.sessions.get(body.key)
      if (!session || session.exited) {
        sendJson(response, 404, { error: `No live session ${body.key}` })
        return
      }
      const data = `${body.data ?? ''}${body.keys ? encodeTerminalKeys(body.keys) : ''}`
      if (data) session.proc.write(data)
      sendJson(response, 200, { ok: true })
      return
    }

    if (route === 'POST /api/sessions/resize') {
      const body = sessionResizeSchema.parse(await readJsonBody(request))
      const session = registry.sessions.get(body.key)
      if (!session || session.exited) {
        sendJson(response, 404, { error: `No live session ${body.key}` })
        return
      }
      registry.resize(session, body.cols, body.rows)
      sendJson(response, 200, { ok: true })
      return
    }

    if (route === 'POST /api/sessions/wait-for') {
      const body = waitForSchema.parse(await readJsonBody(request))
      const session = registry.sessions.get(body.key)
      if (!session) {
        sendJson(response, 404, { error: `No session ${body.key}` })
        return
      }
      const startedAt = Date.now()
      try {
        const result = await registry.waitForScreen(session, {
          pattern: new RegExp(body.pattern, body.flags),
          timeoutMs: body.timeoutMs,
          scope: body.scope,
        })
        sendJson(response, 200, {
          matched: true,
          match: result.match,
          elapsedMs: Date.now() - startedAt,
        })
      } catch {
        sendJson(response, 200, { matched: false, elapsedMs: Date.now() - startedAt })
      }
      return
    }

    if (route === 'POST /api/sessions/kill') {
      const body = sessionKeySchema.parse(await readJsonBody(request))
      const session = registry.sessions.get(body.key)
      if (session) registry.kill(session)
      sendJson(response, 200, { ok: true })
      return
    }

    if (route === 'POST /api/shutdown') {
      sendJson(response, 200, { ok: true })
      void close().then(() => {
        options.onRequestShutdown?.()
      })
      return
    }

    sendJson(response, 404, { error: `Unknown route ${route}` })
  }
}

export async function runKiritermDaemon(options: KiritermDaemonOptions = {}) {
  const handle = await startKiritermDaemon({
    ...options,
    onRequestShutdown: () => process.exit(0),
  })
  console.log(`kiriterm daemon listening on ${handle.info.host}:${handle.info.port} (pid ${process.pid})`)
  const shutdown = () => {
    void handle.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  await new Promise<void>(() => {
    // Runs until a signal or /api/shutdown terminates the process.
  })
}

function loadPersistedSessions(sessionsDir: string) {
  const restored = new Map<string, PersistedSession>()
  let entries: string[] = []
  try {
    entries = readdirSync(sessionsDir)
  } catch {
    return restored
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(sessionsDir, entry), 'utf8'))
      const result = persistedSessionSchema.safeParse(parsed)
      if (result.success) restored.set(result.data.key, result.data)
    } catch {
      // Ignore corrupted snapshot files.
    }
  }
  return restored
}

function drained(session: { readonly headless: { write: (data: string, callback?: () => void) => void } }) {
  return new Promise<void>((resolve) => {
    session.headless.write('', () => {
      resolve()
    })
  })
}

function isAuthorized(request: IncomingMessage, token: string) {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const presented = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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

function sendJson(response: ServerResponse, status: number, value: unknown) {
  if (response.headersSent) {
    response.end()
    return
  }
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(body)
}

function writeFileAtomic(path: string, contents: string) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, contents, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}
