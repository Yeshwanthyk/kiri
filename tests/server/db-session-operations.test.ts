import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import { insertSessionRow } from '../../src/server/db/sessions'
import {
  createForkedSessionRow,
  hydratePersistedPiSessionRows,
  resetSessionRows,
} from '../../src/server/db/session-operations'
import {
  recordRuntimeMessageRow,
  recordRuntimeTimelineEventRow,
  replaceAgentDiffArtifactsRows,
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
      replaceAgentDiffArtifactsRows(database, {
        agentId,
        diffs: [{ title: 'Diff', path: 'src/file.ts', patch: 'patch' }],
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
        database.prepare('SELECT COUNT(*) AS count FROM diff_artifacts WHERE agent_id = ?').get(agentId),
      ).toEqual({ count: 0 })
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
})
