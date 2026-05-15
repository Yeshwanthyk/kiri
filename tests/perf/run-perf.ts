import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tempRoot = mkdtempSync(join(tmpdir(), 'kiri-perf-'))
const agentId = 'perf-agent'
const threadId = 'perf-thread'
const totalMessages = 1_500
const eventsPerMessage = 3
const totalTimelineRows = totalMessages * (eventsPerMessage + 1)
const requestedLimit = 500
const totalDiffs = 80

const perfOutputSchema = z.object({
  ok: z.literal(true),
  storedTimelineRows: z.number(),
  returnedTimelineRows: z.number(),
  returnedMessages: z.number(),
  returnedEvents: z.number(),
  returnedDiffs: z.number(),
  detailJsonBytes: z.number(),
  snapshotJsonBytes: z.number(),
  snapshotMs: z.number(),
  detailMs: z.number(),
  rssDeltaMb: z.number(),
  budgets: z.object({
    maxReturnedTimelineRows: z.number(),
    maxReturnedDiffs: z.number(),
    maxDetailJsonBytes: z.number(),
    maxSnapshotMs: z.number(),
    maxDetailMs: z.number(),
    maxRssDeltaMb: z.number(),
  }),
})

const budgets = {
  maxReturnedTimelineRows: requestedLimit,
  maxReturnedDiffs: 50,
  maxDetailJsonBytes: 1_800_000,
  maxSnapshotMs: 100,
  maxDetailMs: 350,
  maxRssDeltaMb: 64,
}

try {
  process.env.KIRI_ROOT_DIR = tempRoot
  process.env.KIRI_DB_PATH = join(tempRoot, 'kiri.sqlite')
  process.env.KIRI_STATE_DIR = join(tempRoot, 'state')
  process.env.KIRI_SETTINGS_PATH = resolve(repoRoot, 'settings.json')
  process.env.KIRI_PI_SESSIONS_DIR = join(tempRoot, 'pi-sessions')
  process.env.KIRI_RUNTIME_SESSIONS_DIR = join(tempRoot, 'runtime-sessions')

  const { getAgentDetail, getDb, getWorkspaceSnapshot } = await import('../../src/server/db')
  const database = getDb()
  seedPerfHistory(database)

  const beforeRss = process.memoryUsage().rss
  const snapshotStart = performance.now()
  const snapshot = getWorkspaceSnapshot()
  const snapshotMs = performance.now() - snapshotStart

  const detailStart = performance.now()
  const detail = getAgentDetail({ agentId, limit: requestedLimit })
  const detailMs = performance.now() - detailStart
  const afterRss = process.memoryUsage().rss

  const output = perfOutputSchema.parse({
    ok: true,
    storedTimelineRows: totalTimelineRows,
    returnedTimelineRows: detail.timeline.length,
    returnedMessages: detail.messages.length,
    returnedEvents: detail.timelineEvents.length,
    returnedDiffs: detail.diffs.length,
    detailJsonBytes: Buffer.byteLength(JSON.stringify(detail)),
    snapshotJsonBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    snapshotMs: round(snapshotMs),
    detailMs: round(detailMs),
    rssDeltaMb: round((afterRss - beforeRss) / 1024 / 1024),
    budgets,
  })

  assertBudget(output.returnedTimelineRows <= budgets.maxReturnedTimelineRows, 'timeline rows', output)
  assertBudget(output.returnedDiffs <= budgets.maxReturnedDiffs, 'diff rows', output)
  assertBudget(output.detailJsonBytes <= budgets.maxDetailJsonBytes, 'detail payload bytes', output)
  assertBudget(output.snapshotMs <= budgets.maxSnapshotMs, 'snapshot latency', output)
  assertBudget(output.detailMs <= budgets.maxDetailMs, 'detail latency', output)
  assertBudget(output.rssDeltaMb <= budgets.maxRssDeltaMb, 'rss delta', output)

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  database.close()
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function seedPerfHistory(database: ReturnType<typeof import('../../src/server/db')['getDb']>) {
  database.exec('BEGIN')
  try {
    database
      .prepare('INSERT INTO projects (id, name, cwd, position) VALUES (?, ?, ?, ?)')
      .run('perf-project', 'Perf Project', repoRoot, 0)
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
        'perf-project',
        'session-perf',
        'Perf Agent',
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
      .run(threadId, agentId, 1, 'message 1499', totalMessages, timestampFor(totalMessages - 1, 0))

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
    const insertDiff = database.prepare(
      'INSERT INTO diff_artifacts (id, agent_id, title, path, patch, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )

    for (let index = 0; index < totalMessages; index += 1) {
      insertMessage.run(
        `message-${index}`,
        threadId,
        index % 2 === 0 ? 'user' : 'assistant',
        `message ${index} ${'x'.repeat(80)}`,
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

    const patch = makePatch()
    for (let index = 0; index < totalDiffs; index += 1) {
      insertDiff.run(
        `perf-diff-${index}`,
        agentId,
        `src/perf-${index}.ts`,
        `src/perf-${index}.ts`,
        patch,
        timestampFor(totalMessages - 1, index),
      )
    }

    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function makePatch() {
  const lines = [
    'diff --git a/src/perf.ts b/src/perf.ts',
    'index 1111111..2222222 100644',
    '--- a/src/perf.ts',
    '+++ b/src/perf.ts',
    '@@ -1,3 +1,3 @@',
  ]
  for (let index = 0; index < 96; index += 1) {
    lines.push(`-old ${index} ${'a'.repeat(80)}`)
    lines.push(`+new ${index} ${'b'.repeat(80)}`)
  }
  return lines.join('\n')
}

function timestampFor(index: number, offset: number) {
  return new Date(Date.UTC(2026, 4, 12, 12, 0, 0) + index * 2_000 + offset).toISOString()
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function assertBudget(condition: boolean, label: string, output: unknown) {
  if (!condition) {
    throw new Error(`Perf budget exceeded: ${label}\n${JSON.stringify(output, null, 2)}`)
  }
}
