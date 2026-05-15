import type { RuntimeKind, TerminalMode } from '~/lib/contracts'

export type TerminalRegistryProc = {
  readonly resize: (cols: number, rows: number) => void
  readonly write: (data: string) => void
  readonly kill: () => void
}

export type TerminalRegistrySocket = {
  readonly readyState: number
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
  buffer: string
  idleTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
}

export type TerminalRegistryTimers = {
  readonly setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

type TerminalRegistryInput = {
  readonly maxReplayBytes: number
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

  function sessionKey(config: TerminalRegistryLaunchConfig, mode: TerminalMode) {
    return mode === 'shell'
      ? `${config.projectId}:shell`
      : `${config.id}:runtime`
  }

  function getReusable(config: TerminalRegistryLaunchConfig, mode: TerminalMode, cols: number, rows: number) {
    const key = sessionKey(config, mode)
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
      buffer: inputSession.initialBuffer,
      idleTimer: null,
      exited: false,
    }
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
  }

  function detach(session: TerminalRegistrySession, socket: TerminalRegistrySocket) {
    session.sockets.delete(socket)
    if (session.exited) return
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
    session.buffer = `${session.buffer}${data}`.slice(-input.maxReplayBytes)
  }

  function broadcast(session: TerminalRegistrySession, data: string) {
    for (const socket of session.sockets) {
      if (socket.readyState === input.socketOpenState) socket.send(data)
    }
  }

  function exit(session: TerminalRegistrySession, message: string) {
    session.exited = true
    if (session.idleTimer) {
      timers.clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    append(session, message)
    broadcast(session, message)
    for (const socket of session.sockets) {
      socket.close()
    }
    deleteOwnedSession(session)
  }

  function closeAgentRuntime(agentId: string) {
    const session = sessions.get(`${agentId}:runtime`)
    if (session) kill(session)
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

  function deleteOwnedSession(session: TerminalRegistrySession) {
    if (sessions.get(session.key) === session) {
      sessions.delete(session.key)
    }
  }
}
