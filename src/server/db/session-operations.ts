import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { projectPiSessionFile } from '../pi-jsonl'
import {
  clearAgentContextUsage,
  upsertAgentContextUsage,
} from './runtime-state'
import {
  deletedSessionDbRowSchema,
  persistedSessionDbRowSchema,
  projectIdDbRowSchema,
} from './schema'
import {
  ensureThreadForAgent,
  hydrateProjectionMessages,
  replaceAgentTasksForThread,
} from './timeline-writes'
import { withTransaction } from './transaction'

export function resetSessionRows(database: DatabaseSync, agentId: string) {
  const id = agentId.trim()
  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(id) as { id: string } | undefined
  if (!thread) throw new Error(`No active thread for agent: ${id}`)

  const now = new Date().toISOString()
  withTransaction(database, () => {
    database.prepare('DELETE FROM messages WHERE thread_id = ?').run(thread.id)
    database.prepare('DELETE FROM timeline_events WHERE thread_id = ?').run(thread.id)
    database.prepare('DELETE FROM agent_tasks WHERE thread_id = ?').run(thread.id)
    database.prepare('DELETE FROM diff_artifacts WHERE agent_id = ?').run(id)
    clearAgentContextUsage(database, id)
    database
      .prepare("UPDATE threads SET preview = 'Ready.', message_count = 0, updated_at = ? WHERE id = ?")
      .run(now, thread.id)
    database
      .prepare("UPDATE agent_slots SET status = 'idle', session_file = NULL WHERE id = ?")
      .run(id)
  })
}

export function createForkedSessionRow(
  database: DatabaseSync,
  input: {
    readonly sourceAgentId: string
    readonly sessionFile: string
    readonly sessionDirForProjectSlot: (projectId: string, slot: string) => string
    readonly now?: () => string
    readonly slotTimestampMs?: () => number
    readonly slotSuffix?: () => string
  },
) {
  const source = database
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          a.title,
          a.runtime,
          a.interface_mode AS interfaceMode,
          a.model
        FROM agent_slots a
        WHERE a.id = ?
      `,
    )
    .get(input.sourceAgentId) as
    | {
        id: string
        projectId: string
        title: string
        runtime: string
        interfaceMode: string
        model: string
      }
    | undefined
  if (!source) throw new Error(`Agent not found: ${input.sourceAgentId}`)
  if (source.runtime !== 'pi') throw new Error(`${source.runtime} agents do not support /fork yet`)
  if (!existsSync(input.sessionFile)) {
    throw new Error(`Forked Pi session file does not exist: ${input.sessionFile}`)
  }

  const nextPosition = database
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM agent_slots WHERE project_id = ?')
    .get(source.projectId) as { position: number }
  const suffix = input.slotSuffix?.() ?? Math.random().toString(36).slice(2, 8)
  const slot = `session-${(input.slotTimestampMs?.() ?? Date.now()).toString(36)}-${suffix}`
  const id = `${source.projectId}-${slot}`
  const sessionDir = input.sessionDirForProjectSlot(source.projectId, slot)
  mkdirSync(sessionDir, { recursive: true })
  const sessionFile = join(sessionDir, basename(input.sessionFile))
  if (resolve(sessionFile) !== resolve(input.sessionFile)) {
    copyFileSync(input.sessionFile, sessionFile)
  }
  const projection = safeProjectPiSessionFile(sessionFile)
  const now = input.now?.() ?? new Date().toISOString()

  withTransaction(database, () => {
    database
      .prepare(
        `
          INSERT INTO agent_slots (
            id, project_id, slot, title, runtime, interface_mode, model, status, session_dir, session_file, position
          )
          VALUES (?, ?, ?, ?, 'pi', ?, ?, 'idle', ?, ?, ?)
        `,
      )
      .run(
        id,
        source.projectId,
        slot,
        `${source.title} fork`,
        source.interfaceMode,
        source.model,
        sessionDir,
        sessionFile,
        nextPosition.position,
      )
    database
      .prepare(
        `
          INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
          VALUES (?, ?, 1, ?, 0, ?)
        `,
      )
      .run(`thread-${id}`, id, projection?.preview || 'Ready.', projection?.updatedAt ?? now)
    if (projection) {
      hydrateProjectionMessages(database, id, projection)
      upsertAgentContextUsage(database, {
        agentId: id,
        usedTokens: projection.contextUsedTokens,
        sessionFile,
        updatedAt: projection.updatedAt,
      })
    }
  })

  return id
}

export function hydratePersistedPiSessionRows(
  database: DatabaseSync,
  input: {
    readonly piSessionsDir: string
    readonly defaultModel: string
  },
) {
  const projects = database
    .prepare('SELECT id FROM projects ORDER BY position ASC')
    .all()
    .map((row) => projectIdDbRowSchema.parse(row))

  for (const project of projects) {
    const projectSessionRoot = join(input.piSessionsDir, project.id)
    if (!existsSync(projectSessionRoot)) continue
    const deletedSlots = new Set(
      database
        .prepare('SELECT slot FROM deleted_sessions WHERE project_id = ?')
        .all(project.id)
        .map((row) => deletedSessionDbRowSchema.parse(row).slot),
    )

    const slots = readdirSync(projectSessionRoot, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory() && entry.name.startsWith('session-') && !deletedSlots.has(entry.name)
          ? [entry.name]
          : [],
      )
      .sort()

    for (const slot of slots) {
      const sessionDir = join(projectSessionRoot, slot)
      const id = `${project.id}-${slot}`
      const existing = database
        .prepare(
          `
            SELECT
              id,
              slot,
              session_dir AS sessionDir,
              session_file AS sessionFile
            FROM agent_slots
            WHERE id = ?
          `,
        )
        .get(id)
      const existingAgent = existing
        ? persistedSessionDbRowSchema.parse(existing)
        : undefined
      const sessionFile = activePiSessionFile(sessionDir, existingAgent?.sessionFile)
      const projection = sessionFile ? safeProjectPiSessionFile(sessionFile) : undefined
      const agent = existingAgent ??
        createPersistedSessionAgent(database, {
          id,
          projectId: project.id,
          slot,
          title: sessionTitle(projection?.preview, slot),
          model: input.defaultModel,
          sessionDir,
          sessionFile,
        })

      if (sessionFile && !agent.sessionFile) {
        database
          .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
          .run(sessionFile, id)
      }
      const threadId = ensureThreadForAgent(database, id, projection)
      if (projection) {
        hydrateProjectionMessages(database, id, projection)
        replaceAgentTasksForThread(database, {
          threadId,
          source: 'pi',
          tasks: projection.tasks,
          updatedAt: projection.updatedAt ?? new Date().toISOString(),
        })
      }
      if (projection?.messages.length) {
        upsertAgentContextUsage(database, {
          agentId: id,
          usedTokens: projection.contextUsedTokens,
          sessionFile,
          updatedAt: projection.updatedAt,
        })
      }
    }
  }
}

function activePiSessionFile(sessionDir: string, storedSessionFile: string | null | undefined) {
  if (storedSessionFile && existsSync(storedSessionFile)) return storedSessionFile
  return latestPiSessionFile(sessionDir)
}

function createPersistedSessionAgent(
  database: DatabaseSync,
  input: {
    readonly id: string
    readonly projectId: string
    readonly slot: string
    readonly title: string
    readonly model: string
    readonly sessionDir: string
    readonly sessionFile?: string
  },
) {
  const nextPosition = database
    .prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM agent_slots WHERE project_id = ?',
    )
    .get(input.projectId) as { position: number }
  database
    .prepare(
      `
        INSERT INTO agent_slots (
          id, project_id, slot, title, runtime, interface_mode, model, status, session_dir, session_file, position
        )
        VALUES (?, ?, ?, ?, 'pi', 'gui', ?, 'idle', ?, ?, ?)
      `,
    )
    .run(
      input.id,
      input.projectId,
      input.slot,
      input.title,
      input.model,
      input.sessionDir,
      input.sessionFile ?? null,
      nextPosition.position,
    )
  return {
    id: input.id,
    slot: input.slot,
    sessionDir: input.sessionDir,
    sessionFile: input.sessionFile ?? null,
  }
}

function latestPiSessionFile(sessionDir: string) {
  if (!existsSync(sessionDir)) return undefined
  return readdirSync(sessionDir, { withFileTypes: true })
    .flatMap((entry) => entry.isFile() && entry.name.endsWith('.jsonl') ? [join(sessionDir, entry.name)] : [])
    .sort()
    .at(-1)
}

export function safeProjectPiSessionFile(path: string) {
  try {
    return projectPiSessionFile(path)
  } catch {
    return undefined
  }
}

function sessionTitle(preview: string | undefined, fallback: string) {
  const title = preview?.replace(/\s+/g, ' ').trim()
  if (!title) return fallback
  return title.length > 44 ? `${title.slice(0, 41)}...` : title
}
