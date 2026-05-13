#!/usr/bin/env node

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const kiriHome = resolve(process.env.KIRI_HOME ?? join(homedir(), '.kiri'))
const stateDir = resolve(process.env.KIRI_STATE_DIR ?? join(kiriHome, 'userdata'))
const dbPath = process.env.KIRI_DB_PATH
  ? resolve(process.env.KIRI_DB_PATH)
  : join(stateDir, 'kiri.sqlite')
const rootDir = resolve(process.env.KIRI_ROOT_DIR ?? process.cwd())
main()

function main() {
  const [command, ...args] = process.argv.slice(2)
  const options = parseArgs(args)
  const database = openDb()

  if (command === 'list') {
    listProjects(database, options)
    return
  }

  if (command === 'add') {
    addProject(database, options)
    return
  }

  if (command === 'delete' || command === 'remove') {
    deleteProject(database, options)
    return
  }

  if (command === 'hide') {
    hideProject(database, options)
    return
  }

  if (command === 'unhide' || command === 'show') {
    unhideProject(database, options)
    return
  }

  usage(command ? `Unknown command: ${command}` : undefined)
}

function openDb() {
  const legacyMigration = migrateLegacyRepoState()
  mkdirSync(dirname(dbPath), { recursive: true })
  const database = new DatabaseSync(dbPath)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA foreign_keys = ON')
  migrate(database)
  if (legacyMigration) {
    rewriteLegacyAgentStatePaths(database, legacyMigration.legacyStateDir, stateDir)
  }
  return database
}

function migrate(database) {
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
      runtime TEXT NOT NULL CHECK (runtime IN ('pi', 'codex', 'claude')),
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'queued', 'blocked', 'failed')),
      session_dir TEXT NOT NULL,
      session_file TEXT,
      runtime_state_json TEXT,
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

    CREATE TABLE IF NOT EXISTS agent_context_usage (
      agent_id TEXT PRIMARY KEY REFERENCES agent_slots(id) ON DELETE CASCADE,
      used_tokens INTEGER NOT NULL,
      window_tokens INTEGER,
      updated_at TEXT NOT NULL,
      session_file TEXT
    );
  `)
  addProjectHiddenAtColumn(database)
  addRuntimeStateColumn(database)
  addAgentArchivedAtColumn(database)
}

function migrateLegacyRepoState() {
  if (isLegacyAetherTarget(stateDir, dbPath)) return
  if (kiriDatabaseState(dbPath) === 'nonempty') return

  const legacyCandidates = [
    resolve(rootDir, '.aether'),
    resolve(rootDir, '.kiri'),
  ]
  if (resolve(stateDir) === resolve(kiriHome, 'userdata')) {
    legacyCandidates.splice(1, 0, resolve(homedir(), '.aether', 'userdata'))
  }
  const legacyStateDir = legacyCandidates.find((candidate) => (
    existsSync(join(candidate, 'aether.sqlite')) || existsSync(join(candidate, 'kiri.sqlite'))
  ))

  if (!legacyStateDir || resolve(legacyStateDir) === resolve(stateDir)) return
  if (kiriDatabaseState(dbPath) === 'nonempty') return
  mkdirSync(stateDir, { recursive: true })
  cpSync(legacyStateDir, stateDir, { recursive: true, errorOnExist: false })
  copyLegacyDatabaseFile(legacyStateDir)
  return { legacyStateDir }
}

function isLegacyAetherTarget(stateDir, dbPath) {
  const stateParts = resolve(stateDir).split(/[\\/]+/)
  const dbName = dbPath.split(/[\\/]+/).pop()
  return stateParts.includes('.aether') || dbName === 'aether.sqlite'
}

function kiriDatabaseState(path) {
  if (!existsSync(path)) return 'missing'
  if (!hasSqliteHeader(path)) return 'unreadable'
  try {
    return isEmptyKiriDatabase(path) ? 'empty' : 'nonempty'
  } catch {
    return 'unreadable'
  }
}

function hasSqliteHeader(path) {
  const header = readFileSync(path, { encoding: 'utf8', flag: 'r' }).slice(0, 16)
  return header === '' || header === 'SQLite format 3\0'
}

function copyLegacyDatabaseFile(legacyStateDir) {
  const sourceName = existsSync(join(legacyStateDir, 'aether.sqlite')) ? 'aether.sqlite' : 'kiri.sqlite'
  mkdirSync(dirname(dbPath), { recursive: true })
  backupExistingDatabaseFiles(dbPath)
  for (const suffix of ['', '-wal', '-shm']) {
    const source = join(legacyStateDir, `${sourceName}${suffix}`)
    const target = `${dbPath}${suffix}`
    if (existsSync(source)) {
      copyFileSync(source, target)
    } else {
      rmSync(target, { force: true })
    }
  }
}

function backupExistingDatabaseFiles(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${path}${suffix}`
    if (existsSync(target)) {
      renameSync(target, `${target}.malformed-${stamp}`)
    }
  }
}

function isEmptyKiriDatabase(path) {
  const database = new DatabaseSync(path)
  try {
    const hasProjectsTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
      .get()
    if (!hasProjectsTable) return true
    const row = database
      .prepare('SELECT COUNT(*) AS count FROM projects')
      .get()
    return row.count === 0
  } finally {
    database.close()
  }
}

function rewriteLegacyAgentStatePaths(database, legacyStateDir, targetStateDir) {
  const rows = database
    .prepare('SELECT id, session_dir AS sessionDir, session_file AS sessionFile FROM agent_slots')
    .all()
  const update = database.prepare('UPDATE agent_slots SET session_dir = ?, session_file = ? WHERE id = ?')

  for (const row of rows) {
    const sessionDir = rewritePathWithin(row.sessionDir, legacyStateDir, targetStateDir)
    const sessionFile = row.sessionFile ? rewritePathWithin(row.sessionFile, legacyStateDir, targetStateDir) : null
    if (sessionDir !== row.sessionDir || sessionFile !== row.sessionFile) {
      update.run(sessionDir, sessionFile, row.id)
    }
  }
}

function rewritePathWithin(path, fromRoot, toRoot) {
  const absolutePath = resolve(path)
  const absoluteFrom = resolve(fromRoot)
  if (absolutePath === absoluteFrom) return resolve(toRoot)
  const prefix = `${absoluteFrom}/`
  if (!absolutePath.startsWith(prefix)) return path
  return join(resolve(toRoot), absolutePath.slice(prefix.length))
}

function listProjects(database, options) {
  const includeHidden = options.all
  const rows = database
    .prepare(
      `
        SELECT p.id, p.name, p.cwd, p.hidden_at AS hiddenAt, COUNT(a.id) AS sessions
        FROM projects p
        LEFT JOIN agent_slots a ON a.project_id = p.id
        WHERE ? OR p.hidden_at IS NULL
        GROUP BY p.id
        ORDER BY p.position ASC
      `,
    )
    .all(includeHidden ? 1 : 0)

  if (rows.length === 0) {
    console.log('No projects configured.')
    return
  }

  for (const row of rows) {
    const state = row.hiddenAt ? 'hidden' : 'visible'
    console.log(`${row.id}\t${row.name}\t${state}\t${row.sessions} sessions\t${row.cwd}`)
  }
}

function addProject(database, options) {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
  const name = required(options.name, '--name')
  const id = options.id ?? slugify(name)

  if (!existsSync(cwd)) {
    die(`Project cwd does not exist: ${cwd}`)
  }

  const exists = database
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(id)
  if (exists) {
    die(`Project already exists: ${id}`)
  }

  const nextPosition = nextProjectPosition(database)
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, cwd, position)
    VALUES (?, ?, ?, ?)
  `)
  database.exec('BEGIN')
  try {
    insertProject.run(id, name, cwd, nextPosition)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  console.log(`Added project ${id}: ${name}`)
}

function deleteProject(database, options) {
  const id = required(options.id ?? options._[0], '--id')
  if (!options.yes) {
    die(`Refusing to delete ${id} without --yes`)
  }

  const existing = database
    .prepare('SELECT id, name FROM projects WHERE id = ?')
    .get(id)
  if (!existing) {
    die(`Project not found: ${id}`)
  }

  database.exec('BEGIN')
  try {
    database.prepare('DELETE FROM projects WHERE id = ?').run(id)
    reindexProjects(database)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  console.log(`Deleted project ${existing.id}: ${existing.name}`)
}

function hideProject(database, options) {
  const id = required(options.id ?? options._[0], '--id')
  const visibleCount = database
    .prepare('SELECT COUNT(*) AS count FROM projects WHERE hidden_at IS NULL')
    .get()
  if (visibleCount.count <= 1) {
    die('Cannot hide the last visible project')
  }

  const existing = database
    .prepare('SELECT id, name FROM projects WHERE id = ?')
    .get(id)
  if (!existing) {
    die(`Project not found: ${id}`)
  }

  database
    .prepare('UPDATE projects SET hidden_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
  console.log(`Hidden project ${existing.id}: ${existing.name}`)
}

function unhideProject(database, options) {
  const id = required(options.id ?? options._[0], '--id')
  const existing = database
    .prepare('SELECT id, name FROM projects WHERE id = ?')
    .get(id)
  if (!existing) {
    die(`Project not found: ${id}`)
  }

  database.prepare('UPDATE projects SET hidden_at = NULL WHERE id = ?').run(id)
  console.log(`Unhid project ${existing.id}: ${existing.name}`)
}

function addProjectHiddenAtColumn(database) {
  const columns = database.prepare('PRAGMA table_info(projects)').all()
  if (columns.some((column) => column.name === 'hidden_at')) return
  database.exec('ALTER TABLE projects ADD COLUMN hidden_at TEXT')
}

function addRuntimeStateColumn(database) {
  const columns = database.prepare('PRAGMA table_info(agent_slots)').all()
  if (columns.some((column) => column.name === 'runtime_state_json')) return
  database.exec('ALTER TABLE agent_slots ADD COLUMN runtime_state_json TEXT')
}

function addAgentArchivedAtColumn(database) {
  const columns = database.prepare('PRAGMA table_info(agent_slots)').all()
  if (columns.some((column) => column.name === 'archived_at')) return
  database.exec('ALTER TABLE agent_slots ADD COLUMN archived_at TEXT')
}

function nextProjectPosition(database) {
  const row = database
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM projects')
    .get()
  return row.position
}

function reindexProjects(database) {
  const rows = database
    .prepare('SELECT id FROM projects ORDER BY position ASC, id ASC')
    .all()
  const update = database.prepare('UPDATE projects SET position = ? WHERE id = ?')
  for (const [position, row] of rows.entries()) {
    update.run(position, row.id)
  }
}

function parseArgs(args) {
  const options = { _: [] }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--yes' || arg === '-y') {
      options.yes = true
      continue
    }
    if (arg === '--all') {
      options.all = true
      continue
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        die(`Missing value for ${arg}`)
      }
      options[key] = value
      index += 1
      continue
    }
    options._.push(arg)
  }
  return options
}

function required(value, label) {
  if (!value) die(`Missing required ${label}`)
  return value
}

function slugify(value) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) die('Project name must contain at least one ASCII letter or digit')
  return slug
}

function usage(error) {
  if (error) console.error(error)
  console.error(`
Usage:
  pnpm kiri:projects list [--all]
  pnpm kiri:projects add --name "Project Name" --cwd /path/to/project [--id project-id]
  pnpm kiri:projects hide --id project-id
  pnpm kiri:projects unhide --id project-id
  pnpm kiri:projects delete --id project-id --yes
`)
  process.exit(error ? 1 : 0)
}

function die(message) {
  console.error(message)
  process.exit(1)
}
