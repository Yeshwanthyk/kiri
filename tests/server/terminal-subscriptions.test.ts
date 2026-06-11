import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTerminalRegistry } from '../../src/server/terminal-registry'
import { makeTerminalSubscriptions } from '../../src/server/terminal-subscriptions'

// Wake-mode delivery mechanics: condition fires → compact summary is typed
// into the receiving agent's terminal (text first, Enter as a separate write).

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function proc() {
  return {
    resize: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
  }
}

function setup() {
  const registry = makeTerminalRegistry({ idleKillMs: 60_000, socketOpenState: 1 })
  const register = (key: string, withProc = proc()) => {
    const session = registry.register({
      key,
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: withProc,
      cols: 80,
      rows: 24,
    })
    return { session, proc: withProc }
  }
  return { registry, register }
}

function writesOf(target: ReturnType<typeof proc>) {
  return target.write.mock.calls.map((call) => {
    const value: unknown = call[0]
    if (typeof value !== 'string') throw new Error('expected string write')
    return value
  })
}

async function until(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('terminal subscriptions (wake delivery)', () => {
  it('delivers a compact wake with tail and note, submitting Enter separately', async () => {
    const { registry, register } = setup()
    const worker = register('worker-1:runtime')
    const orchestrator = register('orch-1:runtime')
    const subscriptions = makeTerminalSubscriptions({ registry, submitDelayMs: 20 })

    const { id } = subscriptions.subscribe({
      targets: [{ key: 'worker-1:runtime', label: 'Implementer', pattern: 'DONE-42', flags: '', scope: 'screen' }],
      timeoutMs: 5_000,
      quorum: 'any',
      deliver: { agentId: 'orch-1', note: 'integrate the result', title: 'review run' },
    })

    registry.append(worker.session, 'working...\r\nDONE-42\r\n')
    await subscriptions.settled()

    const writes = writesOf(orchestrator.proc)
    expect(writes.length).toBeGreaterThanOrEqual(1)
    const wake = writes[0] ?? ''
    expect(wake).toContain(`[kiri wake ${id}] review run: Implementer: matched "DONE-42"`)
    expect(wake).toContain('tail Implementer:')
    expect(wake).toContain('DONE-42')
    expect(wake).toContain('note: integrate the result')
    // Enter arrives as its own write after the delay (Claude paste heuristic).
    await until(() => writesOf(orchestrator.proc).includes('\r'))
    expect(writesOf(orchestrator.proc).at(-1)).toBe('\r')

    expect(subscriptions.list()).toMatchObject([
      { id, status: 'delivered', deliverAgentId: 'orch-1', outcome: 'condition met' },
    ])
  })

  it('delivers a timeout wake when the condition never fires', async () => {
    const { registry, register } = setup()
    register('worker-2:runtime')
    const orchestrator = register('orch-2:runtime')
    const subscriptions = makeTerminalSubscriptions({ registry, submitDelayMs: 10 })

    subscriptions.subscribe({
      targets: [{ key: 'worker-2:runtime', pattern: 'never-appears', flags: '', scope: 'screen' }],
      timeoutMs: 200,
      quorum: 'any',
      deliver: { agentId: 'orch-2' },
    })
    await subscriptions.settled()

    const wake = writesOf(orchestrator.proc)[0] ?? ''
    expect(wake).toContain('timed out after 200ms with no match')
    expect(subscriptions.list()[0]).toMatchObject({ status: 'delivered', outcome: 'timed out' })
  })

  it('reports missing workers and spawns the receiver when its session is gone', async () => {
    const { registry, register } = setup()
    const subscriptions = makeTerminalSubscriptions({
      registry,
      submitDelayMs: 10,
      // Wake receiver is not running: delivery brings it up first.
      spawnForDelivery: (agentId) => {
        register(`${agentId}:runtime`, lateOrchestratorProc)
        return Promise.resolve()
      },
    })
    const lateOrchestratorProc = proc()

    subscriptions.subscribe({
      targets: [{ key: 'gone-worker:runtime', pattern: 'x', flags: '', scope: 'screen' }],
      timeoutMs: 1_000,
      quorum: 'any',
      deliver: { agentId: 'orch-3', note: 'workers vanished' },
    })
    await subscriptions.settled()

    const wake = writesOf(lateOrchestratorProc)[0] ?? ''
    expect(wake).toContain('missing sessions: gone-worker:runtime')
    expect(wake).toContain('note: workers vanished')
  })

  it('fails the subscription when no receiver can be brought up', async () => {
    const { registry } = setup()
    const subscriptions = makeTerminalSubscriptions({ registry, submitDelayMs: 10 })
    const { id } = subscriptions.subscribe({
      targets: [{ key: 'gone:runtime', pattern: 'x', flags: '', scope: 'screen' }],
      timeoutMs: 500,
      quorum: 'any',
      deliver: { agentId: 'nobody' },
    })
    await subscriptions.settled()
    expect(subscriptions.list()).toMatchObject([
      { id, status: 'failed' },
    ])
    expect(subscriptions.list()[0]?.outcome).toContain('no live session nobody:runtime')
  })

  it('journals pending subscriptions and re-arms them on restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiri-subs-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const journalPath = join(dir, 'subscriptions.json')

    const { registry, register } = setup()
    const worker = register('worker-9:runtime')
    const orchestrator = register('orch-9:runtime')

    const first = makeTerminalSubscriptions({ registry, journalPath, submitDelayMs: 10 })
    const { id } = first.subscribe({
      targets: [{ key: 'worker-9:runtime', pattern: 'LATER', flags: '', scope: 'screen' }],
      timeoutMs: 60_000,
      quorum: 'any',
      deliver: { agentId: 'orch-9', note: 'restart survivor' },
    })
    expect(readFileSync(journalPath, 'utf8')).toContain(id)

    // A "restarted" engine re-arms the pending subscription from the journal
    // and delivers when the condition finally fires.
    const second = makeTerminalSubscriptions({ registry, journalPath, submitDelayMs: 10 })
    registry.append(worker.session, 'LATER\r\n')
    await second.settled()

    const wake = writesOf(orchestrator.proc).find((write) => write.includes('[kiri wake'))
    expect(wake).toContain('restart survivor')
    expect(second.list().find((record) => record.id === id)?.status).toBe('delivered')
  })
})
