import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { rememberCodexTerminalSession } from './codex-cli-sessions'
import {
  getAgentLaunchConfig,
  requeueAgentTerminalInputs,
  takeAgentTerminalInputs,
} from './db'
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
}

export function makeKiritermDaemonClient(
  options: KiritermDaemonClientOptions = {},
): TerminalServerApi {
  const stateDir = options.stateDir ?? defaultKiritermStateDir()
  let record: KiritermDaemonRecord | null = null
  let ensuring: Promise<KiritermDaemonRecord> | null = null

  async function ensureDaemon(): Promise<KiritermDaemonRecord> {
    if (record && (await checkKiritermDaemonHealth(record))) return record
    record = null
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
      return existing
    }
    const spawnTimeoutMs = options.spawnTimeoutMs ?? 8_000
    const lock = acquireKiritermDaemonLock(stateDir, spawnTimeoutMs)
    if (lock) {
      try {
        const latest = readKiritermDaemonRecord(stateDir)
        if (latest && (await checkKiritermDaemonHealth(latest))) {
          record = latest
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
    close: () => Promise.resolve(),
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

function resolveDaemonLaunch(): {
  command: string
  args: string[]
  env: Record<string, string>
} {
  const override = process.env.KIRI_TERM_DAEMON_BIN?.trim()
  if (override) return { command: override, args: ['term', 'daemon'], env: {} }

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

function isCodexLaunch(value: unknown): value is KiritermCodexLaunch {
  if (typeof value !== 'object' || value === null) return false
  if (!('agentId' in value) || typeof value.agentId !== 'string') return false
  if (!('codexHome' in value) || (typeof value.codexHome !== 'string' && value.codexHome !== null)) {
    return false
  }
  if (!('launchedAtMs' in value) || typeof value.launchedAtMs !== 'number') return false
  return 'launchToken' in value && typeof value.launchToken === 'string'
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
