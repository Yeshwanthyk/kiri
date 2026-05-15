import type { DatabaseSync } from 'node:sqlite'
import { idDbRowSchema } from './schema'

export function applyDatabaseBootstraps(
  database: DatabaseSync,
  input: {
    readonly piModels: readonly string[]
    readonly defaultPiModel: string
  },
) {
  normalizeSeededModels(database, input)
  removeLegacySeedProject(database)
}

function normalizeSeededModels(
  database: DatabaseSync,
  input: {
    readonly piModels: readonly string[]
    readonly defaultPiModel: string
  },
) {
  if (input.piModels.length === 0) return
  const staleRows = database
    .prepare(
      `
        SELECT id
        FROM agent_slots
        WHERE runtime = 'pi'
          AND model NOT IN (${input.piModels.map(() => '?').join(', ')})
      `,
    )
    .all(...input.piModels)
    .map((row) => idDbRowSchema.parse(row))

  const update = database.prepare('UPDATE agent_slots SET model = ? WHERE id = ?')
  for (const row of staleRows) {
    update.run(input.defaultPiModel, row.id)
  }
}

function removeLegacySeedProject(database: DatabaseSync) {
  database.exec(`
    DELETE FROM projects
    WHERE id = 'kiri'
      AND name = 'kiri Orchestrator'
      AND (
        SELECT COUNT(*)
        FROM projects
      ) = 1
      AND NOT EXISTS (
        SELECT 1
        FROM agent_slots
        WHERE project_id = 'kiri'
      )
  `)
}
