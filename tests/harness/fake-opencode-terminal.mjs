#!/usr/bin/env node
// Emulates the opencode CLI surface kiri's opencodeLaunch uses: positional
// project directory, --model/--session flags, stdin prompt loop.
const args = process.argv.slice(2)
const mode = args.includes('--session') ? 'resume' : 'fresh'

process.stdout.write(`fake-opencode ready mode:${mode}\r\n`)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\r' || char === '\n') {
      const command = buffer.trim()
      buffer = ''
      if (!command) continue
      if (command === 'exit') process.exit(0)
      process.stdout.write(`opencode-reply:${command}\r\n`)
    } else {
      buffer += char
    }
  }
})
