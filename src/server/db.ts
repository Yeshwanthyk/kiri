import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type {
  AddProjectInput,
  AgentStatus,
  StartSessionInput,
  MessageRole,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import {
  agentStatusSchema,
  messageRoleSchema,
  runtimeKindSchema,
  workspaceSnapshotSchema,
} from '~/lib/contracts'
import type { PiRpcMessage } from './pi-rpc'
import { assertConfiguredModel, getRuntimeSettings, getSettings } from './settings'

const dbPath = join(process.cwd(), '.pican', 'pican.sqlite')
const defaultAgentSlots = [
  ['planner', 'Planner'],
  ['builder', 'Builder'],
  ['reviewer', 'Reviewer'],
] as const

let db: DatabaseSync | undefined

const projectDbRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  position: z.number().int().nonnegative(),
})

const agentDbRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  slot: z.string(),
  title: z.string(),
  runtime: runtimeKindSchema,
  model: z.string(),
  status: agentStatusSchema,
  sessionDir: z.string(),
  sessionFile: z.string().nullable(),
  position: z.number().int().nonnegative(),
  preview: z.string().nullable(),
  messageCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.string().nullable(),
  diffCount: z.number().int().nonnegative(),
  threadId: z.string().nullable(),
})

const messageDbRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  role: messageRoleSchema,
  text: z.string(),
  timestamp: z.string(),
})

const diffDbRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  path: z.string(),
  patch: z.string(),
  updatedAt: z.string(),
})

const agentLaunchConfigSchema = z.object({
  id: z.string(),
  runtime: runtimeKindSchema,
  sessionDir: z.string(),
  model: z.string(),
  cwd: z.string(),
})

const idDbRowSchema = z.object({
  id: z.string(),
})

export function getDb() {
  if (db) return db
  mkdirSync(dirname(dbPath), { recursive: true })
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  normalizeSeededModels(db)
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
    .all()
    .map((row) => projectDbRowSchema.parse(row))

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
    .all()
    .map((row) => agentDbRowSchema.parse(row))

  const messages = database
    .prepare(
      `
        SELECT m.id, t.agent_id AS agentId, m.role, m.text, m.timestamp
        FROM messages m
        INNER JOIN threads t ON t.id = m.thread_id
        WHERE t.active = 1
        ORDER BY m.timestamp ASC, m.id ASC
      `,
    )
    .all()
    .map((row) => messageDbRowSchema.parse(row))

  const diffs = database
    .prepare(
      `
        SELECT id, agent_id AS agentId, title, path, patch, updated_at AS updatedAt
        FROM diff_artifacts
        ORDER BY updated_at DESC
      `,
    )
    .all()
    .map((row) => diffDbRowSchema.parse(row))

  const messagesByAgent = groupBy(messages, (message) => message.agentId)
  const diffsByAgent = groupBy(diffs, (diff) => diff.agentId)
  const agentsByProject = groupBy(agents, (agent) => agent.projectId)

  const snapshotProjects = projects.map((project) => ({
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
  }))
  const selectedProject = snapshotProjects[0]
  const selectedAgent = selectedProject?.agents[0]

  const snapshot = {
    settings: getSettings(),
    projects: snapshotProjects,
    selected: {
      projectId: selectedProject?.id ?? '',
      agentId: selectedAgent?.id ?? '',
    },
  }

  return workspaceSnapshotSchema.parse(snapshot)
}

export function addProject(input: AddProjectInput) {
  const database = getDb()
  const id = input.id?.trim() || slugify(input.name)
  const name = input.name.trim()
  const cwd = input.cwd.trim()

  if (!name) throw new Error('Project name is required')
  if (!cwd) throw new Error('Project cwd is required')
  if (!existsSync(cwd)) throw new Error(`Project cwd does not exist: ${cwd}`)

  const existing = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(id)
  if (existing) throw new Error(`Project already exists: ${id}`)

  const nextPosition = database
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM projects')
    .get() as { position: number }
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, cwd, position)
    VALUES (?, ?, ?, ?)
  `)
  const insertAgent = database.prepare(`
    INSERT INTO agent_slots (
      id, project_id, slot, title, runtime, model, status, session_dir, session_file, position
    )
    VALUES (?, ?, ?, ?, 'pi', ?, 'idle', ?, NULL, ?)
  `)
  const insertThread = database.prepare(`
    INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
    VALUES (?, ?, 1, 'Ready.', 0, ?)
  `)
  const now = new Date().toISOString()
  const piModel = getRuntimeSettings('pi').defaultModel

  database.exec('BEGIN')
  try {
    insertProject.run(id, name, cwd, nextPosition.position)
    for (const [position, [slot, title]] of defaultAgentSlots.entries()) {
      const agentId = `${id}-${slot}`
      insertAgent.run(
        agentId,
        id,
        slot,
        title,
        piModel,
        join(process.cwd(), '.pican', 'pi-sessions', id, slot),
        position,
      )
      insertThread.run(`thread-${agentId}`, agentId, now)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return getWorkspaceSnapshot()
}

export function startSession(input: StartSessionInput) {
  const database = getDb()
  const projectId = input.projectId.trim()
  const project = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)

  const runtime = runtimeKindSchema.parse(input.runtime ?? 'pi')
  const runtimeSettings = getRuntimeSettings(runtime)
  const model = input.model?.trim() || runtimeSettings.defaultModel
  assertConfiguredModel(runtime, model)

  const nextPosition = database
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM agent_slots WHERE project_id = ?')
    .get(projectId) as { position: number }
  const suffix = Math.random().toString(36).slice(2, 8)
  const slot = `session-${Date.now().toString(36)}-${suffix}`
  const id = `${projectId}-${slot}`
  const title = input.title?.trim() || `Session ${nextPosition.position + 1}`
  const now = new Date().toISOString()

  database.exec('BEGIN')
  try {
    database
      .prepare(
        `
          INSERT INTO agent_slots (
            id, project_id, slot, title, runtime, model, status, session_dir, session_file, position
          )
          VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, NULL, ?)
        `,
      )
      .run(
        id,
        projectId,
        slot,
        title,
        runtime,
        model,
        join(process.cwd(), '.pican', 'pi-sessions', projectId, slot),
        nextPosition.position,
      )
    database
      .prepare(
        `
          INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
          VALUES (?, ?, 1, 'Ready.', 0, ?)
        `,
      )
      .run(`thread-${id}`, id, now)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return getWorkspaceSnapshot()
}

export function deleteProject(id: string) {
  const database = getDb()
  const projectId = id.trim()
  if (!projectId) throw new Error('Project id is required')

  const count = database
    .prepare('SELECT COUNT(*) AS count FROM projects')
    .get() as { count: number }
  if (count.count <= 1) throw new Error('Cannot delete the last project')

  const existing = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId)
  if (!existing) throw new Error(`Project not found: ${projectId}`)

  database.exec('BEGIN')
  try {
    database.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    const rows = database
      .prepare('SELECT id FROM projects ORDER BY position ASC, id ASC')
      .all()
      .map((row) => idDbRowSchema.parse(row))
    const update = database.prepare('UPDATE projects SET position = ? WHERE id = ?')
    for (const [position, row] of rows.entries()) {
      update.run(position, row.id)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return getWorkspaceSnapshot()
}

export function getAgentLaunchConfig(agentId: string) {
  const row = getDb()
    .prepare(
      `
        SELECT
          a.id,
          a.runtime,
          a.session_dir AS sessionDir,
          a.model,
          p.cwd
        FROM agent_slots a
        INNER JOIN projects p ON p.id = a.project_id
        WHERE a.id = ?
      `,
    )
    .get(agentId)
  if (!row) throw new Error(`Agent not found: ${agentId}`)
  return agentLaunchConfigSchema.parse(row)
}

export function setAgentStatus(agentId: string, status: AgentStatus) {
  const parsed = agentStatusSchema.parse(status)
  getDb().prepare('UPDATE agent_slots SET status = ? WHERE id = ?').run(parsed, agentId)
}

export function recordPiMessages(input: {
  agentId: string
  promptText: string
  messages: PiRpcMessage[]
  sessionFile?: string
}) {
  const database = getDb()
  const thread = database
    .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
    .get(input.agentId) as { id: string } | undefined
  if (!thread) throw new Error(`No active thread for agent: ${input.agentId}`)

  const insertMessage = database.prepare(`
    INSERT INTO messages (id, thread_id, role, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `)
  const now = Date.now()
  const currentTurn = currentPiTurn(input.messages, input.promptText)
  const rows = currentTurn
    .map((message, index) => {
      const role = normalizePiRole(message.role)
      const text = piMessageToText(message)
      if (!role || !text) return null
      return {
        id: `pi-${input.agentId}-${now}-${index}`,
        role,
        text,
        timestamp: new Date(message.timestamp ?? now + index).toISOString(),
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
  const preview = lastMessageText(rows, 'assistant') ?? rows[rows.length - 1]?.text

  database.exec('BEGIN')
  try {
    for (const row of rows) {
      insertMessage.run(row.id, thread.id, row.role, row.text, row.timestamp)
    }
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?')
      .get(thread.id) as { count: number }
    database
      .prepare('UPDATE threads SET preview = COALESCE(?, preview), message_count = ?, updated_at = ? WHERE id = ?')
      .run(preview ?? null, count.count, new Date().toISOString(), thread.id)
    if (input.sessionFile) {
      database
        .prepare('UPDATE agent_slots SET session_file = ? WHERE id = ?')
        .run(input.sessionFile, input.agentId)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
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
      runtime TEXT NOT NULL CHECK (runtime IN ('pi', 'codex', 'claude', 'opencode')),
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
  widenRuntimeCheck(database)
  repairAgentSlotReferences(database)
}

function widenRuntimeCheck(database: DatabaseSync) {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_slots'")
    .get() as { sql?: string } | undefined
  if (!row?.sql?.includes("CHECK (runtime = 'pi')")) return

  database.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE agent_slots RENAME TO agent_slots_old;

    CREATE TABLE agent_slots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      title TEXT NOT NULL,
      runtime TEXT NOT NULL CHECK (runtime IN ('pi', 'codex', 'claude', 'opencode')),
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'queued', 'blocked', 'failed')),
      session_dir TEXT NOT NULL,
      session_file TEXT,
      position INTEGER NOT NULL
    );

    INSERT INTO agent_slots (
      id, project_id, slot, title, runtime, model, status, session_dir, session_file, position
    )
    SELECT id, project_id, slot, title, runtime, model, status, session_dir, session_file, position
    FROM agent_slots_old;

    DROP TABLE agent_slots_old;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `)
}

function repairAgentSlotReferences(database: DatabaseSync) {
  const tables = database
    .prepare(
      `
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('threads', 'diff_artifacts')
      `,
    )
    .all() as Array<{ name: string; sql?: string }>
  if (!tables.some((table) => table.sql?.includes('agent_slots_old'))) return

  database.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;

    ALTER TABLE threads RENAME TO threads_old;
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
      active INTEGER NOT NULL DEFAULT 1,
      preview TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
    SELECT id, agent_id, active, preview, message_count, updated_at
    FROM threads_old;
    DROP TABLE threads_old;

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_thread_per_agent
      ON threads(agent_id)
      WHERE active = 1;

    ALTER TABLE diff_artifacts RENAME TO diff_artifacts_old;
    CREATE TABLE diff_artifacts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      patch TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO diff_artifacts (id, agent_id, title, path, patch, updated_at)
    SELECT id, agent_id, title, path, patch, updated_at
    FROM diff_artifacts_old;
    DROP TABLE diff_artifacts_old;

    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `)
}

function normalizeSeededModels(database: DatabaseSync) {
  const piSettings = getRuntimeSettings('pi')
  const staleRows = database
    .prepare(
      `
        SELECT id
        FROM agent_slots
        WHERE runtime = 'pi'
          AND model NOT IN (${piSettings.models.map(() => '?').join(', ')})
      `,
    )
    .all(...piSettings.models)
    .map((row) => idDbRowSchema.parse(row))

  const update = database.prepare('UPDATE agent_slots SET model = ? WHERE id = ?')
  for (const row of staleRows) {
    update.run(piSettings.defaultModel, row.id)
  }
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

  const piModel = getRuntimeSettings('pi').defaultModel
  const agents = [
    ['pican-planner', 'pican', 'planner', 'Planner', piModel, 'idle', 0],
    ['pican-builder', 'pican', 'builder', 'Builder', piModel, 'running', 1],
    ['pican-reviewer', 'pican', 'reviewer', 'Reviewer', piModel, 'queued', 2],
    ['pi-inspector', 'pi-mono', 'inspector', 'Inspector', piModel, 'idle', 0],
    ['pi-rpc', 'pi-mono', 'runtime', 'RPC Runtime', piModel, 'blocked', 1],
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

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error('Project name must contain at least one ASCII letter or digit')
  return slug
}

function normalizePiRole(role: string): MessageRole | null {
  const parsed = messageRoleSchema.safeParse(role)
  if (parsed.success && parsed.data !== 'summary' && parsed.data !== 'tool') {
    return parsed.data
  }
  if (role === 'toolResult' || role === 'bashExecution') return 'tool'
  return null
}

function currentPiTurn(messages: PiRpcMessage[], promptText: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && piMessageToText(message) === promptText.trim()) {
      return messages.slice(index)
    }
  }
  return messages
}

function lastMessageText(
  rows: Array<{ role: MessageRole; text: string }>,
  role: MessageRole,
) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role === role) return rows[index]?.text
  }
  return undefined
}

function piMessageToText(message: PiRpcMessage) {
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      if ('text' in part && typeof part.text === 'string') return part.text
      if ('thinking' in part && typeof part.thinking === 'string') {
        return part.thinking
      }
      if ('name' in part && typeof part.name === 'string') {
        return `tool call: ${part.name}`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}
