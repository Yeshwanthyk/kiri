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

  it('batches near-simultaneous wakes to the same receiver into one turn', async () => {
    const { registry, register } = setup()
    const workerA = register('worker-a:runtime')
    const workerB = register('worker-b:runtime')
    const orchestrator = register('orch-batch:runtime')
    const subscriptions = makeTerminalSubscriptions({
      registry,
      batchDelayMs: 30,
      submitDelayMs: 10,
    })

    const first = subscriptions.subscribe({
      targets: [{ key: 'worker-a:runtime', label: 'Implementer', pattern: 'DONE-A', flags: '', scope: 'screen' }],
      timeoutMs: 5_000,
      quorum: 'any',
      deliver: { agentId: 'orch-batch', note: 'first note', title: 'batch wake' },
    })
    const second = subscriptions.subscribe({
      targets: [{ key: 'worker-b:runtime', label: 'Reviewer', pattern: 'DONE-B', flags: '', scope: 'screen' }],
      timeoutMs: 5_000,
      quorum: 'any',
      deliver: { agentId: 'orch-batch', note: 'second note', title: 'batch wake' },
    })

    registry.append(workerA.session, 'DONE-A\r\n')
    registry.append(workerB.session, 'DONE-B\r\n')
    await subscriptions.settled()
    await until(() => writesOf(orchestrator.proc).includes('\r'))

    const writes = writesOf(orchestrator.proc)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toContain(`[kiri wake ${first.id}] batch wake: Implementer: matched "DONE-A"`)
    expect(writes[0]).toContain(`[kiri wake ${second.id}] batch wake: Reviewer: matched "DONE-B"`)
    expect(writes[0]).toContain('note: first note')
    expect(writes[0]).toContain('note: second note')
    expect(writes[1]).toBe('\r')
    expect(subscriptions.list()).toMatchObject([
      { id: first.id, status: 'delivered', deliverAgentId: 'orch-batch', outcome: 'condition met' },
      { id: second.id, status: 'delivered', deliverAgentId: 'orch-batch', outcome: 'condition met' },
    ])
  })

  it('respawns the receiver when it exits during the batch window', async () => {
    const { registry, register } = setup()
    const worker = register('worker-respawn:runtime')
    const orchestrator = register('orch-respawn:runtime')
    const respawnedProc = proc()
    const timers: Array<() => void> = []
    const subscriptions = makeTerminalSubscriptions({
      registry,
      batchDelayMs: 50,
      submitDelayMs: 10,
      timers: {
        setTimeout: (callback) => {
          timers.push(callback)
          return 0 as unknown as ReturnType<typeof setTimeout>
        },
      },
      spawnForDelivery: (agentId) => {
        register(`${agentId}:runtime`, respawnedProc)
        return Promise.resolve()
      },
    })

    const { id } = subscriptions.subscribe({
      targets: [{ key: 'worker-respawn:runtime', label: 'Worker', pattern: 'DONE', flags: '', scope: 'screen' }],
      timeoutMs: 5_000,
      quorum: 'any',
      deliver: { agentId: 'orch-respawn', title: 'respawn wake' },
    })

    registry.append(worker.session, 'DONE\r\n')
    await until(() => timers.length === 1)
    registry.kill(orchestrator.session)
    const settled = subscriptions.settled()
    timers.shift()?.()
    await until(() => writesOf(respawnedProc).length === 1)
    expect(writesOf(respawnedProc)[0]).toContain(`[kiri wake ${id}] respawn wake: Worker: matched "DONE"`)
    await until(() => timers.length === 1)
    timers.shift()?.()
    await settled

    expect(writesOf(respawnedProc).at(-1)).toBe('\r')
    expect(subscriptions.list()).toMatchObject([
      { id, status: 'delivered', deliverAgentId: 'orch-respawn', outcome: 'condition met' },
    ])
  })

  it('respawns the receiver once for concurrent batched wakes', async () => {
    const { registry, register } = setup()
    const workerA = register('worker-dead-a:runtime')
    const workerB = register('worker-dead-b:runtime')
    const respawnedProc = proc()
    let spawnCount = 0
    const subscriptions = makeTerminalSubscriptions({
      registry,
      batchDelayMs: 20,
      submitDelayMs: 10,
      spawnForDelivery: (agentId) => {
        spawnCount += 1
        register(`${agentId}:runtime`, respawnedProc)
        return Promise.resolve()
      },
    })

    const first = subscriptions.subscribe({
      targets: [{ key: 'worker-dead-a:runtime', label: 'A', pattern: 'A-DONE', flags: '', scope: 'screen' }],
      timeoutMs: 5_000,
      quorum: 'any',
      deliver: { agentId: 'orch-dead', title: 'dead wake' },
    })
    const second = subscriptions.subscribe({
      targets: [{ key: 'worker-dead-b:runtime', label: 'B', pattern: 'B-DONE', flags: '', scope: 'screen' }],
      timeoutMs: 5_000,
      quorum: 'any',
      deliver: { agentId: 'orch-dead', title: 'dead wake' },
    })

    registry.append(workerA.session, 'A-DONE\r\n')
    registry.append(workerB.session, 'B-DONE\r\n')
    await subscriptions.settled()

    expect(spawnCount).toBe(1)
    const wake = writesOf(respawnedProc)[0] ?? ''
    expect(wake).toContain(`[kiri wake ${first.id}] dead wake: A: matched "A-DONE"`)
    expect(wake).toContain(`[kiri wake ${second.id}] dead wake: B: matched "B-DONE"`)
  })

  it('does not respawn twice when a later wake arrives during a slow receiver spawn', async () => {
    const { registry, register } = setup()
    const workerA = register('worker-slow-a:runtime')
    const workerB = register('worker-slow-b:runtime')
    const respawnedProc = proc()
    const timers: Array<() => void> = []
    let spawnCount = 0
    let finishSpawn: (() => void) | undefined
    const subscriptions = makeTerminalSubscriptions({
      registry,
      batchDelayMs: 50,
      submitDelayMs: 10,
      timers: {
        setTimeout: (callback) => {
          timers.push(callback)
          return 0 as unknown as ReturnType<typeof setTimeout>
        },
      },
      spawnForDelivery: (agentId) => {
        spawnCount += 1
        return new Promise((resolve) => {
          finishSpawn = () => {
            register(`${agentId}:runtime`, respawnedProc)
            resolve(null)
          }
        })
      },
    })

    const first = subscriptions.subscribe({
      targets: [{ key: 'worker-slow-a:runtime', label: 'A', pattern: 'A-DONE', flags: '', scope: 'screen' }],
      timeoutMs: 5_000,
      quorum: 'any',
      deliver: { agentId: 'orch-slow', title: 'slow wake' },
    })
    registry.append(workerA.session, 'A-DONE\r\n')
    await until(() => timers.length === 1)
    timers.shift()?.()
    await until(() => spawnCount === 1)

    const second = subscriptions.subscribe({
      targets: [{ key: 'worker-slow-b:runtime', label: 'B', pattern: 'B-DONE', flags: '', scope: 'screen' }],
      timeoutMs: 5_000,
      quorum: 'any',
      deliver: { agentId: 'orch-slow', title: 'slow wake' },
    })
    registry.append(workerB.session, 'B-DONE\r\n')

    finishSpawn?.()
    await until(() => timers.length === 1)
    timers.shift()?.()
    await until(() => timers.length === 1)
    timers.shift()?.()
    await until(() => timers.length === 1)
    timers.shift()?.()
    await subscriptions.settled()

    expect(spawnCount).toBe(1)
    const writes = writesOf(respawnedProc).filter((write) => write.includes('[kiri wake'))
    expect(writes).toHaveLength(2)
    expect(writes[0]).toContain(`[kiri wake ${first.id}] slow wake: A: matched "A-DONE"`)
    expect(writes[1]).toContain(`[kiri wake ${second.id}] slow wake: B: matched "B-DONE"`)
  })

  it('marks queued wakes failed when the receiver write throws', async () => {
    const { registry, register } = setup()
    const worker = register('worker-throw:runtime')
    const throwingProc = proc()
    throwingProc.write.mockImplementation(() => {
      throw new Error('pty write failed')
    })
    const orchestrator = register('orch-throw:runtime', throwingProc)
    const subscriptions = makeTerminalSubscriptions({ registry, batchDelayMs: 20, submitDelayMs: 10 })

    const { id } = subscriptions.subscribe({
      targets: [{ key: 'worker-throw:runtime', label: 'Worker', pattern: 'DONE', flags: '', scope: 'screen' }],
      timeoutMs: 5_000,
      quorum: 'any',
      deliver: { agentId: 'orch-throw', title: 'throw wake' },
    })

    registry.append(worker.session, 'DONE\r\n')
    await subscriptions.settled()

    expect(orchestrator.proc.write).toHaveBeenCalledTimes(1)
    expect(subscriptions.list()).toMatchObject([
      { id, status: 'failed', deliverAgentId: 'orch-throw', outcome: 'pty write failed' },
    ])
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

    const firstSetup = setup()
    firstSetup.register('worker-9:runtime')

    const first = makeTerminalSubscriptions({ registry: firstSetup.registry, journalPath, submitDelayMs: 10 })
    const { id } = first.subscribe({
      targets: [{ key: 'worker-9:runtime', pattern: 'LATER', flags: '', scope: 'screen' }],
      timeoutMs: 60_000,
      quorum: 'any',
      deliver: { agentId: 'orch-9', note: 'restart survivor' },
    })
    expect(readFileSync(journalPath, 'utf8')).toContain(id)

    // A "restarted" engine re-arms the pending subscription from the journal
    // and delivers when the condition finally fires.
    const { registry, register } = setup()
    const worker = register('worker-9:runtime')
    const orchestrator = register('orch-9:runtime')
    const second = makeTerminalSubscriptions({ registry, journalPath, submitDelayMs: 10 })
    registry.append(worker.session, 'LATER\r\n')
    await second.settled()

    const wakes = writesOf(orchestrator.proc).filter((write) => write.includes('[kiri wake'))
    expect(wakes).toHaveLength(1)
    const wake = wakes[0] ?? ''
    expect(wake).toContain('restart survivor')
    expect(second.list().find((record) => record.id === id)?.status).toBe('delivered')
  })

  it('bounds settled records while preserving pending subscriptions in the journal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiri-subs-prune-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const journalPath = join(dir, 'subscriptions.json')
    const { registry, register } = setup()
    const orchestrator = register('orch-prune:runtime')
    const subscriptions = makeTerminalSubscriptions({
      registry,
      journalPath,
      batchDelayMs: 5,
      submitDelayMs: 5,
    })

    for (let index = 0; index < 101; index += 1) {
      subscriptions.subscribe({
        targets: [{ key: `missing-${index}:runtime`, pattern: 'x', flags: '', scope: 'screen' }],
        timeoutMs: 60_000,
        quorum: 'any',
        deliver: { agentId: 'orch-prune', title: 'prune wake' },
      })
    }
    await subscriptions.settled()
    await until(() => writesOf(orchestrator.proc).includes('\r'))

    const worker = register('worker-pending:runtime')
    const pending = subscriptions.subscribe({
      targets: [{ key: 'worker-pending:runtime', pattern: 'NEVER', flags: '', scope: 'screen' }],
      timeoutMs: 60_000,
      quorum: 'any',
      deliver: { agentId: 'orch-prune', title: 'pending wake' },
    })
    expect(worker.session.exited).toBe(false)

    const records = subscriptions.list()
    expect(records.filter((record) => record.status !== 'pending')).toHaveLength(100)
    expect(records.find((record) => record.id === pending.id)).toMatchObject({ status: 'pending' })

    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Array<{ status: string; id: string }>
    expect(journal.filter((record) => record.status !== 'pending')).toHaveLength(100)
    expect(journal.find((record) => record.id === pending.id)).toMatchObject({ status: 'pending' })
  })
})
