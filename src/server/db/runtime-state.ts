import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentStatus,
  ContextUsage,
  KiriSettings,
  PendingQuestion,
  RuntimeKind,
} from '~/lib/contracts'
import {
  agentStatusSchema,
  pendingQuestionSchema,
  thinkingLevelSchema,
} from '~/lib/contracts'
import { appendAgentEvent } from './agent-events'
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

export type PendingTerminalInput = {
  readonly text: string
  readonly submit: boolean
  readonly createdAt: string
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
  return parseAgentRuntimeStateJson(row?.runtimeStateJson, agentId)
}

export function isAgentArchived(database: DatabaseSync, agentId: string) {
  const row = database
    .prepare('SELECT archived_at AS archivedAt FROM agent_slots WHERE id = ?')
    .get(agentId) as { archivedAt: string | null } | undefined
  return row?.archivedAt !== undefined && row.archivedAt !== null
}

export function parseAgentRuntimeStateJson(
  json: string | null | undefined,
  agentId: string,
): Record<string, unknown> {
  if (!json) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    throw new Error(`Invalid runtime state JSON for agent ${agentId}`)
  }
  throw new Error(`Invalid runtime state JSON for agent ${agentId}`)
}

export function setAgentRuntimeState(
  database: DatabaseSync,
  agentId: string,
  state: Record<string, unknown>,
) {
  database
    .prepare(
      `
        UPDATE agent_slots
        SET runtime_state_json = ?, runtime_state_updated_at = ?
        WHERE id = ?
          AND archived_at IS NULL
      `,
    )
    .run(JSON.stringify(state), new Date().toISOString(), agentId)
}

export function queueAgentTerminalInput(
  database: DatabaseSync,
  agentId: string,
  input: {
    readonly text: string
    readonly submit: boolean
    readonly createdAt?: string
  },
) {
  const state = getAgentRuntimeState(database, agentId)
  const pending = pendingTerminalInputs(state.pendingTerminalInputs)
  replaceAgentTerminalInputs(database, agentId, state, [
    ...pending,
    {
      text: input.text,
      submit: input.submit,
      createdAt: input.createdAt ?? new Date().toISOString(),
    },
  ])
}

export function requeueAgentTerminalInputs(
  database: DatabaseSync,
  agentId: string,
  inputs: readonly PendingTerminalInput[],
) {
  if (inputs.length === 0) return
  const state = getAgentRuntimeState(database, agentId)
  const pending = pendingTerminalInputs(state.pendingTerminalInputs)
  replaceAgentTerminalInputs(database, agentId, state, [...inputs, ...pending])
}

function replaceAgentTerminalInputs(
  database: DatabaseSync,
  agentId: string,
  state: Record<string, unknown>,
  inputs: readonly PendingTerminalInput[],
) {
  setAgentRuntimeState(database, agentId, {
    ...state,
    pendingTerminalInputs: inputs,
  })
}

export function takeAgentTerminalInputs(database: DatabaseSync, agentId: string): PendingTerminalInput[] {
  const state = getAgentRuntimeState(database, agentId)
  const pending = pendingTerminalInputs(state.pendingTerminalInputs)
  if (pending.length === 0) return []
  const nextState = { ...state }
  delete nextState.pendingTerminalInputs
  setAgentRuntimeState(database, agentId, nextState)
  return pending
}

export function setAgentPendingQuestion(
  database: DatabaseSync,
  agentId: string,
  pendingQuestion: PendingQuestion | null,
) {
  const state = getAgentRuntimeState(database, agentId)
  const nextState = { ...state }
  if (pendingQuestion) {
    nextState.pendingQuestion = pendingQuestion
  } else {
    delete nextState.pendingQuestion
  }
  setAgentRuntimeState(database, agentId, nextState)
}

export function clearAgentRuntimeState(database: DatabaseSync, agentId: string) {
  database
    .prepare(
      `
        UPDATE agent_slots
        SET runtime_state_json = NULL, runtime_state_updated_at = ?
        WHERE id = ?
          AND archived_at IS NULL
      `,
    )
    .run(new Date().toISOString(), agentId)
}

export function setAgentStatus(
  database: DatabaseSync,
  agentId: string,
  status: AgentStatus,
) {
  const parsed = agentStatusSchema.parse(status)
  const row = database
    .prepare('SELECT status, archived_at AS archivedAt FROM agent_slots WHERE id = ?')
    .get(agentId) as { status: AgentStatus; archivedAt: string | null } | undefined
  if (!row || row.archivedAt !== null) return
  const previousStatus = row?.status
  const result = database
    .prepare('UPDATE agent_slots SET status = ? WHERE id = ? AND archived_at IS NULL')
    .run(parsed, agentId)
  if (previousStatus && previousStatus !== parsed) {
    if (result.changes === 0) return
    appendAgentEvent(database, {
      agentId,
      type: 'agent.status.changed',
      payload: { status: parsed, previousStatus },
    })
  }
}

export function upsertAgentContextUsage(
  database: DatabaseSync,
  input: ContextUsageInput,
) {
  if (input.usedTokens === undefined) return
  if (isAgentArchived(database, input.agentId)) return
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

function pendingTerminalInputs(value: unknown): PendingTerminalInput[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const object = recordValue(item)
    if (!object) return []
    const text = stringField(object, 'text')
    if (text === null) return []
    return [{
      text,
      submit: typeof object.submit === 'boolean' ? object.submit : true,
      createdAt: typeof object.createdAt === 'string'
        ? object.createdAt
        : new Date(0).toISOString(),
    }]
  })
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(value: Record<string, unknown>, field: string) {
  const candidate = value[field]
  return typeof candidate === 'string' ? candidate : null
}
