#!/usr/bin/env node
// Emulates the pi CLI surface kiri's piLaunch uses: --session-dir/--session/
// --model flags and a stdin-driven prompt loop.
const args = process.argv.slice(2)
const sessionDirIndex = args.indexOf('--session-dir')
const sessionDir = sessionDirIndex >= 0 ? args[sessionDirIndex + 1] ?? '' : ''

process.stdout.write(`fake-pi ready session-dir:${sessionDir}\r\n`)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\r' || char === '\n') {
      const command = buffer.trim()
      buffer = ''
      if (!command) continue
      if (command === 'exit') process.exit(0)
      process.stdout.write(`pi-reply:${command}\r\n`)
    } else {
      buffer += char
    }
  }
})
