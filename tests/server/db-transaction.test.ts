import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { withTransaction } from '../../src/server/db/transaction'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

describe('database transactions', () => {
  it('commits nested transactions through savepoints', () => {
    const database = testDatabase()

    withTransaction(database, () => {
      insertValue(database, 'outer')
      withTransaction(database, () => {
        insertValue(database, 'inner')
      })
    })

    expect(values(database)).toEqual(['outer', 'inner'])
  })

  it('rolls back a failed nested transaction without aborting a caught outer transaction', () => {
    const database = testDatabase()

    withTransaction(database, () => {
      insertValue(database, 'outer-before')
      expect(() =>
        withTransaction(database, () => {
          insertValue(database, 'inner')
          throw new Error('inner failed')
        }),
      ).toThrow('inner failed')
      insertValue(database, 'outer-after')
    })

    expect(values(database)).toEqual(['outer-before', 'outer-after'])
  })

  it('rolls back outer transaction failures after nested commits', () => {
    const database = testDatabase()

    expect(() =>
      withTransaction(database, () => {
        insertValue(database, 'outer')
        withTransaction(database, () => {
          insertValue(database, 'inner')
        })
        throw new Error('outer failed')
      }),
    ).toThrow('outer failed')

    expect(values(database)).toEqual([])
  })
})

function testDatabase() {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  database.exec('CREATE TABLE values_test (value TEXT NOT NULL)')
  return database
}

function insertValue(database: DatabaseSync, value: string) {
  database.prepare('INSERT INTO values_test (value) VALUES (?)').run(value)
}

function values(database: DatabaseSync) {
  return database
    .prepare('SELECT value FROM values_test ORDER BY rowid ASC')
    .all()
    .map((row) => (row as { value: string }).value)
}
