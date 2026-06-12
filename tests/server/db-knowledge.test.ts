import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import {
  addKnowledgeEntry,
  markKnowledgeEntrySeen,
  searchKnowledgeEntries,
} from '../../src/server/db/knowledge'

describe('knowledge repository', () => {
  it('adds, searches, and marks reusable answers seen', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-knowledge-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })

      const created = addKnowledgeEntry(database, {
        projectId,
        title: 'xterm dynamic import 404 after desktop restart',
        problem: 'The terminal pane fails to load an assets/xterm module after restart.',
        answer: 'Refresh the backend browser owner URL before restoring the desktop shell.',
        tags: ['desktop', 'xterm'],
      })

      expect(created).toMatchObject({
        projectId,
        title: 'xterm dynamic import 404 after desktop restart',
        seenCount: 0,
        lastSeenAt: null,
      })

      const matches = searchKnowledgeEntries(database, {
        projectId,
        query: 'dynamic import xterm',
        limit: 10,
      })
      expect(matches.map((entry) => entry.id)).toEqual([created.id])

      const seen = markKnowledgeEntrySeen(database, { id: created.id })
      expect(seen).toMatchObject({
        id: created.id,
        seenCount: 1,
        lastSeenAt: expect.any(String),
      })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('validates project and entry boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-knowledge-validation-'))
    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      expect(() =>
        addKnowledgeEntry(database, {
          projectId: 'missing-project',
          title: 'Missing',
          problem: 'missing',
          answer: 'missing',
          tags: [],
        }),
      ).toThrow('Project not found: missing-project')
      expect(() => markKnowledgeEntrySeen(database, { id: 'missing-entry' }))
        .toThrow('Knowledge entry not found: missing-entry')
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
