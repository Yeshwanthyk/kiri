import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { WorkspaceSnapshot } from '~/lib/contracts'
import { workspaceSnapshotSchema } from '~/lib/contracts'

const dbPath = join(process.cwd(), '.pican', 'pican.sqlite')

let db: DatabaseSync | undefined

export function getDb() {
  if (db) return db
  mkdirSync(dirname(dbPath), { recursive: true })
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  seed(db)
  return db
}

export function getWorkspaceSnapshot(): WorkspaceSnapshot {
  const database = getDb()
  const projects = database
    .prepare(
      `
        SELECT id, name, cwd, position
        FROM projects
        ORDER BY position ASC
      `,
    )
    .all() as Array<{
    id: string
    name: string
    cwd: string
    position: number
  }>

  const agents = database
    .prepare(
      `
        SELECT
          a.id,
          a.project_id AS projectId,
          a.slot,
          a.title,
          a.runtime,
          a.model,
          a.status,
          a.session_dir AS sessionDir,
          a.session_file AS sessionFile,
          a.position,
          t.id AS threadId,
          t.preview,
          t.message_count AS messageCount,
          t.updated_at AS updatedAt,
          (
            SELECT COUNT(*)
            FROM diff_artifacts d
            WHERE d.agent_id = a.id
          ) AS diffCount
        FROM agent_slots a
        LEFT JOIN threads t ON t.agent_id = a.id AND t.active = 1
        ORDER BY a.position ASC
      `,
    )
    .all() as Array<{
    id: string
    projectId: string
    slot: string
    title: string
    runtime: 'pi'
    model: string
    status: 'idle' | 'running' | 'queued' | 'blocked' | 'failed'
    sessionDir: string
    sessionFile: string | null
    position: number
    preview: string | null
    messageCount: number | null
    updatedAt: string | null
    diffCount: number
    threadId: string | null
  }>

  const messages = database
    .prepare(
      `
        SELECT m.id, t.agent_id AS agentId, m.role, m.text, m.timestamp
        FROM messages m
        INNER JOIN threads t ON t.id = m.thread_id
        WHERE t.active = 1
        ORDER BY timestamp ASC, id ASC
      `,
    )
    .all() as Array<{
    id: string
    agentId: string
    role: 'user' | 'assistant' | 'tool' | 'system' | 'summary'
    text: string
    timestamp: string
  }>

  const diffs = database
    .prepare(
      `
        SELECT id, agent_id AS agentId, title, path, patch, updated_at AS updatedAt
        FROM diff_artifacts
        ORDER BY updated_at DESC
      `,
    )
    .all() as Array<{
    id: string
    agentId: string
    title: string
    path: string
    patch: string
    updatedAt: string
  }>

  const messagesByAgent = groupBy(messages, (message) => message.agentId)
  const diffsByAgent = groupBy(diffs, (diff) => diff.agentId)
  const agentsByProject = groupBy(agents, (agent) => agent.projectId)

  const snapshot = {
    projects: projects.map((project) => ({
      ...project,
      agents: (agentsByProject.get(project.id) ?? []).map((agent) => ({
        id: agent.id,
        projectId: agent.projectId,
        slot: agent.slot,
        title: agent.title,
        runtime: agent.runtime,
        model: agent.model,
        status: agent.status,
        sessionDir: agent.sessionDir,
        sessionFile: agent.sessionFile,
        preview: agent.preview ?? 'No messages yet',
        messageCount: agent.messageCount ?? 0,
        diffCount: agent.diffCount,
        updatedAt: agent.updatedAt ?? new Date(0).toISOString(),
        messages: (messagesByAgent.get(agent.id) ?? []).map(
          ({ agentId: _agentId, ...message }) => message,
        ),
        diffs: (diffsByAgent.get(agent.id) ?? []).map(
          ({ agentId: _agentId, ...diff }) => diff,
        ),
      })),
    })),
    selected: {
      projectId: projects[0]?.id ?? '',
      agentId: agents[0]?.id ?? '',
    },
  }

  return workspaceSnapshotSchema.parse(snapshot)
}

function migrate(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_slots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      title TEXT NOT NULL,
      runtime TEXT NOT NULL CHECK (runtime = 'pi'),
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'queued', 'blocked', 'failed')),
      session_dir TEXT NOT NULL,
      session_file TEXT,
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
      active INTEGER NOT NULL DEFAULT 1,
      preview TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_thread_per_agent
      ON threads(agent_id)
      WHERE active = 1;

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system', 'summary')),
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS diff_artifacts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      patch TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function groupBy<T, K extends string>(
  items: T[],
  getKey: (item: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = getKey(item)
    const group = groups.get(key)
    if (group) {
      group.push(item)
    } else {
      groups.set(key, [item])
    }
  }
  return groups
}

function seed(database: DatabaseSync) {
  const count = database
    .prepare('SELECT COUNT(*) AS count FROM projects')
    .get() as { count: number }
  if (count.count > 0) return

  const now = new Date().toISOString()
  const root = process.cwd()

  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, cwd, position)
    VALUES (?, ?, ?, ?)
  `)
  const insertAgent = database.prepare(`
    INSERT INTO agent_slots (
      id, project_id, slot, title, runtime, model, status, session_dir, session_file, position
    )
    VALUES (?, ?, ?, ?, 'pi', ?, ?, ?, NULL, ?)
  `)
  const insertThread = database.prepare(`
    INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
  `)
  const insertMessage = database.prepare(`
    INSERT INTO messages (id, thread_id, role, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `)
  const insertDiff = database.prepare(`
    INSERT INTO diff_artifacts (id, agent_id, title, path, patch, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const projects = [
    ['pican', 'Pican Orchestrator', root, 0],
    ['pi-mono', 'Pi Runtime Reference', '/Users/yesh/Documents/personal/reference/pi-mono', 1],
  ] as const

  for (const project of projects) {
    insertProject.run(...project)
  }

  const agents = [
    ['pican-planner', 'pican', 'planner', 'Planner', 'gpt-5.4:high', 'idle', 0],
    ['pican-builder', 'pican', 'builder', 'Builder', 'gpt-5.4:medium', 'running', 1],
    ['pican-reviewer', 'pican', 'reviewer', 'Reviewer', 'gpt-5.4:medium', 'queued', 2],
    ['pi-inspector', 'pi-mono', 'inspector', 'Inspector', 'gpt-5.4:high', 'idle', 0],
    ['pi-rpc', 'pi-mono', 'runtime', 'RPC Runtime', 'gpt-5.4:medium', 'blocked', 1],
  ] as const

  for (const [id, projectId, slot, title, model, status, position] of agents) {
    insertAgent.run(
      id,
      projectId,
      slot,
      title,
      model,
      status,
      join(root, '.pican', 'pi-sessions', projectId, slot),
      position,
    )
    insertThread.run(
      `thread-${id}`,
      id,
      seedPreview(slot),
      slot === 'reviewer' ? 2 : 3,
      now,
    )
  }

  insertMessage.run(
    'm1',
    'thread-pican-builder',
    'user',
    'Build the TanStack Start kanban shell and keep Pi as the first runtime.',
    now,
  )
  insertMessage.run(
    'm2',
    'thread-pican-builder',
    'assistant',
    'Scaffold is ready. I am wiring the board projection, Pi RPC contract, and Pierre diff panel next.',
    now,
  )
  insertMessage.run(
    'm3',
    'thread-pican-builder',
    'tool',
    'SQLite initialized at .pican/pican.sqlite. Pi sessions are reserved under .pican/pi-sessions.',
    now,
  )
  insertMessage.run(
    'm4',
    'thread-pican-planner',
    'summary',
    'MVP contract: one active Pi session per project x agent slot. pican stores orchestration metadata; Pi owns execution and JSONL transcript.',
    now,
  )
  insertMessage.run(
    'm5',
    'thread-pi-rpc',
    'system',
    'Blocked until a real Pi RPC process is attached from the server adapter.',
    now,
  )

  insertDiff.run(
    'diff-1',
    'pican-builder',
    'Initial pican contracts',
    'src/lib/contracts.ts',
    `diff --git a/src/lib/contracts.ts b/src/lib/contracts.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/lib/contracts.ts
@@ -0,0 +1,10 @@
+import { z } from 'zod'
+
+export const runtimeKindSchema = z.enum(['pi', 'codex', 'claude', 'opencode'])
+export const agentStatusSchema = z.enum(['idle', 'running', 'queued', 'blocked', 'failed'])
+
+export const agentCellSchema = z.object({
+  id: z.string(),
+  runtime: runtimeKindSchema,
+  status: agentStatusSchema,
+})`,
    now,
  )
}

function seedPreview(slot: string) {
  if (slot === 'planner') return 'Contract-first plan is ready.'
  if (slot === 'builder') return 'Building the initial orchestrator UI.'
  if (slot === 'reviewer') return 'Waiting for first implementation chunk.'
  if (slot === 'runtime') return 'RPC adapter boundary identified.'
  return 'Ready.'
}
