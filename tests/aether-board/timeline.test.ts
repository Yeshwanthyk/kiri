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
    tasks: [],
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

  it('keeps runtime tool calls grouped after the turn completes', () => {
    const rows = deriveAgentTimelineRows(
      agent({
        runtime: 'claude',
        timeline: [
          {
            type: 'message',
            id: 'message:u1',
            timestamp: now,
            message: message('u1', 'user', 'check it'),
          },
          {
            type: 'event',
            id: 'event:e1',
            timestamp: now,
            event: {
              id: 'e1',
              kind: 'claude_tool_completed',
              tone: 'tool',
              label: 'Read completed',
              detail: 'Read: src/app.ts',
              timestamp: now,
            },
          },
          {
            type: 'event',
            id: 'event:e2',
            timestamp: now,
            event: {
              id: 'e2',
              kind: 'claude_tool_completed',
              tone: 'tool',
              label: 'Bash completed',
              detail: 'Bash: pnpm test',
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
      }),
      '/repo',
    )

    expect(rows.map((row) => row.kind)).toEqual(['message', 'work', 'message'])
    expect(rows[1]).toMatchObject({
      kind: 'work',
      entries: [
        { kind: 'claude_tool_completed', label: 'Read completed', detail: 'Read: src/app.ts' },
        { kind: 'claude_tool_completed', label: 'Bash completed', detail: 'Bash: pnpm test' },
      ],
    })
    expect(rows[2]).toMatchObject({ kind: 'message', message: { text: 'done' } })
  })

  it('surfaces edited-file diffs inside grouped runtime work', () => {
    const rows = deriveAgentTimelineRows(
      agent({
        runtime: 'pi',
        timeline: [
          {
            type: 'message',
            id: 'message:u1',
            timestamp: now,
            message: message('u1', 'user', 'edit it'),
          },
          {
            type: 'event',
            id: 'event:e1',
            timestamp: now,
            event: {
              id: 'e1',
              kind: 'fileOperationCompleted',
              tone: 'tool',
              label: 'Edit',
              detail: 'edit',
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

  it('adds persisted diffs to the latest work row when no tool event names the file', () => {
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
              kind: 'tool_execution_start',
              tone: 'tool',
              label: 'Bash',
              detail: "Bash: git status --short",
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
      entries: [
        { kind: 'tool_execution_start', label: 'Ran command' },
        { kind: 'diff.artifact', label: 'Edited', path: 'src/app.ts', diff: { id: 'diff:src/app.ts' } },
      ],
    })
  })

  it('renders raw git diff command output as an inline diff', () => {
    const rows = deriveAgentTimelineRows(
      agent({
        timeline: [
          {
            type: 'message',
            id: 'message:u1',
            timestamp: now,
            message: message('u1', 'user', 'show diff'),
          },
          {
            type: 'message',
            id: 'message:t1',
            timestamp: now,
            message: message(
              't1',
              'tool',
              [
                'git diff',
                'diff --git a/src/app.ts b/src/app.ts',
                'index 111..222 100644',
                '--- a/src/app.ts',
                '+++ b/src/app.ts',
                '@@ -1 +1 @@',
                '-old',
                '+new',
              ].join('\n'),
            ),
          },
          {
            type: 'message',
            id: 'message:a1',
            timestamp: now,
            message: message('a1', 'assistant', 'done'),
          },
        ],
      }),
      '/repo',
    )

    expect(rows[1]).toMatchObject({
      kind: 'work',
      entries: [
        {
          kind: 'tool.message',
          label: 'git diff',
        },
        {
          kind: 'tool.message.diff',
          label: 'Diff',
          path: 'src/app.ts',
          diff: {
            id: 't1:patch:0',
            path: 'src/app.ts',
          },
        },
      ],
    })
  })

  it('folds interim assistant updates into runtime work', () => {
    const rows = deriveAgentTimelineRows(
      agent({
        timeline: [
          {
            type: 'message',
            id: 'message:u1',
            timestamp: now,
            message: message('u1', 'user', 'make it'),
          },
          {
            type: 'message',
            id: 'message:a1',
            timestamp: now,
            message: message('a1', 'assistant', 'I am checking the repo.'),
          },
          {
            type: 'message',
            id: 'message:t1',
            timestamp: now,
            message: message('t1', 'tool', 'pnpm test\nok'),
          },
          {
            type: 'message',
            id: 'message:a2',
            timestamp: now,
            message: message('a2', 'assistant', 'done'),
          },
        ],
      }),
      '/repo',
    )

    expect(rows.map((row) => row.kind)).toEqual(['message', 'work', 'message'])
    expect(rows[1]).toMatchObject({
      kind: 'work',
      entries: [
        { kind: 'assistant.status', label: 'Update', detail: 'I am checking the repo.' },
        { kind: 'tool.message', label: 'pnpm test' },
      ],
    })
    expect(rows[2]).toMatchObject({ kind: 'message', message: { text: 'done' } })
  })

  it('folds interim assistant updates for pi sessions without hiding the final reply', () => {
    const rows = deriveAgentTimelineRows(
      agent({
        runtime: 'pi',
        timeline: [
          {
            type: 'message',
            id: 'message:u1',
            timestamp: now,
            message: message('u1', 'user', 'make it'),
          },
          {
            type: 'message',
            id: 'message:a1',
            timestamp: now,
            message: message('a1', 'assistant', 'I am checking the repo.'),
          },
          {
            type: 'message',
            id: 'message:a2',
            timestamp: now,
            message: message('a2', 'assistant', 'done'),
          },
        ],
      }),
      '/repo',
    )

    expect(rows.map((row) => row.kind)).toEqual(['message', 'work', 'message'])
    expect(rows[1]).toMatchObject({
      kind: 'work',
      entries: [{ kind: 'assistant.status', label: 'Update', detail: 'I am checking the repo.' }],
    })
    expect(rows[2]).toMatchObject({ kind: 'message', message: { text: 'done' } })
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
    expect(summarizeWorkEntries(entries)).toBe('edited 1 file, ran 2 commands')
  })

  it('counts patch line changes without headers', () => {
    expect(diffLineStats('--- a/file\n+++ b/file\n-old\n+new\n+next')).toEqual({
      added: 2,
      deleted: 1,
    })
  })
})
