import type { DatabaseSync } from 'node:sqlite'

import { withTransaction } from '../../src/server/db/transaction'

declare const database: DatabaseSync

withTransaction(database, () => 'ok')

// @ts-expect-error transactions are synchronous; async callbacks can escape rollback.
withTransaction(database, async () => 'nope')
