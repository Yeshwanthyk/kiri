import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { terminalServerFrameSchema, type TerminalServerFrame } from '../../src/lib/contracts'
import {
  checkKiritermDaemonHealth,
  readKiritermDaemonRecord,
  startKiritermDaemon,
  type KiritermDaemonHandle,
} from '../../src/server/kiriterm-daemon'

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
