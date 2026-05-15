import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { openKiriDatabase } from '../../src/server/db/connection'
import { withTransaction } from '../../src/server/db/transaction'

describe('DB connection', () => {
  it('opens a configured migrated database at the requested path', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-connection-'))
    const dbPath = join(root, 'nested', 'kiri.sqlite')
    const database = openKiriDatabase(dbPath)
    try {
      expect(existsSync(dbPath)).toBe(true)

      const projectsTable = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
        .get()
      expect(projectsTable).toEqual({ name: 'projects' })

      const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
      expect(foreignKeys.foreign_keys).toBe(1)

      const busyTimeout = database.prepare('PRAGMA busy_timeout').get() as { timeout: number }
      expect(busyTimeout.timeout).toBe(5000)

      const journalMode = database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(journalMode.journal_mode).toBe('wal')
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('DB transactions', () => {
  it('commits successful operations and rolls back failed operations', () => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec('CREATE TABLE items (id TEXT PRIMARY KEY)')

      withTransaction(database, () => {
        database.prepare('INSERT INTO items (id) VALUES (?)').run('committed')
      })

      expect(database.prepare('SELECT COUNT(*) AS count FROM items').get()).toEqual({ count: 1 })
      expect(() =>
        withTransaction(database, () => {
          database.prepare('INSERT INTO items (id) VALUES (?)').run('rolled-back')
          throw new Error('fail')
        }),
      ).toThrow('fail')
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM items WHERE id = ?').get('rolled-back'),
      ).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })
})
