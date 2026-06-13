import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const codexSessionIdFile = 'codex-session-id'
const codexHookSessionFile = 'codex-hook-session.json'

export type CodexHookSessionBinding = {
  readonly agentId: string
  readonly sessionId: string
  readonly source?: string
  readonly cwd?: string
  readonly transcriptPath?: string
  readonly model?: string
  readonly hookEventName: 'SessionStart'
  readonly writtenAtMs: number
}

export function codexTerminalSessionIdPath(sessionDir: string) {
  return join(sessionDir, codexSessionIdFile)
}

export function codexHookSessionBindingPath(sessionDir: string) {
  return join(sessionDir, codexHookSessionFile)
}

export function readCodexTerminalSessionId(sessionDir: string) {
  try {
    return normalizeCodexSessionId(readFileSync(codexTerminalSessionIdPath(sessionDir), 'utf8'))
  } catch {
    return undefined
  }
}

export function writeCodexTerminalSessionId(sessionDir: string, sessionId: string) {
  const normalized = normalizeCodexSessionId(sessionId)
  if (!normalized) return
  mkdirSync(sessionDir, { recursive: true })
  writeFileAtomic(codexTerminalSessionIdPath(sessionDir), `${normalized}\n`)
}

export function readCodexHookSessionBinding(sessionDir: string): CodexHookSessionBinding | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(codexHookSessionBindingPath(sessionDir), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (record.version !== 1) return undefined
    const agentId = stringValue(record.agentId)
    const sessionId = normalizeCodexSessionId(record.sessionId)
    const writtenAtMs = typeof record.writtenAtMs === 'number' ? record.writtenAtMs : NaN
    if (record.hookEventName !== 'SessionStart') return undefined
    if (!agentId || !sessionId || !Number.isFinite(writtenAtMs)) return undefined
    return {
      agentId,
      sessionId,
      source: stringValue(record.source),
      cwd: stringValue(record.cwd),
      transcriptPath: stringValue(record.transcriptPath),
      model: stringValue(record.model),
      hookEventName: 'SessionStart',
      writtenAtMs,
    }
  } catch {
    return undefined
  }
}

export function writeCodexHookSessionBinding(sessionDir: string, binding: CodexHookSessionBinding) {
  mkdirSync(sessionDir, { recursive: true })
  writeFileAtomic(codexHookSessionBindingPath(sessionDir), `${JSON.stringify({
    version: 1,
    agentId: binding.agentId,
    sessionId: binding.sessionId,
    source: binding.source,
    cwd: binding.cwd,
    transcriptPath: binding.transcriptPath,
    model: binding.model,
    hookEventName: binding.hookEventName,
    writtenAtMs: binding.writtenAtMs,
  }, null, 2)}\n`)
}

export function normalizeCodexSessionId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function writeFileAtomic(path: string, contents: string) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, contents, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}
