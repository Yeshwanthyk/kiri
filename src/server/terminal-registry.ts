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

type TerminalRegistryKeyState = {
  readonly key: string
  generation: number
  readonly sockets: Set<TerminalRegistrySocket>
  readonly pendingAttaches: PendingAttach[]
  readonly screenListeners: Set<() => void>
  replacement: ReplacementReplay | null
}

type ReplacementReplay = {
  readonly session: TerminalRegistrySession
  readonly sockets: Set<TerminalRegistrySocket>
  readonly buffered: Map<TerminalRegistrySocket, string[]>
}

export type TerminalRegistrySession = {
  readonly key: string
  readonly cwd: string
  readonly mode: TerminalMode
  readonly label: string
  readonly state: TerminalRegistryKeyState
  readonly proc: TerminalRegistryProc
  readonly sockets: Set<TerminalRegistrySocket>
  readonly headless: HeadlessTerminal
  readonly serializer: SerializeAddon
  readonly pendingAttaches: PendingAttach[]
  readonly outstandingBytes: Map<TerminalRegistrySocket, number>
  readonly recentOutputChunks: string[]
  readonly screenListeners: Set<() => void>
  recentOutputBytes: number
  recentOutputStartSeq: number
  outputSeq: number
  generation: number
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
  const keyStates = new Map<string, TerminalRegistryKeyState>()
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
    return termId === 'main' ? `${config.projectId}:shell` : `${config.projectId}:shell:${termId}`
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
    if (existing?.exited) {
      deleteOwnedSession(existing)
      maybeDeleteKeyState(existing.state)
      return null
    }
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
    const state = stateFor(inputSession.key)
    const isReplacement = state.generation > 0
    state.generation += 1
    state.replacement = null
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
      state,
      proc: inputSession.proc,
      sockets: state.sockets,
      headless,
      serializer,
      pendingAttaches: state.pendingAttaches,
      outstandingBytes: new Map(),
      recentOutputChunks: [],
      screenListeners: new Set(),
      recentOutputBytes: 0,
      recentOutputStartSeq: 1,
      outputSeq: 0,
      generation: state.generation,
      cols: inputSession.cols,
      rows: inputSession.rows,
      paused: false,
      idleTimer: null,
      exited: false,
    }
    sessions.set(session.key, session)
    if (inputSession.banner) append(session, inputSession.banner)
    if (isReplacement) publishReplacement(session)
    return session
  }

  // Attach sequencing: the emulator parses writes asynchronously, so a snapshot
  // taken synchronously could miss output that is appended but not yet parsed.
  // A zero-byte write sentinel flushes the queue; live output arriving before
  // the sentinel fires is buffered per attaching socket and replayed after the
  // snapshot, preserving exact ordering without duplication.
  function attach(session: TerminalRegistrySession, socket: TerminalRegistrySocket) {
    if (session.exited) {
      session.state.sockets.add(socket)
      maybeDeleteKeyState(session.state)
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
        generation: session.generation,
      })
      session.sockets.add(socket)
      session.outstandingBytes.set(socket, 0)
      for (const chunk of pending.buffered) {
        sendData(session, socket, chunk)
      }
    })
  }

  function detach(session: TerminalRegistrySession, socket: TerminalRegistrySocket) {
    detachKey(session.key, socket)
  }

  function detachKey(key: string, socket: TerminalRegistrySocket) {
    const state = keyStates.get(key)
    if (!state) return
    state.sockets.delete(socket)
    removePendingAttachFromState(state, socket)
    const replacement = state.replacement
    if (replacement) {
      replacement.sockets.delete(socket)
      replacement.buffered.delete(socket)
    }
    const session = sessions.get(key)
    if (session) {
      session.outstandingBytes.delete(socket)
      maybeResume(session)
      scheduleIdleKill(session)
    }
    maybeDeleteKeyState(state)
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
    closeKeyState(session.state)
    session.proc.kill()
    disposeEmulator(session)
  }

  function append(session: TerminalRegistrySession, data: string) {
    if (!data) return
    session.headless.write(data, () => {
      for (const listener of session.screenListeners) listener()
      for (const listener of session.state.screenListeners) listener()
    })
    session.recentOutputChunks.push(data)
    session.recentOutputBytes += data.length
    while (
      session.recentOutputBytes > maxRecentOutputBytes &&
      session.recentOutputChunks.length > 1
    ) {
      const removed = session.recentOutputChunks.shift() ?? ''
      session.recentOutputBytes -= removed.length
      session.recentOutputStartSeq += 1
    }
    session.outputSeq += 1
  }

  function broadcast(session: TerminalRegistrySession, data: string) {
    const replacement = session.state.replacement
    for (const socket of session.sockets) {
      if (replacement?.session === session && replacement.sockets.has(socket)) {
        replacement.buffered.get(socket)?.push(data)
        continue
      }
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

  function ackKey(key: string, socket: TerminalRegistrySocket, bytes: number) {
    const session = sessions.get(key)
    if (session && !session.exited) ack(session, socket, bytes)
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

  function cursor(session: TerminalRegistrySession) {
    return `${session.generation}:${session.outputSeq}`
  }

  function outputSince(session: TerminalRegistrySession, cursorValue: string | undefined) {
    if (!cursorValue) return ''
    const parsed = /^(\d+):(\d+)$/.exec(cursorValue)
    if (!parsed) return session.recentOutputChunks.join('')
    const generation = Number(parsed[1])
    const seq = Number(parsed[2])
    if (generation !== session.generation) return session.recentOutputChunks.join('')
    const offset = Math.max(0, seq - session.recentOutputStartSeq + 1)
    return session.recentOutputChunks.slice(offset).join('')
  }

  // Resolves once `pattern` matches the visible screen ('screen' scope) or the
  // recent raw output window ('output' scope), or rejects on timeout or abort.
  // Matching re-runs after every parsed output chunk. The abort signal lets
  // multiplexed waits (wait-any) release their listeners as soon as another
  // session wins the race.
  function waitForScreen(
    session: TerminalRegistrySession,
    options: {
      readonly pattern: RegExp
      readonly timeoutMs: number
      readonly scope?: 'screen' | 'output'
      readonly followReplacement?: boolean
      readonly signal?: AbortSignal
    },
  ) {
    const scope = options.scope ?? 'screen'
    const listenerSet = options.followReplacement
      ? session.state.screenListeners
      : session.screenListeners
    const matchTarget = () => {
      const target = options.followReplacement ? sessions.get(session.key) : session
      if (!target || target.exited) return ''
      return scope === 'screen'
        ? readScreen(target).lines.join('\n')
        : target.recentOutputChunks.join('')
    }
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
        listenerSet.delete(listener)
        timers.clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      listenerSet.add(listener)
      listener()
    })
  }

  // Resolves once the session has produced no parsed output for `settleMs`
  // (measured from this call or the last output, whichever is later), rejects
  // on timeout/abort. Exited sessions are immediately idle. This is the
  // "worker went quiet" primitive behind idle-based wakes.
  function waitForIdle(
    session: TerminalRegistrySession,
    options: {
      readonly settleMs: number
      readonly timeoutMs: number
      readonly signal?: AbortSignal
    },
  ) {
    return new Promise<{ quietMs: number }>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error(`Wait aborted for ${session.key}`))
        return
      }
      if (session.exited) {
        resolve({ quietMs: 0 })
        return
      }
      let settled = false
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      const fire = () => {
        if (settled) return
        settle()
        resolve({ quietMs: options.settleMs })
      }
      const arm = () => {
        if (settleTimer) timers.clearTimeout(settleTimer)
        settleTimer = timers.setTimeout(fire, options.settleMs)
      }
      const listener = () => {
        if (!settled) arm()
      }
      const onAbort = () => {
        if (settled) return
        settle()
        reject(new Error(`Wait aborted for ${session.key}`))
      }
      const timeoutTimer = timers.setTimeout(() => {
        if (settled) return
        settle()
        reject(new Error(`Timed out waiting for idle on ${session.key}`))
      }, options.timeoutMs)
      function settle() {
        settled = true
        session.screenListeners.delete(listener)
        if (settleTimer) timers.clearTimeout(settleTimer)
        timers.clearTimeout(timeoutTimer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      session.screenListeners.add(listener)
      arm()
    })
  }

  function exit(session: TerminalRegistrySession, message: string) {
    if (session.exited || sessions.get(session.key) !== session) return
    session.exited = true
    if (session.idleTimer) {
      timers.clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    append(session, message)
    const frame: TerminalServerFrame = { type: 'exit', message }
    for (const socket of session.sockets) {
      if (socket.readyState === input.socketOpenState) sendFrame(socket, frame)
    }
    for (const pending of session.pendingAttaches) {
      if (pending.socket.readyState === input.socketOpenState) sendFrame(pending.socket, frame)
      session.state.sockets.add(pending.socket)
    }
    session.pendingAttaches.length = 0
    deleteOwnedSession(session)
    disposeEmulator(session)
    maybeDeleteKeyState(session.state)
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
    for (const state of Array.from(keyStates.values())) closeKeyState(state)
    keyStates.clear()
  }

  return {
    sessions,
    sessionKey,
    getReusable,
    register,
    attach,
    detach,
    detachKey,
    scheduleIdleKill,
    kill,
    append,
    broadcast,
    ack,
    ackKey,
    resize,
    snapshot,
    readScreen,
    cursor,
    outputSince,
    waitForScreen,
    waitForIdle,
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

  function removePendingAttachFromState(
    state: TerminalRegistryKeyState,
    socket: TerminalRegistrySocket,
  ) {
    const index = state.pendingAttaches.findIndex((pending) => pending.socket === socket)
    if (index !== -1) state.pendingAttaches.splice(index, 1)
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

  function stateFor(key: string) {
    const existing = keyStates.get(key)
    if (existing) return existing
    const state: TerminalRegistryKeyState = {
      key,
      generation: 0,
      sockets: new Set(),
      pendingAttaches: [],
      screenListeners: new Set(),
      replacement: null,
    }
    keyStates.set(key, state)
    return state
  }

  function publishReplacement(session: TerminalRegistrySession) {
    const replay: ReplacementReplay = {
      session,
      sockets: new Set(session.state.sockets),
      buffered: new Map(Array.from(session.state.sockets, (socket) => [socket, []])),
    }
    session.state.replacement = replay
    session.headless.write('', () => {
      if (session.state.replacement !== replay) return
      for (const socket of replay.sockets) {
        if (socket.readyState !== input.socketOpenState) continue
        sendFrame(socket, { type: 'replaced', generation: session.generation })
        sendFrame(socket, {
          type: 'snapshot',
          data: session.serializer.serialize(),
          cols: session.cols,
          rows: session.rows,
          generation: session.generation,
        })
        session.outstandingBytes.set(socket, 0)
        for (const chunk of replay.buffered.get(socket) ?? []) {
          sendData(session, socket, chunk)
        }
      }
      session.state.replacement = null
      for (const listener of session.state.screenListeners) listener()
    })
  }

  function maybeDeleteKeyState(state: TerminalRegistryKeyState) {
    if (sessions.has(state.key)) return
    if (state.sockets.size > 0) return
    if (state.pendingAttaches.length > 0) return
    if (state.screenListeners.size > 0) return
    if (state.replacement) return
    keyStates.delete(state.key)
  }

  function closeKeyState(state: TerminalRegistryKeyState) {
    for (const socket of state.sockets) socket.close()
    for (const pending of state.pendingAttaches) pending.socket.close()
    state.sockets.clear()
    state.pendingAttaches.length = 0
    state.screenListeners.clear()
    state.replacement = null
    keyStates.delete(state.key)
  }
}

function sendFrame(socket: TerminalRegistrySocket, frame: TerminalServerFrame) {
  socket.send(JSON.stringify(frame))
}
