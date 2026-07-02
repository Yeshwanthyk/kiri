import type { DatabaseSync } from 'node:sqlite'
import {
  findCodexTerminalSessionJsonl,
  readCodexPlanTasksFromJsonl,
} from '../codex-jsonl-tasks'
import { replaceAgentTasksRows } from './timeline-writes'

type CodexTerminalTaskHydrationInput = {
  readonly agentId?: string
  readonly projectId?: string
  readonly codexHome?: string
}

type CodexTerminalAgentRow = {
  readonly id: string
  readonly cwd: string
  readonly sessionDir: string
  readonly runtimeStateJson: string | null
}

export function hydrateCodexTerminalTasksRows(
  database: DatabaseSync,
  input: CodexTerminalTaskHydrationInput = {},
) {
  for (const row of codexTerminalAgentRows(database, input)) {
    const state = parseRuntimeState(row.runtimeStateJson)
    const sessionFile = findCodexTerminalSessionJsonl({
      agentId: row.id,
      cwd: row.cwd,
      sessionDir: row.sessionDir,
      state,
      codexHome: input.codexHome,
    })
    if (!sessionFile) continue
    const projection = readCodexPlanTasksFromJsonl(sessionFile)
    if (!projection) continue
    replaceAgentTasksRows(database, {
      agentId: row.id,
      source: 'codex',
      tasks: projection.tasks,
      updatedAt: projection.updatedAt,
    })
  }
}

function codexTerminalAgentRows(
  database: DatabaseSync,
  input: CodexTerminalTaskHydrationInput,
) {
  const agentId = input.agentId?.trim() || null
  const projectId = input.projectId?.trim() || null
  return database
    .prepare(
      `
        SELECT
          a.id,
          p.cwd,
          a.session_dir AS sessionDir,
          a.runtime_state_json AS runtimeStateJson
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        WHERE a.runtime = 'codex'
          AND a.interface_mode = 'terminal'
          AND a.archived_at IS NULL
          AND (? IS NULL OR a.id = ?)
          AND (? IS NULL OR a.project_id = ?)
      `,
    )
    .all(agentId, agentId, projectId, projectId) as CodexTerminalAgentRow[]
}

function parseRuntimeState(value: string | null) {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}
