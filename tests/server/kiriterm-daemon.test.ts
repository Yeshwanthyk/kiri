import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { terminalServerFrameSchema, type TerminalServerFrame } from '../../src/lib/contracts'
import {
  acquireKiritermDaemonLock,
  checkKiritermDaemonHealth,
  readKiritermDaemonRecord,
  startKiritermDaemon,
  type KiritermDaemonHandle,
} from '../../src/server/kiriterm-daemon'
import { makeKiritermDaemonClient } from '../../src/server/kiriterm-daemon-client'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function tempStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kiriterm-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function startDaemon(stateDir: string) {
  const handle = await startKiritermDaemon({ stateDir, version: 'test' })
  cleanups.push(() => handle.close())
  return handle
}

async function startDaemonWithOptions(
  stateDir: string,
  options: { readonly dumpIntervalMs?: number },
) {
  const handle = await startKiritermDaemon({ stateDir, version: 'test', ...options })
  cleanups.push(() => handle.close())
  return handle
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

function launchConfig(stateDir: string) {
  return {
    id: 'agent-t1',
    projectId: 'proj-t1',
    runtime: 'codex',
    sessionDir: stateDir,
    sessionFile: null,
    model: '',
    cwd: stateDir,
    runtimeStateJson: null,
  }
}

function useFakeCodexTerminal(stateDir: string) {
  const previousBin = process.env.KIRI_CODEX_BIN
  const previousHome = process.env.KIRI_CODEX_HOME
  process.env.KIRI_CODEX_BIN = join(process.cwd(), 'tests/harness/fake-codex-terminal.mjs')
  process.env.KIRI_CODEX_HOME = stateDir
  cleanups.push(() => {
    if (previousBin === undefined) delete process.env.KIRI_CODEX_BIN
    else process.env.KIRI_CODEX_BIN = previousBin
    if (previousHome === undefined) delete process.env.KIRI_CODEX_HOME
    else process.env.KIRI_CODEX_HOME = previousHome
  })
}

function api(handle: KiritermDaemonHandle, route: string, body?: unknown) {
  return fetch(`http://${handle.info.host}:${handle.info.port}/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${handle.info.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function apiJson(handle: KiritermDaemonHandle, route: string, body?: unknown) {
  const response = await api(handle, route, body)
  expect(response.ok).toBe(true)
  const payload: unknown = await response.json()
  return payload
}

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

type AttachedSocket = {
  readonly socket: WebSocket
  readonly frames: TerminalServerFrame[]
  readonly nextFrame: (predicate: (frame: TerminalServerFrame) => boolean) => Promise<TerminalServerFrame>
}

function attachShell(handle: KiritermDaemonHandle, agentId: string): Promise<AttachedSocket> {
  const url = `ws://${handle.info.host}:${handle.info.port}${handle.info.path}` +
    `?agentId=${agentId}&mode=shell&cols=90&rows=24&token=${handle.info.token}`
  const socket = new WebSocket(url)
  cleanups.push(() => {
    socket.close()
  })
  const frames: TerminalServerFrame[] = []
  const waiters: Array<{
    predicate: (frame: TerminalServerFrame) => boolean
    resolve: (frame: TerminalServerFrame) => void
  }> = []
  socket.on('message', (raw) => {
    const text = Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : Buffer.from(new Uint8Array(raw)).toString('utf8')
    const parsed = terminalServerFrameSchema.safeParse(JSON.parse(text))
    if (!parsed.success) return
    frames.push(parsed.data)
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (waiter && waiter.predicate(parsed.data)) {
        waiters.splice(index, 1)
        waiter.resolve(parsed.data)
      }
    }
  })
  const nextFrame = (predicate: (frame: TerminalServerFrame) => boolean) => {
    const existing = frames.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise<TerminalServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for frame')), 10_000)
      waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer)
          resolve(frame)
        },
      })
    })
  }
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, frames, nextFrame }))
    socket.once('error', reject)
  })
}

describe('kiriterm daemon', () => {
  it('serves sessions over websocket and exposes the control api', async () => {
    const stateDir = tempStateDir()
    const handle = await startDaemon(stateDir)

    const record = readKiritermDaemonRecord(stateDir)
    expect(record?.pid).toBe(process.pid)
    expect(record?.token).toBe(handle.info.token)
    await expect(checkKiritermDaemonHealth(handle.record)).resolves.toBe(true)

    // Unauthorized control requests are rejected.
    const unauthorized = await fetch(
      `http://${handle.info.host}:${handle.info.port}/api/sessions`,
      { headers: { authorization: 'Bearer wrong' } },
    )
    expect(unauthorized.status).toBe(401)

    await apiJson(handle, 'agents/upsert', { config: launchConfig(stateDir) })

    const attached = await attachShell(handle, 'agent-t1')
    const snapshot = await attached.nextFrame((frame) => frame.type === 'snapshot')
    expect(snapshot.type).toBe('snapshot')

    attached.socket.send(JSON.stringify({ type: 'input', data: "printf 'daemon-%s\\n' ok\r" }))
    const waited = await apiJson(handle, 'sessions/wait-for', {
      key: 'proj-t1:shell',
      pattern: 'daemon-ok',
      timeoutMs: 10_000,
    })
    expect(waited).toMatchObject({ matched: true, match: 'daemon-ok' })

    const read = await apiJson(handle, 'sessions/read', { key: 'proj-t1:shell' })
    expect(JSON.stringify(read)).toContain('daemon-ok')

    const sessions = await apiJson(handle, 'sessions')
    expect(sessions).toMatchObject({
      sessions: [{ key: 'proj-t1:shell', mode: 'shell', attachedClients: 1 }],
    })

    // Keys can be injected through the control api like a human keystroke.
    await apiJson(handle, 'sessions/input', {
      key: 'proj-t1:shell',
      data: "printf 'keys-%s' done",
      keys: ['enter'],
    })
    const keysWaited = await apiJson(handle, 'sessions/wait-for', {
      key: 'proj-t1:shell',
      pattern: 'keys-done',
      timeoutMs: 10_000,
    })
    expect(keysWaited).toMatchObject({ matched: true })
  }, 30_000)

  it('restores shell scrollback across daemon restarts', async () => {
    const stateDir = tempStateDir()
    const first = await startDaemon(stateDir)
    await apiJson(first, 'agents/upsert', { config: launchConfig(stateDir) })

    const attached = await attachShell(first, 'agent-t1')
    await attached.nextFrame((frame) => frame.type === 'snapshot')
    attached.socket.send(JSON.stringify({ type: 'input', data: "printf 'persist-%s\\n' me\r" }))
    await apiJson(first, 'sessions/wait-for', {
      key: 'proj-t1:shell',
      pattern: 'persist-me',
      timeoutMs: 10_000,
    })
    attached.socket.close()
    await first.close()
    expect(readKiritermDaemonRecord(stateDir)).toBeNull()

    const second = await startDaemon(stateDir)
    await apiJson(second, 'agents/upsert', { config: launchConfig(stateDir) })
    const reattached = await attachShell(second, 'agent-t1')
    const snapshot = await reattached.nextFrame((frame) => frame.type === 'snapshot')
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot frame')
    expect(snapshot.data).toContain('persist-me')
    expect(snapshot.data).toContain('restored scrollback from previous session')
  }, 30_000)

  it('does not rewrite persisted shell dumps when output is unchanged', async () => {
    const stateDir = tempStateDir()
    const handle = await startDaemonWithOptions(stateDir, { dumpIntervalMs: 50 })
    await apiJson(handle, 'agents/upsert', { config: launchConfig(stateDir) })

    const attached = await attachShell(handle, 'agent-t1')
    await attached.nextFrame((frame) => frame.type === 'snapshot')
    attached.socket.send(JSON.stringify({ type: 'input', data: "printf 'dump-%s\\n' once\r" }))
    await apiJson(handle, 'sessions/wait-for', {
      key: 'proj-t1:shell',
      pattern: 'dump-once',
      timeoutMs: 10_000,
    })

    const persistedPath = join(stateDir, 'sessions', `${encodeURIComponent('proj-t1:shell')}.json`)
    await until(() => existsSync(persistedPath))
    const first = await stableSavedAt(persistedPath)

    attached.socket.send(JSON.stringify({ type: 'input', data: "printf 'dump-%s\\n' twice\r" }))
    await apiJson(handle, 'sessions/wait-for', {
      key: 'proj-t1:shell',
      pattern: 'dump-twice',
      timeoutMs: 10_000,
    })
    await until(() => {
      const next = JSON.parse(readFileSync(persistedPath, 'utf8')) as { savedAt: string; snapshot: string }
      return next.savedAt !== first && next.snapshot.includes('dump-twice')
    })
  }, 30_000)

  it('removes legacy runtime snapshots at startup without dropping shell snapshots', async () => {
    const stateDir = tempStateDir()
    const sessionsDir = join(stateDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const runtimePath = join(sessionsDir, `${encodeURIComponent('agent-t1:runtime')}.json`)
    const shellPath = join(sessionsDir, `${encodeURIComponent('proj-t1:shell')}.json`)
    const savedAt = new Date().toISOString()
    writeFileSync(runtimePath, JSON.stringify({
      key: 'agent-t1:runtime',
      mode: 'runtime',
      label: 'codex',
      cwd: stateDir,
      cols: 100,
      rows: 30,
      snapshot: 'legacy-runtime',
      savedAt,
    }))
    writeFileSync(shellPath, JSON.stringify({
      key: 'proj-t1:shell',
      mode: 'shell',
      label: 'shell',
      cwd: stateDir,
      cols: 100,
      rows: 30,
      snapshot: 'legacy-shell',
      savedAt,
    }))

    await startDaemon(stateDir)

    expect(existsSync(runtimePath)).toBe(false)
    expect(existsSync(shellPath)).toBe(true)
  }, 30_000)

  it('does not persist live runtime snapshots during daemon dumps', async () => {
    const stateDir = tempStateDir()
    useFakeCodexTerminal(stateDir)
    const handle = await startDaemonWithOptions(stateDir, { dumpIntervalMs: 50 })
    await apiJson(handle, 'agents/upsert', { config: launchConfig(stateDir) })
    await apiJson(handle, 'agents/spawn', { agentId: 'agent-t1' })
    await until(async () => JSON.stringify(await apiJson(handle, 'sessions')).includes('agent-t1:runtime'))

    const runtimePath = join(stateDir, 'sessions', `${encodeURIComponent('agent-t1:runtime')}.json`)
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(existsSync(runtimePath)).toBe(false)
  }, 30_000)

  it('serializes daemon startup with a releasable lock file', () => {
    const stateDir = tempStateDir()
    const first = acquireKiritermDaemonLock(stateDir)
    expect(first).not.toBeNull()
    expect(acquireKiritermDaemonLock(stateDir)).toBeNull()

    first?.release()
    const second = acquireKiritermDaemonLock(stateDir)
    expect(second).not.toBeNull()
    second?.release()
  })

  it('accepts a recovered existing daemon record after transient health failures', async () => {
    const stateDir = tempStateDir()
    let healthChecks = 0
    const server = createServer((request, response) => {
      if (request.url !== '/api/health') {
        response.writeHead(404).end()
        return
      }
      healthChecks += 1
      const healthy = healthChecks >= 3
      response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: healthy }))
    })
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const port = await listen(server)
    writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port,
      path: '/terminal',
      token: 'token',
      version: 'test',
      startedAt: '2026-01-01T00:00:00.000Z',
    }))

    const previousDaemonBin = process.env.KIRI_TERM_DAEMON_BIN
    process.env.KIRI_TERM_DAEMON_BIN = process.execPath
    cleanups.push(() => {
      if (previousDaemonBin === undefined) delete process.env.KIRI_TERM_DAEMON_BIN
      else process.env.KIRI_TERM_DAEMON_BIN = previousDaemonBin
    })

    const client = makeKiritermDaemonClient({ stateDir, spawnTimeoutMs: 1_000 })
    await expect(client.ensure()).resolves.toMatchObject({ host: '127.0.0.1', port })
    expect(healthChecks).toBeGreaterThanOrEqual(3)
  })

  it('projects rust daemon presence events into runtime agent status', async () => {
    const stateDir = tempStateDir()
    const statuses: Array<{ agentId: string; status: string }> = []
    const events = [
      { seq: 1, key: 'agent-1:runtime', mode: 'runtime', event: { type: 'status', agent: 'claude', event: 'busy' } },
      { seq: 2, key: 'agent-1:runtime', mode: 'runtime', event: { type: 'status', agent: 'claude', event: 'awaiting_input' } },
      { seq: 3, key: 'project-1:shell', mode: 'shell', event: { type: 'status', agent: 'claude', event: 'busy' } },
      { seq: 4, key: 'agent-1:runtime', mode: 'runtime', event: { type: 'status', agent: 'claude', event: 'session_end' } },
    ]
    const server = createServer((request, response) => {
      if (request.url === '/api/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
        return
      }
      if (request.url === '/api/presence-events') {
        let body = ''
        request.on('data', (chunk) => {
          body += String(chunk)
        })
        request.on('end', () => {
          const afterSeq = JSON.parse(body || '{}').afterSeq ?? 0
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            events: events.filter((event) => event.seq > afterSeq),
            latestSeq: events.at(-1)?.seq ?? 0,
          }))
        })
        return
      }
      response.writeHead(404).end()
    })
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const port = await listen(server)
    writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port,
      path: '/terminal',
      token: 'token',
      version: 'test',
      startedAt: '2026-01-01T00:00:00.000Z',
    }))

    const client = makeKiritermDaemonClient({
      stateDir,
      spawnTimeoutMs: 1_000,
      presencePollIntervalMs: 10,
      setAgentStatus: (agentId, status) => {
        statuses.push({ agentId, status })
      },
    })
    cleanups.push(() => client.close())

    await client.ensure()
    await expect.poll(() => statuses, { timeout: 2_000 }).toEqual([
      { agentId: 'agent-1', status: 'running' },
      { agentId: 'agent-1', status: 'blocked' },
      { agentId: 'agent-1', status: 'idle' },
    ])
  })

  it('delivers wake subscriptions into a runtime session over the control api', async () => {
    const stateDir = tempStateDir()
    useFakeCodexTerminal(stateDir)

    const handle = await startDaemon(stateDir)
    // Orchestrator: a fake-codex runtime session. Worker: a shell session.
    await apiJson(handle, 'agents/upsert', {
      config: { ...launchConfig(stateDir), id: 'orch-agent' },
    })
    await apiJson(handle, 'agents/spawn', { agentId: 'orch-agent' })
    await apiJson(handle, 'agents/upsert', { config: launchConfig(stateDir) })
    const worker = await attachShell(handle, 'agent-t1')
    await worker.nextFrame((frame) => frame.type === 'snapshot')

    const subscribed = await apiJson(handle, 'sessions/subscribe', {
      targets: [{ key: 'proj-t1:shell', label: 'Shell worker', pattern: 'wake-trigger-99' }],
      timeoutMs: 15_000,
      quorum: 'any',
      deliver: { agentId: 'orch-agent', note: 'go integrate', title: 'daemon wake' },
    })
    expect(subscribed).toMatchObject({ ok: true })

    worker.socket.send(JSON.stringify({ type: 'input', data: "printf 'wake-%s\\n' trigger-99\r" }))

    // The wake is typed into the orchestrator's terminal; the fake echoes it.
    const woke = await apiJson(handle, 'sessions/wait-for', {
      key: 'orch-agent:runtime',
      pattern: 'echo:.*kiri wake',
      scope: 'output',
      timeoutMs: 15_000,
    })
    expect(woke).toMatchObject({ matched: true })
    const noted = await apiJson(handle, 'sessions/wait-for', {
      key: 'orch-agent:runtime',
      pattern: 'note: go integrate',
      scope: 'output',
      timeoutMs: 15_000,
    })
    expect(noted).toMatchObject({ matched: true })

    await until(async () => JSON.stringify(await apiJson(handle, 'subscriptions')).includes('"delivered"'))
  }, 30_000)

  it('refuses to double-start and shuts down via the control api', async () => {
    const stateDir = tempStateDir()
    const handle = await startDaemon(stateDir)

    await expect(startKiritermDaemon({ stateDir, version: 'test' }))
      .rejects.toThrow('already running')

    const response = await api(handle, 'shutdown', {})
    expect(response.ok).toBe(true)
    await expect.poll(() => readKiritermDaemonRecord(stateDir), {
      timeout: 5_000,
    }).toBeNull()
    await expect(checkKiritermDaemonHealth(handle.record)).resolves.toBe(false)
  }, 30_000)
})

async function stableSavedAt(path: string) {
  let previous = JSON.parse(readFileSync(path, 'utf8')) as { savedAt: string }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 90))
    const next = JSON.parse(readFileSync(path, 'utf8')) as { savedAt: string }
    if (next.savedAt === previous.savedAt) return next.savedAt
    previous = next
  }
  throw new Error('persisted dump did not stabilize')
}
