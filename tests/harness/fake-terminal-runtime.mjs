import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { argv, env, pid, stdin, stdout } from 'node:process'

export function runFakeTerminal(runtime) {
  const capturePath = env.KIRI_CAPTURE_PATH
  const session = runtimeSession(runtime)
  const mode = argv.includes('--resume') || argv.includes('resume') ? 'resume' : 'fresh'
  let sequence = 0
  let buffer = ''

  writeLine(`${runtime}:ready:${session}:${pid}:mode:${mode}`)
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => {
    buffer += chunk.replaceAll('\r', '\n')
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) {
        if (line === 'exit') {
          writeLine(`${runtime}:bye:${session}:${pid}`)
          process.exit(0)
        }
        sequence += 1
        writeLine(`${runtime}:paste:${session}:${pid}:${sequence}:${line}`)
      }
      newline = buffer.indexOf('\n')
    }
  })
  stdin.resume()

  function writeLine(line) {
    stdout.write(`${line}\n`)
    if (!capturePath) return
    mkdirSync(dirname(capturePath), { recursive: true })
    appendFileSync(capturePath, `${line}\n`)
  }
}

function runtimeSession(runtime) {
  if (env.KIRI_FAKE_TERMINAL_SESSION) return env.KIRI_FAKE_TERMINAL_SESSION
  if (runtime === 'claude' && env.KIRI_CLAUDE_SESSION_ID) return env.KIRI_CLAUDE_SESSION_ID
  return `${runtime}-${Date.now()}`
}
