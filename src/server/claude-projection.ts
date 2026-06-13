import type { DatabaseSync } from 'node:sqlite'
import { projectClaudeSessionJsonl } from './claude-jsonl'
import { claudeCursorState, readClaudeSessionFile } from './claude-jsonl-file'
import { getAgentRuntimeState, setAgentRuntimeState } from './db/runtime-state'
import { recordRuntimeMessagesInTransaction } from './db/timeline-writes'
import { withTransaction } from './db/transaction'
import { agentDetailDbRowSchema } from './db/schema'

export function hydrateClaudeSession(database: DatabaseSync, agentId: string) {
  const agent = readClaudeAgent(database, agentId)
  if (!agent || agent.runtime !== 'claude') return false

  const state = getAgentRuntimeState(database, agent.id)
  const sessionFile = readClaudeSessionFile({
    agentId: agent.id,
    cwd: agent.cwd,
    runtimeState: state,
    env: process.env,
  })
  if (!sessionFile) return false

  const projection = projectClaudeSessionJsonl({
    content: sessionFile.content,
    sessionId: sessionFile.sessionId,
    ...claudeCursorState(state, sessionFile.offset),
    ...(sessionFile.offset === undefined ? {} : { offset: sessionFile.offset }),
  })
  if (projection.messages.length === 0 && Object.keys(projection.nextState).length === 0) return true

  withTransaction(database, () => {
    recordRuntimeMessagesInTransaction(database, {
      agentId: agent.id,
      messages: projection.messages,
      sessionFile: sessionFile.path,
    })
    setAgentRuntimeState(database, agent.id, {
      ...state,
      ...projection.nextState,
    })
  })
  return true
}

function readClaudeAgent(database: DatabaseSync, agentId: string) {
  const row = database
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          p.cwd,
          a.slot,
          a.title,
          a.runtime,
          a.interface_mode AS interfaceMode,
          a.model,
          a.status,
          a.session_dir AS sessionDir,
          a.session_file AS sessionFile,
          a.position,
          a.archived_at AS archivedAt,
          t.id AS threadId,
          t.preview,
          t.message_count AS messageCount,
          t.updated_at AS updatedAt
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        LEFT JOIN threads t ON t.agent_id = a.id AND t.active = 1
        WHERE a.id = ?
      `,
    )
    .get(agentId)
  if (!row) return null
  return agentDetailDbRowSchema.parse(row)
}
