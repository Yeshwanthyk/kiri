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
