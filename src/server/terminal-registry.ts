import type { RuntimeKind, TerminalMode } from '~/lib/contracts'

export type TerminalRegistryProc = {
  readonly resize: (cols: number, rows: number) => void
  readonly write: (data: string) => void
  readonly paste: (text: string, submit: boolean) => void
  readonly snapshot: () => void
  readonly kill: () => void
}

export type TerminalRegistrySocket = {
  readonly readyState: number
  readonly bufferedAmount?: number
  readonly send: (data: string) => void
  readonly close: () => void
}

export type TerminalRegistryLaunchConfig = {
  readonly id: string
  readonly projectId: string
  readonly runtime: RuntimeKind
  readonly cwd: string
}

export type TerminalRegistrySession = {
  readonly key: string
  readonly cwd: string
  readonly mode: TerminalMode
  readonly label: string
  readonly proc: TerminalRegistryProc
  readonly sockets: Set<TerminalRegistrySocket>
  readonly replayChunks: string[]
  buffer: string
  replayBytes: number
  idleTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
}

type TerminalRegistryTimers = {
  readonly setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

type TerminalRegistryInput = {
  readonly maxReplayBytes: number
  readonly maxSocketBufferedBytes?: number
  readonly idleKillMs: number
  readonly socketOpenState: number
  readonly timers?: TerminalRegistryTimers
}

const defaultTimers: TerminalRegistryTimers = {
  setTimeout,
  clearTimeout,
}

export function makeTerminalRegistry(input: TerminalRegistryInput) {
  const sessions = new Map<string, TerminalRegistrySession>()
  const timers = input.timers ?? defaultTimers
  const maxSocketBufferedBytes = input.maxSocketBufferedBytes ?? 5_000_000
  const exitCloseDelayMs = 20

  function sessionKey(config: TerminalRegistryLaunchConfig, mode: TerminalMode, instanceId = 'main') {
    const suffix = terminalInstanceSuffix(instanceId)
    return mode === 'shell'
      ? `${config.projectId}:shell:${suffix}`
      : `${config.id}:runtime:${suffix}`
  }

  function getReusable(
    config: TerminalRegistryLaunchConfig,
    mode: TerminalMode,
    cols: number,
    rows: number,
    instanceId = 'main',
  ) {
    const key = sessionKey(config, mode, instanceId)
    const existing = sessions.get(key)
    if (existing && existing.cwd === config.cwd) {
      existing.proc.resize(cols, rows)
      return existing
    }
    if (existing) kill(existing)
    return null
  }

  function register(inputSession: {
    readonly key: string
    readonly cwd: string
    readonly mode: TerminalMode
    readonly label: string
    readonly proc: TerminalRegistryProc
    readonly initialBuffer: string
  }) {
    const session: TerminalRegistrySession = {
      key: inputSession.key,
      cwd: inputSession.cwd,
      mode: inputSession.mode,
      label: inputSession.label,
      proc: inputSession.proc,
      sockets: new Set(),
      replayChunks: inputSession.initialBuffer ? [inputSession.initialBuffer] : [],
      buffer: inputSession.initialBuffer,
      replayBytes: inputSession.initialBuffer.length,
      idleTimer: null,
      exited: false,
    }
    trimReplay(session)
    session.buffer = session.replayChunks.join('')
    sessions.set(session.key, session)
    return session
  }

  function attach(session: TerminalRegistrySession, socket: TerminalRegistrySocket) {
    if (session.idleTimer) {
      timers.clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    session.sockets.add(socket)
    if (session.buffer) socket.send(session.buffer)
    session.proc.snapshot()
  }

  function detach(session: TerminalRegistrySession, socket: TerminalRegistrySocket) {
    session.sockets.delete(socket)
    if (session.exited) return
    if (session.mode === 'runtime') return
    if (session.sockets.size > 0 || session.idleTimer) return
    session.idleTimer = timers.setTimeout(() => {
      if (session.sockets.size === 0) kill(session)
    }, input.idleKillMs)
  }

  function kill(session: TerminalRegistrySession) {
    if (session.exited) return
    session.exited = true
    if (session.idleTimer) {
      timers.clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    deleteOwnedSession(session)
    session.proc.kill()
  }

  function append(session: TerminalRegistrySession, data: string) {
    const replayData = replayableTerminalData(data)
    if (!replayData) return
    session.replayChunks.push(replayData)
    session.replayBytes += replayData.length
    trimReplay(session)
    session.buffer = session.replayChunks.join('')
  }

  function broadcast(session: TerminalRegistrySession, data: string) {
    for (const socket of session.sockets) {
      if (socket.readyState !== input.socketOpenState) continue
      if ((socket.bufferedAmount ?? 0) > maxSocketBufferedBytes) {
        session.sockets.delete(socket)
        socket.close()
        continue
      }
      socket.send(data)
    }
  }

  function exit(session: TerminalRegistrySession, message: string) {
    if (session.exited) return
    session.exited = true
    if (session.idleTimer) {
      timers.clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    append(session, message)
    broadcast(session, message)
    const sockets = Array.from(session.sockets)
    timers.setTimeout(() => {
      for (const socket of sockets) {
        socket.close()
      }
    }, exitCloseDelayMs)
    deleteOwnedSession(session)
  }

  function closeAgentRuntime(agentId: string) {
    for (const [key, session] of Array.from(sessions)) {
      if (key.startsWith(`${agentId}:runtime:`)) kill(session)
    }
  }

  function closeAll() {
    for (const session of Array.from(sessions.values())) {
      kill(session)
    }
    sessions.clear()
  }

  return {
    sessions,
    sessionKey,
    getReusable,
    register,
    attach,
    detach,
    kill,
    append,
    broadcast,
    exit,
    closeAgentRuntime,
    closeAll,
  }

  function trimReplay(session: TerminalRegistrySession) {
    const totalBytes = session.replayBytes
    while (
      session.replayBytes > input.maxReplayBytes &&
      session.replayChunks.length > 1
    ) {
      const removed = session.replayChunks.shift() ?? ''
      session.replayBytes -= removed.length
    }
    if (session.replayBytes <= input.maxReplayBytes) return
    const rawTail = session.replayChunks[0]?.slice(-input.maxReplayBytes) ?? ''
    const tail = totalBytes > input.maxReplayBytes && rawTail.includes('\n')
      ? lineSafeTail(rawTail)
      : rawTail
    session.replayChunks.splice(0, session.replayChunks.length, tail)
    session.replayBytes = tail.length
  }

  function deleteOwnedSession(session: TerminalRegistrySession) {
    if (sessions.get(session.key) === session) {
      sessions.delete(session.key)
    }
  }
}

function lineSafeTail(rawTail: string) {
  const newline = rawTail.indexOf('\n')
  return newline === -1 ? '' : rawTail.slice(newline + 1)
}

function terminalInstanceSuffix(instanceId: string) {
  const normalized = instanceId.trim().replace(/[^a-zA-Z0-9_.:-]/g, '-')
  return normalized || 'main'
}

function replayableTerminalData(data: string) {
  return data
    .split(/(?<=\n)/)
    .filter((chunk) => !isTerminalMetricFrame(chunk))
    .join('')
}

function isTerminalMetricFrame(chunk: string) {
  const line = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk
  if (!line.trim()) return false
  try {
    const parsed: unknown = JSON.parse(line)
    return Boolean(
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'type' in parsed &&
      parsed.type === 'metric',
    )
  } catch {
    return false
  }
}
