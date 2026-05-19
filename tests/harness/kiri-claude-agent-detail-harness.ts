import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tempRoot = mkdtempSync(join(tmpdir(), 'kiri-claude-detail-'))
const cwd = join(tempRoot, 'project')
const claudeHome = join(tempRoot, 'claude-home')
const agentId = 'claude-agent'
const threadId = 'thread-claude-agent'
const sessionId = '11111111-1111-5111-8111-111111111111'

const outputSchema = z.object({
  ok: z.literal(true),
  checked: z.array(z.string()),
  messages: z.array(z.object({
    id: z.string(),
    role: z.string(),
    text: z.string(),
    timestamp: z.string(),
  })),
  preview: z.string(),
  messageCount: z.number(),
  cursorUuid: z.string(),
  cursorOffset: z.number(),
})

try {
  mkdirSync(cwd, { recursive: true })
  process.env.KIRI_ROOT_DIR = tempRoot
  process.env.KIRI_DB_PATH = join(tempRoot, 'kiri.sqlite')
  process.env.KIRI_STATE_DIR = join(tempRoot, 'state')
  process.env.KIRI_SETTINGS_PATH = resolve(repoRoot, 'settings.json')
  process.env.KIRI_CLAUDE_HOME = claudeHome

  const [{ getDb }, { claudeProjectKey }, { makeKiriControl }, { runKiriOperation }] = await Promise.all([
    import('../../src/server/db'),
    import('../../src/server/terminal-launch'),
    import('../../src/server/kiri-control'),
    import('../../src/server/kiri-router'),
  ])
  const database = getDb()
  seedClaudeAgent(database)
  const firstLine = assistantLine('uuid-1', 'First Claude answer', '2026-01-02T00:00:01.000Z')
  const secondLine = assistantLine('uuid-2', 'Second Claude answer', '2026-01-02T00:00:02.000Z')
  const projectDir = join(claudeHome, '.claude', 'projects', claudeProjectKey(cwd))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${metadataLine()}${firstLine}${secondLine}`)

  const control = makeKiriControl()
  const response = await runKiriOperation(control, {
    operation: 'agent.detail',
    params: { agentId, limit: 50 },
  })
  if (!response.ok) throw new Error(response.error.message)
  const detail = z.object({
    messages: z.array(z.object({
      id: z.string(),
      role: z.string(),
      text: z.string(),
      timestamp: z.string(),
    })),
    preview: z.string(),
    messageCount: z.number(),
  }).parse(response.result)
  const runtimeState = database
    .prepare('SELECT runtime_state_json AS runtimeStateJson FROM agent_slots WHERE id = ?')
    .get(agentId) as { runtimeStateJson: string }
  const parsedState = z.object({
    claudeLastSeenUuid: z.string(),
    claudeLastSeenOffset: z.number(),
  }).parse(JSON.parse(runtimeState.runtimeStateJson))
  const messages = detail.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
  }))

  if (messages.length !== 2) throw new Error(`Expected 2 Claude messages, got ${messages.length}`)
  if (messages[0]?.text !== 'First Claude answer') throw new Error('First Claude message not parsed')
  if (messages[1]?.text !== 'Second Claude answer') throw new Error('Second Claude message not parsed')
  if (detail.preview !== 'Second Claude answer') throw new Error(`Expected Claude preview, got ${detail.preview}`)

  const output = outputSchema.parse({
    ok: true,
    checked: [
      'agent-detail-hydrates-claude-jsonl',
      'agent-detail-returns-parsed-claude-messages',
      'agent-detail-updates-thread-summary',
      'agent-detail-persists-claude-cursor',
    ],
    messages,
    preview: detail.preview,
    messageCount: detail.messageCount,
    cursorUuid: parsedState.claudeLastSeenUuid,
    cursorOffset: parsedState.claudeLastSeenOffset,
  })

  process.stdout.write(JSON.stringify(output, null, 2))
  process.stdout.write('\n')
  database.close()
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function seedClaudeAgent(database: ReturnType<typeof import('../../src/server/db')['getDb']>) {
  database.exec('BEGIN')
  try {
    database
      .prepare('INSERT INTO projects (id, name, cwd, position) VALUES (?, ?, ?, ?)')
      .run('claude-project', 'Claude Project', cwd, 0)
    database
      .prepare(
        `
          INSERT INTO agent_slots (
            id, project_id, slot, title, runtime, interface_mode, model, status,
            session_dir, session_file, runtime_state_json, position
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        agentId,
        'claude-project',
        'session-claude',
        'Claude Agent',
        'claude',
        'terminal',
        'claude-sonnet-4-5',
        'idle',
        tempRoot,
        null,
        JSON.stringify({ sessionId }),
        0,
      )
    database
      .prepare(
        'INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(threadId, agentId, 1, 'Ready.', 0, '2026-01-01T00:00:00.000Z')
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function metadataLine() {
  return `${JSON.stringify({ type: 'system', cwd })}\n`
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
