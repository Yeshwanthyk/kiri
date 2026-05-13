import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tempRoot = mkdtempSync(join(tmpdir(), 'kiri-detail-history-'))
const agentId = 'history-agent'
const threadId = 'history-thread'
const totalRows = 620
const requestedLimit = 500
const eventsPerMessage = 3

const harnessOutputSchema = z.object({
  ok: z.literal(true),
  checked: z.array(z.string()),
  messages: z.number(),
  events: z.number(),
  timeline: z.number(),
  firstMessageId: z.string(),
  lastMessageId: z.string(),
})

try {
  process.env.KIRI_ROOT_DIR = tempRoot
  process.env.KIRI_DB_PATH = join(tempRoot, 'kiri.sqlite')
  process.env.KIRI_STATE_DIR = join(tempRoot, 'state')
  process.env.KIRI_SETTINGS_PATH = resolve(repoRoot, 'settings.json')

  const [{ getAgentDetail, getDb }, { deriveAgentTimelineRows }] = await Promise.all([
    import('../../src/server/db'),
    import('../../src/components/kiri-board/timeline'),
  ])

  const database = getDb()
  seedHistory(database)

  const detail = getAgentDetail({ agentId, limit: requestedLimit })
  const messageItems = detail.timeline.filter((item) => item.type === 'message')
  const eventItems = detail.timeline.filter((item) => item.type === 'event')

  if (detail.messages.length !== totalRows) {
    throw new Error(`Expected ${totalRows} messages, got ${detail.messages.length}`)
  }
  if (messageItems.length !== totalRows) {
    throw new Error(`Expected ${totalRows} message timeline items, got ${messageItems.length}`)
  }
  if (eventItems.length !== totalRows * eventsPerMessage) {
    throw new Error(
      `Expected ${totalRows * eventsPerMessage} event timeline items, got ${eventItems.length}`,
    )
  }
  if (detail.messages[0]?.id !== 'message-0') {
    throw new Error(`Expected oldest returned message-0, got ${detail.messages[0]?.id ?? 'none'}`)
  }
  if (detail.messages.at(-1)?.id !== 'message-619') {
    throw new Error(`Expected newest returned message-619, got ${detail.messages.at(-1)?.id ?? 'none'}`)
  }

  const rows = deriveAgentTimelineRows(detail, repoRoot)
  const workEntries = rows.flatMap((row) => row.kind === 'work' ? row.entries : [])
  if (!workEntries.some((entry) => entry.id === 'diff:history-diff')) {
    throw new Error('Expected unmatched persisted diff to appear in the chat work timeline')
  }

  const output = harnessOutputSchema.parse({
    ok: true,
    checked: [
      'agent-detail-preserves-500-messages',
      'agent-detail-loads-all-messages',
      'agent-detail-keeps-runtime-events-for-the-message-window',
      'timeline-no-longer-slices-messages-out',
      'unmatched-diff-appears-in-work-row',
    ],
    messages: detail.messages.length,
    events: eventItems.length,
    timeline: detail.timeline.length,
    firstMessageId: detail.messages[0]?.id ?? '',
    lastMessageId: detail.messages.at(-1)?.id ?? '',
  })

  process.stdout.write(JSON.stringify(output, null, 2))
  process.stdout.write('\n')
  database.close()
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function seedHistory(database: ReturnType<typeof import('../../src/server/db')['getDb']>) {
  database.exec('BEGIN')
  try {
    database
      .prepare('INSERT INTO projects (id, name, cwd, position) VALUES (?, ?, ?, ?)')
      .run('history-project', 'History Project', repoRoot, 0)
    database
      .prepare(
        `
          INSERT INTO agent_slots (
            id, project_id, slot, title, runtime, model, status,
            session_dir, session_file, position
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        agentId,
        'history-project',
        'session-history',
        'History Agent',
        'pi',
        'openai-codex/gpt-5.5',
        'idle',
        repoRoot,
        null,
        0,
      )
    database
      .prepare(
        'INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(threadId, agentId, 1, 'message 619', totalRows, timestampFor(totalRows - 1, 0))

    const insertMessage = database.prepare(
      'INSERT INTO messages (id, thread_id, role, text, timestamp) VALUES (?, ?, ?, ?, ?)',
    )
    const insertEvent = database.prepare(
      `
        INSERT INTO timeline_events (
          id, thread_id, kind, tone, label, detail, timestamp, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )

    for (let index = 0; index < totalRows; index += 1) {
      insertMessage.run(
        `message-${index}`,
        threadId,
        index % 2 === 0 ? 'user' : 'assistant',
        `message ${index}`,
        timestampFor(index, 0),
      )
      for (let eventIndex = 0; eventIndex < eventsPerMessage; eventIndex += 1) {
        insertEvent.run(
          `event-${index}-${eventIndex}`,
          threadId,
          'tool_execution_start',
          'tool',
          'Ran command',
          `echo ${index}-${eventIndex}`,
          timestampFor(index, eventIndex + 1),
          JSON.stringify({
            type: 'tool_execution_start',
            toolName: 'bash',
            args: { command: `echo ${index}-${eventIndex}` },
          }),
        )
      }
    }

    database
      .prepare(
        'INSERT INTO diff_artifacts (id, agent_id, title, path, patch, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        'history-diff',
        agentId,
        'src/history.ts',
        'src/history.ts',
        [
          'diff --git a/src/history.ts b/src/history.ts',
          'index 1111111..2222222 100644',
          '--- a/src/history.ts',
          '+++ b/src/history.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
        ].join('\n'),
        timestampFor(totalRows - 1, 2),
      )

    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function timestampFor(index: number, offset: number) {
  return new Date(Date.UTC(2026, 4, 12, 12, 0, 0) + index * 2_000 + offset).toISOString()
}
