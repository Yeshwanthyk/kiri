#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const trackerPath = 'docs/effect-migration-tracker.md'
const serverRoot = 'src/server'
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts'])

const allowedClassifications = new Set([
  'pure',
  'transport',
  'use-case',
  'repository',
  'projection',
  'runtime-adapter',
  'process-adapter',
  'config',
  'ui',
  'script',
  'legacy-compat',
])
const allowedStatuses = new Set([
  'not-started',
  'migrating',
  'legacy-compat',
  'migrated',
  'explicit-non-migration',
])
const allowedReviewGates = new Set(['required', 'passed', 'not-required'])
const forbiddenMigratedPatterns = [
  {
    label: 'raw SQLite import',
    pattern: /\b(from|import)\s*\(?['"](?:node:)?sqlite['"]\)?|require\(['"](?:node:)?sqlite['"]\)/,
  },
  {
    label: 'raw child process import',
    pattern: /\b(from|import)\s*\(?['"](?:node:)?child_process['"]\)?|require\(['"](?:node:)?child_process['"]\)/,
  },
  {
    label: 'module-global Map or Set',
    pattern: /^(?:export\s+)?(?:const|let)\s+\w+(?:\s*:[^=\n]+)?\s*=\s*new (Map|Set)\b/m,
  },
]

const errors = []

if (!existsSync(trackerPath)) {
  fail([`Missing tracker: ${trackerPath}`])
}

const tracker = readFileSync(trackerPath, 'utf8')
const rows = parseRows(tracker)
const serverFiles = listServerFiles(serverRoot)
const rowByFile = new Map(rows.map((row) => [row.file, row]))
const records = parseRecords(tracker)

for (const row of rows) {
  const matches = rows.filter((candidate) => candidate.file === row.file)
  if (matches.length > 1) {
    errors.push(`Duplicate tracker row for ${row.file}`)
  }
}

for (const file of serverFiles) {
  if (!rowByFile.has(file)) {
    errors.push(`Missing tracker row for ${file}`)
  }
}

for (const row of rows) {
  const fileExists = existsSync(row.file)
  if (!fileExists) {
    errors.push(`Tracker row points to missing file: ${row.file}`)
  }
  if (!allowedClassifications.has(row.classification)) {
    errors.push(`${row.file}: invalid classification ${row.classification}`)
  }
  if (!allowedStatuses.has(row.status)) {
    errors.push(`${row.file}: invalid status ${row.status}`)
  }
  if (!allowedReviewGates.has(row.reviewGate)) {
    errors.push(`${row.file}: invalid review gate ${row.reviewGate}`)
  }
  if (row.status === 'explicit-non-migration' && row.reviewGate !== 'not-required') {
    errors.push(`${row.file}: explicit non-migration rows must use review gate not-required`)
  }
  if (row.status === 'migrated' && row.reviewGate !== 'passed') {
    errors.push(`${row.file}: migrated rows must have review gate passed`)
  }
  if (row.status === 'migrated' && !records.has(row.file)) {
    errors.push(`${row.file}: migrated rows must have a matching migration record heading`)
  }
  if (row.status === 'migrated' && fileExists) {
    checkMigratedFile(row)
  }
}

if (!tracker.includes('## Migration Records')) {
  errors.push('Tracker must include ## Migration Records')
}

if (errors.length > 0) {
  fail(errors)
}

const counts = rows.reduce((acc, row) => {
  acc[row.status] = (acc[row.status] ?? 0) + 1
  return acc
}, {})

process.stdout.write(`${JSON.stringify({
  ok: true,
  trackedFiles: rows.length,
  serverFiles: serverFiles.length,
  counts,
}, null, 2)}\n`)

function parseRows(markdown) {
  const lines = markdown.split(/\r?\n/)
  const rows = []
  let inTable = false
  for (const line of lines) {
    if (line.trim() === '## File Tracker') {
      inTable = true
      continue
    }
    if (inTable && line.startsWith('## ')) break
    if (!inTable || !line.startsWith('|')) continue
    if (line.includes('---') || line.includes(' File ')) continue

    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length !== 6) continue
    rows.push({
      file: stripCode(cells[0]),
      classification: cells[1],
      targetSeam: stripCode(cells[2]),
      status: cells[3],
      reviewGate: cells[4],
      notes: cells[5],
    })
  }
  return rows
}

function parseRecords(markdown) {
  const records = new Set()
  const section = markdown.split(/^## Migration Records\s*$/m)[1] ?? ''
  for (const match of section.matchAll(/^###\s+(.+)$/gm)) {
    records.add(stripCode(match[1].trim()))
  }
  return records
}

function listServerFiles(root) {
  const files = []
  visit(root)
  return files.sort()

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile() && sourceExtensions.has(extname(path))) {
        files.push(path)
      }
    }
  }
}

function checkMigratedFile(row) {
  const body = readFileSync(row.file, 'utf8')
  for (const check of forbiddenMigratedPatterns) {
    if (check.pattern.test(body)) {
      errors.push(`${row.file}: migrated file still contains ${check.label}`)
    }
  }
}

function stripCode(value) {
  return value.replace(/^`|`$/g, '')
}

function fail(messages) {
  for (const message of messages) {
    process.stderr.write(`${message}\n`)
  }
  process.exit(1)
}
