import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { migrate } from '../../src/server/db/migrations'

describe('DB migrations', () => {
  it('widens legacy pi-only runtime slots without leaving renamed foreign keys', () => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          cwd TEXT NOT NULL,
          position INTEGER NOT NULL
        );

        CREATE TABLE agent_slots (
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

        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
          active INTEGER NOT NULL DEFAULT 1,
          preview TEXT NOT NULL,
          message_count INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE diff_artifacts (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          path TEXT NOT NULL,
          patch TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE agent_context_usage (
          agent_id TEXT PRIMARY KEY REFERENCES agent_slots(id) ON DELETE CASCADE,
          used_tokens INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          session_file TEXT
        );

        INSERT INTO projects (id, name, cwd, position)
        VALUES ('project-1', 'Project', '/tmp/project', 0);

        INSERT INTO agent_slots (
          id, project_id, slot, title, runtime, model, status, session_dir, session_file, position
        )
        VALUES (
          'agent-1', 'project-1', 'session-1', 'Agent', 'pi', 'test-model', 'idle', '/tmp/session', NULL, 0
        );

        INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
        VALUES ('thread-1', 'agent-1', 1, 'preview', 1, '2026-01-01T00:00:00.000Z');

        INSERT INTO diff_artifacts (id, agent_id, title, path, patch, updated_at)
        VALUES ('diff-1', 'agent-1', 'Diff', 'file.ts', 'patch', '2026-01-01T00:00:00.000Z');
      `)

      migrate(database)

      const agentSql = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_slots'")
        .get() as { sql?: string } | undefined
      expect(agentSql?.sql).toContain("runtime IN ('pi', 'codex', 'claude', 'opencode')")

      const agentColumns = database
        .prepare('PRAGMA table_info(agent_slots)')
        .all() as Array<{ name: string }>
      expect(agentColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['interface_mode', 'runtime_state_json', 'runtime_state_updated_at', 'archived_at']),
      )
      const readModelSql = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'read_model_entries'")
        .get() as { sql?: string } | undefined
      expect(readModelSql?.sql).toContain("kind IN ('workspace.summary', 'agent.timeline.summary', 'diff.summary')")

      database
        .prepare(
          `
            INSERT INTO agent_slots (
              id, project_id, slot, title, runtime, interface_mode, model, status,
              session_dir, session_file, runtime_state_json, archived_at, position
            )
            VALUES (
              'agent-2', 'project-1', 'session-2', 'Codex', 'codex', 'gui', 'test-model', 'idle',
              '/tmp/session-2', NULL, NULL, NULL, 1
            )
          `,
        )
        .run()

      const threadForeignKeys = database
        .prepare('PRAGMA foreign_key_list(threads)')
        .all() as Array<{ table: string }>
      const diffForeignKeys = database
        .prepare('PRAGMA foreign_key_list(diff_artifacts)')
        .all() as Array<{ table: string }>
      expect(threadForeignKeys.map((key) => key.table)).toContain('agent_slots')
      expect(diffForeignKeys.map((key) => key.table)).toContain('agent_slots')
      expect(threadForeignKeys.map((key) => key.table)).not.toContain('agent_slots_old')
      expect(diffForeignKeys.map((key) => key.table)).not.toContain('agent_slots_old')

      const threadIndexes = database
        .prepare('PRAGMA index_list(threads)')
        .all() as Array<{ name: string }>
      expect(threadIndexes.map((index) => index.name)).toContain('one_active_thread_per_agent')

      const migratedThread = database
        .prepare('SELECT agent_id, preview, message_count FROM threads WHERE id = ?')
        .get('thread-1')
      expect(migratedThread).toEqual({
        agent_id: 'agent-1',
        preview: 'preview',
        message_count: 1,
      })

      const migratedDiff = database
        .prepare('SELECT agent_id, title, path, patch FROM diff_artifacts WHERE id = ?')
        .get('diff-1')
      expect(migratedDiff).toEqual({
        agent_id: 'agent-1',
        title: 'Diff',
        path: 'file.ts',
        patch: 'patch',
      })

      const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all()
      expect(foreignKeyViolations).toEqual([])
    } finally {
      database.close()
    }
  })

  it('widens current runtime checks for OpenCode slots and tasks', () => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          cwd TEXT NOT NULL,
          position INTEGER NOT NULL,
          hidden_at TEXT
        );

        CREATE TABLE agent_slots (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          slot TEXT NOT NULL,
          title TEXT NOT NULL,
          runtime TEXT NOT NULL CHECK (runtime IN ('pi', 'codex', 'claude')),
          interface_mode TEXT NOT NULL DEFAULT 'gui' CHECK (interface_mode IN ('gui', 'terminal')),
          model TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'queued', 'blocked', 'failed')),
          session_dir TEXT NOT NULL,
          session_file TEXT,
          runtime_state_json TEXT,
          archived_at TEXT,
          position INTEGER NOT NULL
        );

        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
          active INTEGER NOT NULL DEFAULT 1,
          preview TEXT NOT NULL,
          message_count INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE agent_tasks (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          source TEXT NOT NULL CHECK (source IN ('pi', 'codex', 'claude')),
          task_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'inProgress', 'completed', 'failed')),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (thread_id, source, task_id)
        );

        INSERT INTO projects (id, name, cwd, position)
        VALUES ('project-1', 'Project', '/tmp/project', 0);

        INSERT INTO agent_slots (
          id, project_id, slot, title, runtime, interface_mode, model, status,
          session_dir, session_file, runtime_state_json, archived_at, position
        )
        VALUES (
          'agent-1', 'project-1', 'session-1', 'Codex', 'codex', 'gui', 'test-model', 'idle',
          '/tmp/session', NULL, NULL, NULL, 0
        );

        INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at)
        VALUES ('thread-1', 'agent-1', 1, 'preview', 1, '2026-01-01T00:00:00.000Z');

        INSERT INTO agent_tasks (thread_id, source, task_id, position, title, status, updated_at)
        VALUES ('thread-1', 'codex', 'task-1', 0, 'Existing task', 'pending', '2026-01-01T00:00:00.000Z');
      `)

      migrate(database)

      const agentSql = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_slots'")
        .get() as { sql?: string } | undefined
      const taskSql = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'")
        .get() as { sql?: string } | undefined
      expect(agentSql?.sql).toContain("runtime IN ('pi', 'codex', 'claude', 'opencode')")
      expect(taskSql?.sql).toContain("source IN ('pi', 'codex', 'claude', 'opencode')")

      database
        .prepare(
          `
            INSERT INTO agent_slots (
              id, project_id, slot, title, runtime, interface_mode, model, status,
              session_dir, session_file, runtime_state_json, archived_at, position
            )
            VALUES (
              'agent-2', 'project-1', 'session-2', 'OpenCode', 'opencode', 'terminal', 'opencode/gpt-5.5', 'idle',
              '/tmp/session-2', NULL, NULL, NULL, 1
            )
          `,
        )
        .run()
      database
        .prepare(
          `
            INSERT INTO agent_tasks (thread_id, source, task_id, position, title, status, updated_at)
            VALUES ('thread-1', 'opencode', 'task-2', 1, 'OpenCode task', 'pending', '2026-01-01T00:00:00.000Z')
          `,
        )
        .run()

      const taskRows = database
        .prepare('SELECT source, task_id, title FROM agent_tasks ORDER BY position')
        .all()
      expect(taskRows).toEqual([
        { source: 'codex', task_id: 'task-1', title: 'Existing task' },
        { source: 'opencode', task_id: 'task-2', title: 'OpenCode task' },
      ])

      const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all()
      expect(foreignKeyViolations).toEqual([])
    } finally {
      database.close()
    }
  })

  it('keeps hot snapshot and detail query indexes available after migration', () => {
    const database = new DatabaseSync(':memory:')
    try {
      migrate(database)

      const messageIndexes = indexNames(database, 'messages')
      const diffIndexes = indexNames(database, 'diff_artifacts')
      expect(messageIndexes).toContain('messages_thread_timestamp')
      expect(diffIndexes).toContain('diff_artifacts_agent_updated')

      const messagePlan = queryPlan(database, `
        EXPLAIN QUERY PLAN
        SELECT id
        FROM messages
        WHERE thread_id = 'thread-1'
        ORDER BY timestamp DESC, id DESC
        LIMIT 500
      `)
      expect(messagePlan).toContain('USING COVERING INDEX messages_thread_timestamp')

      const diffPlan = queryPlan(database, `
        EXPLAIN QUERY PLAN
        SELECT id, agent_id, title, path, patch, updated_at
        FROM diff_artifacts
        WHERE agent_id = 'agent-1'
        ORDER BY updated_at DESC
        LIMIT 50
      `)
      expect(diffPlan).toContain('USING INDEX diff_artifacts_agent_updated')
      expect(diffPlan).not.toContain('USE TEMP B-TREE')
    } finally {
      database.close()
    }
  })
})

function indexNames(database: DatabaseSync, table: string) {
  return (database.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
    .map((index) => index.name)
}

function queryPlan(database: DatabaseSync, sql: string) {
  return (database.prepare(sql).all() as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join('\n')
}
