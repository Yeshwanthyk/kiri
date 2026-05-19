import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { PiSessionProjection } from '../../src/server/pi-jsonl'

import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import { insertSessionRow } from '../../src/server/db/sessions'
import {
  appendUserMessageRow,
  recordRuntimeMessages,
  recordPiLiveMessages,
  recordPiProjectionMessages,
  replaceAgentDiffArtifactsRows,
} from '../../src/server/db/timeline-writes'

type DbFixture = {
  readonly root: string
  readonly database: DatabaseSync
  readonly agentId: string
  readonly threadId: string
}

function createFixture(): DbFixture {
  const root = mkdtempSync(join(tmpdir(), 'kiri-db-timeline-writes-'))
  const cwd = join(root, 'project')
  mkdirSync(cwd)

  const database = openKiriDatabase(join(root, 'kiri.sqlite'))
  const projectId = insertProject(database, { name: 'Project One', cwd })
  const agentId = insertSessionRow(database, {
    projectId,
    runtime: 'pi',
    interfaceMode: 'gui',
    model: 'test-model',
    sessionDirForSlot: (slot) => join(root, 'sessions', slot),
    now: () => '2026-01-01T00:00:00.000Z',
    slotTimestampMs: () => 10,
    slotSuffix: () => 'aaaaaa',
  })
  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(agentId) as { id: string }

  return { root, database, agentId, threadId: thread.id }
}

function closeFixture(fixture: DbFixture) {
  fixture.database.close()
  rmSync(fixture.root, { recursive: true, force: true })
}

function readMessages(database: DatabaseSync, threadId: string) {
  return database
    .prepare(
      `
        SELECT id, role, text, timestamp
        FROM messages
        WHERE thread_id = ?
        ORDER BY timestamp ASC, id ASC
      `,
    )
    .all(threadId) as Array<{
      id: string
      role: string
      text: string
      timestamp: string
    }>
}

describe('timeline write repository', () => {
  it('persists the current Pi live turn without duplicating the submitted prompt', () => {
    const fixture = createFixture()
    try {
      recordPiLiveMessages(fixture.database, {
        agentId: fixture.agentId,
        promptText: 'Ship it',
        turnStartedAt: 1_700_000_000_000,
        turnCompletedAt: 1_700_000_005_000,
        sessionFile: '/tmp/pi-live.jsonl',
        messages: [
          { role: 'assistant', content: 'Previous turn' },
          { role: 'user', content: 'Ship it' },
          { role: 'assistant', content: [{ text: 'Done now' }] },
          { role: 'toolResult', content: [{ text: 'tool output' }] },
        ],
      })

      expect(readMessages(fixture.database, fixture.threadId)).toMatchObject([
        {
          role: 'tool',
          text: 'tool output',
          timestamp: '2023-11-14T22:13:20.002Z',
        },
        {
          role: 'assistant',
          text: 'Done now',
          timestamp: '2023-11-14T22:13:25.001Z',
        },
      ])
      expect(
        fixture.database
          .prepare(
            'SELECT preview, message_count AS messageCount FROM threads WHERE id = ?',
          )
          .get(fixture.threadId),
      ).toEqual({ preview: 'Done now', messageCount: 2 })
      expect(
        fixture.database
          .prepare('SELECT session_file AS sessionFile FROM agent_slots WHERE id = ?')
          .get(fixture.agentId),
      ).toEqual({ sessionFile: '/tmp/pi-live.jsonl' })
    } finally {
      closeFixture(fixture)
    }
  })

  it('replaces transient prompt rows with projected JSONL messages, tasks, and context usage', () => {
    const fixture = createFixture()
    try {
      appendUserMessageRow(fixture.database, {
        agentId: fixture.agentId,
        text: 'Summarize this',
      })

      const projection: PiSessionProjection = {
        preview: 'Projected answer',
        updatedAt: '2026-01-02T00:00:02.000Z',
        contextUsedTokens: 123,
        tasks: [{
          id: 'task-1',
          title: 'Write summary',
          status: 'completed',
          source: 'pi',
          updatedAt: '2026-01-02T00:00:03.000Z',
        }],
        messages: [
          {
            id: 'jsonl-user-1',
            role: 'user',
            text: 'Summarize this',
            timestamp: '2026-01-02T00:00:00.000Z',
          },
          {
            id: 'jsonl-assistant-1',
            role: 'assistant',
            text: 'Projected answer',
            timestamp: '2026-01-02T00:00:01.000Z',
          },
        ],
      }

      recordPiProjectionMessages(fixture.database, {
        agentId: fixture.agentId,
        promptText: 'Summarize this',
        sessionFile: '/tmp/pi-projected.jsonl',
        projection,
      })

      expect(readMessages(fixture.database, fixture.threadId)).toEqual([
        {
          id: `pi-jsonl-${fixture.agentId}-jsonl-user-1`,
          role: 'user',
          text: 'Summarize this',
          timestamp: '2026-01-02T00:00:00.000Z',
        },
        {
          id: `pi-jsonl-${fixture.agentId}-jsonl-assistant-1`,
          role: 'assistant',
          text: 'Projected answer',
          timestamp: '2026-01-02T00:00:01.000Z',
        },
      ])
      expect(
        fixture.database
          .prepare(
            `
              SELECT task_id AS id, title, status, source, updated_at AS updatedAt
              FROM agent_tasks
              WHERE thread_id = ?
            `,
          )
          .get(fixture.threadId),
      ).toEqual({
        id: 'task-1',
        title: 'Write summary',
        status: 'completed',
        source: 'pi',
        updatedAt: '2026-01-02T00:00:03.000Z',
      })
      expect(
        fixture.database
          .prepare(
            `
              SELECT used_tokens AS usedTokens, session_file AS sessionFile
              FROM agent_context_usage
              WHERE agent_id = ?
            `,
          )
          .get(fixture.agentId),
      ).toEqual({ usedTokens: 123, sessionFile: '/tmp/pi-projected.jsonl' })
    } finally {
      closeFixture(fixture)
    }
  })

  it('replaces diff artifacts instead of appending stale patches', () => {
    const fixture = createFixture()
    try {
      replaceAgentDiffArtifactsRows(fixture.database, {
        agentId: fixture.agentId,
        diffs: [
          { title: 'Old', path: 'src/old.ts', patch: 'old patch' },
          { title: 'Also old', path: 'src/also-old.ts', patch: 'old patch 2' },
        ],
      })
      replaceAgentDiffArtifactsRows(fixture.database, {
        agentId: fixture.agentId,
        diffs: [
          { title: 'New', path: 'src/new.ts', patch: 'new patch' },
        ],
      })

      expect(
        fixture.database
          .prepare(
            `
              SELECT title, path, patch
              FROM diff_artifacts
              WHERE agent_id = ?
              ORDER BY path ASC
            `,
          )
          .all(fixture.agentId),
      ).toEqual([{ title: 'New', path: 'src/new.ts', patch: 'new patch' }])
    } finally {
      closeFixture(fixture)
    }
  })

  it('rolls back diff replacement when a later insert fails', () => {
    const fixture = createFixture()
    try {
      replaceAgentDiffArtifactsRows(fixture.database, {
        agentId: fixture.agentId,
        diffs: [
          { title: 'Old', path: 'src/old.ts', patch: 'old patch' },
        ],
      })
      fixture.database.exec(`
        CREATE TEMP TRIGGER fail_diff_insert
        BEFORE INSERT ON diff_artifacts
        WHEN NEW.path = 'src/fail.ts'
        BEGIN
          SELECT RAISE(ABORT, 'forced diff insert failure');
        END;
      `)

      expect(() => replaceAgentDiffArtifactsRows(fixture.database, {
        agentId: fixture.agentId,
        diffs: [
          { title: 'New', path: 'src/new.ts', patch: 'new patch' },
          { title: 'Fail', path: 'src/fail.ts', patch: 'fail patch' },
        ],
      })).toThrow('forced diff insert failure')

      expect(
        fixture.database
          .prepare(
            `
              SELECT title, path, patch
              FROM diff_artifacts
              WHERE agent_id = ?
              ORDER BY path ASC
            `,
          )
          .all(fixture.agentId),
      ).toEqual([{ title: 'Old', path: 'src/old.ts', patch: 'old patch' }])
    } finally {
      closeFixture(fixture)
    }
  })

  it('records runtime projection messages idempotently and updates the thread summary', () => {
    const fixture = createFixture()
    try {
      recordRuntimeMessages(fixture.database, {
        agentId: fixture.agentId,
        sessionFile: '/tmp/claude.jsonl',
        messages: [
          {
            id: 'claude:session-1:assistant-1',
            role: 'assistant',
            text: 'First answer',
            timestamp: '2026-01-02T00:00:01.000Z',
          },
          {
            id: 'claude:session-1:user-1',
            role: 'user',
            text: 'Human prompt',
            timestamp: '2026-01-02T00:00:02.000Z',
          },
        ],
      })
      recordRuntimeMessages(fixture.database, {
        agentId: fixture.agentId,
        sessionFile: '/tmp/claude.jsonl',
        messages: [
          {
            id: 'claude:session-1:assistant-1',
            role: 'assistant',
            text: 'First answer edited',
            timestamp: '2026-01-02T00:00:03.000Z',
          },
        ],
      })

      expect(readMessages(fixture.database, fixture.threadId)).toEqual([
        {
          id: 'claude:session-1:user-1',
          role: 'user',
          text: 'Human prompt',
          timestamp: '2026-01-02T00:00:02.000Z',
        },
        {
          id: 'claude:session-1:assistant-1',
          role: 'assistant',
          text: 'First answer edited',
          timestamp: '2026-01-02T00:00:03.000Z',
        },
      ])
      expect(
        fixture.database
          .prepare(
            'SELECT preview, message_count AS messageCount FROM threads WHERE id = ?',
          )
          .get(fixture.threadId),
      ).toEqual({ preview: 'First answer edited', messageCount: 2 })
      expect(
        fixture.database
          .prepare('SELECT session_file AS sessionFile FROM agent_slots WHERE id = ?')
          .get(fixture.agentId),
      ).toEqual({ sessionFile: '/tmp/claude.jsonl' })
    } finally {
      closeFixture(fixture)
    }
  })
})
