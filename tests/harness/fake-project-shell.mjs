import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cwd, env, pid, stdin, stdout } from 'node:process'

const capturePath = env.KIRI_CAPTURE_PATH
const session = env.KIRI_FAKE_TERMINAL_SESSION ?? `shell-${pid}`
let sequence = 0
let buffer = ''

writeLine(`shell:ready:${session}:${pid}:0:${cwd()}`)
stdin.setEncoding('utf8')
stdin.on('data', (chunk) => {
  buffer += chunk.replaceAll('\r', '\n')
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) handleLine(line)
    newline = buffer.indexOf('\n')
  }
})
stdin.resume()

function handleLine(line) {
  sequence += 1
  if (line.startsWith('edit ')) {
    const file = line.slice('edit '.length)
    writeFileSync(join(cwd(), file), `edited:${file}\n`)
    writeLine(`shell:paste:${session}:${pid}:${sequence}:edited:${file}`)
    return
  }
  if (line.startsWith('run ')) {
    writeLine(`shell:paste:${session}:${pid}:${sequence}:running:${line.slice('run '.length)}`)
    return
  }
  writeLine(`shell:paste:${session}:${pid}:${sequence}:${line}`)
}

function writeLine(line) {
  stdout.write(`${line}\n`)
  if (!capturePath) return
  mkdirSync(dirname(capturePath), { recursive: true })
  appendFileSync(capturePath, `${line}\n`)
}
