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
  normalizeCodexSessionId,
  writeCodexTerminalSessionId,
} from './codex-terminal-session'

type CodexSessionCandidate = {
  readonly path: string
  readonly mtimeMs: number
}

type CodexSessionDiscoveryInput = {
  readonly codexHome?: string
  readonly cwd: string
  readonly limit?: number
  readonly newerThanMs?: number
  readonly closestToMs?: number
  readonly requireUnique?: boolean
}

type WaitForCodexSessionInput = CodexSessionDiscoveryInput & {
  readonly attempts?: number
  readonly intervalMs?: number
}

type RememberCodexTerminalSessionInput = {
  readonly launchedAtMs: number
  readonly launchToken: string
  readonly attempts?: number
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
    .filter((candidate) => input.newerThanMs === undefined || candidate.mtimeMs >= input.newerThanMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, input.limit ?? 200)
  const matchingSessions: Array<{ id: string; sortMs: number }> = []

  for (const candidate of candidates) {
    const firstLine = readFirstLine(candidate.path)
    if (!firstLine) continue

    try {
      const event: unknown = JSON.parse(firstLine)
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue
      const payload = 'payload' in event ? event.payload : undefined
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
      const id = 'id' in payload && typeof payload.id === 'string' ? payload.id : undefined
      const sessionCwd = 'cwd' in payload && typeof payload.cwd === 'string'
        ? normalizePath(payload.cwd)
        : undefined
      if (id && sessionCwd === cwd) {
        const payloadTimestamp = 'timestamp' in payload && typeof payload.timestamp === 'string'
          ? Date.parse(payload.timestamp)
          : NaN
        const sortMs = Number.isFinite(payloadTimestamp) ? payloadTimestamp : candidate.mtimeMs
        matchingSessions.push({ id, sortMs })
      }
    } catch {
      continue
    }
  }

  if (input.closestToMs !== undefined) {
    const closestToMs = input.closestToMs
    matchingSessions.sort((left, right) =>
      Math.abs(left.sortMs - closestToMs) - Math.abs(right.sortMs - closestToMs)
      || left.sortMs - right.sortMs)
    return matchingSessions[0]?.id ?? null
  }
  if (!input.requireUnique) return matchingSessions[0]?.id ?? null
  return matchingSessions.length === 1 ? matchingSessions[0].id : null
}

export async function rememberCodexTerminalSession(
  config: TerminalAgentLaunchConfig,
  env: NodeJS.ProcessEnv,
  input: RememberCodexTerminalSessionInput,
) {
  if (config.runtime !== 'codex') return true
  latestLaunchTokenByAgentId.set(config.id, input.launchToken)
  const initialResume = codexResumeIdFromState(getAgentRuntimeState(config.id))
  if (initialResume) {
    writeCodexTerminalSessionId(config.sessionDir, initialResume)
    return true
  }

  const sessionId = await waitForLatestCodexSessionForCwd({
    codexHome: env.CODEX_HOME,
    cwd: config.cwd,
    newerThanMs: input.launchedAtMs - 1000,
    closestToMs: input.launchedAtMs,
    attempts: input.attempts,
    intervalMs: input.intervalMs,
  })
  if (!sessionId) return false
  if (latestLaunchTokenByAgentId.get(config.id) !== input.launchToken) return true

  const currentState = getAgentRuntimeState(config.id)
  if (latestLaunchTokenByAgentId.get(config.id) !== input.launchToken) return true
  const currentResume = codexResumeIdFromState(currentState)
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
      candidates.push({ path, mtimeMs: statSync(path).mtimeMs })
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

function codexResumeIdFromState(state: Record<string, unknown>) {
  return normalizeCodexSessionId(state.resume) ?? normalizeCodexSessionId(state.codexSessionId)
}

function normalizePath(path: string) {
  return resolve(path)
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
