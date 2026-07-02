import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import {
  archiveSessionRow,
  hardDeleteSessionRow,
  insertSessionRow,
  listSessionSummaries,
  renameSessionRow,
  requireSessionSummary,
  restoreSessionRow,
} from '../../src/server/db/sessions'
import { upsertAgentContextUsage } from '../../src/server/db/runtime-state'
import { hydratePersistedPiSessionRows } from '../../src/server/db/session-operations'
import {
  recordRuntimeMessageRow,
  recordRuntimeTimelineEventRow,
} from '../../src/server/db/timeline-writes'

function piJsonl(userText: string, assistantText: string) {
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
      timestamp: '2026-01-02T00:00:01.000Z',
      message: { role: 'assistant', content: [{ text: assistantText }] },
    }),
  ].join('\n')
}

describe('session repository', () => {
  it('preserves session start, summary, archive, restore, and rename semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-sessions-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const firstId = insertSessionRow(database, {
        projectId,
        title: '  Build me  ',
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        thinkingLevel: 'high',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        now: () => '2026-01-01T00:00:00.000Z',
        slotTimestampMs: () => 10,
        slotSuffix: () => 'aaaaaa',
      })
      const secondId = insertSessionRow(database, {
        projectId,
        runtime: 'codex',
        interfaceMode: 'terminal',
        model: 'codex-model',
        thinkingLevel: 'medium',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        now: () => '2026-01-02T00:00:00.000Z',
        slotTimestampMs: () => 11,
        slotSuffix: () => 'bbbbbb',
      })

      expect(firstId).toBe(`${projectId}-session-a-aaaaaa`)
      expect(secondId).toBe(`${projectId}-session-b-bbbbbb`)
      expect(requireSessionSummary(database, firstId)).toEqual({
        id: firstId,
        projectId,
        projectName: 'Project One',
        title: 'Build me',
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        status: 'idle',
        preview: 'Ready.',
        messageCount: 0,
        updatedAt: '2026-01-01T00:00:00.000Z',
        archivedAt: null,
      })
      expect(
        database
          .prepare('SELECT session_dir AS sessionDir FROM agent_slots WHERE id = ?')
          .get(firstId),
      ).toEqual({ sessionDir: join(root, 'sessions', 'session-a-aaaaaa') })
      expect(listSessionSummaries(database, { projectId }).map((session) => session.id)).toEqual([
        secondId,
        firstId,
      ])
      expect(
        database
          .prepare(
            `
              SELECT e.kind, e.label, e.detail, e.payload_json AS payloadJson
              FROM timeline_events e
              INNER JOIN threads t ON t.id = e.thread_id
              WHERE t.agent_id = ?
            `,
          )
          .get(firstId),
      ).toMatchObject({
        kind: 'thinking_level',
        label: 'Thinking level changed',
        detail: 'high',
      })

      renameSessionRow(database, { agentId: firstId, title: '  Renamed  ' })
      expect(requireSessionSummary(database, firstId).title).toBe('Renamed')

      archiveSessionRow(database, firstId)
      expect(() => requireSessionSummary(database, firstId)).toThrow(
        `Session not found: ${firstId}`,
      )
      expect(requireSessionSummary(database, firstId, true).archivedAt).toEqual(expect.any(String))
      expect(listSessionSummaries(database, { projectId }).map((session) => session.id)).toEqual([
        secondId,
      ])
      expect(
        listSessionSummaries(database, { projectId, includeArchived: true })
          .map((session) => session.id),
      ).toEqual([secondId, firstId])

      restoreSessionRow(database, firstId)
      expect(requireSessionSummary(database, firstId).archivedAt).toBeNull()
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps validation errors at the repository boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-validation-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      database
        .prepare(
          `
            INSERT INTO agent_slots (
              id, project_id, slot, title, runtime, interface_mode, model, status,
              session_dir, session_file, runtime_state_json, archived_at, position
            )
            VALUES (
              'planner-1', ?, 'planner', 'Planner', 'pi', 'gui', 'test-model', 'idle',
              '/tmp/planner', NULL, NULL, NULL, 0
            )
          `,
        )
        .run(projectId)

      expect(() =>
        insertSessionRow(database, {
          projectId: 'missing-project',
          runtime: 'pi',
          interfaceMode: 'gui',
          model: 'test-model',
          sessionDirForSlot: (slot) => join(root, slot),
        }),
      ).toThrow('Project not found: missing-project')
      expect(() => requireSessionSummary(database, 'missing-session')).toThrow(
        'Session not found: missing-session',
      )
      expect(() => renameSessionRow(database, { agentId: 'planner-1', title: 'New' })).toThrow(
        'Only started sessions can be renamed',
      )
      expect(() => renameSessionRow(database, { agentId: 'planner-1', title: '   ' })).toThrow(
        'Session title cannot be empty',
      )
      expect(() => archiveSessionRow(database, 'planner-1')).toThrow(
        'Only started sessions can be removed',
      )
      expect(() => restoreSessionRow(database, 'planner-1')).toThrow(
        'Only started sessions can be restored',
      )
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rolls back partial session starts when thread creation fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-rollback-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      database.exec(`
        CREATE TEMP TRIGGER fail_session_thread_insert
        BEFORE INSERT ON threads
        BEGIN
          SELECT RAISE(ABORT, 'forced thread failure');
        END;
      `)

      expect(() =>
        insertSessionRow(database, {
          projectId,
          runtime: 'pi',
          interfaceMode: 'gui',
          model: 'test-model',
          thinkingLevel: 'medium',
          sessionDirForSlot: (slot) => join(root, slot),
          slotTimestampMs: () => 12,
          slotSuffix: () => 'cccccc',
        }),
      ).toThrow('forced thread failure')
      expect(database.prepare('SELECT COUNT(*) AS count FROM agent_slots').get()).toEqual({
        count: 0,
      })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rolls back archive failures and compacts session positions on success', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-archive-rollback-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const firstId = insertSessionRow(database, {
        projectId,
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, slot),
        slotTimestampMs: () => 13,
        slotSuffix: () => 'aaaaaa',
      })
      const secondId = insertSessionRow(database, {
        projectId,
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, slot),
        slotTimestampMs: () => 14,
        slotSuffix: () => 'bbbbbb',
      })
      const thirdId = insertSessionRow(database, {
        projectId,
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, slot),
        slotTimestampMs: () => 15,
        slotSuffix: () => 'cccccc',
      })
      database
        .prepare(
          `
            UPDATE agent_slots
            SET position = CASE id
              WHEN ? THEN 10
              WHEN ? THEN 20
              WHEN ? THEN 30
            END
            WHERE id IN (?, ?, ?)
          `,
        )
        .run(firstId, secondId, thirdId, firstId, secondId, thirdId)
      const before = sessionPositions(database)
      database.exec(`
        CREATE TEMP TRIGGER fail_archive_position_update
        BEFORE UPDATE OF position ON agent_slots
        WHEN OLD.id = '${secondId}'
        BEGIN
          SELECT RAISE(ABORT, 'forced archive compaction failure');
        END;
      `)

      expect(() => archiveSessionRow(database, firstId)).toThrow(
        'forced archive compaction failure',
      )
      expect(sessionPositions(database)).toEqual(before)

      database.exec('DROP TRIGGER fail_archive_position_update')
      archiveSessionRow(database, firstId)
      const archivedRows = sessionPositions(database)
      expect(typeof archivedRows[0]?.archivedAt).toBe('string')
      expect(archivedRows).toEqual([
        { id: firstId, archivedAt: archivedRows[0]?.archivedAt, position: 0 },
        { id: secondId, archivedAt: null, position: 1 },
        { id: thirdId, archivedAt: null, position: 2 },
      ])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps archived state unchanged when restore fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-restore-rollback-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, slot),
        slotTimestampMs: () => 16,
        slotSuffix: () => 'aaaaaa',
      })
      archiveSessionRow(database, agentId)
      const archived = sessionPositions(database)
      database.exec(`
        CREATE TEMP TRIGGER fail_restore_update
        AFTER UPDATE OF archived_at ON agent_slots
        WHEN OLD.id = '${agentId}' AND NEW.archived_at IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'forced restore failure');
        END;
      `)

      expect(() => restoreSessionRow(database, agentId)).toThrow('forced restore failure')
      expect(sessionPositions(database)).toEqual(archived)
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires sessions to be archived before hard-delete', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-hard-delete-gate-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
      })

      expect(() => hardDeleteSessionRow(database, agentId)).toThrow(
        `Session must be archived before hard-delete: ${agentId}`,
      )
      expect(database.prepare('SELECT id FROM agent_slots WHERE id = ?').get(agentId)).toEqual({
        id: agentId,
      })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hard-deletes archived sessions, tombstones the slot, and removes the session directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-session-hard-delete-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, 'pi-sessions', projectId, slot),
        slotTimestampMs: () => 17,
        slotSuffix: () => 'aaaaaa',
      })
      const slot = 'session-h-aaaaaa'
      const sessionDir = join(root, 'pi-sessions', projectId, slot)
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'session.jsonl'), piJsonl('Deleted', 'Should not return'))
      recordRuntimeMessageRow(database, {
        agentId,
        id: 'message-1',
        role: 'assistant',
        text: 'Persisted answer',
      })
      recordRuntimeTimelineEventRow(database, {
        agentId,
        kind: 'tool',
        tone: 'tool',
        label: 'Ran command',
      })
      upsertAgentContextUsage(database, { agentId, usedTokens: 10 })
      archiveSessionRow(database, agentId)

      expect(hardDeleteSessionRow(database, agentId)).toBe(agentId)

      expect(database.prepare('SELECT id FROM agent_slots WHERE id = ?').get(agentId)).toBeUndefined()
      expect(database.prepare('SELECT COUNT(*) AS count FROM threads WHERE agent_id = ?').get(agentId))
        .toEqual({ count: 0 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM timeline_events').get()).toEqual({ count: 0 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM agent_context_usage WHERE agent_id = ?').get(agentId))
        .toEqual({ count: 0 })
      expect(
        database
          .prepare('SELECT project_id AS projectId, slot FROM deleted_sessions WHERE project_id = ? AND slot = ?')
          .get(projectId, slot),
      ).toEqual({ projectId, slot })
      expect(existsSync(sessionDir)).toBe(false)

      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'session.jsonl'), piJsonl('Deleted', 'Should not return'))
      hydratePersistedPiSessionRows(database, {
        piSessionsDir: join(root, 'pi-sessions'),
        defaultModel: 'test-model',
      })
      expect(database.prepare('SELECT id FROM agent_slots WHERE id = ?').get(agentId)).toBeUndefined()
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function sessionPositions(database: ReturnType<typeof openKiriDatabase>) {
  return database
    .prepare('SELECT id, archived_at AS archivedAt, position FROM agent_slots ORDER BY position ASC, id ASC')
    .all() as Array<{ id: string; archivedAt: string | null; position: number }>
}
