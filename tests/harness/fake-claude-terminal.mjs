#!/usr/bin/env node
// Emulates the Claude Code CLI surface kiri's claudeLaunch depends on:
// --session-id/--resume selection, the positional prompt, and the session
// JSONL file under $HOME/.claude/projects/<project-key>/<sessionId>.jsonl
// that claudeSessionExists() uses to decide fresh vs resume on respawn.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flagsWithValue = new Set([
  '--mcp-config',
  '--append-system-prompt',
  '--model',
  '--session-id',
  '--resume',
])
let sessionId = ''
let mode = 'fresh'
let prompt = ''
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--session-id') {
    sessionId = args[index + 1] ?? ''
  } else if (arg === '--resume') {
    sessionId = args[index + 1] ?? ''
    mode = 'resume'
  }
  if (flagsWithValue.has(arg)) {
    index += 1
    continue
  }
  if (arg.startsWith('--')) continue
  prompt = arg
}

const home = process.env.HOME ?? process.cwd()
// Use the logical project cwd kiri passes in: process.cwd() returns the
// physical path (e.g. /private/var vs /var on macOS), which would compute a
// different project key than kiri's claudeSessionExists check.
const projectCwd = process.env.KIRI_PROJECT_CWD ?? process.cwd()
const projectKey = resolve(projectCwd).replace(/[\\/]/g, '-')
const sessionPath = join(home, '.claude', 'projects', projectKey, `${sessionId || 'unknown'}.jsonl`)

mkdirSync(dirname(sessionPath), { recursive: true })
if (!existsSync(sessionPath)) writeFileSync(sessionPath, '')

process.stdout.write(`fake-claude mode:${mode} session:${sessionId}\r\n`)
if (mode === 'resume') {
  const lines = readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean)
  const last = lines.at(-1)
  if (last) process.stdout.write(`claude-remembers:${last}\r\n`)
}
if (prompt) reply(prompt)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\r' || char === '\n') {
      const command = buffer.trim()
      buffer = ''
      if (!command) continue
      if (command === 'exit') process.exit(0)
      reply(command)
    } else {
      buffer += char
    }
  }
})

function reply(text) {
  appendFileSync(sessionPath, `${text}\n`)
  process.stdout.write(`claude-reply:${text}\r\n`)
}
