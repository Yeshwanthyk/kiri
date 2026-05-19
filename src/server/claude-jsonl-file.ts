import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { claudeProjectKey, claudeTerminalSessionId } from './terminal-launch'

const claudeRuntimeStateSchema = z.object({
  homePath: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  resume: z.string().trim().min(1).optional(),
  claudeLastSeenUuid: z.string().trim().min(1).optional(),
  claudeLastSeenOffset: z.number().int().nonnegative().optional(),
})

export type ClaudeSessionFile = {
  readonly sessionId: string
  readonly path: string
  readonly content: string
  readonly offset: number | undefined
}

export type ClaudeSessionFileInput = {
  readonly agentId: string
  readonly cwd: string
  readonly runtimeState?: Record<string, unknown>
  readonly env?: Partial<Pick<NodeJS.ProcessEnv, 'KIRI_CLAUDE_HOME'>>
}

export function readClaudeSessionFile(input: ClaudeSessionFileInput): ClaudeSessionFile | null {
  const state = claudeRuntimeStateSchema.parse(input.runtimeState ?? {})
  const homePath = stringValue(input.env?.KIRI_CLAUDE_HOME) ?? state.homePath ?? homedir()
  const sessionId = state.resume ?? claudeTerminalSessionId(input.agentId, state)
  if (!isSafeClaudeSessionFilename(sessionId)) return null
  const path = join(homePath, '.claude', 'projects', claudeProjectKey(input.cwd), `${sessionId}.jsonl`)
  if (!existsSync(path) || !statSync(path).isFile()) return null

  const buffer = readFileSync(path)
  const size = buffer.byteLength
  const candidateOffset = state.claudeLastSeenOffset !== undefined && state.claudeLastSeenOffset <= size
    ? state.claudeLastSeenOffset
    : undefined
  const offset = candidateOffset !== undefined && isValidOffset(buffer, candidateOffset, state.claudeLastSeenUuid)
    ? candidateOffset
    : undefined
  const content = offset === undefined ? buffer.toString('utf8') : buffer.subarray(offset).toString('utf8')
  return {
    sessionId,
    path,
    content,
    offset,
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isSafeClaudeSessionFilename(value: string) {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..'
}

function isValidOffset(buffer: Buffer, offset: number, afterUuid: string | undefined) {
  if (offset === 0) return true
  if (offset > buffer.byteLength || buffer[offset - 1] !== 0x0a) return false
  if (afterUuid === undefined) return true
  const lines = buffer.subarray(0, offset).toString('utf8').split('\n').filter((line) => line.trim())
  const previousLine = lines.at(-1)
  if (!previousLine) return false
  try {
    const parsed: unknown = JSON.parse(previousLine)
    return !!parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).uuid === afterUuid
  } catch {
    return false
  }
}

export function claudeCursorState(input: Record<string, unknown>, consumedOffset?: number) {
  const state = claudeRuntimeStateSchema.parse(input)
  return {
    ...(state.claudeLastSeenUuid ? { afterUuid: state.claudeLastSeenUuid } : {}),
    ...(consumedOffset !== undefined && state.claudeLastSeenOffset !== undefined
      ? { offset: state.claudeLastSeenOffset }
      : {}),
  }
}
