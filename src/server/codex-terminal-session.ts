import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const codexSessionIdFile = 'codex-session-id'

export function codexTerminalSessionIdPath(sessionDir: string) {
  return join(sessionDir, codexSessionIdFile)
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
  writeFileSync(codexTerminalSessionIdPath(sessionDir), `${normalized}\n`, { mode: 0o600 })
}

export function normalizeCodexSessionId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
