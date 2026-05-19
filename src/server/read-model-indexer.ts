import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  readModelContractVersion,
  readModelEntrySchema,
  readModelIndexContractSchema,
  type ReadModelEntry,
  type ReadModelCandidate,
  type ReadModelKind,
} from './read-model-contract'
import { readModelEntryDbRowSchema } from './db/schema'

const INDEXER_TIMEOUT_MS = 3000
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const FNV_MASK = 0xffffffffffffffffn

export type RustReadModelIndexer = (
  candidates: readonly ReadModelCandidate[],
  env: NodeJS.ProcessEnv,
) => readonly ReadModelEntry[]

export function refreshReadModelEntries(
  database: DatabaseSync,
  input: {
    readonly env?: NodeJS.ProcessEnv
    readonly runRustIndexer?: RustReadModelIndexer
  } = {},
) {
  const entries = indexReadModelCandidates(collectReadModelCandidates(database), input)
  replaceReadModelEntries(database, entries)
  return entries
}

export function listReadModelEntries(
  database: DatabaseSync,
  kind?: ReadModelKind,
): ReadModelEntry[] {
  const rows = kind
    ? database
      .prepare(
        `
          SELECT kind, entity_id AS entityId, revision, payload_json AS payloadJson, updated_at AS updatedAt
          FROM read_model_entries
          WHERE kind = ?
          ORDER BY kind ASC, entity_id ASC
        `,
      )
      .all(kind)
    : database
      .prepare(
        `
          SELECT kind, entity_id AS entityId, revision, payload_json AS payloadJson, updated_at AS updatedAt
          FROM read_model_entries
          ORDER BY kind ASC, entity_id ASC
        `,
      )
      .all()

  return rows.map((row) => {
    const parsed = readModelEntryDbRowSchema.parse(row)
    return readModelEntrySchema.parse({
      kind: parsed.kind,
      entityId: parsed.entityId,
      revision: parsed.revision,
      payload: parsePayload(parsed.payloadJson),
      updatedAt: parsed.updatedAt,
    })
  })
}

export function collectReadModelCandidates(database: DatabaseSync): ReadModelCandidate[] {
  return [
    collectWorkspaceSummaryCandidate(database),
    ...collectAgentTimelineCandidates(database),
    ...collectDiffSummaryCandidates(database),
  ]
}

export function indexReadModelCandidates(
  candidates: readonly ReadModelCandidate[],
  input: {
    readonly env?: NodeJS.ProcessEnv
    readonly runRustIndexer?: RustReadModelIndexer
  } = {},
): ReadModelEntry[] {
  const env = input.env ?? process.env
  const runRustIndexer = input.runRustIndexer ?? indexReadModelCandidatesWithRust
  if (shouldUseRustIndexer(env, Boolean(input.runRustIndexer))) {
    try {
      return [...runRustIndexer(candidates, env)]
    } catch {
      // The Rust spike is an acceleration path; TS keeps the contract available.
    }
  }
  return indexReadModelCandidatesWithTypeScript(candidates)
}

export function indexReadModelCandidatesWithRust(
  candidates: readonly ReadModelCandidate[],
  env: NodeJS.ProcessEnv = process.env,
): ReadModelEntry[] {
  const binaryPath = rustReadModelIndexerBinaryPath(env, { requireExisting: false })
  if (!binaryPath) throw new Error('Rust read-model indexer binary not found')
  const output = execFileSync(binaryPath, {
    input: JSON.stringify({
      version: readModelContractVersion,
      candidates,
    }),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: INDEXER_TIMEOUT_MS,
  })
  const parsed: unknown = JSON.parse(output)
  return readModelIndexContractSchema.parse(parsed).entries
}

export function indexReadModelCandidatesWithTypeScript(
  candidates: readonly ReadModelCandidate[],
): ReadModelEntry[] {
  return candidates.map((candidate) => readModelEntrySchema.parse({
    kind: candidate.kind,
    entityId: candidate.entityId,
    revision: revisionForCandidate(candidate),
    payload: candidate.payload,
    updatedAt: candidate.updatedAt,
  }))
}

function collectWorkspaceSummaryCandidate(database: DatabaseSync): ReadModelCandidate {
  const row = z.object({
    projectCount: z.number(),
    hiddenProjectCount: z.number(),
    activeAgentCount: z.number(),
    archivedAgentCount: z.number(),
    scratchpadBlockCount: z.number(),
    totalMessages: z.number(),
    totalDiffs: z.number(),
    updatedAt: z.string(),
  }).parse(database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects WHERE hidden_at IS NULL) AS projectCount,
      (SELECT COUNT(*) FROM projects WHERE hidden_at IS NOT NULL) AS hiddenProjectCount,
      (SELECT COUNT(*) FROM agent_slots WHERE archived_at IS NULL) AS activeAgentCount,
      (SELECT COUNT(*) FROM agent_slots WHERE archived_at IS NOT NULL) AS archivedAgentCount,
      (SELECT COUNT(*) FROM scratchpad_blocks) AS scratchpadBlockCount,
      (SELECT COALESCE(SUM(message_count), 0) FROM threads WHERE active = 1) AS totalMessages,
      (SELECT COUNT(*) FROM diff_artifacts) AS totalDiffs,
      COALESCE(MAX(updated_at), '') AS updatedAt
    FROM threads
  `).get())

  return {
    kind: 'workspace.summary',
    entityId: 'workspace',
    payload: {
      projectCount: row.projectCount,
      hiddenProjectCount: row.hiddenProjectCount,
      activeAgentCount: row.activeAgentCount,
      archivedAgentCount: row.archivedAgentCount,
      scratchpadBlockCount: row.scratchpadBlockCount,
      totalMessages: row.totalMessages,
      totalDiffs: row.totalDiffs,
    },
    updatedAt: row.updatedAt || new Date(0).toISOString(),
  }
}

function collectAgentTimelineCandidates(database: DatabaseSync): ReadModelCandidate[] {
  return database.prepare(`
    WITH
      event_counts AS (
        SELECT thread_id, COUNT(*) AS event_count, MAX(timestamp) AS event_updated_at
        FROM timeline_events
        GROUP BY thread_id
      ),
      task_counts AS (
        SELECT thread_id, COUNT(*) AS task_count
        FROM agent_tasks
        GROUP BY thread_id
      ),
      diff_counts AS (
        SELECT agent_id, COUNT(*) AS diff_count
        FROM diff_artifacts
        GROUP BY agent_id
      ),
      message_latest AS (
        SELECT thread_id, MAX(timestamp) AS message_updated_at
        FROM messages
        GROUP BY thread_id
      )
    SELECT
      a.id AS agentId,
      t.id AS threadId,
      t.preview,
      t.message_count AS messageCount,
      t.updated_at AS updatedAt,
      COALESCE(event_counts.event_count, 0) AS eventCount,
      COALESCE(task_counts.task_count, 0) AS taskCount,
      COALESCE(diff_counts.diff_count, 0) AS diffCount,
      MAX(
        COALESCE(message_latest.message_updated_at, ''),
        COALESCE(event_counts.event_updated_at, ''),
        t.updated_at
      ) AS latestTimelineAt
    FROM agent_slots a
    INNER JOIN threads t ON t.agent_id = a.id AND t.active = 1
    LEFT JOIN event_counts ON event_counts.thread_id = t.id
    LEFT JOIN task_counts ON task_counts.thread_id = t.id
    LEFT JOIN diff_counts ON diff_counts.agent_id = a.id
    LEFT JOIN message_latest ON message_latest.thread_id = t.id
    ORDER BY a.position ASC, a.id ASC
  `).all().map((row) => {
    const parsed = z.object({
      agentId: z.string(),
      threadId: z.string(),
      preview: z.string(),
      messageCount: z.number(),
      updatedAt: z.string(),
      eventCount: z.number(),
      taskCount: z.number(),
      diffCount: z.number(),
      latestTimelineAt: z.string(),
    }).parse(row)
    return {
      kind: 'agent.timeline.summary' as const,
      entityId: parsed.agentId,
      payload: {
        agentId: parsed.agentId,
        threadId: parsed.threadId,
        preview: parsed.preview,
        messageCount: parsed.messageCount,
        eventCount: parsed.eventCount,
        taskCount: parsed.taskCount,
        diffCount: parsed.diffCount,
        latestTimelineAt: parsed.latestTimelineAt,
      },
      updatedAt: parsed.updatedAt,
    }
  })
}

function collectDiffSummaryCandidates(database: DatabaseSync): ReadModelCandidate[] {
  return database.prepare(`
    SELECT
      id,
      agent_id AS agentId,
      title,
      path,
      updated_at AS updatedAt
    FROM diff_artifacts
    ORDER BY updated_at DESC, id ASC
  `).all().map((row) => {
    const parsed = z.object({
      id: z.string(),
      agentId: z.string(),
      title: z.string(),
      path: z.string(),
      updatedAt: z.string(),
    }).parse(row)
    return {
      kind: 'diff.summary' as const,
      entityId: parsed.id,
      payload: {
        id: parsed.id,
        agentId: parsed.agentId,
        title: parsed.title,
        path: parsed.path,
      },
      updatedAt: parsed.updatedAt,
    }
  })
}

function replaceReadModelEntries(
  database: DatabaseSync,
  entries: readonly ReadModelEntry[],
) {
  const insert = database.prepare(`
    INSERT INTO read_model_entries (kind, entity_id, revision, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  database.exec('BEGIN')
  try {
    database.prepare('DELETE FROM read_model_entries').run()
    for (const entry of entries) {
      insert.run(
        entry.kind,
        entry.entityId,
        entry.revision,
        stableStringify(entry.payload),
        entry.updatedAt,
      )
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function shouldUseRustIndexer(env: NodeJS.ProcessEnv, hasInjectedRustIndexer: boolean) {
  const mode = env.KIRI_READ_MODEL_INDEXER?.trim().toLowerCase()
  if (mode === 'typescript' || mode === 'ts') return false
  if (mode === 'rust') return true
  return hasInjectedRustIndexer
    || rustReadModelIndexerBinaryPath(env, { requireExisting: true }) !== null
}

function rustReadModelIndexerBinaryPath(
  env: NodeJS.ProcessEnv,
  options: { readonly requireExisting: boolean },
) {
  const explicit = env.KIRI_READ_MODEL_INDEXER_BIN?.trim()
  if (explicit) return explicit

  const binaryName = process.platform === 'win32'
    ? 'kiri-read-model-indexer.exe'
    : 'kiri-read-model-indexer'
  const resourcesPath = stringValue((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath)
  const candidates = [
    ...(resourcesPath ? [resolve(resourcesPath, 'bin', binaryName)] : []),
    resolve(process.cwd(), 'dist', 'bin', binaryName),
    resolve(process.cwd(), 'target', 'release', binaryName),
    resolve(process.cwd(), 'target', 'debug', binaryName),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  return options.requireExisting ? null : candidates[0]
}

function revisionForCandidate(candidate: ReadModelCandidate) {
  let hash = FNV_OFFSET_BASIS
  hash = updateFnvHash(hash, candidate.kind)
  hash = updateFnvHash(hash, '\0')
  hash = updateFnvHash(hash, candidate.entityId)
  hash = updateFnvHash(hash, '\0')
  hash = updateFnvHash(hash, stableStringify(candidate.payload))
  return hash.toString(16).padStart(16, '0')
}

function updateFnvHash(hash: bigint, value: string) {
  let next = hash
  for (const byte of Buffer.from(value)) {
    next ^= BigInt(byte)
    next = (next * FNV_PRIME) & FNV_MASK
  }
  return next
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(object[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function parsePayload(payloadJson: string) {
  const payload: unknown = JSON.parse(payloadJson)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Read-model payload must be a JSON object')
  }
  return payload as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
