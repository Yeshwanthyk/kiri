import type { DatabaseSync } from 'node:sqlite'

import type { AddScratchpadBlockInput } from '~/lib/contracts'

import { scratchpadBlockDbRowSchema } from './schema'
import { withTransaction } from './transaction'

export function listScratchpadBlocks(
  database: DatabaseSync,
  input: { readonly projectId?: string } = {},
) {
  const projectId = input.projectId?.trim() || null
  return database
    .prepare(
      `
        SELECT
          s.id,
          s.project_id AS projectId,
          p.name AS projectName,
          s.body,
          s.created_at AS createdAt,
          s.triggered_at AS triggeredAt,
          s.triggered_agent_id AS triggeredAgentId
        FROM scratchpad_blocks s
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE (? IS NULL OR s.project_id = ?)
        ORDER BY s.created_at DESC
      `,
    )
    .all(projectId, projectId)
    .map((row) => scratchpadBlockDbRowSchema.parse(row))
}

export function insertScratchpadBlock(
  database: DatabaseSync,
  input: AddScratchpadBlockInput,
) {
  const body = input.body.trim()
  if (!body) throw new Error('Block body is required')
  const projectId = input.projectId?.trim() || null
  if (projectId) {
    const project = database
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
  }
  const id = `block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const createdAt = new Date().toISOString()
  database
    .prepare(
      `
        INSERT INTO scratchpad_blocks (id, project_id, body, created_at)
        VALUES (?, ?, ?, ?)
      `,
    )
    .run(id, projectId, body, createdAt)
  return id
}

export function deleteScratchpadBlockRow(database: DatabaseSync, id: string) {
  const blockId = id.trim()
  if (!blockId) throw new Error('Block id is required')
  database.prepare('DELETE FROM scratchpad_blocks WHERE id = ?').run(blockId)
}

export function markScratchpadBlockTriggered(
  database: DatabaseSync,
  blockId: string,
  agentId: string,
) {
  const id = blockId.trim()
  if (!id) throw new Error('Block id is required')
  const triggeredAt = new Date().toISOString()
  withTransaction(database, () => {
    database
      .prepare(
        `
          UPDATE scratchpad_blocks
          SET triggered_at = ?, triggered_agent_id = ?
          WHERE id = ?
        `,
      )
      .run(triggeredAt, agentId, id)
    database
      .prepare(
        `
          INSERT INTO scratchpad_block_triggers (id, block_id, agent_id, triggered_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(scratchpadTriggerId(id, agentId, triggeredAt), id, agentId, triggeredAt)
  })
}

export function listScratchpadBlockTriggers(database: DatabaseSync, blockId: string) {
  const id = blockId.trim()
  if (!id) throw new Error('Block id is required')
  return database
    .prepare(
      `
        SELECT block_id AS blockId, agent_id AS agentId, triggered_at AS triggeredAt
        FROM scratchpad_block_triggers
        WHERE block_id = ?
        ORDER BY triggered_at ASC, id ASC
      `,
    )
    .all(id) as Array<{ blockId: string; agentId: string; triggeredAt: string }>
}

export function getScratchpadBlock(database: DatabaseSync, id: string) {
  const row = database
    .prepare(
      `
        SELECT
          s.id,
          s.project_id AS projectId,
          p.name AS projectName,
          s.body,
          s.created_at AS createdAt,
          s.triggered_at AS triggeredAt,
          s.triggered_agent_id AS triggeredAgentId
        FROM scratchpad_blocks s
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.id = ?
      `,
    )
    .get(id.trim())
  if (!row) return undefined
  return scratchpadBlockDbRowSchema.parse(row)
}

function scratchpadTriggerId(blockId: string, agentId: string, triggeredAt: string) {
  return `trigger-${blockId}-${agentId}-${Date.parse(triggeredAt).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
