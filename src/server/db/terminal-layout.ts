import type { DatabaseSync } from 'node:sqlite'
import type {
  SaveTerminalLayoutInput,
  TerminalLayout,
} from '~/lib/contracts'
import {
  saveTerminalLayoutInputSchema,
  terminalLayoutSchema,
  type TerminalMode,
} from '~/lib/contracts'
import {
  terminalLayoutDbRowSchema,
  terminalLayoutProjectionSchema,
} from './schema'

export type TerminalLayoutProjection = {
  readonly ownerId: string
  readonly mode: TerminalMode
  readonly layout: TerminalLayout
  readonly updatedAt: string
}

export function upsertTerminalLayout(
  database: DatabaseSync,
  input: SaveTerminalLayoutInput,
  now = () => new Date().toISOString(),
) {
  const parsed = saveTerminalLayoutInputSchema.parse(input)
  const ownerId = parsed.mode === 'runtime'
    ? parsed.agentId
    : parsed.projectId
  if (!ownerId) throw new Error(`Missing ${parsed.mode} terminal layout owner`)
  const id = terminalLayoutId(parsed.mode, ownerId)
  database
    .prepare(
      `
        INSERT INTO terminal_layouts (
          id, agent_id, project_id, mode, layout_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          layout_json = excluded.layout_json,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      id,
      parsed.mode === 'runtime' ? ownerId : null,
      parsed.mode === 'shell' ? ownerId : null,
      parsed.mode,
      JSON.stringify(parsed.layout),
      now(),
    )
  return id
}

export function readProjectShellTerminalLayout(
  database: DatabaseSync,
  projectId: string,
) {
  return readTerminalLayout(database, 'shell', projectId)
}

export function readAgentRuntimeTerminalLayout(
  database: DatabaseSync,
  agentId: string,
) {
  return readTerminalLayout(database, 'runtime', agentId)
}

export function readProjectShellTerminalLayouts(database: DatabaseSync) {
  return readTerminalLayouts(database, 'shell')
}

export function readAgentRuntimeTerminalLayouts(database: DatabaseSync) {
  return readTerminalLayouts(database, 'runtime')
}

function readTerminalLayout(
  database: DatabaseSync,
  mode: TerminalMode,
  ownerId: string,
) {
  const row = database
    .prepare(
      `
        SELECT
          id,
          agent_id AS agentId,
          project_id AS projectId,
          mode,
          layout_json AS layoutJson,
          updated_at AS updatedAt
        FROM terminal_layouts
        WHERE id = ?
      `,
    )
    .get(terminalLayoutId(mode, ownerId))
  if (!row) return null
  return parseTerminalLayoutProjection(row)
}

function readTerminalLayouts(
  database: DatabaseSync,
  mode: TerminalMode,
) {
  return database
    .prepare(
      `
        SELECT
          id,
          agent_id AS agentId,
          project_id AS projectId,
          mode,
          layout_json AS layoutJson,
          updated_at AS updatedAt
        FROM terminal_layouts
        WHERE mode = ?
        ORDER BY updated_at DESC, id ASC
      `,
    )
    .all(mode)
    .map(parseTerminalLayoutProjection)
}

function parseTerminalLayoutProjection(row: unknown): TerminalLayoutProjection {
  const parsed = terminalLayoutDbRowSchema.parse(row)
  const ownerId = parsed.mode === 'runtime' ? parsed.agentId : parsed.projectId
  if (!ownerId) throw new Error(`Terminal layout ${parsed.id} has no owner`)
  return terminalLayoutProjectionSchema.parse({
    ownerId,
    mode: parsed.mode,
    layout: terminalLayoutSchema.parse(JSON.parse(parsed.layoutJson)),
    updatedAt: parsed.updatedAt,
  })
}

function terminalLayoutId(mode: TerminalMode, ownerId: string) {
  return `${mode}:${ownerId}`
}
