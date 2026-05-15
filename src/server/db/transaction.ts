import type { DatabaseSync } from 'node:sqlite'

type NonPromise<T> = T extends PromiseLike<unknown> ? never : T

export function withTransaction<T>(
  database: DatabaseSync,
  operation: () => NonPromise<T>,
): NonPromise<T> {
  database.exec('BEGIN')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
