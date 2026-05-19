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
  readonly env?: Pick<NodeJS.ProcessEnv, 'KIRI_CLAUDE_HOME'>
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
  const offset = state.claudeLastSeenOffset !== undefined && state.claudeLastSeenOffset <= size
    ? state.claudeLastSeenOffset
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

export function claudeCursorState(input: Record<string, unknown>) {
  const state = claudeRuntimeStateSchema.parse(input)
  return {
    ...(state.claudeLastSeenUuid ? { claudeLastSeenUuid: state.claudeLastSeenUuid } : {}),
    ...(state.claudeLastSeenOffset !== undefined
      ? { claudeLastSeenOffset: state.claudeLastSeenOffset }
      : {}),
  }
}
