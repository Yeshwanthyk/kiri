import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import { archiveSessionRow, insertSessionRow, restoreSessionRow } from '../../src/server/db/sessions'
import {
  clearPiHydrationStamps,
  createForkedSessionRow,
  hydratePersistedPiSessionRows,
  resetSessionRows,
} from '../../src/server/db/session-operations'
import {
  recordRuntimeMessageRow,
  recordRuntimeTimelineEventRow,
  replaceAgentTasksRows,
} from '../../src/server/db/timeline-writes'
import { upsertAgentContextUsage } from '../../src/server/db/runtime-state'

function piJsonl(userText: string, assistantText: string, updatedAt = '2026-01-02T00:00:01.000Z') {
  return [
    JSON.stringify({
      type: 'message',
      id: 'user-1',
      timestamp: '2026-01-02T00:00:00.000Z',
      message: { role: 'user', content: userText },
    }),
    JSON.stringify({
      type: 'message',
      id: 'assistant-1',
      timestamp: updatedAt,
      message: {
        role: 'assistant',
        content: [{ text: assistantText }],
        usage: { totalTokens: 77 },
      },
    }),
  ].join('\n')
}

describe('session operations repository', () => {
  beforeEach(() => {
    clearPiHydrationStamps()
  })

  afterEach(() => {
    clearPiHydrationStamps()
  })

  it('resets all persisted session detail state', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-reset-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        runtime: 'codex',
        interfaceMode: 'gui',
        model: 'codex-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
      })
      recordRuntimeMessageRow(database, {
        agentId,
        id: 'message-1',
        role: 'assistant',
        text: 'Done',
        timestamp: '2026-01-01T00:00:00.000Z',
      })
      recordRuntimeTimelineEventRow(database, {
        agentId,
        kind: 'tool',
        tone: 'tool',
        label: 'Ran command',
      })
      replaceAgentTasksRows(database, {
        agentId,
        source: 'codex',
        tasks: [{
          id: 'task-1',
          title: 'Task',
          status: 'inProgress',
          source: 'codex',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      })
      upsertAgentContextUsage(database, { agentId, usedTokens: 20 })
      database
        .prepare("UPDATE agent_slots SET status = 'running', session_file = ? WHERE id = ?")
        .run('/tmp/session.jsonl', agentId)

      resetSessionRows(database, agentId)

      const thread = database
        .prepare('SELECT id, preview, message_count AS messageCount FROM threads WHERE agent_id = ?')
        .get(agentId) as { id: string; preview: string; messageCount: number }
      expect(thread).toMatchObject({ preview: 'Ready.', messageCount: 0 })
      for (const table of ['messages', 'timeline_events', 'agent_tasks'] as const) {
        expect(
          database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE thread_id = ?`).get(thread.id),
        ).toEqual({ count: 0 })
      }
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM agent_context_usage WHERE agent_id = ?').get(agentId),
      ).toEqual({ count: 0 })
      expect(
        database.prepare('SELECT status, session_file AS sessionFile FROM agent_slots WHERE id = ?').get(agentId),
      ).toEqual({ status: 'idle', sessionFile: null })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('copies and hydrates forked Pi session files', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-fork-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const sourceAgentId = insertSessionRow(database, {
        projectId,
        title: 'Source',
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
      })
      const sourceFile = join(root, 'source.jsonl')
      writeFileSync(sourceFile, piJsonl('Fork me', 'Forked answer'))

      const forkedAgentId = createForkedSessionRow(database, {
        sourceAgentId,
        sessionFile: sourceFile,
        sessionDirForProjectSlot: (id, slot) => join(root, 'pi-sessions', id, slot),
        now: () => '2026-01-03T00:00:00.000Z',
        slotTimestampMs: () => 12,
        slotSuffix: () => 'cccccc',
      })

      expect(forkedAgentId).toBe(`${projectId}-session-c-cccccc`)
      const fork = database
        .prepare('SELECT title, session_file AS sessionFile FROM agent_slots WHERE id = ?')
        .get(forkedAgentId) as { title: string; sessionFile: string }
      expect(fork.title).toBe('Source fork')
      expect(fork.sessionFile).toBe(join(root, 'pi-sessions', projectId, 'session-c-cccccc', 'source.jsonl'))
      expect(
        database
          .prepare(
            `
              SELECT m.role, m.text
              FROM messages m
              INNER JOIN threads t ON t.id = m.thread_id
              WHERE t.agent_id = ?
              ORDER BY m.timestamp ASC
            `,
          )
          .all(forkedAgentId),
      ).toEqual([
        { role: 'user', text: 'Fork me' },
        { role: 'assistant', text: 'Forked answer' },
      ])
      expect(
        database
          .prepare('SELECT used_tokens AS usedTokens FROM agent_context_usage WHERE agent_id = ?')
          .get(forkedAgentId),
      ).toEqual({ usedTokens: 77 })

      const secondForkId = createForkedSessionRow(database, {
        sourceAgentId: forkedAgentId,
        sessionFile: fork.sessionFile,
        sessionDirForProjectSlot: (id, slot) => join(root, 'pi-sessions', id, slot),
        now: () => '2026-01-04T00:00:00.000Z',
        slotTimestampMs: () => 13,
        slotSuffix: () => 'dddddd',
      })
      expect(
        database
          .prepare('SELECT title FROM agent_slots WHERE id = ?')
          .get(secondForkId),
      ).toEqual({ title: 'Source fork' })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('auto-retitles fresh sessions from first assistant message and in-progress task', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-auto-title-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const messageAgentId = insertSessionRow(database, {
        projectId,
        runtime: 'codex',
        interfaceMode: 'gui',
        model: 'codex-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        slotTimestampMs: () => 20,
        slotSuffix: () => 'aaaaaa',
      })
      recordRuntimeMessageRow(database, {
        agentId: messageAgentId,
        id: 'assistant-1',
        role: 'assistant',
        text: 'Implement the deterministic title refresh path with plenty of detail',
        timestamp: '2026-01-01T00:00:00.000Z',
      })
      expect(
        database.prepare('SELECT title FROM agent_slots WHERE id = ?').get(messageAgentId),
      ).toEqual({ title: 'Implement the deterministic title refresh...' })

      const taskAgentId = insertSessionRow(database, {
        projectId,
        runtime: 'claude',
        interfaceMode: 'terminal',
        model: 'claude-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        slotTimestampMs: () => 21,
        slotSuffix: () => 'bbbbbb',
      })
      replaceAgentTasksRows(database, {
        agentId: taskAgentId,
        source: 'claude',
        tasks: [{
          id: 'task-1',
          title: 'Wire Claude TodoWrite projection',
          status: 'inProgress',
          source: 'claude',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      })
      expect(
        database.prepare('SELECT title FROM agent_slots WHERE id = ?').get(taskAgentId),
      ).toEqual({ title: 'Wire Claude TodoWrite projection' })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not auto-retitle manually renamed sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-manual-title-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        title: 'Pinned title',
        runtime: 'codex',
        interfaceMode: 'gui',
        model: 'codex-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
      })
      recordRuntimeMessageRow(database, {
        agentId,
        id: 'assistant-1',
        role: 'assistant',
        text: 'Should not replace the title',
        timestamp: '2026-01-01T00:00:00.000Z',
      })
      expect(database.prepare('SELECT title FROM agent_slots WHERE id = ?').get(agentId))
        .toEqual({ title: 'Pinned title' })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hydrates persisted Pi sessions and skips deleted slots', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-hydrate-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const keepSlot = 'session-a-aaaaaa'
      const deletedSlot = 'session-b-bbbbbb'
      const keepDir = join(root, 'pi-sessions', projectId, keepSlot)
      const deletedDir = join(root, 'pi-sessions', projectId, deletedSlot)
      mkdirSync(keepDir, { recursive: true })
      mkdirSync(deletedDir, { recursive: true })
      writeFileSync(join(keepDir, 'keep.jsonl'), piJsonl('Resume me', 'Hydrated answer'))
      writeFileSync(join(deletedDir, 'deleted.jsonl'), piJsonl('Deleted', 'Should not hydrate'))
      database
        .prepare('INSERT INTO deleted_sessions (project_id, slot, deleted_at) VALUES (?, ?, ?)')
        .run(projectId, deletedSlot, '2026-01-01T00:00:00.000Z')

      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
      })

      expect(
        database.prepare('SELECT id, title, model FROM agent_slots ORDER BY id ASC').all(),
      ).toEqual([{
        id: `${projectId}-${keepSlot}`,
        title: 'Resume me',
        model: 'test-model',
      }])
      expect(
        database
          .prepare(
            `
              SELECT m.role, m.text
              FROM messages m
              INNER JOIN threads t ON t.id = m.thread_id
              WHERE t.agent_id = ?
              ORDER BY m.timestamp ASC
            `,
          )
          .all(`${projectId}-${keepSlot}`),
      ).toEqual([
        { role: 'user', text: 'Resume me' },
        { role: 'assistant', text: 'Hydrated answer' },
      ])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hydrates only the requested Pi agent when scoped by agent id', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-hydrate-scoped-'))
    const firstCwd = join(root, 'project-one')
    const secondCwd = join(root, 'project-two')
    mkdirSync(firstCwd)
    mkdirSync(secondCwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const firstProjectId = insertProject(database, { name: 'Project One', cwd: firstCwd })
      const secondProjectId = insertProject(database, { name: 'Project Two', cwd: secondCwd })
      const agentId = insertSessionRow(database, {
        projectId: firstProjectId,
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, 'pi-sessions', firstProjectId, slot),
        slotTimestampMs: () => 10,
        slotSuffix: () => 'aaaaaa',
      })
      const firstSessionFile = join(root, 'pi-sessions', firstProjectId, 'session-a-aaaaaa', 'first.jsonl')
      mkdirSync(join(root, 'pi-sessions', firstProjectId, 'session-a-aaaaaa'), { recursive: true })
      writeFileSync(firstSessionFile, piJsonl('Scoped', 'Hydrated scoped answer'))
      const otherSlot = 'session-b-bbbbbb'
      const otherDir = join(root, 'pi-sessions', secondProjectId, otherSlot)
      mkdirSync(otherDir, { recursive: true })
      writeFileSync(join(otherDir, 'other.jsonl'), piJsonl('Other', 'Should not hydrate'))

      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
        onlyAgentId: agentId,
      })

      expect(
        database
          .prepare(
            `
              SELECT m.text
              FROM messages m
              INNER JOIN threads t ON t.id = m.thread_id
              WHERE t.agent_id = ? AND m.role = 'assistant'
            `,
          )
          .get(agentId),
      ).toEqual({ text: 'Hydrated scoped answer' })
      expect(
        database.prepare('SELECT id FROM agent_slots WHERE id = ?').get(`${secondProjectId}-${otherSlot}`),
      ).toBeUndefined()
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips persisted Pi hydration when the session file is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-hydrate-cache-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const slot = 'session-a-aaaaaa'
      const sessionDir = join(root, 'pi-sessions', projectId, slot)
      const agentId = `${projectId}-${slot}`
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'session.jsonl'), piJsonl('Resume me', 'Hydrated answer'))

      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
      })
      const thread = database
        .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
        .get(agentId) as { id: string }
      database
        .prepare('INSERT INTO messages (id, thread_id, role, text, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('sentinel-message', thread.id, 'assistant', 'keep me', '2026-01-02T00:00:02.000Z')

      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
      })

      expect(
        database.prepare('SELECT text FROM messages WHERE id = ?').get('sentinel-message'),
      ).toEqual({ text: 'keep me' })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('forgets Pi hydration stamps when a session is archived', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-hydrate-archive-forget-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const slot = 'session-a-aaaaaa'
      const sessionDir = join(root, 'pi-sessions', projectId, slot)
      const agentId = `${projectId}-${slot}`
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'session.jsonl'), piJsonl('Resume me', 'Hydrated answer'))

      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
      })
      const thread = database
        .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
        .get(agentId) as { id: string }
      database
        .prepare('INSERT INTO messages (id, thread_id, role, text, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('sentinel-message', thread.id, 'assistant', 'delete me', '2026-01-02T00:00:02.000Z')

      archiveSessionRow(database, agentId)
      restoreSessionRow(database, agentId)
      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
        onlyAgentId: agentId,
      })

      expect(database.prepare('SELECT text FROM messages WHERE id = ?').get('sentinel-message'))
        .toBeUndefined()
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the cached project slot list when the project session root is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-hydrate-root-cache-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const projectSessionRoot = join(root, 'pi-sessions', projectId)
      const firstSlot = 'session-a-aaaaaa'
      const firstDir = join(projectSessionRoot, firstSlot)
      const cachedRootTimeSeconds = 1_700_000_000
      mkdirSync(firstDir, { recursive: true })
      writeFileSync(join(firstDir, 'first.jsonl'), piJsonl('First', 'First answer'))
      utimesSync(projectSessionRoot, cachedRootTimeSeconds, cachedRootTimeSeconds)

      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
      })

      const secondSlot = 'session-b-bbbbbb'
      const secondDir = join(projectSessionRoot, secondSlot)
      mkdirSync(secondDir, { recursive: true })
      writeFileSync(join(secondDir, 'second.jsonl'), piJsonl('Second', 'Should wait'))
      utimesSync(projectSessionRoot, cachedRootTimeSeconds, cachedRootTimeSeconds)

      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
      })

      expect(
        database.prepare('SELECT id FROM agent_slots WHERE id = ?').get(`${projectId}-${secondSlot}`),
      ).toBeUndefined()
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rehydrates persisted Pi sessions when the session file changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-hydrate-change-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const slot = 'session-a-aaaaaa'
      const sessionDir = join(root, 'pi-sessions', projectId, slot)
      const sessionFile = join(sessionDir, 'session.jsonl')
      const agentId = `${projectId}-${slot}`
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(sessionFile, piJsonl('Resume me', 'Hydrated answer'))

      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
      })
      const thread = database
        .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
        .get(agentId) as { id: string }
      database
        .prepare('INSERT INTO messages (id, thread_id, role, text, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('sentinel-message', thread.id, 'assistant', 'delete me', '2026-01-02T00:00:02.000Z')
      appendFileSync(sessionFile, `\n${JSON.stringify({
        type: 'message',
        id: 'assistant-2',
        timestamp: '2026-01-02T00:00:03.000Z',
        message: {
          role: 'assistant',
          content: [{ text: 'Fresh answer' }],
          usage: { totalTokens: 88 },
        },
      })}\n`)

      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
      })

      expect(
        database.prepare('SELECT text FROM messages WHERE id = ?').get('sentinel-message'),
      ).toBeUndefined()
      expect(
        database
          .prepare('SELECT text FROM messages WHERE id = ?')
          .get(`pi-jsonl-${agentId}-assistant-2`),
      ).toEqual({ text: 'Fresh answer' })
      expect(
        database
          .prepare('SELECT used_tokens AS usedTokens FROM agent_context_usage WHERE agent_id = ?')
          .get(agentId),
      ).toEqual({ usedTokens: 88 })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
