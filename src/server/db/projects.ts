import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

import type { AddProjectInput } from '~/lib/contracts'

import {
  idDbRowSchema,
  projectSummaryDbRowSchema,
} from './schema'
import { withTransaction } from './transaction'

export function listProjectSummaries(database: DatabaseSync, includeHidden = false) {
  return database
    .prepare(
      `
        SELECT
          p.id,
          p.name,
          p.cwd,
          p.hidden_at AS hiddenAt,
          (
            SELECT COUNT(*)
            FROM agent_slots a
            WHERE a.project_id = p.id
              AND a.archived_at IS NULL
          ) AS sessionCount
        FROM projects p
        ${includeHidden ? '' : 'WHERE p.hidden_at IS NULL'}
        ORDER BY p.position ASC, p.id ASC
      `,
    )
    .all()
    .map(projectSummaryFromDbRow)
}

export function requireProjectSummary(
  database: DatabaseSync,
  id: string,
  includeHidden = false,
) {
  const project = database
    .prepare(
      `
        SELECT
          p.id,
          p.name,
          p.cwd,
          p.hidden_at AS hiddenAt,
          (
            SELECT COUNT(*)
            FROM agent_slots a
            WHERE a.project_id = p.id
              AND a.archived_at IS NULL
          ) AS sessionCount
        FROM projects p
        WHERE p.id = ?
          AND (? = 1 OR p.hidden_at IS NULL)
      `,
    )
    .get(id, includeHidden ? 1 : 0)
  if (!project) throw new Error(`Project not found: ${id}`)
  return projectSummaryFromDbRow(project)
}

export function insertProject(database: DatabaseSync, input: AddProjectInput) {
  const id = input.id?.trim() || slugify(input.name)
  const name = input.name.trim()
  const cwd = input.cwd.trim()

  if (!name) throw new Error('Project name is required')
  if (!cwd) throw new Error('Project cwd is required')
  if (!existsSync(cwd)) throw new Error(`Project cwd does not exist: ${cwd}`)

  const existing = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(id)
  if (existing) throw new Error(`Project already exists: ${id}`)

  const nextPosition = database
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM projects')
    .get() as { position: number }
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, cwd, position)
    VALUES (?, ?, ?, ?)
  `)
  withTransaction(database, () => {
    insertProject.run(id, name, cwd, nextPosition.position)
  })

  return id
}

export function deleteProjectRow(database: DatabaseSync, id: string) {
  const projectId = id.trim()
  if (!projectId) throw new Error('Project id is required')

  const count = database
    .prepare('SELECT COUNT(*) AS count FROM projects')
    .get() as { count: number }
  if (count.count <= 1) throw new Error('Cannot delete the last project')

  const existing = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!existing) throw new Error(`Project not found: ${projectId}`)

  withTransaction(database, () => {
    database.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    const rows = database
      .prepare('SELECT id FROM projects ORDER BY position ASC, id ASC')
      .all()
      .map((row) => idDbRowSchema.parse(row))
    const update = database.prepare('UPDATE projects SET position = ? WHERE id = ?')
    for (const [position, row] of rows.entries()) {
      update.run(position, row.id)
    }
  })
}

export function reorderVisibleProjectRows(database: DatabaseSync, ids: readonly string[]) {
  const projectIds = ids.map((id) => id.trim())
  const uniqueIds = new Set(projectIds)
  if (uniqueIds.size !== projectIds.length) {
    throw new Error('Project order contains duplicates')
  }

  const visibleRows = database
    .prepare('SELECT id FROM projects WHERE hidden_at IS NULL ORDER BY position ASC, id ASC')
    .all()
    .map((row) => idDbRowSchema.parse(row))
  const visibleIds = new Set(visibleRows.map((row) => row.id))
  const hasEveryVisibleProject =
    visibleIds.size === projectIds.length && projectIds.every((id) => visibleIds.has(id))
  if (!hasEveryVisibleProject) {
    throw new Error('Project order is stale; reopen projects and try again')
  }

  const hiddenRows = database
    .prepare('SELECT id FROM projects WHERE hidden_at IS NOT NULL ORDER BY position ASC, id ASC')
    .all()
    .map((row) => idDbRowSchema.parse(row))
  const update = database.prepare('UPDATE projects SET position = ? WHERE id = ?')

  withTransaction(database, () => {
    let position = 0
    for (const id of projectIds) {
      update.run(position, id)
      position += 1
    }
    for (const row of hiddenRows) {
      update.run(position, row.id)
      position += 1
    }
  })
}

export function hideProjectRow(database: DatabaseSync, id: string) {
  const projectId = id.trim()
  if (!projectId) throw new Error('Project id is required')

  const visibleCount = database
    .prepare('SELECT COUNT(*) AS count FROM projects WHERE hidden_at IS NULL')
    .get() as { count: number }
  if (visibleCount.count <= 1) throw new Error('Cannot hide the last visible project')

  const existing = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!existing) throw new Error(`Project not found: ${projectId}`)

  database
    .prepare('UPDATE projects SET hidden_at = ? WHERE id = ?')
    .run(new Date().toISOString(), projectId)
  return projectId
}

export function unhideProjectRow(database: DatabaseSync, id: string) {
  const projectId = id.trim()
  if (!projectId) throw new Error('Project id is required')

  const existing = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!existing) throw new Error(`Project not found: ${projectId}`)

  database.prepare('UPDATE projects SET hidden_at = NULL WHERE id = ?').run(projectId)
  return projectId
}

function projectSummaryFromDbRow(row: unknown) {
  const parsed = projectSummaryDbRowSchema.parse(row)
  return {
    id: parsed.id,
    name: parsed.name,
    cwd: parsed.cwd,
    hidden: parsed.hiddenAt !== null,
    sessionCount: parsed.sessionCount,
  }
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error('Project name must contain at least one ASCII letter or digit')
  return slug
}
