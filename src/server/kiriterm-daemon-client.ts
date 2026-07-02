import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { rememberCodexTerminalSession } from './codex-cli-sessions'
import {
  getAgentLaunchConfig,
  requeueAgentTerminalInputs,
  setAgentStatus,
  takeAgentTerminalInputs,
} from './db'
import type { AgentStatus } from '~/lib/contracts'
import {
  acquireKiritermDaemonLock,
  checkKiritermDaemonHealth,
  defaultKiritermStateDir,
  readKiritermDaemonRecord,
  type KiritermCodexLaunch,
  type KiritermDaemonRecord,
} from './kiriterm-daemon'
import type { TerminalAgentLaunchConfig } from './terminal-launch'
import type { TerminalServerApi, TerminalServerInfo } from './terminal-server'

// Backend-side client for the kiriterm daemon. Implements the same surface as
// the embedded terminal server, but sessions live in a detached process that
// survives backend and UI restarts. All database reads stay on this side: the
// daemon receives launch configs and pending inputs over its control API.

export type KiritermDaemonClientOptions = {
  readonly stateDir?: string
  readonly spawnTimeoutMs?: number
  readonly presencePollIntervalMs?: number
  readonly setAgentStatus?: (agentId: string, status: AgentStatus) => void
}

export function makeKiritermDaemonClient(
  options: KiritermDaemonClientOptions = {},
): TerminalServerApi {
  const stateDir = options.stateDir ?? defaultKiritermStateDir()
  let record: KiritermDaemonRecord | null = null
  let ensuring: Promise<KiritermDaemonRecord> | null = null
  let presencePoll: NodeJS.Timeout | null = null
  let presencePollDaemon: KiritermDaemonRecord | null = null
  let presencePollInFlight: Promise<void> | null = null
  let presencePollEpoch = 0
  let lastPresenceSeq = 0
  const projectAgentStatus = options.setAgentStatus ?? setAgentStatus

  async function ensureDaemon(): Promise<KiritermDaemonRecord> {
    if (record && (await checkKiritermDaemonHealth(record))) {
      startPresencePolling(record)
      return record
    }
    record = null
    stopPresencePolling()
    if (!ensuring) {
      ensuring = discoverOrSpawn().finally(() => {
        ensuring = null
      })
    }
    return ensuring
  }

  async function discoverOrSpawn(): Promise<KiritermDaemonRecord> {
    const existing = readKiritermDaemonRecord(stateDir)
    if (existing && (await checkKiritermDaemonHealth(existing))) {
      record = existing
      startPresencePolling(existing)
      return existing
    }
    const spawnTimeoutMs = options.spawnTimeoutMs ?? 8_000
    const lock = acquireKiritermDaemonLock(stateDir, spawnTimeoutMs)
    if (lock) {
      try {
        const latest = readKiritermDaemonRecord(stateDir)
        if (latest && (await checkKiritermDaemonHealth(latest))) {
          record = latest
          startPresencePolling(latest)
          return latest
        }
        spawnDaemonProcess(stateDir)
      } finally {
        lock.release()
      }
    }
    const deadline = Date.now() + spawnTimeoutMs
    while (Date.now() < deadline) {
      await sleep(120)
      const candidate = readKiritermDaemonRecord(stateDir)
      if (candidate && (await checkKiritermDaemonHealth(candidate))) {
        record = candidate
        startPresencePolling(candidate)
        return candidate
      }
    }
    throw new Error('kiriterm daemon did not become healthy in time')
  }

  async function request(route: string, body?: unknown): Promise<unknown> {
    const daemon = await ensureDaemon()
    const response = await fetch(`http://${daemon.host}:${daemon.port}/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${daemon.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(630_000),
    })
    const payload: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message =
        typeof payload === 'object' && payload !== null && 'error' in payload
          ? String(payload.error)
          : `kiriterm daemon request failed: ${route} (${response.status})`
      throw new Error(message)
    }
    return payload
  }

  function processCodexLaunches(config: TerminalAgentLaunchConfig, payload: unknown) {
    if (typeof payload !== 'object' || payload === null || !('codexLaunches' in payload)) return
    const launches = payload.codexLaunches
    if (!Array.isArray(launches)) return
    for (const launch of launches) {
      if (!isCodexLaunch(launch)) continue
      const launchConfig = launch.agentId === config.id ? config : getAgentLaunchConfig(launch.agentId)
      void rememberCodexTerminalSession(
        launchConfig,
        launch.codexHome === null ? {} : { CODEX_HOME: launch.codexHome },
        { launchedAtMs: launch.launchedAtMs, launchToken: launch.launchToken },
      ).then((remembered) => {
        if (!remembered) {
          console.error('kiriterm daemon Codex session memory did not find session metadata')
        }
      }).catch((error) => {
        console.error('kiriterm daemon Codex session memory failed', error)
      })
    }
  }

  async function upsertAgent(config: TerminalAgentLaunchConfig) {
    const pendingInputs = takeAgentTerminalInputs(config.id)
    try {
      await request('agents/upsert', { config, pendingInputs })
    } catch (error) {
      if (pendingInputs.length > 0) requeueAgentTerminalInputs(config.id, pendingInputs)
      throw error
    }
  }

  return {
    ensure: async (): Promise<TerminalServerInfo> => {
      const daemon = await ensureDaemon()
      return { host: daemon.host, port: daemon.port, path: daemon.path, token: daemon.token }
    },
    prepareAgent: async (input) => {
      await upsertAgent(input.config)
      if (input.mode === 'runtime') {
        const payload = await request('agents/spawn', { agentId: input.config.id })
        processCodexLaunches(input.config, payload)
      }
    },
    spawnAgentRuntime: async (input) => {
      const config = getAgentLaunchConfig(input.agentId)
      await upsertAgent(config)
      const payload = await request('agents/spawn', {
        agentId: input.agentId,
        ...(input.cols !== undefined ? { cols: input.cols } : {}),
        ...(input.rows !== undefined ? { rows: input.rows } : {}),
      })
      processCodexLaunches(config, payload)
      return { agentId: input.agentId, mode: 'runtime' }
    },
    closeAgentRuntime: (agentId) => {
      void request('agents/close-runtime', { agentId }).catch((error) => {
        console.error('kiriterm daemon close-runtime failed', error)
      })
    },
    // The daemon outliving the backend is the point: closing the backend's
    // client must not stop detached sessions.
    close: () => {
      stopPresencePolling()
      return Promise.resolve()
    },
  }

  function startPresencePolling(daemon: KiritermDaemonRecord) {
    if (presencePoll && presencePollDaemon && sameDaemonRecord(presencePollDaemon, daemon)) return
    stopPresencePolling()
    presencePollDaemon = daemon
    lastPresenceSeq = 0
    presencePollEpoch += 1
    const epoch = presencePollEpoch
    const intervalMs = options.presencePollIntervalMs ?? 500
    presencePoll = setInterval(() => {
      tickPresencePolling(daemon, epoch)
    }, intervalMs)
    tickPresencePolling(daemon, epoch)
  }

  function stopPresencePolling() {
    if (presencePoll) clearInterval(presencePoll)
    presencePoll = null
    presencePollDaemon = null
    presencePollInFlight = null
    presencePollEpoch += 1
  }

  function tickPresencePolling(daemon: KiritermDaemonRecord, epoch: number) {
    if (presencePollInFlight) return
    presencePollInFlight = pollPresenceEvents(daemon, epoch)
      .catch(() => {})
      .finally(() => {
        if (presencePollEpoch === epoch) presencePollInFlight = null
      })
  }

  async function pollPresenceEvents(daemon: KiritermDaemonRecord, epoch: number) {
    const afterSeq = lastPresenceSeq
    const payload = await requestRecord(daemon, 'presence-events', { afterSeq })
    if (presencePollEpoch !== epoch || afterSeq !== lastPresenceSeq) return
    if (!isPresenceEventsPayload(payload)) return
    for (const event of payload.events) {
      lastPresenceSeq = Math.max(lastPresenceSeq, event.seq)
      if (event.mode !== 'runtime') continue
      const agentId = runtimeAgentIdFromKey(event.key)
      if (!agentId) continue
      const status = agentStatusFromPresenceEvent(event.event)
      if (!status) continue
      projectAgentStatus(agentId, status)
    }
    lastPresenceSeq = Math.max(lastPresenceSeq, payload.latestSeq)
  }

  async function requestRecord(
    daemon: KiritermDaemonRecord,
    route: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`http://${daemon.host}:${daemon.port}/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${daemon.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(630_000),
    })
    const payload: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (route === 'presence-events' && response.status === 404) {
        return { events: [], latestSeq: lastPresenceSeq }
      }
      const message =
        typeof payload === 'object' && payload !== null && 'error' in payload
          ? String(payload.error)
          : `kiriterm daemon request failed: ${route} (${response.status})`
      throw new Error(message)
    }
    return payload
  }
}

function spawnDaemonProcess(stateDir: string) {
  const launch = resolveDaemonLaunch()
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...launch.env,
      KIRI_TERM_STATE_DIR: stateDir,
    },
  })
  child.unref()
}

export function resolveDaemonLaunch(): {
  command: string
  args: string[]
  env: Record<string, string>
} {
  const override = process.env.KIRI_TERM_DAEMON_BIN?.trim()
  if (override) return { command: override, args: ['term', 'daemon'], env: {} }
  if (process.env.KIRI_TERM_CORE === 'rust') {
    return { command: resolveRustDaemonBinary(), args: [], env: {} }
  }

  const builtCli = resolve(process.cwd(), 'dist/cli/kirictl.mjs')
  if (existsSync(builtCli)) {
    return {
      command: process.execPath,
      args: [builtCli, 'term', 'daemon'],
      // Electron binaries need this to run the entry as plain node.
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }

  return {
    command: 'pnpm',
    args: ['exec', 'tsx', resolve(process.cwd(), 'src/cli/kirictl.ts'), 'term', 'daemon'],
    env: {},
  }
}

function resolveRustDaemonBinary() {
  const binaryName = process.platform === 'win32' ? 'kiri-termd.exe' : 'kiri-termd'
  const packaged = resolve(process.resourcesPath ?? process.cwd(), 'bin', binaryName)
  if (existsSync(packaged)) return packaged
  const dist = resolve(process.cwd(), 'dist/bin', binaryName)
  if (existsSync(dist)) return dist
  return resolve(process.cwd(), 'target/debug', binaryName)
}

function isCodexLaunch(value: unknown): value is KiritermCodexLaunch {
  if (typeof value !== 'object' || value === null) return false
  if (!('agentId' in value) || typeof value.agentId !== 'string') return false
  if (!('codexHome' in value) || (typeof value.codexHome !== 'string' && value.codexHome !== null)) {
    return false
  }
  if (!('launchedAtMs' in value) || typeof value.launchedAtMs !== 'number') return false
  return 'launchToken' in value && typeof value.launchToken === 'string'
}

type PresenceEventsPayload = {
  readonly events: readonly PresenceEventRecord[]
  readonly latestSeq: number
}

type PresenceEventRecord = {
  readonly seq: number
  readonly key: string
  readonly mode: string
  readonly event: unknown
}

function isPresenceEventsPayload(value: unknown): value is PresenceEventsPayload {
  if (typeof value !== 'object' || value === null) return false
  if (!('latestSeq' in value) || typeof value.latestSeq !== 'number') return false
  if (!('events' in value) || !Array.isArray(value.events)) return false
  return value.events.every((event) => (
    typeof event === 'object' &&
    event !== null &&
    'seq' in event &&
    typeof event.seq === 'number' &&
    'key' in event &&
    typeof event.key === 'string' &&
    'mode' in event &&
    typeof event.mode === 'string' &&
    'event' in event
  ))
}

function runtimeAgentIdFromKey(key: string) {
  const suffix = ':runtime'
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) : null
}

function sameDaemonRecord(left: KiritermDaemonRecord, right: KiritermDaemonRecord) {
  return left.host === right.host &&
    left.port === right.port &&
    left.path === right.path &&
    left.token === right.token
}

function agentStatusFromPresenceEvent(event: unknown): AgentStatus | null {
  if (typeof event !== 'object' || event === null || !('event' in event)) return null
  switch (event.event) {
    case 'busy':
      return 'running'
    case 'awaiting_input':
      return 'blocked'
    case 'session_start':
    case 'idle':
    case 'session_end':
      return 'idle'
    default:
      return null
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
