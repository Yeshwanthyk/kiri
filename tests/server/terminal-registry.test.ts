import { describe, expect, it, vi } from 'vitest'
import { makeTerminalRegistry } from '../../src/server/terminal-registry'

function proc() {
  return {
    resize: vi.fn(),
    write: vi.fn(),
    paste: vi.fn(),
    snapshot: vi.fn(),
    kill: vi.fn(),
  }
}

function socket(openState = 1) {
  return {
    readyState: openState,
    send: vi.fn(),
    close: vi.fn(),
  }
}

function slowSocket(openState = 1, bufferedAmount = 6_000_000) {
  return {
    readyState: openState,
    bufferedAmount,
    send: vi.fn(),
    close: vi.fn(),
  }
}

function createRegistry() {
  const timers: Array<() => void> = []
  return {
    timers,
    registry: makeTerminalRegistry({
      maxReplayBytes: 12,
      idleKillMs: 100,
      socketOpenState: 1,
      timers: {
        setTimeout: (callback) => {
          timers.push(callback)
          return timers.length as unknown as ReturnType<typeof setTimeout>
        },
        clearTimeout: () => undefined,
      },
    }),
  }
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

    expect(registry.sessionKey(config, 'shell')).toBe('project-1:shell:main')
    expect(registry.sessionKey(config, 'runtime')).toBe('agent-1:runtime:main')
    expect(registry.sessionKey(config, 'runtime', 'pane/2')).toBe('agent-1:runtime:pane-2')
  })

  it('reuses matching cwd sessions and kills stale cwd sessions', () => {
    const { registry } = createRegistry()
    const firstProc = proc()
    const session = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: firstProc,
      initialBuffer: '',
    })
    const config = {
      id: 'agent-1',
      projectId: 'project-1',
      runtime: 'codex' as const,
      cwd: '/repo',
    }

    expect(registry.getReusable(config, 'runtime', 120, 40)).toBe(session)
    expect(firstProc.resize).toHaveBeenCalledWith(120, 40)

    expect(registry.getReusable({ ...config, cwd: '/other' }, 'runtime', 80, 24)).toBeNull()
    expect(firstProc.kill).toHaveBeenCalledTimes(1)
    expect(registry.sessions.has('agent-1:runtime:main')).toBe(false)
  })

  it('does not let stale process exit unregister a replacement session with the same key', () => {
    const { registry } = createRegistry()
    const oldProc = proc()
    const oldSession = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: oldProc,
      initialBuffer: '',
    })
    const config = {
      id: 'agent-1',
      projectId: 'project-1',
      runtime: 'codex' as const,
      cwd: '/other',
    }

    expect(registry.getReusable(config, 'runtime', 80, 24)).toBeNull()
    const replacement = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/other',
      mode: 'runtime',
      label: 'codex',
      proc: proc(),
      initialBuffer: '',
    })
    registry.exit(oldSession, 'old exit')

    expect(registry.sessions.get('agent-1:runtime:main')).toBe(replacement)
  })

  it('caps replay buffer and broadcasts only to open sockets', () => {
    const { registry } = createRegistry()
    const session = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: proc(),
      initialBuffer: 'hello',
    })
    const open = socket(1)
    const closed = socket(3)
    registry.attach(session, open)
    registry.attach(session, closed)

    registry.append(session, '-0123456789abcdef')
    registry.broadcast(session, 'next')

    expect(session.buffer).toBe('456789abcdef')
    expect(open.send).toHaveBeenCalledWith('hello')
    expect(session.proc.snapshot).toHaveBeenCalledTimes(2)
    expect(open.send).toHaveBeenCalledWith('next')
    expect(closed.send).toHaveBeenCalledWith('hello')
    expect(closed.send).not.toHaveBeenCalledWith('next')
  })

  it('trims replay on chunk boundaries before slicing a single oversized chunk', () => {
    const { registry } = createRegistry()
    const session = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: proc(),
      initialBuffer: '',
    })

    registry.append(session, 'abcde')
    registry.append(session, 'fghij')
    registry.append(session, 'klm')

    expect(session.buffer).toBe('fghijklm')
    expect(session.replayBytes).toBe(8)

    registry.append(session, 'mnopqrstuvwxyz')

    expect(session.buffer).toBe('opqrstuvwxyz')
    expect(session.replayChunks).toEqual(['opqrstuvwxyz'])
    expect(session.replayBytes).toBe(12)
  })

  it('sends the chunk-trimmed replay buffer on attach', () => {
    const { registry } = createRegistry()
    const session = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: proc(),
      initialBuffer: '',
    })
    registry.append(session, 'abcde')
    registry.append(session, 'fghij')
    registry.append(session, 'klm')
    const attached = socket(1)

    registry.attach(session, attached)

    expect(attached.send).toHaveBeenCalledWith('fghijklm')
  })

  it('broadcasts metric frames without storing them in replay', () => {
    const registry = makeTerminalRegistry({
      maxReplayBytes: 1000,
      idleKillMs: 100,
      socketOpenState: 1,
    })
    const session = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: proc(),
      initialBuffer: '',
    })
    const attached = socket(1)
    registry.attach(session, attached)
    const metric = '{"type":"metric","terminalId":"term","metric":{"name":"terminal.pty.read_bytes","value":10,"unit":"bytes"}}\n'
    const patch = '{"type":"patch","terminalId":"term","patch":{"ops":[]}}\n'

    registry.append(session, metric + patch)
    registry.broadcast(session, metric + patch)

    expect(session.buffer).toBe(patch)
    expect(attached.send).toHaveBeenCalledWith(metric + patch)
  })

  it('kills idle shell sessions after the last socket detaches and cancels idle kill on reattach', () => {
    const timers: Array<() => void> = []
    const activeTimers = new Set<ReturnType<typeof setTimeout>>()
    const registry = makeTerminalRegistry({
      maxReplayBytes: 12,
      idleKillMs: 100,
      socketOpenState: 1,
      timers: {
        setTimeout: (callback) => {
          const timer = (timers.length + 1) as unknown as ReturnType<typeof setTimeout>
          activeTimers.add(timer)
          timers.push(() => {
            if (activeTimers.has(timer)) callback()
          })
          return timer
        },
        clearTimeout: (timer) => {
          clearTimeout(timer)
          activeTimers.delete(timer)
        },
      },
    })
    const fakeProc = proc()
    const session = registry.register({
      key: 'project-1:shell:main',
      cwd: '/repo',
      mode: 'shell',
      label: 'shell',
      proc: fakeProc,
      initialBuffer: '',
    })
    const first = socket()

    registry.attach(session, first)
    registry.detach(session, first)
    expect(timers).toHaveLength(1)

    registry.attach(session, first)
    expect(activeTimers.size).toBe(0)
    expect(session.idleTimer).toBeNull()
    registry.detach(session, first)
    expect(timers).toHaveLength(2)

    timers[0]?.()
    expect(fakeProc.kill).not.toHaveBeenCalled()
    timers[0]?.()
    expect(fakeProc.kill).not.toHaveBeenCalled()
    timers[1]?.()
    expect(fakeProc.kill).toHaveBeenCalledTimes(1)
    expect(registry.sessions.has(session.key)).toBe(false)
  })

  it('keeps runtime sessions alive when their last socket detaches', () => {
    const { registry, timers } = createRegistry()
    const fakeProc = proc()
    const session = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: fakeProc,
      initialBuffer: '',
    })
    const first = socket()

    registry.attach(session, first)
    registry.detach(session, first)

    expect(timers).toHaveLength(0)
    expect(fakeProc.kill).not.toHaveBeenCalled()
    expect(registry.sessions.get(session.key)).toBe(session)
  })

  it('closes slow sockets instead of buffering terminal output without bound', () => {
    const registry = makeTerminalRegistry({
      maxReplayBytes: 1000,
      maxSocketBufferedBytes: 10,
      idleKillMs: 100,
      socketOpenState: 1,
    })
    const session = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: proc(),
      initialBuffer: '',
    })
    const fast = socket(1)
    const slow = slowSocket(1, 11)
    registry.attach(session, fast)
    registry.attach(session, slow)

    registry.broadcast(session, 'next')

    expect(fast.send).toHaveBeenCalledWith('next')
    expect(slow.send).not.toHaveBeenCalledWith('next')
    expect(slow.close).toHaveBeenCalledTimes(1)
    expect(session.sockets.has(slow)).toBe(false)
  })

  it('delays socket close on exit so final frames can flush', () => {
    const { registry, timers } = createRegistry()
    const session = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: proc(),
      initialBuffer: '',
    })
    const attached = socket(1)
    registry.attach(session, attached)

    registry.exit(session, 'done')

    expect(attached.send).toHaveBeenCalledWith('done')
    expect(attached.close).not.toHaveBeenCalled()
    timers.at(-1)?.()
    expect(attached.close).toHaveBeenCalledTimes(1)
  })

  it('closeAgentRuntime and closeAll cleanup sessions without touching shell-only keys accidentally', () => {
    const clearTimeout = vi.fn()
    const timer = 1 as unknown as ReturnType<typeof setTimeout>
    const registry = makeTerminalRegistry({
      maxReplayBytes: 12,
      idleKillMs: 100,
      socketOpenState: 1,
      timers: {
        setTimeout: () => timer,
        clearTimeout,
      },
    })
    const runtimeProc = proc()
    const shellProc = proc()
    const runtimeSession = registry.register({
      key: 'agent-1:runtime:main',
      cwd: '/repo',
      mode: 'runtime',
      label: 'codex',
      proc: runtimeProc,
      initialBuffer: '',
    })
    registry.register({
      key: 'project-1:shell:main',
      cwd: '/repo',
      mode: 'shell',
      label: 'shell',
      proc: shellProc,
      initialBuffer: '',
    })
    runtimeSession.idleTimer = timer

    registry.closeAgentRuntime('agent-1')
    expect(runtimeProc.kill).toHaveBeenCalledTimes(1)
    expect(clearTimeout).toHaveBeenCalledTimes(1)
    expect(runtimeSession.idleTimer).toBeNull()
    expect(shellProc.kill).not.toHaveBeenCalled()

    registry.exit(runtimeSession, 'late runtime exit')
    expect(registry.sessions.has('project-1:shell:main')).toBe(true)

    registry.closeAll()
    expect(shellProc.kill).toHaveBeenCalledTimes(1)
    expect(registry.sessions.size).toBe(0)
  })
})
