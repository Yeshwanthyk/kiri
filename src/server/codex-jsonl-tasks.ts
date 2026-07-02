import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { AgentTask } from '~/lib/contracts'
import {
  codexHookSessionIdForLaunch,
  normalizeCodexSessionId,
  readCodexHookSessionBinding,
  readCodexTerminalSessionId,
} from './codex-terminal-session'
import { normalizeTaskStatus } from './codex-value-helpers'

type CodexPlanTaskProjection = {
  readonly tasks: AgentTask[]
  readonly updatedAt?: string
}

type CodexSessionFileCandidate = {
  readonly path: string
  readonly mtimeMs: number
}

export function findCodexTerminalSessionJsonl(input: {
  readonly agentId: string
  readonly cwd: string
  readonly sessionDir: string
  readonly state?: Record<string, unknown>
  readonly codexHome?: string
}) {
  const binding = readCodexHookSessionBinding(input.sessionDir)
  const hookSessionId = codexHookSessionIdForLaunch(binding, input)
  if (hookSessionId && binding?.transcriptPath && isAbsolute(binding.transcriptPath) && existsSync(binding.transcriptPath)) {
    return binding.transcriptPath
  }

  const sessionId = hookSessionId
    ?? readCodexTerminalSessionId(input.sessionDir)
    ?? normalizeCodexSessionId(input.state?.codexSessionId)
    ?? normalizeCodexSessionId(input.state?.resume)
  if (!sessionId) return undefined
  return findCodexSessionJsonlById({ codexHome: input.codexHome, sessionId })
}

export function findCodexSessionJsonlById(input: {
  readonly codexHome?: string
  readonly sessionId: string
}) {
  const root = join(input.codexHome ?? join(homedir(), '.codex'), 'sessions')
  if (!existsSync(root)) return undefined
  const candidates: CodexSessionFileCandidate[] = []
  collectCodexSessionJsonlFiles(root, candidates, 0)
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const candidate of candidates) {
    const firstLine = readFirstLine(candidate.path)
    if (!firstLine) continue
    const metadata = parseJsonObject(firstLine)
    const payload = objectValue(metadata?.payload)
    if (payload && normalizeCodexSessionId(payload.id) === input.sessionId) return candidate.path
  }
  return undefined
}

export function readCodexPlanTasksFromJsonl(filePath: string): CodexPlanTaskProjection | null {
  if (!existsSync(filePath)) return null
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  let latest: CodexPlanTaskProjection | null = null
  for (const line of lines) {
    const event = parseJsonObject(line)
    if (!event) continue
    const timestamp = stringValue(event.timestamp)
    const payload = objectValue(event.payload)
    if (!payload) continue
    const tasks = codexPlanTasksFromPayload(payload, timestamp)
    if (tasks) latest = tasks
  }
  return latest
}

export function codexPlanTasksFromPayload(
  payload: Record<string, unknown>,
  updatedAt = new Date().toISOString(),
): CodexPlanTaskProjection | null {
  if (payload.type !== 'function_call' || payload.name !== 'update_plan') return null
  const args = parseJsonObject(stringValue(payload.arguments) ?? '')
  const plan = Array.isArray(args?.plan) ? args.plan : undefined
  if (!plan) return null

  const seenByTitle = new Map<string, number>()
  const tasks = plan.flatMap((item): AgentTask[] => {
    const record = objectValue(item)
    if (!record) return []
    const title = stringValue(record.step)?.replace(/\s+/g, ' ').trim()
    const status = normalizeTaskStatus(record.status)
    if (!title || !status) return []
    const seen = seenByTitle.get(title) ?? 0
    seenByTitle.set(title, seen + 1)
    return [{
      id: codexPlanTaskId(title, seen),
      title,
      status,
      source: 'codex',
      updatedAt,
    }]
  })
  return { tasks, updatedAt }
}

function collectCodexSessionJsonlFiles(
  dir: string,
  candidates: CodexSessionFileCandidate[],
  depth: number,
) {
  if (depth > 5) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectCodexSessionJsonlFiles(entryPath, candidates, depth + 1)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      candidates.push({ path: entryPath, mtimeMs: statSync(entryPath).mtimeMs })
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

function codexPlanTaskId(title: string, duplicateIndex: number) {
  const hash = createHash('sha256')
    .update(title)
    .digest('hex')
    .slice(0, 16)
  return duplicateIndex === 0 ? `codex-plan-${hash}` : `codex-plan-${hash}-${duplicateIndex}`
}

function parseJsonObject(input: string | undefined) {
  if (!input?.trim()) return undefined
  try {
    return objectValue(JSON.parse(input))
  } catch {
    return undefined
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}
