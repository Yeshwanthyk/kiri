import type { DatabaseSync } from 'node:sqlite'

type NonPromise<T> = T extends PromiseLike<unknown> ? never : T

let transactionDepth = 0

export function withTransaction<T>(
  database: DatabaseSync,
  operation: () => NonPromise<T>,
): NonPromise<T> {
  const depth = transactionDepth
  const savepoint = `kiri_tx_${depth}`
  database.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
  transactionDepth += 1
  try {
    const result = operation()
    transactionDepth -= 1
    database.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
    return result
  } catch (error) {
    transactionDepth -= 1
    if (depth === 0) {
      database.exec('ROLLBACK')
    } else {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      database.exec(`RELEASE SAVEPOINT ${savepoint}`)
    }
    throw error
  }
}
