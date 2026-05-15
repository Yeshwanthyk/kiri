import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { applyDatabaseBootstraps } from '../../src/server/db/bootstrap'
import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'

describe('database bootstraps', () => {
  it('normalizes stale seeded Pi models without touching configured models', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-bootstrap-models-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      database
        .prepare(
          `
            INSERT INTO agent_slots (
              id, project_id, slot, title, runtime, interface_mode, model, status,
              session_dir, session_file, runtime_state_json, archived_at, position
            )
            VALUES
              ('stale', ?, 'session-a', 'Stale', 'pi', 'gui', 'old-model', 'idle', '/tmp/a', NULL, NULL, NULL, 0),
              ('fresh', ?, 'session-b', 'Fresh', 'pi', 'gui', 'new-model', 'idle', '/tmp/b', NULL, NULL, NULL, 1),
              ('codex', ?, 'session-c', 'Codex', 'codex', 'gui', 'old-model', 'idle', '/tmp/c', NULL, NULL, NULL, 2)
          `,
        )
        .run(projectId, projectId, projectId)

      applyDatabaseBootstraps(database, {
        piModels: ['new-model'],
        defaultPiModel: 'new-model',
      })

      expect(
        database
          .prepare('SELECT id, model FROM agent_slots ORDER BY id ASC')
          .all(),
      ).toEqual([
        { id: 'codex', model: 'old-model' },
        { id: 'fresh', model: 'new-model' },
        { id: 'stale', model: 'new-model' },
      ])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes only the empty legacy seed project', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-bootstrap-legacy-'))
    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      database
        .prepare('INSERT INTO projects (id, name, cwd, position, hidden_at) VALUES (?, ?, ?, 0, NULL)')
        .run('kiri', 'kiri Orchestrator', root)

      applyDatabaseBootstraps(database, {
        piModels: ['new-model'],
        defaultPiModel: 'new-model',
      })

      expect(database.prepare('SELECT COUNT(*) AS count FROM projects').get())
        .toEqual({ count: 0 })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
