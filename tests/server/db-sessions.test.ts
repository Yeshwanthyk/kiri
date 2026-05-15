import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import {
  archiveSessionRow,
  insertSessionRow,
  listSessionSummaries,
  renameSessionRow,
  requireSessionSummary,
  restoreSessionRow,
} from '../../src/server/db/sessions'

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
})
