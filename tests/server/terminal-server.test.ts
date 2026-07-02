import { createServer, type Server } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import type { AgentStatus } from '~/lib/contracts'
import {
  closeTerminalServerForTests,
  ensureTerminalServer,
  makeTerminalServerService,
  TerminalServerService,
} from '~/server/terminal-server'
import { readCodexHookSessionBinding } from '~/server/codex-terminal-session'
import type { TerminalRegistrySession } from '~/server/terminal-registry'

describe('terminal server', () => {
  afterEach(async () => {
    await closeTerminalServerForTests()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('clears failed startup state so listen failures can be retried', async () => {
    const blocker = createServer()
    const port = await listen(blocker)
    vi.stubEnv('KIRI_TERMINAL_HOST', '127.0.0.1')
    vi.stubEnv('KIRI_TERMINAL_PORT', String(port))

    try {
      await expect(ensureTerminalServer()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    } finally {
      await close(blocker)
    }

    await expect(ensureTerminalServer()).resolves.toMatchObject({
      host: '127.0.0.1',
      port,
      path: '/terminal',
    })
  })

  it('keeps independent server service instances scoped to their own state', async () => {
    const first = makeTerminalServerService()
    const second = makeTerminalServerService()

    try {
      const [firstInfo, secondInfo] = await Promise.all([
        first.ensure(),
        second.ensure(),
      ])

      expect(firstInfo).toMatchObject({ host: '127.0.0.1', path: '/terminal' })
      expect(secondInfo).toMatchObject({ host: '127.0.0.1', path: '/terminal' })
      expect(firstInfo.token).not.toBe(secondInfo.token)
      expect(firstInfo.port).not.toBe(secondInfo.port)
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('spawns a runtime PTY and writes queued workflow paste input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-terminal-paste-'))
    const capturePath = join(root, 'capture.txt')
    const scriptPath = join(root, 'fake-agent.sh')
    writeFileSync(scriptPath, [
      '#!/bin/sh',
      'IFS= read -r line',
      'printf "%s" "$line" > "$KIRI_CAPTURE_PATH"',
      'sleep 5',
    ].join('\n'))
    chmodSync(scriptPath, 0o755)
    const service = makeTerminalServerService({
      getAgentLaunchConfig: () => ({
        id: 'agent-1',
        projectId: 'project-1',
        runtime: 'pi',
        sessionDir: root,
        sessionFile: null,
        model: 'test-model',
        cwd: root,
      }),
      buildTerminalProcessLaunch: () => ({
        command: scriptPath,
        args: [],
        cwd: root,
        env: {
          ...process.env,
          KIRI_CAPTURE_PATH: capturePath,
        },
        label: 'pi',
      }),
      takeAgentTerminalInputs: () => [{
        text: 'workflow terminal body',
        submit: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    })

    try {
      await expect(service.spawnAgentRuntime({
        agentId: 'agent-1',
      })).resolves.toMatchObject({
        agentId: 'agent-1',
        mode: 'runtime',
      })
      await expect.poll(() => readFileSync(capturePath, 'utf8')).toBe('workflow terminal body')
    } finally {
      await service.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('consumes queued input that was passed as the runtime initial prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-terminal-initial-prompt-'))
    const capturePath = join(root, 'capture.txt')
    const scriptPath = join(root, 'fake-agent.sh')
    writeFileSync(scriptPath, [
      '#!/bin/sh',
      'printf "%s" "$1" > "$KIRI_CAPTURE_PATH"',
      'sleep 5',
    ].join('\n'))
    chmodSync(scriptPath, 0o755)
    const pending = [{
      text: 'workflow terminal body',
      submit: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    }]
    const requeue = vi.fn()
    const service = makeTerminalServerService({
      getAgentLaunchConfig: () => ({
        id: 'agent-1',
        projectId: 'project-1',
        runtime: 'claude',
        sessionDir: root,
        sessionFile: null,
        model: 'test-model',
        cwd: root,
      }),
      buildTerminalProcessLaunch: () => ({
        command: scriptPath,
        args: [pending[0]?.text ?? ''],
        cwd: root,
        env: {
          ...process.env,
          KIRI_CAPTURE_PATH: capturePath,
        },
        label: 'claude',
        initialTerminalInput: pending[0],
      }),
      takeAgentTerminalInputs: () => pending,
      requeueAgentTerminalInputs: requeue,
    })

    try {
      await expect(service.spawnAgentRuntime({
        agentId: 'agent-1',
      })).resolves.toMatchObject({
        agentId: 'agent-1',
        mode: 'runtime',
      })
      await expect.poll(() => readFileSync(capturePath, 'utf8')).toBe('workflow terminal body')
      expect(requeue).not.toHaveBeenCalled()
    } finally {
      await service.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('submits runtime initial prompts after the TUI has time to initialize', async () => {
    vi.useFakeTimers()
    const write = vi.fn()
    const pending = {
      text: 'workflow terminal body',
      submit: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const service = makeTerminalServerService({
      getAgentLaunchConfig: () => ({
        id: 'agent-1',
        projectId: 'project-1',
        runtime: 'codex',
        sessionDir: '/tmp/session',
        sessionFile: null,
        model: 'test-model',
        cwd: '/tmp/project',
      }),
      buildTerminalProcessLaunch: () => ({
        command: '/bin/fake',
        args: [pending.text],
        cwd: '/tmp/project',
        env: process.env,
        label: 'codex',
        initialTerminalInput: pending,
      }),
      spawnPty: () => ({
        write,
        resize: vi.fn(),
        kill: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn(),
      } as never),
      takeAgentTerminalInputs: () => [pending],
    })

    try {
      await expect(service.spawnAgentRuntime({ agentId: 'agent-1' })).resolves.toMatchObject({
        agentId: 'agent-1',
        mode: 'runtime',
      })
      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(8_000)
      expect(write).toHaveBeenCalledWith('\r')
    } finally {
      await service.close()
    }
  })

  it('writes a fresh pid-bound Codex hook binding for resume launches', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'kiri-codex-resume-'))
    const service = makeTerminalServerService({
      getAgentLaunchConfig: () => ({
        id: 'agent-1',
        projectId: 'project-1',
        runtime: 'codex',
        sessionDir,
        sessionFile: null,
        model: 'test-model',
        cwd: '/tmp/project',
      }),
      buildTerminalProcessLaunch: () => ({
        command: '/bin/fake',
        args: ['resume', 'codex-session-1'],
        cwd: '/tmp/project',
        env: process.env,
        label: 'codex',
        codexResumeSessionId: 'codex-session-1',
      }),
      spawnPty: () => ({
        pid: 4242,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn(),
      } as never),
    })

    try {
      await service.spawnAgentRuntime({ agentId: 'agent-1' })

      expect(readCodexHookSessionBinding(sessionDir)).toMatchObject({
        agentId: 'agent-1',
        sessionId: 'codex-session-1',
        cwd: '/tmp/project',
        pid: 4242,
      })
    } finally {
      await service.close()
      rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it('requeues pending workflow paste input when PTY write fails', async () => {
    const pending = [{
      text: 'retry me',
      submit: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    }]
    const requeue = vi.fn()
    const kill = vi.fn()
    const service = makeTerminalServerService({
      getAgentLaunchConfig: () => ({
        id: 'agent-1',
        projectId: 'project-1',
        runtime: 'pi',
        sessionDir: '/tmp/session',
        sessionFile: null,
        model: 'test-model',
        cwd: '/tmp/project',
      }),
      buildTerminalProcessLaunch: () => ({
        command: '/bin/fake',
        args: [],
        cwd: '/tmp/project',
        env: process.env,
        label: 'pi',
      }),
      spawnPty: () => ({
        write: () => {
          throw new Error('write failed')
        },
        resize: vi.fn(),
        kill,
        onData: vi.fn(),
        onExit: vi.fn(),
      } as never),
      takeAgentTerminalInputs: () => pending,
      requeueAgentTerminalInputs: requeue,
    })

    try {
      await expect(service.spawnAgentRuntime({ agentId: 'agent-1' }))
        .rejects.toThrow('write failed')
      expect(requeue).toHaveBeenCalledWith('agent-1', pending)
      expect(kill).toHaveBeenCalledTimes(1)
      await expect(service.spawnAgentRuntime({ agentId: 'agent-1' }))
        .rejects.toThrow('write failed')
      expect(requeue).toHaveBeenCalledTimes(2)
    } finally {
      await service.close()
    }
  })

  it('dedups concurrent runtime spawns and resizes joined callers to their geometry', async () => {
    const resize = vi.fn()
    const spawnPty = vi.fn(() => ({
      write: vi.fn(),
      resize,
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    } as never))
    const service = makeTerminalServerService({
      getAgentLaunchConfig: () => ({
        id: 'agent-1',
        projectId: 'project-1',
        runtime: 'pi',
        sessionDir: '/tmp/session',
        sessionFile: null,
        model: 'test-model',
        cwd: '/tmp/project',
      }),
      buildTerminalProcessLaunch: () => ({
        command: '/bin/fake',
        args: [],
        cwd: '/tmp/project',
        env: process.env,
        label: 'pi',
      }),
      spawnPty,
    })

    try {
      await service.ensure()
      await Promise.all([
        service.spawnAgentRuntime({ agentId: 'agent-1', cols: 80, rows: 24 }),
        service.spawnAgentRuntime({ agentId: 'agent-1', cols: 132, rows: 40 }),
      ])

      expect(spawnPty).toHaveBeenCalledTimes(1)
      expect(service.registry.sessions.size).toBe(1)
      expect(service.registry.sessions.get('agent-1:runtime')).toMatchObject({
        cols: 132,
        rows: 40,
      })
      expect(resize).toHaveBeenCalledWith(132, 40)
    } finally {
      await service.close()
    }
  })

  it('projects runtime OSC presence into agent status and leaves shell presence local', async () => {
    const statuses: Array<{ agentId: string; status: AgentStatus }> = []
    const service = makeTerminalServerService({
      getAgentLaunchConfig: () => ({
        id: 'agent-1',
        projectId: 'project-1',
        runtime: 'claude',
        sessionDir: '/tmp/session',
        sessionFile: null,
        model: 'test-model',
        cwd: '/tmp/project',
      }),
      buildTerminalProcessLaunch: () => ({
        command: '/bin/fake',
        args: [],
        cwd: '/tmp/project',
        env: process.env,
        label: 'claude',
      }),
      spawnPty: () => ({
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn(),
      } as never),
      setAgentStatus: (agentId, status) => {
        statuses.push({ agentId, status })
      },
    })

    try {
      await service.spawnAgentRuntime({ agentId: 'agent-1' })
      const runtime = service.registry.sessions.get('agent-1:runtime')
      if (!runtime) throw new Error('expected runtime session')
      service.registry.append(runtime, '\x1b]3008;start=claude;event=busy\x1b\\')
      await drainTerminalSession(runtime)
      service.registry.append(runtime, '\x1b]3008;start=claude;event=awaiting_input\x1b\\')
      await drainTerminalSession(runtime)
      service.registry.exit(runtime, '[exited]')

      const shell = service.registry.register({
        key: 'project-1:shell',
        cwd: '/tmp/project',
        mode: 'shell',
        label: 'shell',
        cols: 100,
        rows: 30,
        banner: '',
        proc: {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(),
          onExit: vi.fn(),
        } as never,
      })
      service.registry.append(shell, '\x1b]3008;start=claude;event=busy\x1b\\')
      await drainTerminalSession(shell)

      expect(statuses).toEqual([
        { agentId: 'agent-1', status: 'running' },
        { agentId: 'agent-1', status: 'blocked' },
        { agentId: 'agent-1', status: 'idle' },
      ])
      expect(shell.presence).toEqual({ agent: 'claude', event: 'busy' })
    } finally {
      await service.close()
    }
  })

  it('drains pending runtime input after joining an in-flight spawn', async () => {
    const write = vi.fn()
    const pendingInput = {
      text: 'late prompt',
      submit: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    let takeCount = 0
    const service = makeTerminalServerService({
      getAgentLaunchConfig: () => ({
        id: 'agent-1',
        projectId: 'project-1',
        runtime: 'pi',
        sessionDir: '/tmp/session',
        sessionFile: null,
        model: 'test-model',
        cwd: '/tmp/project',
      }),
      buildTerminalProcessLaunch: () => ({
        command: '/bin/fake',
        args: [],
        cwd: '/tmp/project',
        env: process.env,
        label: 'pi',
      }),
      spawnPty: () => ({
        write,
        resize: vi.fn(),
        kill: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn(),
      } as never),
      takeAgentTerminalInputs: () => {
        takeCount += 1
        return takeCount === 2 ? [pendingInput] : []
      },
    })

    try {
      await service.ensure()
      await Promise.all([
        service.spawnAgentRuntime({ agentId: 'agent-1' }),
        service.spawnAgentRuntime({ agentId: 'agent-1' }),
      ])

      expect(write).toHaveBeenCalledWith('late prompt\r')
    } finally {
      await service.close()
    }
  })

  it('can idle-kill shells without scheduling runtime idle cleanup when configured shell-only', async () => {
    const runtimeKill = vi.fn()
    const shellKill = vi.fn()
    const service = makeTerminalServerService({
      getAgentLaunchConfig: () => ({
        id: 'agent-1',
        projectId: 'project-1',
        runtime: 'pi',
        sessionDir: '/tmp/session',
        sessionFile: null,
        model: 'test-model',
        cwd: '/tmp/project',
      }),
      buildTerminalProcessLaunch: () => ({
        command: '/bin/fake',
        args: [],
        cwd: '/tmp/project',
        env: process.env,
        label: 'pi',
      }),
      spawnPty: () => ({
        write: vi.fn(),
        resize: vi.fn(),
        kill: runtimeKill,
        onData: vi.fn(),
        onExit: vi.fn(),
      } as never),
    }, { idleKillModes: ['shell'] })

    try {
      await service.spawnAgentRuntime({ agentId: 'agent-1' })
      const runtime = service.registry.sessions.get('agent-1:runtime')
      if (!runtime) throw new Error('expected runtime session')
      service.registry.scheduleIdleKill(runtime)
      expect(runtime.idleTimer).toBeNull()
      expect(runtimeKill).not.toHaveBeenCalled()

      const shell = service.registry.register({
        key: 'project-1:shell',
        cwd: '/tmp/project',
        mode: 'shell',
        label: 'shell',
        cols: 100,
        rows: 30,
        banner: '',
        proc: {
          write: vi.fn(),
          resize: vi.fn(),
          kill: shellKill,
          onData: vi.fn(),
          onExit: vi.fn(),
        } as never,
      })
      service.registry.scheduleIdleKill(shell)
      expect(shell.idleTimer).not.toBeNull()
      expect(shellKill).not.toHaveBeenCalled()
    } finally {
      await service.close()
    }
  })

  it('keeps an attached websocket subscribed across runtime respawn', async () => {
    const exitHandlers: Array<(event: { exitCode: number; signal?: number }) => void> = []
    const service = makeTerminalServerService({
      getAgentLaunchConfig: () => ({
        id: 'agent-1',
        projectId: 'project-1',
        runtime: 'pi',
        sessionDir: '/tmp/session',
        sessionFile: null,
        model: 'test-model',
        cwd: '/tmp/project',
      }),
      buildTerminalProcessLaunch: () => ({
        command: '/bin/fake',
        args: [],
        cwd: '/tmp/project',
        env: process.env,
        label: 'pi',
      }),
      spawnPty: () => ({
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn((handler: (event: { exitCode: number; signal?: number }) => void) => {
          exitHandlers.push(handler)
        }),
      } as never),
    })

    let socket: WebSocket | null = null
    try {
      const info = await service.ensure()
      socket = new WebSocket(
        `ws://${info.host}:${info.port}${info.path}?token=${info.token}&agentId=agent-1&mode=runtime`,
      )
      const frames = collectFrames(socket)
      await frames.opened

      await expect(frames.next()).resolves.toMatchObject({
        type: 'snapshot',
        generation: 1,
      })

      exitHandlers[0]?.({ exitCode: 0 })
      await expect(frames.next()).resolves.toEqual({
        type: 'exit',
        message: '\r\n[kiri terminal exited: 0]\r\n',
      })

      await service.spawnAgentRuntime({ agentId: 'agent-1' })
      await expect(frames.next()).resolves.toEqual({ type: 'replaced', generation: 2 })
      await expect(frames.next()).resolves.toMatchObject({
        type: 'snapshot',
        generation: 2,
      })
      expect(socket.readyState).toBe(WebSocket.OPEN)
    } finally {
      socket?.close()
      await service.close()
    }
  })

  it('provides a scoped Effect service layer and closes resources after scope exit', async () => {
    const info = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const service = yield* TerminalServerService
        return yield* Effect.promise(() => service.ensure())
      }).pipe(Effect.provide(TerminalServerService.layer)),
    ))

    expect(info).toMatchObject({
      host: '127.0.0.1',
      path: '/terminal',
    })

    const probe = createServer()
    try {
      await listen(probe, info.port)
    } finally {
      await close(probe)
    }
  })
})

function listen(server: Server, port = 0) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP address'))
        return
      }
      resolve(address.port)
    })
  })
}

function collectFrames(socket: WebSocket) {
  const pending: unknown[] = []
  const waiters: Array<(frame: unknown) => void> = []
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.on('message', (raw) => {
    const frame: unknown = JSON.parse(rawDataToString(raw))
    const waiter = waiters.shift()
    if (waiter) {
      waiter(frame)
      return
    }
    pending.push(frame)
  })
  return {
    opened,
    next: () => new Promise<unknown>((resolve) => {
      const frame = pending.shift()
      if (frame !== undefined) {
        resolve(frame)
        return
      }
      waiters.push(resolve)
    }),
  }
}

function rawDataToString(raw: RawData) {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  return Buffer.from(raw).toString('utf8')
}

function drainTerminalSession(session: TerminalRegistrySession) {
  return new Promise<void>((resolve) => {
    session.headless.write('', () => {
      resolve()
    })
  })
}

function close(server: Server) {
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
