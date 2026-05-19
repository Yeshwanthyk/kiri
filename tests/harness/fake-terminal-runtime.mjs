import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { stdin, stdout } from 'node:process'

export function runFakeTerminal(runtime) {
  const capturePath = process.env.KIRI_CAPTURE_PATH
  const session = process.env.KIRI_FAKE_TERMINAL_SESSION ?? `${runtime}-${Date.now()}`
  let sequence = 0
  let buffer = ''

  writeLine(`${runtime}:ready:${session}:${process.pid}`)
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => {
    buffer += chunk.replaceAll('\r', '\n')
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) {
        sequence += 1
        writeLine(`${runtime}:paste:${session}:${process.pid}:${sequence}:${line}`)
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
