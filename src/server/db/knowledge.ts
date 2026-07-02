import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

import type {
  KnowledgeAddInput,
  KnowledgeEntry,
  KnowledgeListInput,
  KnowledgeMarkSeenInput,
  KnowledgeSearchInput,
  KnowledgeUpdateInput,
} from '~/lib/contracts'

import {
  knowledgeEntryDbRowSchema,
} from './schema'

const jsonStringArraySchema = z.array(z.string())

export function searchKnowledgeEntries(
  database: DatabaseSync,
  input: KnowledgeSearchInput & { readonly projectId: string },
): KnowledgeEntry[] {
  const projectId = requireProjectId(input.projectId)
  const limit = Math.max(1, Math.min(input.limit, 50))
  const terms = searchTerms(input.query)

  return database
    .prepare(
      `
        SELECT
          id,
          project_id AS projectId,
          title,
          problem,
          answer,
          tags_json AS tagsJson,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_seen_at AS lastSeenAt,
          seen_count AS seenCount
        FROM knowledge_entries
        WHERE project_id = ?
        ORDER BY updated_at DESC, id DESC
      `,
    )
    .all(projectId)
    .map(entryFromRow)
    .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) =>
      right.score - left.score
        || compareDesc(right.entry.lastSeenAt ?? right.entry.updatedAt, left.entry.lastSeenAt ?? left.entry.updatedAt)
        || right.entry.seenCount - left.entry.seenCount)
    .slice(0, limit)
    .map(({ entry }) => entry)
}

export function listKnowledgeEntries(
  database: DatabaseSync,
  input: KnowledgeListInput = {},
): KnowledgeEntry[] {
  const projectId = input.projectId?.trim() || null
  if (projectId) assertProjectExists(database, projectId)
  return database
    .prepare(
      `
        SELECT
          id,
          project_id AS projectId,
          title,
          problem,
          answer,
          tags_json AS tagsJson,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_seen_at AS lastSeenAt,
          seen_count AS seenCount
        FROM knowledge_entries
        WHERE (? IS NULL OR project_id = ?)
        ORDER BY updated_at DESC, id DESC
      `,
    )
    .all(projectId, projectId)
    .map(entryFromRow)
}

export function addKnowledgeEntry(
  database: DatabaseSync,
  input: KnowledgeAddInput & { readonly projectId: string },
): KnowledgeEntry {
  const projectId = requireProjectId(input.projectId)
  assertProjectExists(database, projectId)
  const id = knowledgeId()
  const now = new Date().toISOString()
  database
    .prepare(
      `
        INSERT INTO knowledge_entries (
          id, project_id, title, problem, answer, tags_json,
          created_at, updated_at, last_seen_at, seen_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
      `,
    )
    .run(
      id,
      projectId,
      input.title,
      input.problem,
      input.answer,
      JSON.stringify(input.tags),
      now,
      now,
    )
  return requireKnowledgeEntry(database, id)
}

export function updateKnowledgeEntry(
  database: DatabaseSync,
  input: KnowledgeUpdateInput,
): KnowledgeEntry {
  const entry = requireKnowledgeEntry(database, input.id)
  const now = new Date().toISOString()
  database
    .prepare(
      `
        UPDATE knowledge_entries
        SET title = ?, problem = ?, answer = ?, tags_json = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .run(
      input.title,
      input.problem,
      input.answer,
      JSON.stringify(input.tags),
      now,
      entry.id,
    )
  return requireKnowledgeEntry(database, entry.id)
}

export function deleteKnowledgeEntry(database: DatabaseSync, id: string): KnowledgeEntry {
  const entry = requireKnowledgeEntry(database, id)
  database.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(entry.id)
  return entry
}

export function markKnowledgeEntrySeen(
  database: DatabaseSync,
  input: KnowledgeMarkSeenInput,
): KnowledgeEntry {
  const entry = requireKnowledgeEntry(database, input.id)
  const now = new Date().toISOString()
  database
    .prepare(
      `
        UPDATE knowledge_entries
        SET last_seen_at = ?, updated_at = ?, seen_count = seen_count + 1
        WHERE id = ?
      `,
    )
    .run(now, now, entry.id)
  return requireKnowledgeEntry(database, entry.id)
}

function requireKnowledgeEntry(database: DatabaseSync, id: string): KnowledgeEntry {
  const row = database
    .prepare(
      `
        SELECT
          id,
          project_id AS projectId,
          title,
          problem,
          answer,
          tags_json AS tagsJson,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_seen_at AS lastSeenAt,
          seen_count AS seenCount
        FROM knowledge_entries
        WHERE id = ?
      `,
    )
    .get(id.trim())
  if (!row) throw new Error(`Knowledge entry not found: ${id}`)
  return entryFromRow(row)
}

function entryFromRow(row: unknown): KnowledgeEntry {
  const parsed = knowledgeEntryDbRowSchema.parse(row)
  return {
    id: parsed.id,
    projectId: parsed.projectId,
    title: parsed.title,
    problem: parsed.problem,
    answer: parsed.answer,
    tags: parseStringArray(parsed.tagsJson),
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    lastSeenAt: parsed.lastSeenAt,
    seenCount: parsed.seenCount,
  }
}

function parseStringArray(value: string) {
  return jsonStringArraySchema.parse(JSON.parse(value))
}

function scoreEntry(entry: KnowledgeEntry, terms: readonly string[]) {
  const fields = [
    entry.title,
    entry.problem,
    entry.answer,
    ...entry.tags,
  ].map(normalizeSearchText)
  return terms.reduce((score, term) => {
    if (normalizeSearchText(entry.title).includes(term)) return score + 8
    if (entry.tags.map(normalizeSearchText).some((tag) => tag === term)) return score + 6
    return score + fields.filter((field) => field.includes(term)).length
  }, 0)
}

function searchTerms(value: string) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((term) => term.length >= 2)
    .slice(0, 40)
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function compareDesc(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function requireProjectId(projectId: string) {
  const value = projectId.trim()
  if (!value) throw new Error('Project id is required')
  return value
}

function assertProjectExists(database: DatabaseSync, projectId: string) {
  const project = database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)
}

function knowledgeId() {
  return `knowledge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
