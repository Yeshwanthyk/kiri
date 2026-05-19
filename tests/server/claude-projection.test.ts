import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { hydrateClaudeSession } from '~/server/claude-projection'
import { claudeProjectKey, claudeTerminalSessionId } from '~/server/terminal-launch'
import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import { getAgentRuntimeState, setAgentRuntimeState } from '../../src/server/db/runtime-state'
import { insertSessionRow } from '../../src/server/db/sessions'

type Fixture = {
  readonly root: string
  readonly database: DatabaseSync
  readonly cwd: string
  readonly agentId: string
  readonly threadId: string
  readonly claudeHome: string
  readonly sessionId: string
}

function createFixture(runtime: 'claude' | 'codex' = 'claude'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'kiri-claude-projection-'))
  const cwd = join(root, 'project')
  const claudeHome = join(root, 'claude-home')
  mkdirSync(cwd)
  mkdirSync(claudeHome)
  const database = openKiriDatabase(join(root, 'kiri.sqlite'))
  const projectId = insertProject(database, { name: 'Project One', cwd })
  const agentId = insertSessionRow(database, {
    projectId,
    runtime,
    interfaceMode: runtime === 'claude' ? 'terminal' : 'gui',
    model: `${runtime}-model`,
    sessionDirForSlot: (slot) => join(root, 'sessions', slot),
    now: () => '2026-01-01T00:00:00.000Z',
    slotTimestampMs: () => 10,
    slotSuffix: () => 'aaaaaa',
  })
  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(agentId) as { id: string }
  const sessionId = claudeTerminalSessionId(agentId)
  return { root, database, cwd, agentId, threadId: thread.id, claudeHome, sessionId }
}

function closeFixture(fixture: Fixture) {
  fixture.database.close()
  rmSync(fixture.root, { recursive: true, force: true })
}

function writeClaudeJsonl(fixture: Fixture, content: string) {
  const projectDir = join(fixture.claudeHome, '.claude', 'projects', claudeProjectKey(fixture.cwd))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${fixture.sessionId}.jsonl`), content)
}

function assistantLine(uuid: string, text: string, timestamp: string) {
  return `${JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  })}\n`
}

describe('hydrateClaudeSession', () => {
  it('projects Claude JSONL into the active thread and persists both cursor fields', () => {
    const fixture = createFixture()
    vi.stubEnv('KIRI_CLAUDE_HOME', fixture.claudeHome)
    try {
      const first = assistantLine('uuid-1', 'First answer', '2026-01-02T00:00:01.000Z')
      const second = assistantLine('uuid-2', 'Second answer', '2026-01-02T00:00:02.000Z')
      writeClaudeJsonl(fixture, first)

      expect(hydrateClaudeSession(fixture.database, fixture.agentId)).toBe(true)
      expect(fixture.database
        .prepare('SELECT id, role, text, timestamp FROM messages WHERE thread_id = ?')
        .all(fixture.threadId)).toEqual([{
        id: `claude:${fixture.sessionId}:uuid-1`,
        role: 'assistant',
        text: 'First answer',
        timestamp: '2026-01-02T00:00:01.000Z',
      }])
      expect(getAgentRuntimeState(fixture.database, fixture.agentId)).toMatchObject({
        claudeLastSeenUuid: 'uuid-1',
        claudeLastSeenOffset: Buffer.byteLength(first),
      })

      writeClaudeJsonl(fixture, `${first}${second}`)
      expect(hydrateClaudeSession(fixture.database, fixture.agentId)).toBe(true)

      expect(fixture.database
        .prepare('SELECT id, role, text, timestamp FROM messages WHERE thread_id = ? ORDER BY timestamp ASC')
        .all(fixture.threadId)).toEqual([
        {
          id: `claude:${fixture.sessionId}:uuid-1`,
          role: 'assistant',
          text: 'First answer',
          timestamp: '2026-01-02T00:00:01.000Z',
        },
        {
          id: `claude:${fixture.sessionId}:uuid-2`,
          role: 'assistant',
          text: 'Second answer',
          timestamp: '2026-01-02T00:00:02.000Z',
        },
      ])
      expect(getAgentRuntimeState(fixture.database, fixture.agentId)).toMatchObject({
        claudeLastSeenUuid: 'uuid-2',
        claudeLastSeenOffset: Buffer.byteLength(first) + Buffer.byteLength(second),
      })
    } finally {
      vi.unstubAllEnvs()
      closeFixture(fixture)
    }
  })

  it('preserves existing runtime state while adding Claude cursor state', () => {
    const fixture = createFixture()
    vi.stubEnv('KIRI_CLAUDE_HOME', fixture.claudeHome)
    try {
      setAgentRuntimeState(fixture.database, fixture.agentId, {
        pendingQuestion: { requestId: 'request-1', questions: [] },
      })
      const line = assistantLine('uuid-1', 'Answer', '2026-01-02T00:00:01.000Z')
      writeClaudeJsonl(fixture, line)

      hydrateClaudeSession(fixture.database, fixture.agentId)

      expect(getAgentRuntimeState(fixture.database, fixture.agentId)).toMatchObject({
        pendingQuestion: { requestId: 'request-1', questions: [] },
        claudeLastSeenUuid: 'uuid-1',
        claudeLastSeenOffset: Buffer.byteLength(line),
      })
    } finally {
      vi.unstubAllEnvs()
      closeFixture(fixture)
    }
  })

  it('uses UUID cursor fallback when the stored byte offset is stale', () => {
    const fixture = createFixture()
    vi.stubEnv('KIRI_CLAUDE_HOME', fixture.claudeHome)
    try {
      const first = assistantLine('uuid-1', 'First answer', '2026-01-02T00:00:01.000Z')
      const second = assistantLine('uuid-2', 'Second answer', '2026-01-02T00:00:02.000Z')
      setAgentRuntimeState(fixture.database, fixture.agentId, {
        claudeLastSeenUuid: 'uuid-1',
        claudeLastSeenOffset: 999_999,
      })
      writeClaudeJsonl(fixture, `${first}${second}`)

      hydrateClaudeSession(fixture.database, fixture.agentId)

      expect(fixture.database
        .prepare('SELECT id, role, text, timestamp FROM messages WHERE thread_id = ?')
        .all(fixture.threadId)).toEqual([{
        id: `claude:${fixture.sessionId}:uuid-2`,
        role: 'assistant',
        text: 'Second answer',
        timestamp: '2026-01-02T00:00:02.000Z',
      }])
      expect(getAgentRuntimeState(fixture.database, fixture.agentId)).toMatchObject({
        claudeLastSeenUuid: 'uuid-2',
        claudeLastSeenOffset: Buffer.byteLength(first) + Buffer.byteLength(second),
      })
    } finally {
      vi.unstubAllEnvs()
      closeFixture(fixture)
    }
  })

  it('uses UUID cursor fallback when a stale byte offset is still inside the rewritten file', () => {
    const fixture = createFixture()
    vi.stubEnv('KIRI_CLAUDE_HOME', fixture.claudeHome)
    try {
      const first = assistantLine('uuid-1', 'First answer', '2026-01-02T00:00:01.000Z')
      const second = assistantLine('uuid-2', 'Second answer after rewrite', '2026-01-02T00:00:02.000Z')
      setAgentRuntimeState(fixture.database, fixture.agentId, {
        claudeLastSeenUuid: 'old-uuid',
        claudeLastSeenOffset: Buffer.byteLength(first),
      })
      writeClaudeJsonl(fixture, `${first}${second}`)

      hydrateClaudeSession(fixture.database, fixture.agentId)

      expect(fixture.database
        .prepare('SELECT id, role, text, timestamp FROM messages WHERE thread_id = ? ORDER BY timestamp ASC')
        .all(fixture.threadId)).toEqual([])
      expect(getAgentRuntimeState(fixture.database, fixture.agentId)).toMatchObject({
        claudeLastSeenUuid: 'old-uuid',
        claudeLastSeenOffset: Buffer.byteLength(first),
      })
    } finally {
      vi.unstubAllEnvs()
      closeFixture(fixture)
    }
  })

  it('uses UUID cursor fallback when stale offset is not immediately after the saved UUID row', () => {
    const fixture = createFixture()
    vi.stubEnv('KIRI_CLAUDE_HOME', fixture.claudeHome)
    try {
      const first = assistantLine('uuid-1', 'First answer', '2026-01-02T00:00:01.000Z')
      const second = assistantLine('uuid-2', 'Second answer', '2026-01-02T00:00:02.000Z')
      const third = assistantLine('uuid-3', 'Third answer', '2026-01-02T00:00:03.000Z')
      setAgentRuntimeState(fixture.database, fixture.agentId, {
        claudeLastSeenUuid: 'uuid-1',
        claudeLastSeenOffset: Buffer.byteLength(first) + Buffer.byteLength(second),
      })
      writeClaudeJsonl(fixture, `${first}${second}${third}`)

      hydrateClaudeSession(fixture.database, fixture.agentId)

      expect(fixture.database
        .prepare('SELECT id, role, text, timestamp FROM messages WHERE thread_id = ? ORDER BY timestamp ASC')
        .all(fixture.threadId)).toEqual([
        {
          id: `claude:${fixture.sessionId}:uuid-2`,
          role: 'assistant',
          text: 'Second answer',
          timestamp: '2026-01-02T00:00:02.000Z',
        },
        {
          id: `claude:${fixture.sessionId}:uuid-3`,
          role: 'assistant',
          text: 'Third answer',
          timestamp: '2026-01-02T00:00:03.000Z',
        },
      ])
      expect(getAgentRuntimeState(fixture.database, fixture.agentId)).toMatchObject({
        claudeLastSeenUuid: 'uuid-3',
        claudeLastSeenOffset: Buffer.byteLength(first) + Buffer.byteLength(second) + Buffer.byteLength(third),
      })
    } finally {
      vi.unstubAllEnvs()
      closeFixture(fixture)
    }
  })

  it('does nothing for non-Claude agents', () => {
    const fixture = createFixture('codex')
    try {
      expect(hydrateClaudeSession(fixture.database, fixture.agentId)).toBe(false)
    } finally {
      closeFixture(fixture)
    }
  })
})
