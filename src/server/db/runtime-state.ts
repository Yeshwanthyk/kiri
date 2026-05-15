import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentStatus,
  ContextUsage,
  KiriSettings,
  RuntimeKind,
} from '~/lib/contracts'
import {
  agentStatusSchema,
  pendingQuestionSchema,
  thinkingLevelSchema,
} from '~/lib/contracts'
import { agentLaunchConfigSchema } from './schema'

type ContextUsageInput = {
  readonly agentId: string
  readonly usedTokens: number | undefined
  readonly windowTokens?: number | undefined
  readonly sessionFile?: string
  readonly updatedAt?: string
}

type PersistedContextUsage = {
  readonly usedTokens: number
  readonly windowTokens: number | null
}

type RuntimeModel = {
  readonly runtime: RuntimeKind
  readonly model: string
}

export function getAgentLaunchConfig(database: DatabaseSync, agentId: string) {
  const row = database
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          a.runtime,
          a.session_dir AS sessionDir,
          a.session_file AS sessionFile,
          a.model,
          a.runtime_state_json AS runtimeStateJson,
          p.cwd
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        WHERE a.id = ?
          AND a.archived_at IS NULL
      `,
    )
    .get(agentId)
  if (!row) throw new Error(`Agent not found: ${agentId}`)
  return agentLaunchConfigSchema.parse(row)
}

export function getAgentRuntimeState(database: DatabaseSync, agentId: string) {
  const row = database
    .prepare('SELECT runtime_state_json AS runtimeStateJson FROM agent_slots WHERE id = ?')
    .get(agentId) as { runtimeStateJson: string | null } | undefined
  if (!row?.runtimeStateJson) return {}
  try {
    const parsed: unknown = JSON.parse(row.runtimeStateJson)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function setAgentRuntimeState(
  database: DatabaseSync,
  agentId: string,
  state: Record<string, unknown>,
) {
  database
    .prepare('UPDATE agent_slots SET runtime_state_json = ? WHERE id = ?')
    .run(JSON.stringify(state), agentId)
}

export function clearAgentRuntimeState(database: DatabaseSync, agentId: string) {
  database
    .prepare('UPDATE agent_slots SET runtime_state_json = NULL WHERE id = ?')
    .run(agentId)
}

export function setAgentStatus(
  database: DatabaseSync,
  agentId: string,
  status: AgentStatus,
) {
  const parsed = agentStatusSchema.parse(status)
  database.prepare('UPDATE agent_slots SET status = ? WHERE id = ?').run(parsed, agentId)
}

export function upsertAgentContextUsage(
  database: DatabaseSync,
  input: ContextUsageInput,
) {
  if (input.usedTokens === undefined) return
  database
    .prepare(
      `
        INSERT INTO agent_context_usage (
          agent_id, used_tokens, window_tokens, updated_at, session_file
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          used_tokens = excluded.used_tokens,
          window_tokens = COALESCE(excluded.window_tokens, agent_context_usage.window_tokens),
          updated_at = excluded.updated_at,
          session_file = excluded.session_file
      `,
    )
    .run(
      input.agentId,
      input.usedTokens,
      input.windowTokens ?? null,
      input.updatedAt ?? new Date().toISOString(),
      input.sessionFile ?? null,
    )
}

export function clearAgentContextUsage(database: DatabaseSync, agentId: string) {
  database.prepare('DELETE FROM agent_context_usage WHERE agent_id = ?').run(agentId)
}

export function readContextUsage(
  agent: RuntimeModel,
  settings: KiriSettings,
  persistedUsage: PersistedContextUsage | undefined,
): ContextUsage | null {
  if (!persistedUsage) return null

  const windowTokens =
    persistedUsage.windowTokens ?? settings.runtimes[agent.runtime].contextWindows?.[agent.model]
  if (!windowTokens) return null

  const usedTokens = persistedUsage.usedTokens
  return {
    usedTokens,
    remainingTokens: Math.max(windowTokens - usedTokens, 0),
    windowTokens,
    usedPercent: Math.min((usedTokens / windowTokens) * 100, 100),
  }
}

export function getAgentThinkingLevel(database: DatabaseSync, agentId: string) {
  const row = database
    .prepare(
      `
        SELECT e.detail
        FROM timeline_events e
        INNER JOIN threads t ON t.id = e.thread_id
        WHERE t.agent_id = ? AND t.active = 1 AND e.kind = 'thinking_level'
        ORDER BY e.timestamp DESC, e.id DESC
        LIMIT 1
      `,
    )
    .get(agentId) as { detail: string | null } | undefined
  const parsed = thinkingLevelSchema.safeParse(row?.detail)
  return parsed.success ? parsed.data : null
}

export function readPendingQuestion(database: DatabaseSync, agentId: string) {
  const parsed = pendingQuestionSchema.safeParse(
    getAgentRuntimeState(database, agentId).pendingQuestion,
  )
  return parsed.success ? parsed.data : null
}
