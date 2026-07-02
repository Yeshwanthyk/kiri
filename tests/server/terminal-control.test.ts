import { describe, expect, it, vi } from 'vitest'
import { handleSessionControlRoute } from '../../src/server/terminal-control'
import {
  makeTerminalRegistry,
  type TerminalRegistrySession,
} from '../../src/server/terminal-registry'

function proc() {
  return {
    resize: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  }
}

function createRegistry() {
  const timers: Array<() => void> = []
  const registry = makeTerminalRegistry({
    idleKillMs: 100,
    socketOpenState: 1,
    timers: {
      setTimeout: (callback) => {
        timers.push(callback)
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => undefined,
    },
  })
  return { registry, timers }
}

function register(registry: ReturnType<typeof makeTerminalRegistry>, key: string) {
  return registry.register({
    key,
    cwd: '/repo',
    mode: 'runtime',
    label: 'codex',
    proc: proc(),
    cols: 80,
    rows: 24,
  })
}

function drain(session: TerminalRegistrySession) {
  return new Promise<void>((resolve) => {
    session.headless.write('', () => {
      resolve()
    })
  })
}

describe('sessions/read and wait-for control routes', () => {
  it('returns generation, cursor, and incremental output for reads', async () => {
    const { registry } = createRegistry()
    const session = register(registry, 'a:runtime')
    registry.append(session, 'first\r\n')
    await drain(session)

    const initial = await handleSessionControlRoute('POST /api/sessions/read', {
      key: 'a:runtime',
    }, registry)
    expect(initial?.body).toMatchObject({
      generation: 1,
      output: '',
    })
    const cursor = initial && typeof initial.body === 'object' && initial.body !== null &&
      'cursor' in initial.body && typeof initial.body.cursor === 'string'
      ? initial.body.cursor
      : null
    if (!cursor) throw new Error('expected read cursor')

    registry.append(session, 'second\r\n')
    await drain(session)
    const next = await handleSessionControlRoute('POST /api/sessions/read', {
      key: 'a:runtime',
      cursor,
    }, registry)

    expect(next?.body).toMatchObject({
      generation: 1,
      output: 'second\r\n',
    })
  })

  it('wait-for follows a replacement for the same key', async () => {
    const { registry } = createRegistry()
    const first = register(registry, 'a:runtime')
    const pending = handleSessionControlRoute('POST /api/sessions/wait-for', {
      key: 'a:runtime',
      pattern: 'ready-after-respawn',
      timeoutMs: 5_000,
      followReplacement: true,
    }, registry)

    registry.exit(first, '[exited]')
    const second = register(registry, 'a:runtime')
    registry.append(second, 'ready-after-respawn\r\n')
    await drain(second)

    await expect(pending).resolves.toMatchObject({
      status: 200,
      body: {
        matched: true,
        match: 'ready-after-respawn',
        generation: 2,
      },
    })
  })
})

describe('sessions/wait-any control route', () => {
  it('any-quorum resolves on the first match and releases the losing waits', async () => {
    const { registry } = createRegistry()
    const fast = register(registry, 'a:runtime')
    const slow = register(registry, 'b:runtime')

    const pending = handleSessionControlRoute('POST /api/sessions/wait-any', {
      targets: [
        { key: 'a:runtime', pattern: 'ready-a' },
        { key: 'b:runtime', pattern: 'ready-b' },
      ],
      timeoutMs: 5_000,
      quorum: 'any',
    }, registry)

    registry.append(fast, 'ready-a\r\n')
    await drain(fast)
    const result = await pending
    expect(result).toMatchObject({
      status: 200,
      body: { matched: true, matches: [{ key: 'a:runtime', match: 'ready-a' }], missing: [] },
    })
    // The abort released the loser's listener; nothing waits on it anymore.
    expect(slow.screenListeners.size).toBe(0)
    expect(fast.screenListeners.size).toBe(0)
  })

  it('all-quorum waits for every live target', async () => {
    const { registry } = createRegistry()
    const first = register(registry, 'a:runtime')
    const second = register(registry, 'b:runtime')

    const pending = handleSessionControlRoute('POST /api/sessions/wait-any', {
      targets: [
        { key: 'a:runtime', pattern: 'done' },
        { key: 'b:runtime', pattern: 'done' },
      ],
      timeoutMs: 5_000,
      quorum: 'all',
    }, registry)

    registry.append(first, 'done\r\n')
    await drain(first)
    registry.append(second, 'done\r\n')
    await drain(second)

    const result = await pending
    expect(result?.status).toBe(200)
    expect(result?.body).toMatchObject({ matched: true })
    if (!result || typeof result.body !== 'object' || result.body === null) {
      throw new Error('expected body')
    }
    expect('matches' in result.body && Array.isArray(result.body.matches)
      ? result.body.matches
      : []).toHaveLength(2)
  })

  it('tolerates missing sessions and reports them', async () => {
    const { registry } = createRegistry()
    const live = register(registry, 'a:runtime')

    const pending = handleSessionControlRoute('POST /api/sessions/wait-any', {
      targets: [
        { key: 'a:runtime', pattern: 'go' },
        { key: 'gone:runtime', pattern: 'go' },
      ],
      timeoutMs: 5_000,
      quorum: 'all',
    }, registry)
    registry.append(live, 'go\r\n')
    await drain(live)

    const result = await pending
    // 'all' cannot be satisfied when a target is missing, but the live match
    // is still reported alongside the missing key.
    expect(result?.body).toMatchObject({
      matched: false,
      missing: ['gone:runtime'],
      matches: [{ key: 'a:runtime', match: 'go' }],
    })

    const noneLive = await handleSessionControlRoute('POST /api/sessions/wait-any', {
      targets: [{ key: 'gone:runtime', pattern: 'go' }],
      timeoutMs: 5_000,
    }, registry)
    expect(noneLive?.body).toMatchObject({ matched: false, missing: ['gone:runtime'] })
  })

  it('resolves idle targets and includes screen tails in matches', async () => {
    // Real timers for the settle window.
    const registry = makeTerminalRegistry({ idleKillMs: 60_000, socketOpenState: 1 })
    const session = registry.register({
      key: 'idle:runtime',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: proc(),
      cols: 80,
      rows: 24,
    })
    registry.append(session, 'finished step 3\r\n')

    const result = await handleSessionControlRoute('POST /api/sessions/wait-any', {
      targets: [{ key: 'idle:runtime', label: 'Worker', idleMs: 250 }],
      timeoutMs: 5_000,
      quorum: 'any',
    }, registry)

    expect(result?.body).toMatchObject({
      matched: true,
      matches: [{
        key: 'idle:runtime',
        label: 'Worker',
        idle: true,
        tail: ['finished step 3'],
      }],
    })
  })

  it('rejects targets that have neither pattern nor idleMs', async () => {
    const { registry } = createRegistry()
    register(registry, 'a:runtime')
    await expect(handleSessionControlRoute('POST /api/sessions/wait-any', {
      targets: [{ key: 'a:runtime' }],
      timeoutMs: 1_000,
    }, registry)).rejects.toThrow(/pattern and\/or idleMs/)
  })

  it('any-quorum reports no match when every wait times out', async () => {
    const { registry, timers } = createRegistry()
    register(registry, 'a:runtime')

    const pending = handleSessionControlRoute('POST /api/sessions/wait-any', {
      targets: [{ key: 'a:runtime', pattern: 'never' }],
      timeoutMs: 1_000,
      quorum: 'any',
    }, registry)
    // Fire the injected wait timeout.
    timers.at(-1)?.()
    const result = await pending
    expect(result?.body).toMatchObject({ matched: false, matches: [] })
  })
})
