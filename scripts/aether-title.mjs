#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const aetherHome = resolve(process.env.AETHER_HOME ?? join(homedir(), '.aether'))
const stateDir = resolve(process.env.AETHER_STATE_DIR ?? join(aetherHome, 'userdata'))
const dbPath = process.env.AETHER_DB_PATH
  ? resolve(process.env.AETHER_DB_PATH)
  : join(stateDir, 'aether.sqlite')

main()

function main() {
  const options = parseArgs(process.argv.slice(2))
  const agentId = (options.agent ?? process.env.AETHER_AGENT_ID ?? '').trim()
  const title = (options.title ?? options._.join(' ')).trim().replace(/\s+/g, ' ')

  if (!agentId) usage('Missing required --agent or AETHER_AGENT_ID')
  if (!title) usage('Missing required --title')
  if (title.length > 160) usage('Title must be 160 characters or fewer')

  const database = openDb()
  try {
    const row = database
      .prepare('SELECT id, slot, title, archived_at AS archivedAt FROM agent_slots WHERE id = ?')
      .get(agentId)

    if (!row) die(`Session not found: ${agentId}`)
    if (!row.slot.startsWith('session-')) die('Only started sessions can be renamed')

    const changed = row.title !== title
    if (changed) {
      database.prepare('UPDATE agent_slots SET title = ? WHERE id = ?').run(title, agentId)
    }

    const result = {
      id: row.id,
      title,
      previousTitle: row.title,
      changed,
      archivedAt: row.archivedAt ?? null,
    }
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (changed) {
      console.log(`Renamed session ${row.id}: ${title}`)
    } else {
      console.log(`Session ${row.id} already named: ${title}`)
    }
  } finally {
    database.close()
  }
}

function openDb() {
  mkdirSync(dirname(dbPath), { recursive: true })
  if (!existsSync(dbPath)) die(`Aether database not found: ${dbPath}`)
  const database = new DatabaseSync(dbPath)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA foreign_keys = ON')
  return database
}

function parseArgs(args) {
  const options = { _: [] }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--') {
      options._.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[index + 1]
      if (!value || value.startsWith('--')) usage(`Missing value for ${arg}`)
      options[key] = value
      index += 1
      continue
    }
    options._.push(arg)
  }
  return options
}

function usage(error) {
  if (error) console.error(error)
  console.error(`
Usage:
  pnpm aether:title --agent agent-id --title "Current task" [--json]
  AETHER_AGENT_ID=agent-id pnpm aether:title --title "Current task" [--json]
`)
  process.exit(error ? 1 : 0)
}

function die(message) {
  console.error(message)
  process.exit(1)
}
