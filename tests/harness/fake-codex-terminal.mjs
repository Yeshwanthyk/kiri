#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cwd, env, pid, stdin, stdout } from 'node:process'

const args = process.argv.slice(2)
const resumeIndex = args.indexOf('resume')
const isResume = resumeIndex !== -1
const sessionId = isResume
  ? args.at(-1) ?? `fake-session-${pid}`
  : `fake-session-${pid}`
const codexHome = env.CODEX_HOME ?? join(env.HOME ?? cwd(), '.codex')
const capturePath = env.KIRI_CAPTURE_PATH
const statePath = join(codexHome, 'fake-terminal-state.json')
const mode = isResume ? 'resume' : 'fresh'
let remembered = readState()[sessionId] ?? ''
let buffer = ''
let sequence = 0

writeCodexSessionFile()
writeLine(`fake-codex-terminal mode:${mode} session:${sessionId}`)

const initialPrompt = isResume ? null : freshPrompt(args)
if (initialPrompt) handleLine(initialPrompt)

stdin.setEncoding('utf8')
stdin.on('data', (chunk) => {
  buffer += chunk.replaceAll('\r', '\n')
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    handleLine(line)
    newline = buffer.indexOf('\n')
  }
})
stdin.resume()

function handleLine(line) {
  if (!line) return
  capturePaste(line)
  if (line.startsWith('remember ')) {
    remembered = line.slice('remember '.length)
    const state = readState()
    state[sessionId] = remembered
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(state, null, 2))
    writeLine(`remembered:${remembered}:session:${sessionId}`)
    return
  }
  if (line === 'state') {
    writeLine(`state:${remembered}:session:${sessionId}:mode:${mode}`)
    return
  }
  if (line === 'exit') {
    writeLine(`bye session:${sessionId}`)
    process.exit(0)
  }
  writeLine(line)
}

function freshPrompt(argv) {
  let skipNext = false
  let prompt = null
  for (const arg of argv) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (arg === '--model' || arg === '-m') {
      skipNext = true
      continue
    }
    if (arg.startsWith('-')) continue
    prompt = arg
  }
  return prompt
}

function writeLine(line) {
  stdout.write(`${line}\n`)
}

function capturePaste(text) {
  if (!capturePath) return
  sequence += 1
  mkdirSync(dirname(capturePath), { recursive: true })
  appendFileSync(capturePath, `codex:paste:${sessionId}:${pid}:${sequence}:${text}\n`)
}

function writeCodexSessionFile() {
  const sessionPath = join(codexHome, 'sessions', 'fake', `${sessionId}.jsonl`)
  mkdirSync(dirname(sessionPath), { recursive: true })
  appendFileSync(sessionPath, `${JSON.stringify({
    payload: {
      id: sessionId,
      cwd: cwd(),
    },
  })}\n`)
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return {}
  }
}
