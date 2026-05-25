import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openKiriDatabase } from '~/server/db/connection'
import { insertProject } from '~/server/db/projects'
import { insertSessionRow } from '~/server/db/sessions'
import {
  collectReadModelCandidates,
  indexReadModelCandidates,
  indexReadModelCandidatesWithRust,
  indexReadModelCandidatesWithTypeScript,
  listReadModelEntries,
  refreshReadModelEntries,
  refreshReadModelEntriesIfChanged,
} from '~/server/read-model-indexer'

describe('read-model indexer', () => {
  it('materializes workspace, agent timeline, and diff summary rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-read-model-db-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)
    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        title: 'Session',
        runtime: 'codex',
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
      database
        .prepare('INSERT INTO messages (id, thread_id, role, text, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('message-1', thread.id, 'assistant', 'Hello', '2026-01-01T00:00:01.000Z')
      database
        .prepare('UPDATE threads SET preview = ?, message_count = ?, updated_at = ? WHERE id = ?')
        .run('Hello', 1, '2026-01-01T00:00:01.000Z', thread.id)
      database
        .prepare(
          `
            INSERT INTO diff_artifacts (id, agent_id, title, path, patch, updated_at)
            VALUES ('diff-1', ?, 'Diff', 'src/app.ts', 'patch text', '2026-01-01T00:00:02.000Z')
          `,
        )
        .run(agentId)

      const entries = refreshReadModelEntries(database, {
        env: { KIRI_READ_MODEL_INDEXER: 'typescript' },
      })

      expect(entries.map((entry) => entry.kind)).toEqual([
        'workspace.summary',
        'agent.timeline.summary',
        'diff.summary',
      ])
      expect(listReadModelEntries(database).map((entry) => [entry.kind, entry.entityId]))
        .toEqual([
          ['agent.timeline.summary', agentId],
          ['diff.summary', 'diff-1'],
          ['workspace.summary', 'workspace'],
        ])
      expect(entries.find((entry) => entry.kind === 'agent.timeline.summary')?.payload)
        .toMatchObject({
          agentId,
          messageCount: 1,
          diffCount: 1,
        })
    } finally {
      database.close()
    }
  })

  it('uses injected Rust indexer output when requested', () => {
    const candidates = [{
      kind: 'workspace.summary' as const,
      entityId: 'workspace',
      payload: workspacePayload(),
      updatedAt: '2026-01-01T00:00:00.000Z',
    }]

    const entries = indexReadModelCandidates(candidates, {
      env: { KIRI_READ_MODEL_INDEXER: 'rust' },
      runRustIndexer: () => [{
        kind: 'workspace.summary',
        entityId: 'workspace',
        revision: 'rust-revision',
        payload: workspacePayload(),
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    })

    expect(entries[0]?.revision).toBe('rust-revision')
  })

  it('skips rewriting unchanged derived rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-read-model-skip-'))
    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const first = refreshReadModelEntriesIfChanged(database, {
        env: { KIRI_READ_MODEL_INDEXER: 'typescript' },
      })
      const second = refreshReadModelEntriesIfChanged(database, {
        env: { KIRI_READ_MODEL_INDEXER: 'typescript' },
      })

      expect(first.changed).toBe(true)
      expect(second.changed).toBe(false)
      expect(second.entries).toEqual(first.entries)
    } finally {
      database.close()
    }
  })

  it('keeps TypeScript fallback revisions byte-compatible with Rust', () => {
    const candidates = [{
      kind: 'agent.timeline.summary' as const,
      entityId: 'agent-1',
      payload: {
        agentId: 'agent-1',
        threadId: 'thread-1',
        preview: 'Hello',
        messageCount: 2,
        eventCount: 1,
        taskCount: 0,
        diffCount: 3,
        latestTimelineAt: '2026-01-01T00:00:02.000Z',
      },
      updatedAt: '2026-01-01T00:00:02.000Z',
    }]

    const entries = indexReadModelCandidatesWithTypeScript(candidates)

    expect(entries[0]?.revision).toBe('52c7bdc4091c3ecc')
  })

  it('passes stdin contract to the Rust indexer process path', () => {
    const bin = join(mkdtempSync(join(tmpdir(), 'kiri-read-model-indexer-bin-')), 'indexer')
    writeFileSync(
      bin,
      '#!/bin/sh\nnode -e "let input = \'\'; process.stdin.on(\'data\', c => input += c); process.stdin.on(\'end\', () => { const parsed = JSON.parse(input); process.stdout.write(JSON.stringify({ version: 1, entries: parsed.candidates.map(candidate => ({ ...candidate, revision: \'from-bin\' })) })) })"\n',
    )
    chmodSync(bin, 0o755)

    const entries = indexReadModelCandidatesWithRust([{
      kind: 'workspace.summary',
      entityId: 'workspace',
      payload: workspacePayload(),
      updatedAt: '2026-01-01T00:00:00.000Z',
    }], {
      KIRI_READ_MODEL_INDEXER_BIN: bin,
    })

    expect(entries[0]?.revision).toBe('from-bin')
  })

  it('collects stable candidate summaries from grouped counts', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-read-model-candidates-'))
    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const candidates = collectReadModelCandidates(database)

      expect(candidates).toEqual([expect.objectContaining({
        kind: 'workspace.summary',
        entityId: 'workspace',
      })])
    } finally {
      database.close()
    }
  })
})

function workspacePayload() {
  return {
    projectCount: 1,
    hiddenProjectCount: 0,
    activeAgentCount: 0,
    archivedAgentCount: 0,
    scratchpadBlockCount: 0,
    totalMessages: 0,
    totalDiffs: 0,
  }
}
