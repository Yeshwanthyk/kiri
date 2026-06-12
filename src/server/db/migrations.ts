import type { DatabaseSync } from 'node:sqlite'
import { runtimeKinds } from '~/lib/contracts'
import { readModelKinds } from '../read-model-contract'

const runtimeCheckValues = runtimeKinds.map((runtime) => `'${runtime}'`).join(', ')
const readModelKindCheckValues = readModelKinds.map((kind) => `'${kind}'`).join(', ')

export function migrate(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      position INTEGER NOT NULL,
      hidden_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_slots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      title TEXT NOT NULL,
      runtime TEXT NOT NULL CHECK (runtime IN (${runtimeCheckValues})),
      interface_mode TEXT NOT NULL DEFAULT 'gui' CHECK (interface_mode IN ('gui', 'terminal')),
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'queued', 'blocked', 'failed')),
      session_dir TEXT NOT NULL,
      session_file TEXT,
      runtime_state_json TEXT,
      runtime_state_updated_at TEXT,
      archived_at TEXT,
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

    CREATE INDEX IF NOT EXISTS messages_thread_timestamp
      ON messages(thread_id, timestamp, id);

    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      tone TEXT NOT NULL CHECK (tone IN ('thinking', 'tool', 'info', 'error')),
      label TEXT NOT NULL,
      detail TEXT,
      timestamp TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS timeline_events_thread_timestamp
      ON timeline_events(thread_id, timestamp, id);

    CREATE TABLE IF NOT EXISTS agent_tasks (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN (${runtimeCheckValues})),
      task_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'inProgress', 'completed', 'failed')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, source, task_id)
    );

    CREATE INDEX IF NOT EXISTS agent_tasks_thread_position
      ON agent_tasks(thread_id, position, task_id);

    CREATE TABLE IF NOT EXISTS deleted_sessions (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (project_id, slot)
    );

    CREATE TABLE IF NOT EXISTS diff_artifacts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      patch TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS diff_artifacts_agent_updated
      ON diff_artifacts(agent_id, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS agent_context_usage (
      agent_id TEXT PRIMARY KEY REFERENCES agent_slots(id) ON DELETE CASCADE,
      used_tokens INTEGER NOT NULL,
      window_tokens INTEGER,
      updated_at TEXT NOT NULL,
      session_file TEXT
    );

    CREATE TABLE IF NOT EXISTS scratchpad_blocks (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      triggered_at TEXT,
      triggered_agent_id TEXT REFERENCES agent_slots(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS scratchpad_blocks_created_at
      ON scratchpad_blocks(created_at);

    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      problem TEXT NOT NULL,
      answer TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT,
      seen_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS knowledge_entries_project_updated
      ON knowledge_entries(project_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS knowledge_entries_project_seen
      ON knowledge_entries(project_id, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('validated', 'running', 'completed', 'failed', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS workflow_runs_project_updated
      ON workflow_runs(project_id, updated_at);

    CREATE TABLE IF NOT EXISTS workflow_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      client_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('launch', 'scratchpad')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      runtime TEXT CHECK (runtime IN (${runtimeCheckValues})),
      interface_mode TEXT CHECK (interface_mode IN ('gui', 'terminal')),
      model TEXT,
      thinking_level TEXT,
      terminal_paste_json TEXT,
      scratchpad_block_id TEXT REFERENCES scratchpad_blocks(id) ON DELETE SET NULL,
      active_agent_id TEXT REFERENCES agent_slots(id) ON DELETE SET NULL,
      tracked INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'untracked')),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS workflow_items_run_position
      ON workflow_items(run_id, position);

    CREATE TABLE IF NOT EXISTS workflow_item_attempts (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES workflow_items(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agent_slots(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('launched', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS workflow_item_attempts_item_created
      ON workflow_item_attempts(item_id, created_at);

    CREATE TABLE IF NOT EXISTS read_model_entries (
      kind TEXT NOT NULL CHECK (kind IN (${readModelKindCheckValues})),
      entity_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, entity_id)
    );

    CREATE INDEX IF NOT EXISTS read_model_entries_updated
      ON read_model_entries(updated_at);
  `)
  widenRuntimeCheck(database)
  addContextUsageWindowTokensColumn(database)
  addProjectHiddenAtColumn(database)
  addRuntimeStateColumn(database)
  addRuntimeStateUpdatedAtColumn(database)
  addAgentArchivedAtColumn(database)
  addAgentInterfaceModeColumn(database)
  addAgentEventsTable(database)
  addKnowledgeIndexTables(database)
  addReadModelEntriesTable(database)
  widenReadModelKindCheck(database)
  normalizeTerminalOnlyInterfaceMode(database)
  repairAgentSlotReferences(database)
  removeLegacyDefaultAgentSlots(database)
}

function addReadModelEntriesTable(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS read_model_entries (
      kind TEXT NOT NULL CHECK (kind IN (${readModelKindCheckValues})),
      entity_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, entity_id)
    );

    CREATE INDEX IF NOT EXISTS read_model_entries_updated
      ON read_model_entries(updated_at);
  `)
}

function widenReadModelKindCheck(database: DatabaseSync) {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'read_model_entries'")
    .get() as { sql?: string } | undefined
  if (!row?.sql || readModelKinds.every((kind) => row.sql?.includes(`'${kind}'`))) return

  database.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE read_model_entries RENAME TO read_model_entries_old;

    CREATE TABLE read_model_entries (
      kind TEXT NOT NULL CHECK (kind IN (${readModelKindCheckValues})),
      entity_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, entity_id)
    );

    INSERT INTO read_model_entries (kind, entity_id, revision, payload_json, updated_at)
    SELECT kind, entity_id, revision, payload_json, updated_at
    FROM read_model_entries_old
    WHERE kind IN (${readModelKindCheckValues});

    DROP TABLE read_model_entries_old;
    CREATE INDEX IF NOT EXISTS read_model_entries_updated
      ON read_model_entries(updated_at);
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `)
}

function addProjectHiddenAtColumn(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(projects)')
    .all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'hidden_at')) return
  database.exec('ALTER TABLE projects ADD COLUMN hidden_at TEXT')
}

function addContextUsageWindowTokensColumn(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(agent_context_usage)')
    .all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'window_tokens')) return
  database.exec('ALTER TABLE agent_context_usage ADD COLUMN window_tokens INTEGER')
}

function addRuntimeStateColumn(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(agent_slots)')
    .all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'runtime_state_json')) return
  database.exec('ALTER TABLE agent_slots ADD COLUMN runtime_state_json TEXT')
}

function addRuntimeStateUpdatedAtColumn(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(agent_slots)')
    .all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'runtime_state_updated_at')) return
  database.exec('ALTER TABLE agent_slots ADD COLUMN runtime_state_updated_at TEXT')
}

function addAgentArchivedAtColumn(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(agent_slots)')
    .all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'archived_at')) return
  database.exec('ALTER TABLE agent_slots ADD COLUMN archived_at TEXT')
}

function addAgentInterfaceModeColumn(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(agent_slots)')
    .all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'interface_mode')) return
  database.exec("ALTER TABLE agent_slots ADD COLUMN interface_mode TEXT NOT NULL DEFAULT 'gui'")
}

function addAgentEventsTable(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(agent_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS agent_events_agent_sequence
      ON agent_events(agent_id, sequence);
  `)
}

function addKnowledgeIndexTables(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      problem TEXT NOT NULL,
      answer TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT,
      seen_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS knowledge_entries_project_updated
      ON knowledge_entries(project_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS knowledge_entries_project_seen
      ON knowledge_entries(project_id, last_seen_at DESC);
  `)
}

function normalizeTerminalOnlyInterfaceMode(database: DatabaseSync) {
  database
    .prepare("UPDATE agent_slots SET interface_mode = 'terminal' WHERE runtime IN ('claude', 'opencode') AND interface_mode <> 'terminal'")
    .run()
}

function removeLegacyDefaultAgentSlots(database: DatabaseSync) {
  database.prepare("DELETE FROM agent_slots WHERE slot NOT LIKE 'session-%'").run()
}

function widenRuntimeCheck(database: DatabaseSync) {
  widenAgentSlotsRuntimeCheck(database)
  widenAgentTasksSourceCheck(database)
}

function widenAgentSlotsRuntimeCheck(database: DatabaseSync) {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_slots'")
    .get() as { sql?: string } | undefined
  if (!needsRuntimeCheckWidening(row?.sql)) return

  const columns = tableColumns(database, 'agent_slots')
  const interfaceMode = columns.has('interface_mode') ? 'interface_mode' : "'gui'"
  const runtimeStateJson = columns.has('runtime_state_json') ? 'runtime_state_json' : 'NULL'
  const runtimeStateUpdatedAt = columns.has('runtime_state_updated_at') ? 'runtime_state_updated_at' : 'NULL'
  const archivedAt = columns.has('archived_at') ? 'archived_at' : 'NULL'

  database.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE agent_slots RENAME TO agent_slots_old;

    CREATE TABLE agent_slots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      title TEXT NOT NULL,
      runtime TEXT NOT NULL CHECK (runtime IN (${runtimeCheckValues})),
      interface_mode TEXT NOT NULL DEFAULT 'gui' CHECK (interface_mode IN ('gui', 'terminal')),
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'queued', 'blocked', 'failed')),
      session_dir TEXT NOT NULL,
      session_file TEXT,
      runtime_state_json TEXT,
      runtime_state_updated_at TEXT,
      archived_at TEXT,
      position INTEGER NOT NULL
    );

    INSERT INTO agent_slots (
      id, project_id, slot, title, runtime, interface_mode, model, status, session_dir, session_file, runtime_state_json, runtime_state_updated_at, archived_at, position
    )
    SELECT id, project_id, slot, title, runtime, ${interfaceMode}, model, status, session_dir, session_file, ${runtimeStateJson}, ${runtimeStateUpdatedAt}, ${archivedAt}, position
    FROM agent_slots_old;

    DROP TABLE agent_slots_old;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `)
}

function widenAgentTasksSourceCheck(database: DatabaseSync) {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'")
    .get() as { sql?: string } | undefined
  if (!needsRuntimeCheckWidening(row?.sql)) return

  database.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE agent_tasks RENAME TO agent_tasks_old;

    CREATE TABLE agent_tasks (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN (${runtimeCheckValues})),
      task_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'inProgress', 'completed', 'failed')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, source, task_id)
    );

    INSERT INTO agent_tasks (
      thread_id, source, task_id, position, title, status, updated_at
    )
    SELECT thread_id, source, task_id, position, title, status, updated_at
    FROM agent_tasks_old;

    DROP TABLE agent_tasks_old;
    CREATE INDEX IF NOT EXISTS agent_tasks_thread_position
      ON agent_tasks(thread_id, position, task_id);
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `)
}

function needsRuntimeCheckWidening(sql: string | undefined) {
  return sql !== undefined && !runtimeKinds.every((runtime) => sql.includes(`'${runtime}'`))
}

function tableColumns(database: DatabaseSync, tableName: string) {
  return new Set(
    (database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
      .map((column) => column.name),
  )
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
