import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { makeKiriDbService } from '~/server/db'

describe('KiriDbService', () => {
  it('caches the opened database and can close/reopen the connection', () => {
    const openedPaths: string[] = []
    const bootstraps: Array<{
      readonly piModels: readonly string[]
      readonly defaultPiModel: string
    }> = []
    const databases: DatabaseSync[] = []
    const service = makeKiriDbService({
      getConfig: () => ({ dbPath: '/tmp/kiri-test.sqlite' }),
      openDatabase: (dbPath) => {
        openedPaths.push(dbPath)
        const database = new DatabaseSync(':memory:')
        databases.push(database)
        return database
      },
      getPiRuntimeSettings: () => ({
        models: ['pi-model'],
        defaultModel: 'pi-model',
      }),
      bootstrap: (database, input) => {
        bootstraps.push(input)
        database.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)')
      },
    })

    try {
      const first = Effect.runSync(service.get)
      const second = Effect.runSync(service.get)

      expect(second).toBe(first)
      expect(openedPaths).toEqual(['/tmp/kiri-test.sqlite'])
      expect(bootstraps).toEqual([{
        piModels: ['pi-model'],
        defaultPiModel: 'pi-model',
      }])
      expect(first.prepare("SELECT name FROM sqlite_master WHERE name = 'probe'").get())
        .toEqual({ name: 'probe' })

      expect(Effect.runSync(service.close)).toBe(true)
      expect(Effect.runSync(service.close)).toBe(false)

      const reopened = Effect.runSync(service.get)
      expect(databases.indexOf(reopened)).toBe(1)
      expect(openedPaths).toEqual(['/tmp/kiri-test.sqlite', '/tmp/kiri-test.sqlite'])
      expect(bootstraps).toHaveLength(2)
    } finally {
      for (const database of databases) {
        try {
          database.close()
        } catch {
          // The service may have already closed this connection.
        }
      }
    }
  })
})
