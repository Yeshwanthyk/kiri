import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openKiriDatabase } from '../../src/server/db/connection'
import {
  deleteProjectRow,
  hideProjectRow,
  insertProject,
  listProjectSummaries,
  reorderVisibleProjectRows,
  requireProjectSummary,
  unhideProjectRow,
} from '../../src/server/db/projects'

describe('project repository', () => {
  it('preserves project create, summary, visibility, ordering, and delete semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-projects-'))
    const firstCwd = join(root, 'first')
    const secondCwd = join(root, 'second')
    const thirdCwd = join(root, 'third')
    mkdirSync(firstCwd)
    mkdirSync(secondCwd)
    mkdirSync(thirdCwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const firstId = insertProject(database, { name: 'First Project', cwd: firstCwd })
      const secondId = insertProject(database, { name: 'Second Project', cwd: secondCwd })
      const thirdId = insertProject(database, { name: 'Third Project', cwd: thirdCwd })

      expect([firstId, secondId, thirdId]).toEqual([
        'first-project',
        'second-project',
        'third-project',
      ])
      expect(listProjectSummaries(database).map((project) => project.id)).toEqual([
        firstId,
        secondId,
        thirdId,
      ])
      expect(requireProjectSummary(database, secondId)).toEqual({
        id: secondId,
        name: 'Second Project',
        cwd: secondCwd,
        hidden: false,
        sessionCount: 0,
      })
      database
        .prepare(
          `
            INSERT INTO agent_slots (
              id, project_id, slot, title, runtime, interface_mode, model, status,
              session_dir, session_file, runtime_state_json, archived_at, position
            )
            VALUES (
              'agent-1', ?, 'session-1', 'Agent', 'pi', 'gui', 'test-model', 'idle',
              '/tmp/session-1', NULL, NULL, NULL, 0
            )
          `,
        )
        .run(secondId)
      database
        .prepare(
          `
            INSERT INTO agent_slots (
              id, project_id, slot, title, runtime, interface_mode, model, status,
              session_dir, session_file, runtime_state_json, archived_at, position
            )
            VALUES (
              'agent-2', ?, 'session-2', 'Agent', 'pi', 'gui', 'test-model', 'idle',
              '/tmp/session-2', NULL, NULL, '2026-01-01T00:00:00.000Z', 1
            )
          `,
        )
        .run(secondId)
      expect(requireProjectSummary(database, secondId).sessionCount).toBe(1)

      hideProjectRow(database, secondId)
      expect(listProjectSummaries(database).map((project) => project.id)).toEqual([
        firstId,
        thirdId,
      ])
      expect(requireProjectSummary(database, secondId, true).hidden).toBe(true)

      reorderVisibleProjectRows(database, [thirdId, firstId])
      expect(listProjectSummaries(database, true).map((project) => project.id)).toEqual([
        thirdId,
        firstId,
        secondId,
      ])

      unhideProjectRow(database, secondId)
      expect(listProjectSummaries(database).map((project) => project.id)).toEqual([
        thirdId,
        firstId,
        secondId,
      ])

      deleteProjectRow(database, firstId)
      expect(listProjectSummaries(database).map((project) => project.id)).toEqual([
        thirdId,
        secondId,
      ])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps validation errors at the repository boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-project-validation-'))
    const onlyCwd = join(root, 'only')
    mkdirSync(onlyCwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      insertProject(database, { name: 'Only Project', cwd: onlyCwd })

      expect(() => insertProject(database, { name: '!!!', cwd: onlyCwd })).toThrow(
        'Project name must contain at least one ASCII letter or digit',
      )
      expect(() => insertProject(database, { name: 'Missing Cwd', cwd: join(root, 'missing') }))
        .toThrow(`Project cwd does not exist: ${join(root, 'missing')}`)
      expect(() => hideProjectRow(database, 'only-project')).toThrow(
        'Cannot hide the last visible project',
      )
      expect(() => deleteProjectRow(database, 'only-project')).toThrow(
        'Cannot delete the last project',
      )
      expect(() => requireProjectSummary(database, 'missing-project')).toThrow(
        'Project not found: missing-project',
      )

      const secondCwd = join(root, 'second')
      mkdirSync(secondCwd)
      const secondId = insertProject(database, { name: 'Second Project', cwd: secondCwd })
      expect(() => hideProjectRow(database, 'missing-project')).toThrow(
        'Project not found: missing-project',
      )
      expect(() => reorderVisibleProjectRows(database, ['only-project', 'only-project'])).toThrow(
        'Project order contains duplicates',
      )
      expect(() => reorderVisibleProjectRows(database, ['only-project', 'missing-project'])).toThrow(
        'Project order is stale; reopen projects and try again',
      )
      expect(() => deleteProjectRow(database, 'missing-project')).toThrow(
        'Project not found: missing-project',
      )
      expect(listProjectSummaries(database).map((project) => project.id)).toEqual([
        'only-project',
        secondId,
      ])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps project order unchanged when reorder input is stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-project-reorder-stale-'))
    const firstCwd = join(root, 'first')
    const secondCwd = join(root, 'second')
    const thirdCwd = join(root, 'third')
    mkdirSync(firstCwd)
    mkdirSync(secondCwd)
    mkdirSync(thirdCwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const firstId = insertProject(database, { name: 'First Project', cwd: firstCwd })
      const secondId = insertProject(database, { name: 'Second Project', cwd: secondCwd })
      const thirdId = insertProject(database, { name: 'Third Project', cwd: thirdCwd })
      hideProjectRow(database, secondId)
      const before = projectPositions(database)

      expect(() => reorderVisibleProjectRows(database, [thirdId, secondId, firstId])).toThrow(
        'Project order is stale; reopen projects and try again',
      )

      expect(projectPositions(database)).toEqual(before)
      expect(listProjectSummaries(database, true).map((project) => project.id)).toEqual([
        firstId,
        secondId,
        thirdId,
      ])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rolls back project reorder failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-project-reorder-rollback-'))
    const firstCwd = join(root, 'first')
    const secondCwd = join(root, 'second')
    const thirdCwd = join(root, 'third')
    mkdirSync(firstCwd)
    mkdirSync(secondCwd)
    mkdirSync(thirdCwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const firstId = insertProject(database, { name: 'First Project', cwd: firstCwd })
      const secondId = insertProject(database, { name: 'Second Project', cwd: secondCwd })
      const thirdId = insertProject(database, { name: 'Third Project', cwd: thirdCwd })
      const before = projectPositions(database)
      database.exec(`
        CREATE TEMP TRIGGER fail_project_reorder
        BEFORE UPDATE OF position ON projects
        WHEN OLD.id = '${secondId}'
        BEGIN
          SELECT RAISE(ABORT, 'forced project reorder failure');
        END;
      `)

      expect(() => reorderVisibleProjectRows(database, [thirdId, secondId, firstId])).toThrow(
        'forced project reorder failure',
      )
      expect(projectPositions(database)).toEqual(before)
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function projectPositions(database: ReturnType<typeof openKiriDatabase>) {
  return database
    .prepare('SELECT id, position, hidden_at AS hiddenAt FROM projects ORDER BY position ASC')
    .all()
}
