import { describe, expect, it, vi } from 'vitest'
import { terminalServerFrameSchema, type TerminalServerFrame } from '../../src/lib/contracts'
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

function socket(openState = 1) {
  return {
    readyState: openState,
    send: vi.fn(),
    close: vi.fn(),
  }
}

function sentFrames(target: ReturnType<typeof socket>): TerminalServerFrame[] {
  return target.send.mock.calls.map((call) => {
    const raw: unknown = call[0]
    if (typeof raw !== 'string') throw new Error('expected string frame')
    return terminalServerFrameSchema.parse(JSON.parse(raw))
  })
}

function drain(session: TerminalRegistrySession) {
  return new Promise<void>((resolve) => {
    session.headless.write('', () => {
      resolve()
    })
  })
}

type RegistryOptions = {
  idleKillMs?: number
  highWatermarkBytes?: number
  lowWatermarkBytes?: number
}

function createRegistry(options: RegistryOptions = {}) {
  const timers: Array<() => void> = []
  const registry = makeTerminalRegistry({
    idleKillMs: options.idleKillMs ?? 100,
    socketOpenState: 1,
    highWatermarkBytes: options.highWatermarkBytes,
    lowWatermarkBytes: options.lowWatermarkBytes,
    timers: {
      setTimeout: (callback) => {
        timers.push(callback)
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => undefined,
    },
  })
  return { timers, registry }
}

function registerSession(
  registry: ReturnType<typeof makeTerminalRegistry>,
  overrides: { key?: string; cwd?: string; banner?: string; proc?: ReturnType<typeof proc> } = {},
) {
  return registry.register({
    key: overrides.key ?? 'agent-1:runtime',
    cwd: overrides.cwd ?? '/repo',
    mode: 'runtime',
    label: 'codex',
    proc: overrides.proc ?? proc(),
    cols: 80,
    rows: 24,
    banner: overrides.banner,
  })
}

describe('terminal registry', () => {
  it('keys shell sessions by project and runtime sessions by agent', () => {
    const { registry } = createRegistry()
    const config = {
      id: 'agent-1',
      projectId: 'project-1',
      runtime: 'codex' as const,
      cwd: '/repo',
    }

    expect(registry.sessionKey(config, 'shell')).toBe('project-1:shell')
    expect(registry.sessionKey(config, 'runtime')).toBe('agent-1:runtime')
  })

  it('reuses matching cwd sessions, resizing both pty and emulator', () => {
    const { registry } = createRegistry()
    const firstProc = proc()
    const session = registerSession(registry, { proc: firstProc })
    const config = {
      id: 'agent-1',
      projectId: 'project-1',
      runtime: 'codex' as const,
      cwd: '/repo',
    }

    expect(registry.getReusable(config, 'runtime', 120, 40)).toBe(session)
    expect(firstProc.resize).toHaveBeenCalledWith(120, 40)
    expect(session.headless.cols).toBe(120)
    expect(session.headless.rows).toBe(40)
    expect(registry.readScreen(session).cols).toBe(120)

    expect(registry.getReusable({ ...config, cwd: '/other' }, 'runtime', 80, 24)).toBeNull()
    expect(firstProc.kill).toHaveBeenCalledTimes(1)
    expect(registry.sessions.has('agent-1:runtime')).toBe(false)
  })

  it('does not let stale process exit unregister a replacement session with the same key', () => {
    const { registry } = createRegistry()
    const oldSession = registerSession(registry)
    const config = {
      id: 'agent-1',
      projectId: 'project-1',
      runtime: 'codex' as const,
      cwd: '/other',
    }

    expect(registry.getReusable(config, 'runtime', 80, 24)).toBeNull()
    const replacement = registerSession(registry, { cwd: '/other' })
    registry.exit(oldSession, 'old exit')

    expect(registry.sessions.get('agent-1:runtime')).toBe(replacement)
  })

  it('parses output into a readable screen with cursor position', async () => {
    const { registry } = createRegistry()
    const session = registerSession(registry)

    registry.append(session, 'hello \x1b[31mworld\x1b[0m\r\nsecond')
    await drain(session)

    const screen = registry.readScreen(session)
    expect(screen.lines[0]).toBe('hello world')
    expect(screen.lines[1]).toBe('second')
    expect(screen.cursorX).toBe(6)
    expect(screen.cursorY).toBe(1)
    expect(screen.bufferType).toBe('normal')
  })

  it('tracks output sequence only for content writes', () => {
    const { registry } = createRegistry()
    const session = registerSession(registry)

    expect(session.outputSeq).toBe(0)
    registry.append(session, '')
    expect(session.outputSeq).toBe(0)

    registry.append(session, 'hello')
    expect(session.outputSeq).toBe(1)
  })

  it('sends a snapshot frame on attach and streams subsequent data frames', async () => {
    const { registry } = createRegistry()
    const session = registerSession(registry, { banner: '[banner]\r\n' })
    registry.append(session, 'before-attach\r\n')

    const client = socket(1)
    registry.attach(session, client)
    await drain(session)

    registry.append(session, 'after-attach')
    registry.broadcast(session, 'after-attach')
    await drain(session)

    const frames = sentFrames(client)
    expect(frames[0]?.type).toBe('snapshot')
    if (frames[0]?.type !== 'snapshot') throw new Error('expected snapshot frame')
    expect(frames[0].cols).toBe(80)
    expect(frames[0].rows).toBe(24)
    expect(frames[0].data).toContain('[banner]')
    expect(frames[0].data).toContain('before-attach')
    expect(frames[0].data).not.toContain('after-attach')
    expect(frames[1]).toEqual({ type: 'data', data: 'after-attach' })
  })

  it('buffers output that races an attach and replays it after the snapshot', async () => {
    const { registry } = createRegistry()
    const session = registerSession(registry)
    registry.append(session, 'first')

    const client = socket(1)
    registry.attach(session, client)
    // Arrives while the attach sentinel is still queued: must not be lost and
    // must not be duplicated inside the snapshot.
    registry.append(session, 'second')
    registry.broadcast(session, 'second')
    await drain(session)

    const frames = sentFrames(client)
    expect(frames[0]?.type).toBe('snapshot')
    if (frames[0]?.type !== 'snapshot') throw new Error('expected snapshot frame')
    expect(frames[0].data).toContain('first')
    expect(frames[0].data).not.toContain('second')
    expect(frames[1]).toEqual({ type: 'data', data: 'second' })
  })

  it('round-trips a snapshot into an identical screen', async () => {
    const { registry } = createRegistry()
    const original = registerSession(registry)
    registry.append(original, 'line one\r\n\x1b[1;33mbold yellow\x1b[0m\r\n')
    registry.append(original, 'tail without newline')
    await drain(original)

    const restored = registerSession(registry, { key: 'agent-2:runtime' })
    registry.append(restored, registry.snapshot(original))
    await drain(restored)

    expect(registry.readScreen(restored).lines).toEqual(registry.readScreen(original).lines)
    expect(registry.readScreen(restored).cursorX).toBe(registry.readScreen(original).cursorX)
    expect(registry.readScreen(restored).cursorY).toBe(registry.readScreen(original).cursorY)
  })

  it('broadcasts only to open sockets', async () => {
    const { registry } = createRegistry()
    const session = registerSession(registry)
    const open = socket(1)
    const closed = socket(3)
    registry.attach(session, open)
    registry.attach(session, closed)
    await drain(session)

    registry.broadcast(session, 'next')

    expect(sentFrames(open).some((frame) => frame.type === 'data' && frame.data === 'next')).toBe(true)
    expect(sentFrames(closed)).toHaveLength(0)
  })

  it('pauses the pty past the high watermark and resumes after acks', async () => {
    const { registry } = createRegistry({ highWatermarkBytes: 10, lowWatermarkBytes: 5 })
    const fakeProc = proc()
    const session = registerSession(registry, { proc: fakeProc })
    const client = socket(1)
    registry.attach(session, client)
    await drain(session)

    registry.broadcast(session, '0123456789abc')
    expect(fakeProc.pause).toHaveBeenCalledTimes(1)
    expect(session.paused).toBe(true)

    registry.ack(session, client, 4)
    expect(fakeProc.resume).not.toHaveBeenCalled()

    registry.ack(session, client, 9)
    expect(fakeProc.resume).toHaveBeenCalledTimes(1)
    expect(session.paused).toBe(false)
  })

  it('resumes a paused pty when the slow socket detaches', async () => {
    const { registry } = createRegistry({ highWatermarkBytes: 10, lowWatermarkBytes: 5 })
    const fakeProc = proc()
    const session = registerSession(registry, { proc: fakeProc })
    const client = socket(1)
    registry.attach(session, client)
    await drain(session)

    registry.broadcast(session, '0123456789abc')
    expect(session.paused).toBe(true)

    registry.detach(session, client)
    expect(fakeProc.resume).toHaveBeenCalledTimes(1)
  })

  it('waitForScreen resolves on screen matches and rejects on timeout', async () => {
    const { registry, timers } = createRegistry()
    const session = registerSession(registry)

    const waiting = registry.waitForScreen(session, {
      pattern: /ready \d+/,
      timeoutMs: 1_000,
    })
    registry.append(session, 'booting...\r\nready 42\r\n')
    await expect(waiting).resolves.toEqual({ match: 'ready 42' })

    const timingOut = registry.waitForScreen(session, {
      pattern: /never-appears/,
      timeoutMs: 1_000,
    })
    const timeout = timers.at(-1)
    timeout?.()
    await expect(timingOut).rejects.toThrow('Timed out')
  })

  it('waitForIdle resolves after output settles and resets on activity', async () => {
    // Real timers: idle settling is time-based by nature.
    const registry = makeTerminalRegistry({ idleKillMs: 60_000, socketOpenState: 1 })
    const session = registerSession(registry)

    let resolved = false
    const waiting = registry.waitForIdle(session, { settleMs: 250, timeoutMs: 5_000 })
      .then((result) => {
        resolved = true
        return result
      })

    // Activity within the settle window keeps it pending.
    await new Promise((resolve) => setTimeout(resolve, 120))
    registry.append(session, 'still working\r\n')
    await drain(session)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(resolved).toBe(false)

    await expect(waiting).resolves.toEqual({ quietMs: 250 })

    // Exited sessions are immediately idle.
    registry.kill(session)
    await expect(registry.waitForIdle(session, { settleMs: 250, timeoutMs: 1_000 }))
      .resolves.toEqual({ quietMs: 0 })
  })

  it('waitForIdle honors abort and timeout', async () => {
    const registry = makeTerminalRegistry({ idleKillMs: 60_000, socketOpenState: 1 })
    const session = registerSession(registry)
    const controller = new AbortController()

    const aborting = registry.waitForIdle(session, {
      settleMs: 60_000,
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    controller.abort()
    await expect(aborting).rejects.toThrow('aborted')
    expect(session.screenListeners.size).toBe(0)

    // Timeout fires when activity never settles.
    const interval = setInterval(() => {
      registry.append(session, 'busy\r\n')
    }, 40)
    try {
      await expect(registry.waitForIdle(session, { settleMs: 300, timeoutMs: 250 }))
        .rejects.toThrow('Timed out')
    } finally {
      clearInterval(interval)
    }
  })

  it('waitForScreen aborts cleanly and releases its listener', async () => {
    const { registry } = createRegistry()
    const session = registerSession(registry)
    const controller = new AbortController()

    const waiting = registry.waitForScreen(session, {
      pattern: /never/,
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    expect(session.screenListeners.size).toBe(1)
    controller.abort()
    await expect(waiting).rejects.toThrow('aborted')
    expect(session.screenListeners.size).toBe(0)

    // An already-aborted signal rejects without registering anything.
    await expect(registry.waitForScreen(session, {
      pattern: /never/,
      timeoutMs: 60_000,
      signal: controller.signal,
    })).rejects.toThrow('aborted')
    expect(session.screenListeners.size).toBe(0)
  })

  it('waitForScreen output scope matches raw output no longer on screen', async () => {
    const { registry } = createRegistry()
    const session = registerSession(registry)

    // Print a marker, then clear screen + scrollback: it is gone from the
    // visible screen but still matchable in the recent raw output window.
    registry.append(session, 'vanishing-marker\r\n[2J[3J[H')
    await drain(session)
    expect(registry.readScreen(session).lines.join('\n')).not.toContain('vanishing-marker')

    const waiting = registry.waitForScreen(session, {
      pattern: /vanishing-marker/,
      timeoutMs: 1_000,
      scope: 'output',
    })
    await expect(waiting).resolves.toEqual({ match: 'vanishing-marker' })
  })

  it('kills idle sessions after the last socket detaches and cancels idle kill on reattach', async () => {
    const timerCallbacks: Array<() => void> = []
    const activeTimers = new Set<ReturnType<typeof setTimeout>>()
    const registry = makeTerminalRegistry({
      idleKillMs: 100,
      socketOpenState: 1,
      timers: {
        setTimeout: (callback) => {
          const timer = (timerCallbacks.length + 1) as unknown as ReturnType<typeof setTimeout>
          activeTimers.add(timer)
          timerCallbacks.push(() => {
            if (activeTimers.has(timer)) callback()
          })
          return timer
        },
        clearTimeout: (timer) => {
          activeTimers.delete(timer)
        },
      },
    })
    const fakeProc = proc()
    const session = registerSession(registry, { proc: fakeProc })
    const first = socket()

    registry.attach(session, first)
    await drain(session)
    registry.detach(session, first)
    expect(timerCallbacks).toHaveLength(1)

    registry.attach(session, first)
    await drain(session)
    expect(activeTimers.size).toBe(0)
    expect(session.idleTimer).toBeNull()
    registry.detach(session, first)
    expect(timerCallbacks).toHaveLength(2)

    timerCallbacks[0]?.()
    expect(fakeProc.kill).not.toHaveBeenCalled()
    timerCallbacks[1]?.()
    expect(fakeProc.kill).toHaveBeenCalledTimes(1)
    expect(registry.sessions.has(session.key)).toBe(false)
  })

  it('exit notifies attached and pending sockets without closing key subscribers', async () => {
    const { registry } = createRegistry()
    const session = registerSession(registry)
    const attached = socket(1)
    registry.attach(session, attached)
    await drain(session)
    const pending = socket(1)
    registry.attach(session, pending)

    registry.exit(session, '[exited]')

    const attachedFrames = sentFrames(attached)
    expect(attachedFrames.at(-1)).toEqual({ type: 'exit', message: '[exited]' })
    expect(attached.close).not.toHaveBeenCalled()
    expect(sentFrames(pending)).toEqual([{ type: 'exit', message: '[exited]' }])
    expect(pending.close).not.toHaveBeenCalled()
    expect(registry.sessions.has(session.key)).toBe(false)
  })

  it('keeps subscribers across exit and emits replaced plus a fresh snapshot on respawn', async () => {
    const { registry } = createRegistry()
    const first = registerSession(registry, { banner: 'first\r\n' })
    const client = socket(1)
    registry.attach(first, client)
    await drain(first)
    client.send.mockClear()

    registry.exit(first, '[exited]')
    const second = registerSession(registry, { banner: 'second\r\n' })
    registry.append(second, 'after-respawn')
    registry.broadcast(second, 'after-respawn')
    await drain(second)

    const frames = sentFrames(client)
    expect(frames[0]).toEqual({ type: 'exit', message: '[exited]' })
    expect(frames[1]).toEqual({ type: 'replaced', generation: 2 })
    expect(frames[2]).toMatchObject({ type: 'snapshot', generation: 2, cols: 80, rows: 24 })
    expect(frames[2]?.type === 'snapshot' ? frames[2].data : '').toContain('second')
    expect(frames[3]).toEqual({ type: 'data', data: 'after-respawn' })
    expect(client.close).not.toHaveBeenCalled()
  })

  it('closeAgentRuntime and closeAll cleanup sessions without touching shell-only keys accidentally', () => {
    const { registry } = createRegistry()
    const runtimeProc = proc()
    const shellProc = proc()
    const runtimeSession = registerSession(registry, { proc: runtimeProc })
    registry.register({
      key: 'project-1:shell',
      cwd: '/repo',
      mode: 'shell',
      label: 'shell',
      proc: shellProc,
      cols: 80,
      rows: 24,
    })

    registry.closeAgentRuntime('agent-1')
    expect(runtimeProc.kill).toHaveBeenCalledTimes(1)
    expect(shellProc.kill).not.toHaveBeenCalled()

    registry.exit(runtimeSession, 'late runtime exit')
    expect(registry.sessions.has('project-1:shell')).toBe(true)

    registry.closeAll()
    expect(shellProc.kill).toHaveBeenCalledTimes(1)
    expect(registry.sessions.size).toBe(0)
  })
})
