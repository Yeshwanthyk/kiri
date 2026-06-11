import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
// The headless UMD bundle defeats node's CJS named-export detection, so plain
// node ESM (tsx harnesses, kirictl) only sees a default export. The type-only
// import is erased at runtime.
import xtermHeadless, { type Terminal as HeadlessTerminal } from '@xterm/headless'
import type { RuntimeKind, TerminalMode, TerminalServerFrame } from '~/lib/contracts'

const { Terminal: HeadlessTerminalCtor } = xtermHeadless

export type TerminalRegistryProc = {
  readonly resize: (cols: number, rows: number) => void
  readonly write: (data: string) => void
  readonly kill: () => void
  readonly pause?: () => void
  readonly resume?: () => void
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

export type TerminalScreen = {
  readonly lines: string[]
  readonly cursorX: number
  readonly cursorY: number
  readonly cols: number
  readonly rows: number
  readonly bufferType: 'normal' | 'alternate'
}

type PendingAttach = {
  readonly socket: TerminalRegistrySocket
  readonly buffered: string[]
}

export type TerminalRegistrySession = {
  readonly key: string
  readonly cwd: string
  readonly mode: TerminalMode
  readonly label: string
  readonly proc: TerminalRegistryProc
  readonly sockets: Set<TerminalRegistrySocket>
  readonly headless: HeadlessTerminal
  readonly serializer: SerializeAddon
  readonly pendingAttaches: PendingAttach[]
  readonly outstandingBytes: Map<TerminalRegistrySocket, number>
  readonly recentOutputChunks: string[]
  readonly screenListeners: Set<() => void>
  recentOutputBytes: number
  cols: number
  rows: number
  paused: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
}

type TerminalRegistryTimers = {
  readonly setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

type TerminalRegistryInput = {
  readonly idleKillMs: number
  readonly socketOpenState: number
  readonly scrollback?: number
  readonly highWatermarkBytes?: number
  readonly lowWatermarkBytes?: number
  readonly maxRecentOutputBytes?: number
  readonly timers?: TerminalRegistryTimers
  // Which session modes are killed after sitting idle with no clients. The
  // daemon disables this for runtime sessions so background agents keep
  // running detached; shells stay reclaimable.
  readonly idleKillModes?: readonly TerminalMode[]
}

const defaultTimers: TerminalRegistryTimers = {
  setTimeout,
  clearTimeout,
}

const defaultScrollback = 10_000
const defaultHighWatermarkBytes = 256_000
const defaultLowWatermarkBytes = 64_000
const defaultMaxRecentOutputBytes = 64_000

export function makeTerminalRegistry(input: TerminalRegistryInput) {
  const sessions = new Map<string, TerminalRegistrySession>()
  const timers = input.timers ?? defaultTimers
  const scrollback = input.scrollback ?? defaultScrollback
  const highWatermark = input.highWatermarkBytes ?? defaultHighWatermarkBytes
  const lowWatermark = input.lowWatermarkBytes ?? defaultLowWatermarkBytes
  const maxRecentOutputBytes = input.maxRecentOutputBytes ?? defaultMaxRecentOutputBytes
  const idleKillModes = input.idleKillModes ?? ['shell', 'runtime']

  // Shell sessions support multiple terminals per project via termId; the
  // default 'main' keeps the historical key so persisted snapshots and MCP
  // shell targeting stay stable.
  function sessionKey(config: TerminalRegistryLaunchConfig, mode: TerminalMode, termId = 'main') {
    if (mode !== 'shell') return `${config.id}:runtime`
    return termId === 'main'
      ? `${config.projectId}:shell`
      : `${config.projectId}:shell:${termId}`
  }

  function getReusable(
    config: TerminalRegistryLaunchConfig,
    mode: TerminalMode,
    cols: number,
    rows: number,
    termId = 'main',
  ) {
    const key = sessionKey(config, mode, termId)
    const existing = sessions.get(key)
    if (existing && existing.cwd === config.cwd) {
      resize(existing, cols, rows)
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
    readonly cols: number
    readonly rows: number
    readonly banner?: string
  }) {
    const headless = new HeadlessTerminalCtor({
      cols: inputSession.cols,
      rows: inputSession.rows,
      scrollback,
      allowProposedApi: true,
    })
    headless.loadAddon(new Unicode11Addon())
    headless.unicode.activeVersion = '11'
    const serializer = new SerializeAddon()
    headless.loadAddon(serializer)
    const session: TerminalRegistrySession = {
      key: inputSession.key,
      cwd: inputSession.cwd,
      mode: inputSession.mode,
      label: inputSession.label,
      proc: inputSession.proc,
      sockets: new Set(),
      headless,
      serializer,
      pendingAttaches: [],
      outstandingBytes: new Map(),
      recentOutputChunks: [],
      screenListeners: new Set(),
      recentOutputBytes: 0,
      cols: inputSession.cols,
      rows: inputSession.rows,
      paused: false,
      idleTimer: null,
      exited: false,
    }
    sessions.set(session.key, session)
    if (inputSession.banner) append(session, inputSession.banner)
    return session
  }

  // Attach sequencing: the emulator parses writes asynchronously, so a snapshot
  // taken synchronously could miss output that is appended but not yet parsed.
  // A zero-byte write sentinel flushes the queue; live output arriving before
  // the sentinel fires is buffered per attaching socket and replayed after the
  // snapshot, preserving exact ordering without duplication.
  function attach(session: TerminalRegistrySession, socket: TerminalRegistrySocket) {
    if (session.exited) {
      socket.close()
      return
    }
    if (session.idleTimer) {
      timers.clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    const pending: PendingAttach = { socket, buffered: [] }
    session.pendingAttaches.push(pending)
    session.headless.write('', () => {
      const index = session.pendingAttaches.indexOf(pending)
      if (index === -1) return
      session.pendingAttaches.splice(index, 1)
      if (socket.readyState !== input.socketOpenState) return
      sendFrame(socket, {
        type: 'snapshot',
        data: session.serializer.serialize(),
        cols: session.cols,
        rows: session.rows,
      })
      session.sockets.add(socket)
      session.outstandingBytes.set(socket, 0)
      for (const chunk of pending.buffered) {
        sendData(session, socket, chunk)
      }
    })
  }

  function detach(session: TerminalRegistrySession, socket: TerminalRegistrySocket) {
    session.sockets.delete(socket)
    session.outstandingBytes.delete(socket)
    removePendingAttach(session, socket)
    maybeResume(session)
    scheduleIdleKill(session)
  }

  function scheduleIdleKill(session: TerminalRegistrySession) {
    if (session.exited || session.idleTimer) return
    if (!idleKillModes.includes(session.mode)) return
    if (session.sockets.size > 0 || session.pendingAttaches.length > 0) return
    session.idleTimer = timers.setTimeout(() => {
      if (session.sockets.size === 0 && session.pendingAttaches.length === 0) kill(session)
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
    disposeEmulator(session)
  }

  function append(session: TerminalRegistrySession, data: string) {
    if (!data) return
    session.headless.write(data, () => {
      for (const listener of session.screenListeners) listener()
    })
    session.recentOutputChunks.push(data)
    session.recentOutputBytes += data.length
    while (
      session.recentOutputBytes > maxRecentOutputBytes &&
      session.recentOutputChunks.length > 1
    ) {
      const removed = session.recentOutputChunks.shift() ?? ''
      session.recentOutputBytes -= removed.length
    }
  }

  function broadcast(session: TerminalRegistrySession, data: string) {
    for (const socket of session.sockets) {
      sendData(session, socket, data)
    }
    for (const pending of session.pendingAttaches) {
      pending.buffered.push(data)
    }
  }

  function ack(session: TerminalRegistrySession, socket: TerminalRegistrySocket, bytes: number) {
    const outstanding = session.outstandingBytes.get(socket)
    if (outstanding === undefined) return
    session.outstandingBytes.set(socket, Math.max(0, outstanding - bytes))
    maybeResume(session)
  }

  function resize(session: TerminalRegistrySession, cols: number, rows: number) {
    session.cols = cols
    session.rows = rows
    session.proc.resize(cols, rows)
    session.headless.resize(cols, rows)
  }

  function snapshot(session: TerminalRegistrySession, scrollbackLines?: number) {
    return session.serializer.serialize(
      scrollbackLines === undefined ? undefined : { scrollback: scrollbackLines },
    )
  }

  function readScreen(session: TerminalRegistrySession): TerminalScreen {
    const buffer = session.headless.buffer.active
    const lines: string[] = []
    for (let y = buffer.baseY; y < buffer.baseY + session.rows; y += 1) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
    }
    return {
      lines,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      cols: session.cols,
      rows: session.rows,
      bufferType: buffer.type,
    }
  }

  // Resolves once `pattern` matches the visible screen ('screen' scope) or the
  // recent raw output window ('output' scope), or rejects on timeout or abort.
  // Matching re-runs after every parsed output chunk. The abort signal lets
  // multiplexed waits (wait-any) release their listeners as soon as another
  // session wins the race.
  function waitForScreen(session: TerminalRegistrySession, options: {
    readonly pattern: RegExp
    readonly timeoutMs: number
    readonly scope?: 'screen' | 'output'
    readonly signal?: AbortSignal
  }) {
    const scope = options.scope ?? 'screen'
    const matchTarget = () =>
      scope === 'screen'
        ? readScreen(session).lines.join('\n')
        : session.recentOutputChunks.join('')
    return new Promise<{ match: string }>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error(`Wait aborted for ${session.key}`))
        return
      }
      let settled = false
      const listener = () => {
        const match = options.pattern.exec(matchTarget())
        if (!match || settled) return
        settle()
        resolve({ match: match[0] })
      }
      const onAbort = () => {
        if (settled) return
        settle()
        reject(new Error(`Wait aborted for ${session.key}`))
      }
      const timer = timers.setTimeout(() => {
        if (settled) return
        settle()
        reject(new Error(`Timed out waiting for ${options.pattern} on ${session.key}`))
      }, options.timeoutMs)
      function settle() {
        settled = true
        session.screenListeners.delete(listener)
        timers.clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      session.screenListeners.add(listener)
      listener()
    })
  }

  function exit(session: TerminalRegistrySession, message: string) {
    session.exited = true
    if (session.idleTimer) {
      timers.clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    append(session, message)
    const frame: TerminalServerFrame = { type: 'exit', message }
    for (const socket of session.sockets) {
      if (socket.readyState === input.socketOpenState) sendFrame(socket, frame)
      socket.close()
    }
    for (const pending of session.pendingAttaches) {
      if (pending.socket.readyState === input.socketOpenState) sendFrame(pending.socket, frame)
      pending.socket.close()
    }
    session.pendingAttaches.length = 0
    deleteOwnedSession(session)
    disposeEmulator(session)
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
    scheduleIdleKill,
    kill,
    append,
    broadcast,
    ack,
    resize,
    snapshot,
    readScreen,
    waitForScreen,
    exit,
    closeAgentRuntime,
    closeAll,
  }

  function sendData(
    session: TerminalRegistrySession,
    socket: TerminalRegistrySocket,
    data: string,
  ) {
    if (socket.readyState !== input.socketOpenState) return
    sendFrame(socket, { type: 'data', data })
    const outstanding = (session.outstandingBytes.get(socket) ?? 0) + data.length
    session.outstandingBytes.set(socket, outstanding)
    if (outstanding > highWatermark && !session.paused) {
      session.paused = true
      session.proc.pause?.()
    }
  }

  function maybeResume(session: TerminalRegistrySession) {
    if (!session.paused) return
    for (const outstanding of session.outstandingBytes.values()) {
      if (outstanding >= lowWatermark) return
    }
    session.paused = false
    session.proc.resume?.()
  }

  function removePendingAttach(session: TerminalRegistrySession, socket: TerminalRegistrySocket) {
    const index = session.pendingAttaches.findIndex((pending) => pending.socket === socket)
    if (index !== -1) session.pendingAttaches.splice(index, 1)
  }

  function disposeEmulator(session: TerminalRegistrySession) {
    session.screenListeners.clear()
    session.headless.dispose()
  }

  function deleteOwnedSession(session: TerminalRegistrySession) {
    if (sessions.get(session.key) === session) {
      sessions.delete(session.key)
    }
  }
}

function sendFrame(socket: TerminalRegistrySocket, frame: TerminalServerFrame) {
  socket.send(JSON.stringify(frame))
}
