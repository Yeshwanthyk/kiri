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

type CodexSessionCandidate = {
  readonly path: string
  readonly mtimeMs: number
}

type CodexSessionDiscoveryInput = {
  readonly codexHome?: string
  readonly cwd: string
  readonly limit?: number
  readonly newerThanMs?: number
  readonly requireUnique?: boolean
}

type WaitForCodexSessionInput = CodexSessionDiscoveryInput & {
  readonly attempts?: number
  readonly intervalMs?: number
}

type RememberCodexTerminalSessionInput = {
  readonly launchedAtMs: number
  readonly launchToken: string
}

const latestLaunchTokenByAgentId = new Map<string, string>()

export function codexSessionsRoot(codexHome?: string) {
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
  const matchingSessionIds: string[] = []

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
        if (!input.requireUnique) return id
        matchingSessionIds.push(id)
      }
    } catch {
      continue
    }
  }

  return matchingSessionIds.length === 1 ? matchingSessionIds[0] : null
}

export async function rememberCodexTerminalSession(
  config: TerminalAgentLaunchConfig,
  env: NodeJS.ProcessEnv,
  input: RememberCodexTerminalSessionInput,
) {
  if (config.runtime !== 'codex') return
  latestLaunchTokenByAgentId.set(config.id, input.launchToken)
  if (stateHasCodexResume(getAgentRuntimeState(config.id))) return

  const sessionId = await waitForLatestCodexSessionForCwd({
    codexHome: env.CODEX_HOME,
    cwd: config.cwd,
    newerThanMs: input.launchedAtMs - 1000,
    requireUnique: true,
  })
  if (!sessionId) return
  if (latestLaunchTokenByAgentId.get(config.id) !== input.launchToken) return

  const currentState = getAgentRuntimeState(config.id)
  if (latestLaunchTokenByAgentId.get(config.id) !== input.launchToken) return
  if (stateHasCodexResume(currentState)) return
  setAgentRuntimeState(config.id, { ...currentState, codexSessionId: sessionId })
}

export async function waitForLatestCodexSessionForCwd(input: WaitForCodexSessionInput) {
  const attempts = input.attempts ?? 20
  const intervalMs = input.intervalMs ?? 100
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

function stateHasCodexResume(state: Record<string, unknown>) {
  return Boolean(stringValue(state.resume) ?? stringValue(state.codexSessionId))
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function normalizePath(path: string) {
  return resolve(path)
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
