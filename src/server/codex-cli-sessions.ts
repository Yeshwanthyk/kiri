import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TerminalAgentLaunchConfig } from './terminal-launch'
import { getAgentRuntimeState, setAgentRuntimeState } from './db'
import {
  codexHookSessionIdForLaunch,
  readCodexHookSessionBinding,
  readCodexTerminalResumeId,
  writeCodexTerminalSessionId,
} from './codex-terminal-session'

type CodexSessionCandidate = {
  readonly path: string
  readonly createdMs: number
}

type CodexSessionDiscoveryInput = {
  readonly codexHome?: string
  readonly cwd: string
  readonly pid?: number
  readonly limit?: number
  readonly newerThanMs?: number
  readonly closestToMs?: number
  readonly requireUnique?: boolean
  readonly openFilesForPid?: (pid: number) => readonly string[] | null
}

type WaitForCodexSessionInput = CodexSessionDiscoveryInput & {
  readonly attempts?: number
  readonly intervalMs?: number
}

type RememberCodexTerminalSessionInput = {
  readonly launchedAtMs: number
  readonly launchToken: string
  readonly pid?: number
  readonly attempts?: number
  readonly hookWaitMs?: number
  readonly intervalMs?: number
}

const defaultSessionDiscoveryAttempts = 120
const defaultSessionDiscoveryIntervalMs = 500

const latestLaunchTokenByAgentId = new Map<string, string>()

function codexSessionsRoot(codexHome?: string) {
  return join(codexHome ?? join(homedir(), '.codex'), 'sessions')
}

export function findLatestCodexSessionForCwd(input: CodexSessionDiscoveryInput) {
  const root = codexSessionsRoot(input.codexHome)
  if (!existsSync(root)) return null

  const cwd = normalizePath(input.cwd)
  const candidates = collectCodexSessionFiles(root)
    .filter((candidate) => input.newerThanMs === undefined || candidate.createdMs >= input.newerThanMs)
    .sort((left, right) => right.createdMs - left.createdMs)
    .slice(0, input.limit ?? 200)
  const matchingSessions: Array<{ id: string; path: string; sortMs: number }> = []

  for (const candidate of candidates) {
    const firstLine = readFirstLine(candidate.path)
    if (!firstLine) continue

    try {
      const event: unknown = JSON.parse(firstLine)
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue
      const payload = 'payload' in event ? event.payload : undefined
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
      if ('thread_source' in payload && payload.thread_source === 'subagent') continue
      const id = 'id' in payload && typeof payload.id === 'string' ? payload.id : undefined
      const sessionCwd = 'cwd' in payload && typeof payload.cwd === 'string'
        ? normalizePath(payload.cwd)
        : undefined
      if (id && sessionCwd === cwd) {
        const payloadTimestamp = 'timestamp' in payload && typeof payload.timestamp === 'string'
          ? Date.parse(payload.timestamp)
          : NaN
        const sortMs = Number.isFinite(payloadTimestamp) ? payloadTimestamp : candidate.createdMs
        matchingSessions.push({ id, path: candidate.path, sortMs })
      }
    } catch {
      continue
    }
  }

  if (input.pid !== undefined) {
    const confirmed = pidConfirmedSessions(input.pid, matchingSessions, input.openFilesForPid)
    if (confirmed.length === 1) return confirmed[0]?.id ?? null
    if (confirmed.length > 1 && input.requireUnique) return null
  }
  if (input.requireUnique) return matchingSessions.length === 1 ? matchingSessions[0].id : null
  if (input.closestToMs !== undefined) {
    const closestToMs = input.closestToMs
    matchingSessions.sort((left, right) =>
      Math.abs(left.sortMs - closestToMs) - Math.abs(right.sortMs - closestToMs)
      || left.sortMs - right.sortMs)
    return matchingSessions[0]?.id ?? null
  }
  return matchingSessions[0]?.id ?? null
}

export async function rememberCodexTerminalSession(
  config: TerminalAgentLaunchConfig,
  env: NodeJS.ProcessEnv,
  input: RememberCodexTerminalSessionInput,
) {
  if (config.runtime !== 'codex') return true
  latestLaunchTokenByAgentId.set(config.id, input.launchToken)
  const initialResume = codexResumeIdFromState(getAgentRuntimeState(config.id), config, input.launchedAtMs)
  if (initialResume) {
    writeCodexTerminalSessionId(config.sessionDir, initialResume)
    return true
  }

  const attempts = input.attempts ?? defaultSessionDiscoveryAttempts
  const intervalMs = input.intervalMs ?? defaultSessionDiscoveryIntervalMs
  const totalWaitMs = attempts * intervalMs
  const hookWaitMs = Math.min(input.hookWaitMs ?? 15_000, totalWaitMs)
  const binding = await waitForCodexHookSessionBinding(config, {
    launchedAtMs: input.launchedAtMs,
    hookWaitMs,
    intervalMs,
  })
  if (binding) {
    if (latestLaunchTokenByAgentId.get(config.id) !== input.launchToken) return true
    writeCodexTerminalSessionId(config.sessionDir, binding.sessionId)
    setAgentRuntimeState(config.id, {
      ...getAgentRuntimeState(config.id),
      codexSessionId: binding.sessionId,
    })
    return true
  }

  const remainingAttempts = Math.max(0, Math.ceil((totalWaitMs - hookWaitMs) / intervalMs))
  if (remainingAttempts <= 0) return false
  const sessionId = await waitForLatestCodexSessionForCwd({
    codexHome: env.CODEX_HOME,
    cwd: config.cwd,
    pid: input.pid,
    newerThanMs: input.launchedAtMs - 1000,
    requireUnique: true,
    attempts: remainingAttempts,
    intervalMs,
  })
  if (!sessionId) return false
  if (latestLaunchTokenByAgentId.get(config.id) !== input.launchToken) return true

  const currentState = getAgentRuntimeState(config.id)
  if (latestLaunchTokenByAgentId.get(config.id) !== input.launchToken) return true
  const lateBinding = freshCodexHookSessionBinding(config, input.launchedAtMs)
  if (lateBinding) {
    writeCodexTerminalSessionId(config.sessionDir, lateBinding.sessionId)
    setAgentRuntimeState(config.id, { ...currentState, codexSessionId: lateBinding.sessionId })
    return true
  }
  const currentResume = codexResumeIdFromState(currentState, config, input.launchedAtMs)
  if (currentResume) {
    writeCodexTerminalSessionId(config.sessionDir, currentResume)
    return true
  }
  writeCodexTerminalSessionId(config.sessionDir, sessionId)
  setAgentRuntimeState(config.id, { ...currentState, codexSessionId: sessionId })
  return true
}

export async function waitForLatestCodexSessionForCwd(input: WaitForCodexSessionInput) {
  const attempts = input.attempts ?? defaultSessionDiscoveryAttempts
  const intervalMs = input.intervalMs ?? defaultSessionDiscoveryIntervalMs
  for (let index = 0; index < attempts; index += 1) {
    const sessionId = findLatestCodexSessionForCwd(input)
    if (sessionId) return sessionId
    if (index < attempts - 1) await delay(intervalMs)
  }
  return null
}

function collectCodexSessionFiles(root: string) {
  const candidates: CodexSessionCandidate[] = []
  walkCodexSessionFiles(root, candidates, 0)
  return candidates
}

function walkCodexSessionFiles(dir: string, candidates: CodexSessionCandidate[], depth: number) {
  if (depth > 5) return

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkCodexSessionFiles(path, candidates, depth + 1)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const stat = statSync(path)
      candidates.push({ path, createdMs: codexSessionCreatedMs(stat.birthtimeMs, stat.mtimeMs) })
    } catch {
      continue
    }
  }
}

function readFirstLine(path: string) {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(8192)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytesRead <= 0) return null
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0]?.trim() ?? null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

async function waitForCodexHookSessionBinding(
  config: TerminalAgentLaunchConfig,
  input: { readonly launchedAtMs: number; readonly hookWaitMs: number; readonly intervalMs: number },
) {
  if (input.hookWaitMs <= 0) return undefined
  const deadline = Date.now() + input.hookWaitMs
  while (Date.now() <= deadline) {
    const binding = freshCodexHookSessionBinding(config, input.launchedAtMs)
    if (binding) return binding
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(input.intervalMs, remaining))
  }
  return undefined
}

function freshCodexHookSessionBinding(config: TerminalAgentLaunchConfig, launchedAtMs: number) {
  const binding = readCodexHookSessionBinding(config.sessionDir)
  const sessionId = codexHookSessionIdForLaunch(binding, {
    agentId: config.id,
    cwd: config.cwd,
    launchedAtMs,
  })
  return sessionId ? binding : undefined
}

function codexResumeIdFromState(
  state: Record<string, unknown>,
  config: TerminalAgentLaunchConfig,
  launchedAtMs: number,
) {
  return readCodexTerminalResumeId({
    agentId: config.id,
    cwd: config.cwd,
    sessionDir: config.sessionDir,
    state,
    launchedAtMs,
  })
}

function codexSessionCreatedMs(birthtimeMs: number, mtimeMs: number) {
  if (!Number.isFinite(birthtimeMs) || birthtimeMs <= 0) return mtimeMs
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return birthtimeMs
  return Math.min(birthtimeMs, mtimeMs)
}

function pidConfirmedSessions(
  pid: number,
  sessions: ReadonlyArray<{ readonly id: string; readonly path: string; readonly sortMs: number }>,
  openFilesForPid: ((pid: number) => readonly string[] | null) | undefined,
) {
  const openFiles = openFilesForPid?.(pid) ?? lsofOpenFilesForPid(pid)
  if (!openFiles?.length) return []
  const normalizedOpenFiles = new Set(openFiles.map((path) => resolve(path)))
  return sessions.filter((session) => normalizedOpenFiles.has(resolve(session.path)))
}

function lsofOpenFilesForPid(pid: number) {
  const result = spawnSync('lsof', ['-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
  })
  if (result.error || result.status !== 0) return null
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const file = line.trim().split(/\s+/).at(-1)
      return file && file.startsWith('/') ? [file] : []
    })
}

function normalizePath(path: string) {
  return resolve(path)
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
