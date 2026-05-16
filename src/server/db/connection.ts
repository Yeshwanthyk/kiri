import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from './migrations'

export function openKiriDatabase(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const database = new DatabaseSync(dbPath)
  configureKiriDatabase(database)
  migrate(database)
  return database
}

function configureKiriDatabase(database: DatabaseSync) {
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA foreign_keys = ON')
}
