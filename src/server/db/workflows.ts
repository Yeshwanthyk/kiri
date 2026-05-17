import type { DatabaseSync } from 'node:sqlite'
import type {
  RuntimeKind,
  SessionInterfaceMode,
  ThinkingLevel,
  WorkflowAttemptStatus,
  WorkflowItemAction,
  WorkflowItemStatus,
  WorkflowRunStatus,
  WorkflowTerminalPaste,
} from '~/lib/contracts'
import {
  workflowAttemptDbRowSchema,
  workflowItemDbRowSchema,
  workflowRunSummaryDbRowSchema,
} from './schema'
import { withTransaction } from './transaction'

export type PersistWorkflowRunInput = {
  readonly id?: string
  readonly projectId: string
  readonly title: string
  readonly items: readonly PersistWorkflowItemInput[]
}

export type PersistWorkflowItemInput = {
  readonly id?: string
  readonly clientId?: string | null
  readonly action: WorkflowItemAction
  readonly title: string
  readonly body: string
  readonly runtime?: RuntimeKind | null
  readonly interfaceMode?: SessionInterfaceMode | null
  readonly model?: string | null
  readonly thinkingLevel?: ThinkingLevel | null
  readonly terminalPaste?: WorkflowTerminalPaste | null
  readonly scratchpadBlockId?: string | null
  readonly tracked: boolean
}

export type WorkflowRunSummary = ReturnType<typeof workflowRunSummaryFromRow>
export type WorkflowRunDetail = WorkflowRunSummary & {
  readonly items: readonly WorkflowItemDetail[]
}
export type WorkflowItemDetail = ReturnType<typeof workflowItemFromRow> & {
  readonly attempts: readonly WorkflowAttemptDetail[]
}
export type WorkflowAttemptDetail = ReturnType<typeof workflowAttemptFromRow>

export function listWorkflowRuns(
  database: DatabaseSync,
  input: {
    readonly projectId?: string
    readonly includeArchived?: boolean
  } = {},
) {
  const rows = database
    .prepare(
      `
        SELECT
          r.id,
          r.project_id AS projectId,
          p.name AS projectName,
          r.title,
          r.status,
          COUNT(i.id) AS itemCount,
          COALESCE(SUM(CASE WHEN i.active_agent_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS launchedCount,
          COALESCE(SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END), 0) AS failedCount,
          r.created_at AS createdAt,
          r.updated_at AS updatedAt,
          r.archived_at AS archivedAt
        FROM workflow_runs r
        INNER JOIN projects p ON p.id = r.project_id
        LEFT JOIN workflow_items i ON i.run_id = r.id
        WHERE (? IS NULL OR r.project_id = ?)
          AND (? = 1 OR r.archived_at IS NULL)
        GROUP BY r.id
        ORDER BY r.updated_at DESC, r.id ASC
      `,
    )
    .all(
      input.projectId ?? null,
      input.projectId ?? null,
      input.includeArchived ? 1 : 0,
    )
  return rows.map(workflowRunSummaryFromRow)
}

export function getWorkflowRun(database: DatabaseSync, id: string): WorkflowRunDetail {
  const run = workflowRunSummaryFromRow(requireWorkflowRunSummaryRow(database, id, true))
  const items = database
    .prepare(
      `
        SELECT
          id,
          run_id AS runId,
          position,
          client_id AS clientId,
          action,
          title,
          body,
          runtime,
          interface_mode AS interfaceMode,
          model,
          thinking_level AS thinkingLevel,
          terminal_paste_json AS terminalPasteJson,
          scratchpad_block_id AS scratchpadBlockId,
          active_agent_id AS activeAgentId,
          tracked,
          status,
          error,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM workflow_items
        WHERE run_id = ?
        ORDER BY position ASC, id ASC
      `,
    )
    .all(run.id)
    .map((row) => workflowItemWithAttempts(database, row))
  return { ...run, items }
}

export function getWorkflowItem(database: DatabaseSync, itemId: string): WorkflowItemDetail {
  const row = database
    .prepare(
      `
        SELECT
          id,
          run_id AS runId,
          position,
          client_id AS clientId,
          action,
          title,
          body,
          runtime,
          interface_mode AS interfaceMode,
          model,
          thinking_level AS thinkingLevel,
          terminal_paste_json AS terminalPasteJson,
          scratchpad_block_id AS scratchpadBlockId,
          active_agent_id AS activeAgentId,
          tracked,
          status,
          error,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM workflow_items
        WHERE id = ?
      `,
    )
    .get(itemId.trim())
  if (!row) throw new Error(`Workflow item not found: ${itemId}`)
  return workflowItemWithAttempts(database, row)
}

export function insertWorkflowRun(database: DatabaseSync, input: PersistWorkflowRunInput) {
  const projectId = input.projectId.trim()
  assertWorkflowProjectExists(database, projectId)
  if (input.items.length === 0) throw new Error('Workflow must include at least one item')

  const now = new Date().toISOString()
  const runId = input.id ?? workflowId('workflow')
  withTransaction(database, () => {
    database
      .prepare(
        `
          INSERT INTO workflow_runs (id, project_id, title, status, created_at, updated_at)
          VALUES (?, ?, ?, 'validated', ?, ?)
        `,
      )
      .run(runId, projectId, input.title.trim(), now, now)

    const insert = database.prepare(
      `
        INSERT INTO workflow_items (
          id, run_id, position, client_id, action, title, body, runtime, interface_mode,
          model, thinking_level, terminal_paste_json, scratchpad_block_id, tracked, status,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    for (const [index, item] of input.items.entries()) {
      insert.run(
        item.id ?? workflowId('workflow-item'),
        runId,
        index,
        item.clientId ?? null,
        item.action,
        item.title.trim(),
        item.body.trim(),
        item.runtime ?? null,
        item.interfaceMode ?? null,
        item.model?.trim() || null,
        item.thinkingLevel ?? null,
        item.terminalPaste ? globalThis.JSON.stringify(item.terminalPaste) : null,
        item.scratchpadBlockId ?? null,
        item.tracked ? 1 : 0,
        item.tracked ? 'pending' : 'untracked',
        now,
        now,
      )
    }
  })
  return getWorkflowRun(database, runId)
}

export function setWorkflowItemTracking(database: DatabaseSync, itemId: string, tracked: boolean) {
  const id = itemId.trim()
  const item = getWorkflowItem(database, id)
  assertWorkflowRunMutable(database, item.runId)
  const now = new Date().toISOString()
  const status: WorkflowItemStatus = tracked
    ? (item.status === 'untracked' ? statusForTrackedItem(item) : item.status)
    : 'untracked'
  const result = database
    .prepare('UPDATE workflow_items SET tracked = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(tracked ? 1 : 0, status, now, id)
  if (result.changes === 0) throw new Error(`Workflow item not found: ${id}`)
  touchRunForItem(database, id, now)
  return getWorkflowItem(database, id)
}

export function setWorkflowRunArchiveState(database: DatabaseSync, runId: string, archived: boolean) {
  const id = runId.trim()
  const now = new Date().toISOString()
  const status: WorkflowRunStatus = archived ? 'archived' : runStatusFromItems(database, id)
  const result = database
    .prepare('UPDATE workflow_runs SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?')
    .run(status, archived ? now : null, now, id)
  if (result.changes === 0) throw new Error(`Workflow run not found: ${id}`)
  return getWorkflowRun(database, id)
}

export function recordWorkflowItemAttempt(
  database: DatabaseSync,
  input: {
    readonly itemId: string
    readonly agentId?: string | null
    readonly status: WorkflowAttemptStatus
    readonly error?: string | null
  },
) {
  const itemId = input.itemId.trim()
  const item = getWorkflowItem(database, itemId)
  assertWorkflowRunMutable(database, item.runId)
  const now = new Date().toISOString()
  const attemptId = workflowId('workflow-attempt')
  withTransaction(database, () => {
    database
      .prepare(
        `
          INSERT INTO workflow_item_attempts (
            id, item_id, agent_id, status, error, created_at, completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        attemptId,
        itemId,
        input.agentId ?? null,
        input.status,
        input.error ?? null,
        now,
        now,
      )
    database
      .prepare(
        `
          UPDATE workflow_items
          SET active_agent_id = COALESCE(?, active_agent_id),
              status = ?,
              error = ?,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        input.agentId ?? null,
        input.status === 'failed' ? 'failed' : 'running',
        input.error ?? null,
        now,
        itemId,
      )
    updateWorkflowRunStatus(database, item.runId, now)
  })
  return getWorkflowItem(database, itemId).attempts.find((attempt) => attempt.id === attemptId)
}

export function completeScratchpadWorkflowItem(database: DatabaseSync, itemId: string) {
  const id = itemId.trim()
  const item = getWorkflowItem(database, id)
  assertWorkflowRunMutable(database, item.runId)
  const now = new Date().toISOString()
  const result = database
    .prepare("UPDATE workflow_items SET status = 'completed', updated_at = ? WHERE id = ?")
    .run(now, id)
  if (result.changes === 0) throw new Error(`Workflow item not found: ${id}`)
  touchRunForItem(database, id, now)
  return getWorkflowItem(database, id)
}

function workflowItemWithAttempts(database: DatabaseSync, row: unknown) {
  const item = workflowItemFromRow(row)
  const attempts = database
    .prepare(
      `
        SELECT
          id,
          item_id AS itemId,
          agent_id AS agentId,
          status,
          error,
          created_at AS createdAt,
          completed_at AS completedAt
        FROM workflow_item_attempts
        WHERE item_id = ?
        ORDER BY created_at ASC, id ASC
      `,
    )
    .all(item.id)
    .map(workflowAttemptFromRow)
  return { ...item, attempts }
}

function requireWorkflowRunSummaryRow(database: DatabaseSync, id: string, includeArchived = false) {
  const row = database
    .prepare(
      `
        SELECT
          r.id,
          r.project_id AS projectId,
          p.name AS projectName,
          r.title,
          r.status,
          COUNT(i.id) AS itemCount,
          COALESCE(SUM(CASE WHEN i.active_agent_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS launchedCount,
          COALESCE(SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END), 0) AS failedCount,
          r.created_at AS createdAt,
          r.updated_at AS updatedAt,
          r.archived_at AS archivedAt
        FROM workflow_runs r
        INNER JOIN projects p ON p.id = r.project_id
        LEFT JOIN workflow_items i ON i.run_id = r.id
        WHERE r.id = ?
          AND (? = 1 OR r.archived_at IS NULL)
        GROUP BY r.id
      `,
    )
    .get(id.trim(), includeArchived ? 1 : 0)
  if (!row) throw new Error(`Workflow run not found: ${id}`)
  return row
}

function workflowRunSummaryFromRow(row: unknown) {
  return workflowRunSummaryDbRowSchema.parse(row)
}

function workflowItemFromRow(row: unknown) {
  const parsed = workflowItemDbRowSchema.parse(row)
  return {
    id: parsed.id,
    runId: parsed.runId,
    position: parsed.position,
    clientId: parsed.clientId,
    action: parsed.action,
    title: parsed.title,
    body: parsed.body,
    runtime: parsed.runtime,
    interfaceMode: parsed.interfaceMode,
    model: parsed.model,
    thinkingLevel: parsed.thinkingLevel,
    terminalPaste: parseTerminalPaste(parsed.terminalPasteJson),
    scratchpadBlockId: parsed.scratchpadBlockId,
    activeAgentId: parsed.activeAgentId,
    tracked: parsed.tracked === 1,
    status: parsed.status,
    error: parsed.error,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  }
}

function workflowAttemptFromRow(row: unknown) {
  return workflowAttemptDbRowSchema.parse(row)
}

function parseTerminalPaste(value: string | null): WorkflowTerminalPaste | null {
  if (!value) return null
  const parsed: unknown = globalThis.JSON.parse(value)
  if (!parsed || typeof parsed !== 'object') return null
  return {
    submit: 'submit' in parsed && typeof parsed.submit === 'boolean' ? parsed.submit : true,
  }
}

function assertWorkflowProjectExists(database: DatabaseSync, projectId: string) {
  const project = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)
}

function assertWorkflowRunMutable(database: DatabaseSync, runId: string) {
  const row = database
    .prepare('SELECT archived_at AS archivedAt FROM workflow_runs WHERE id = ?')
    .get(runId) as { archivedAt: string | null } | undefined
  if (!row) throw new Error(`Workflow run not found: ${runId}`)
  if (row.archivedAt) throw new Error(`Workflow run is archived: ${runId}`)
}

function statusForTrackedItem(item: {
  readonly activeAgentId: string | null
  readonly error: string | null
}): WorkflowItemStatus {
  if (item.error) return 'failed'
  if (item.activeAgentId) return 'running'
  return 'pending'
}

function touchRunForItem(database: DatabaseSync, itemId: string, now: string) {
  const row = database
    .prepare('SELECT run_id AS runId FROM workflow_items WHERE id = ?')
    .get(itemId) as { runId: string } | undefined
  if (!row) throw new Error(`Workflow item not found: ${itemId}`)
  updateWorkflowRunStatus(database, row.runId, now)
}

function updateWorkflowRunStatus(database: DatabaseSync, runId: string, now: string) {
  const status = runStatusFromItems(database, runId)
  database
    .prepare('UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now, runId)
}

function runStatusFromItems(database: DatabaseSync, runId: string): WorkflowRunStatus {
  const row = database
    .prepare(
      `
        SELECT
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
        FROM workflow_items
        WHERE run_id = ?
      `,
    )
    .get(runId) as { failed: number | null; running: number | null; pending: number | null } | undefined
  if ((row?.failed ?? 0) > 0) return 'failed'
  if ((row?.running ?? 0) > 0 || (row?.pending ?? 0) > 0) return 'running'
  return 'completed'
}

function workflowId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
