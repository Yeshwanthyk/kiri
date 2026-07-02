import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { projectPiSessionFile } from '../pi-jsonl-file'
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
import { compactSessionTitle, forkSessionTitle } from './session-title'
import { withTransaction } from './transaction'

type PiHydrationStamp = {
  readonly sessionFile: string
  readonly mtimeMs: number
  readonly size: number
}

type PiProjectSessionRootCache = {
  readonly mtimeMs: number
  readonly slots: readonly string[]
}

type PersistedPiSessionAgent = {
  readonly id: string
  readonly projectId: string
  readonly slot: string
  readonly sessionDir: string
  readonly sessionFile: string | null
  readonly archivedAt: string | null
}

const piHydrationStamps = new Map<string, PiHydrationStamp>()
const piProjectSessionRootCache = new Map<string, PiProjectSessionRootCache>()

export function clearPiHydrationStamps() {
  piHydrationStamps.clear()
  piProjectSessionRootCache.clear()
}

export function forgetPiHydrationStamp(agentId: string) {
  piHydrationStamps.delete(agentId)
}

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
    clearAgentContextUsage(database, id)
    database
      .prepare("UPDATE threads SET preview = 'Ready.', message_count = 0, updated_at = ? WHERE id = ?")
      .run(now, thread.id)
    database
      .prepare("UPDATE agent_slots SET status = 'idle', session_file = NULL WHERE id = ?")
      .run(id)
    forgetPiHydrationStamp(id)
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
            id, project_id, slot, title, runtime, interface_mode, model, status,
            session_dir, session_file, title_set_manually, position
          )
          VALUES (?, ?, ?, ?, 'pi', ?, ?, 'idle', ?, ?, 1, ?)
        `,
      )
      .run(
        id,
        source.projectId,
        slot,
        forkSessionTitle(source.title),
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
    readonly onlyAgentId?: string
  },
) {
  if (input.onlyAgentId) {
    hydratePersistedPiSessionByAgentId(database, {
      agentId: input.onlyAgentId,
      defaultModel: input.defaultModel,
    })
    return
  }

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

    const slots = projectSessionSlots(projectSessionRoot)
      .filter((slot) => !deletedSlots.has(slot))

    for (const slot of slots) {
      const sessionDir = join(projectSessionRoot, slot)
      const id = `${project.id}-${slot}`
      hydratePersistedPiSession(database, {
        id,
        projectId: project.id,
        slot,
        sessionDir,
        defaultModel: input.defaultModel,
      })
    }
  }
}

function hydratePersistedPiSessionByAgentId(
  database: DatabaseSync,
  input: {
    readonly agentId: string
    readonly defaultModel: string
  },
) {
  const existingAgent = readPersistedPiSessionAgent(database, input.agentId)
  if (!existingAgent || existingAgent.archivedAt !== null) return
  hydratePersistedPiSession(database, {
    id: existingAgent.id,
    projectId: existingAgent.projectId,
    slot: existingAgent.slot,
    sessionDir: existingAgent.sessionDir,
    defaultModel: input.defaultModel,
    existingAgent,
  })
}

function hydratePersistedPiSession(
  database: DatabaseSync,
  input: {
    readonly id: string
    readonly projectId: string
    readonly slot: string
    readonly sessionDir: string
    readonly defaultModel: string
    readonly existingAgent?: PersistedPiSessionAgent
  },
) {
  const existingAgent = input.existingAgent ?? readPersistedPiSessionAgent(database, input.id)
  if (existingAgent?.archivedAt !== null && existingAgent?.archivedAt !== undefined) return
  const sessionFile = activePiSessionFile(input.sessionDir, existingAgent?.sessionFile)
  const stamp = sessionFile ? statSessionFile(sessionFile) : undefined
  if (
    existingAgent &&
    stamp &&
    sameHydrationStamp(piHydrationStamps.get(input.id), stamp)
  ) {
    return
  }
  const projection = sessionFile ? safeProjectPiSessionFile(sessionFile) : undefined
  const agent = existingAgent ??
    createPersistedSessionAgent(database, {
      id: input.id,
      projectId: input.projectId,
      slot: input.slot,
      title: sessionTitle(projection?.preview, input.slot),
      model: input.defaultModel,
      sessionDir: input.sessionDir,
      sessionFile,
    })

  if (sessionFile && !agent.sessionFile) {
    database
      .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
      .run(sessionFile, input.id)
  }
  const threadId = ensureThreadForAgent(database, input.id, projection)
  if (projection) {
    hydrateProjectionMessages(database, input.id, projection)
    replaceAgentTasksForThread(database, {
      threadId,
      source: 'pi',
      tasks: projection.tasks,
      updatedAt: projection.updatedAt ?? new Date().toISOString(),
    })
  }
  if (projection?.messages.length) {
    upsertAgentContextUsage(database, {
      agentId: input.id,
      usedTokens: projection.contextUsedTokens,
      sessionFile,
      updatedAt: projection.updatedAt,
    })
  }
  if (stamp && projection) piHydrationStamps.set(input.id, stamp)
}

function readPersistedPiSessionAgent(database: DatabaseSync, agentId: string) {
  const row = database
    .prepare(
      `
        SELECT
          id,
          project_id AS projectId,
          slot,
          session_dir AS sessionDir,
          session_file AS sessionFile,
          archived_at AS archivedAt
        FROM agent_slots
        WHERE id = ?
          AND runtime = 'pi'
      `,
    )
    .get(agentId)
  if (!row) return undefined
  const extra = row as { projectId: string; archivedAt: string | null }
  return {
    ...persistedSessionDbRowSchema.parse(row),
    projectId: extra.projectId,
    archivedAt: extra.archivedAt,
  }
}

function statSessionFile(path: string): PiHydrationStamp | undefined {
  try {
    const stats = statSync(path)
    return { sessionFile: path, mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return undefined
  }
}

function projectSessionSlots(projectSessionRoot: string) {
  const mtimeMs = statProjectSessionRoot(projectSessionRoot)
  if (mtimeMs === undefined) {
    piProjectSessionRootCache.delete(projectSessionRoot)
    return []
  }
  const cached = piProjectSessionRootCache.get(projectSessionRoot)
  if (cached?.mtimeMs === mtimeMs) return [...cached.slots]

  const slots = readdirSync(projectSessionRoot, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() && entry.name.startsWith('session-') ? [entry.name] : [])
    .sort()
  piProjectSessionRootCache.set(projectSessionRoot, { mtimeMs, slots })
  return slots
}

function statProjectSessionRoot(path: string) {
  try {
    const stats = statSync(path)
    return stats.isDirectory() ? stats.mtimeMs : undefined
  } catch {
    return undefined
  }
}

function sameHydrationStamp(
  previous: PiHydrationStamp | undefined,
  next: PiHydrationStamp,
) {
  return previous !== undefined &&
    previous.sessionFile === next.sessionFile &&
    previous.mtimeMs === next.mtimeMs &&
    previous.size === next.size
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
          id, project_id, slot, title, runtime, interface_mode, model, status,
          session_dir, session_file, title_set_manually, position
        )
        VALUES (?, ?, ?, ?, 'pi', 'gui', ?, 'idle', ?, ?, 0, ?)
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
  return compactSessionTitle(preview, fallback)
}
