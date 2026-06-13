import { isAbsolute } from 'node:path'
import {
  normalizeCodexSessionId,
  writeCodexHookSessionBinding,
  writeCodexTerminalSessionId,
} from './codex-terminal-session'

export type CodexSessionStartHookResult = {
  readonly ok: boolean
  readonly reason?: string
}

export async function handleCodexSessionStartHook(input: {
  readonly stdin: string
  readonly env: NodeJS.ProcessEnv
}): Promise<CodexSessionStartHookResult> {
  try {
    const sessionDir = stringValue(input.env.KIRI_SESSION_DIR)
    const agentId = stringValue(input.env.KIRI_AGENT_ID)
    if (!sessionDir || !agentId) return { ok: true }
    if (!isAbsolute(sessionDir)) return { ok: false, reason: 'KIRI_SESSION_DIR must be absolute' }

    const payload = parseHookPayload(input.stdin)
    if (!payload.ok) return payload

    writeCodexTerminalSessionId(sessionDir, payload.sessionId)
    writeCodexHookSessionBinding(sessionDir, {
      agentId,
      sessionId: payload.sessionId,
      source: payload.source,
      cwd: payload.cwd,
      transcriptPath: payload.transcriptPath,
      model: payload.model,
      hookEventName: 'SessionStart',
      writtenAtMs: Date.now(),
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Codex SessionStart hook failed',
    }
  }
}

function parseHookPayload(input: string):
  | {
    readonly ok: true
    readonly sessionId: string
    readonly source?: string
    readonly cwd?: string
    readonly transcriptPath?: string
    readonly model?: string
  }
  | { readonly ok: false; readonly reason: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Invalid hook JSON',
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'Hook payload must be an object' }
  }
  const record = parsed as Record<string, unknown>
  if (record.hook_event_name !== 'SessionStart') {
    return { ok: false, reason: 'Unsupported hook event' }
  }
  const sessionId = normalizeCodexSessionId(record.session_id)
  if (!sessionId) return { ok: false, reason: 'Missing session_id' }
  return {
    ok: true,
    sessionId,
    source: stringValue(record.source),
    cwd: stringValue(record.cwd),
    transcriptPath: stringValue(record.transcript_path),
    model: stringValue(record.model),
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}
