import { describe, expect, it } from 'vitest'
import type { AgentCell, BoardMessage, DiffArtifact } from '~/lib/contracts'
import {
  compactWorkEntries,
  deriveAgentTimelineRows,
  diffLineStats,
  normalizeTimelinePath,
  summarizeWorkEntries,
} from '~/components/aether-board/timeline'

const now = '2026-05-11T12:00:00.000Z'

function message(id: string, role: BoardMessage['role'], text: string): BoardMessage {
  return { id, role, text, timestamp: now }
}

function agent(overrides: Partial<AgentCell>): AgentCell {
  return {
    id: 'agent-1',
    projectId: 'project-1',
    slot: 'session-1',
    title: 'Agent',
    runtime: 'codex',
    model: 'gpt-5.5',
    status: 'idle',
    sessionDir: '/tmp/session',
    sessionFile: null,
    preview: '',
    messageCount: 0,
    diffCount: 0,
    contextUsage: null,
    pendingQuestion: null,
    updatedAt: now,
    isSession: true,
    messages: [],
    timelineEvents: [],
    timeline: [],
    diffs: [],
    ...overrides,
  }
}

function diff(path: string): DiffArtifact {
  return {
    id: `diff:${path}`,
    title: path,
    path,
    patch: '--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new\n context',
    updatedAt: now,
  }
}

describe('deriveAgentTimelineRows', () => {
  it('falls back to messages when projected timeline is empty', () => {
    const rows = deriveAgentTimelineRows(
      agent({
        messages: [
          message('u1', 'user', 'hello'),
          message('a1', 'assistant', 'hi'),
        ],
      }),
      '/repo',
    )

    expect(rows.map((row) => row.kind)).toEqual(['message', 'message'])
    expect(rows[0]).toMatchObject({ id: 'message:u1' })
  })

  it('groups runtime work before the next chat message and attaches matching diffs', () => {
    const rows = deriveAgentTimelineRows(
      agent({
        timeline: [
          {
            type: 'message',
            id: 'message:u1',
            timestamp: now,
            message: message('u1', 'user', 'change it'),
          },
          {
            type: 'event',
            id: 'event:e1',
            timestamp: now,
            event: {
              id: 'e1',
              kind: 'fileOperationCompleted',
              tone: 'tool',
              label: 'Write',
              detail: 'write',
              path: '/repo/src/app.ts',
              timestamp: now,
            },
          },
          {
            type: 'message',
            id: 'message:a1',
            timestamp: now,
            message: message('a1', 'assistant', 'done'),
          },
        ],
        diffs: [diff('src/app.ts')],
      }),
      '/repo',
    )

    expect(rows.map((row) => row.kind)).toEqual(['message', 'work', 'message'])
    expect(rows[1]).toMatchObject({
      kind: 'work',
      entries: [{ label: 'Edited', path: 'src/app.ts', diff: { id: 'diff:src/app.ts' } }],
    })
  })

  it('adds a working row for running agents', () => {
    const rows = deriveAgentTimelineRows(
      agent({ status: 'running', messages: [message('u1', 'user', 'go')] }),
      '/repo',
    )

    expect(rows.at(-1)).toEqual({
      kind: 'working',
      id: 'working-indicator',
      startedAt: now,
    })
  })
})

describe('timeline helpers', () => {
  it('normalizes absolute paths relative to cwd', () => {
    expect(normalizeTimelinePath('"/repo/src/app.ts"', '/repo')).toBe('src/app.ts')
    expect(normalizeTimelinePath('/other/src/app.ts', '/repo')).toBe('/other/src/app.ts')
  })

  it('compacts repeated entries and summarizes work', () => {
    const entries = compactWorkEntries([
      {
        id: '1',
        kind: 'tool.message',
        tone: 'tool',
        label: 'Bash',
        detail: 'pnpm test',
        timestamp: now,
      },
      {
        id: '2',
        kind: 'tool.message',
        tone: 'tool',
        label: 'Bash',
        detail: 'pnpm test',
        timestamp: now,
      },
      {
        id: '3',
        kind: 'fileOperationCompleted',
        tone: 'tool',
        label: 'Edited',
        detail: 'write',
        diff: diff('src/app.ts'),
        timestamp: now,
      },
    ])

    expect(entries).toHaveLength(2)
    expect(entries[0]?.count).toBe(2)
    expect(summarizeWorkEntries(entries)).toBe('edited 1 file, ran 1 command')
  })

  it('counts patch line changes without headers', () => {
    expect(diffLineStats('--- a/file\n+++ b/file\n-old\n+new\n+next')).toEqual({
      added: 2,
      deleted: 1,
    })
  })
})
