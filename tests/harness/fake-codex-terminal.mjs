#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const resumeIndex = args.indexOf('resume')
const resumeId = resumeIndex >= 0
  ? args.at(-1)
  : undefined
const agentId = process.env.KIRI_AGENT_ID ?? 'agent'
const cwd = process.env.KIRI_PROJECT_CWD ?? process.cwd()
const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? process.cwd(), '.codex')
const sessionId = resumeId ?? `fake-session-${agentId}`
const mode = resumeId ? 'resume' : 'fresh'
const statePath = join(codexHome, 'fake-state', `${sessionId}.txt`)

writeSessionMetadata()
process.stdout.write(`fake-codex-terminal mode:${mode} session:${sessionId} pid:${process.pid}\r\n`)
process.stdout.write(`fake-codex-terminal args:${JSON.stringify(args)}\r\n`)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\r' || char === '\n') {
      const command = buffer.trim()
      buffer = ''
      if (command) handleCommand(command)
    } else {
      buffer += char
    }
  }
})

function handleCommand(command) {
  if (command === 'exit') {
    process.stdout.write(`bye session:${sessionId}\r\n`)
    process.exit(0)
  }
  if (command.startsWith('remember ')) {
    const value = command.slice('remember '.length)
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, value)
    process.stdout.write(`remembered:${value}:session:${sessionId}:pid:${process.pid}\r\n`)
    return
  }
  if (command === 'state') {
    let value = ''
    try {
      value = readFileSync(statePath, 'utf8')
    } catch {
      value = 'missing'
    }
    process.stdout.write(`state:${value}:session:${sessionId}:mode:${mode}:pid:${process.pid}\r\n`)
    return
  }
  process.stdout.write(`echo:${command}:session:${sessionId}:mode:${mode}\r\n`)
}

function writeSessionMetadata() {
  const path = join(codexHome, 'sessions', '2026', '05', '15', `rollout-${sessionId}.jsonl`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: sessionId,
      cwd,
      originator: 'codex_cli_rs',
    },
  })}\n`)
}
