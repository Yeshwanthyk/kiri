import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const appName = 'Aether.app'
const appProcessName = 'Aether'
const arch = process.env.npm_config_arch ?? process.arch
const source = resolve(`dist/mac-${arch}`, appName)
const applicationsDir = join(homedir(), 'Applications')
const destination = join(applicationsDir, appName)
const appProcessPattern = `${appName}/Contents/MacOS/${appProcessName}`
const appBundlePattern = `${appName}/Contents/`

if (!existsSync(source)) {
  console.error(`Desktop app bundle not found: ${source}`)
  console.error('Run pnpm dist:desktop first.')
  process.exit(1)
}

terminateRunningApp([appProcessPattern, appBundlePattern])

mkdirSync(applicationsDir, { recursive: true })
rmSync(destination, { recursive: true, force: true })

const copyResult = spawnSync('ditto', ['--rsrc', '--extattr', source, destination], {
  stdio: 'inherit',
})
if (copyResult.status !== 0) {
  process.exit(copyResult.status ?? 1)
}

const result = spawnSync('open', [destination], { stdio: 'inherit' })
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

console.log(`Installed and opened ${destination}`)

function terminateRunningApp(patterns) {
  const firstPass = runningPids(patterns)
  if (firstPass.length === 0) return

  spawnSync('kill', firstPass, { stdio: 'ignore' })
  spawnSync('sleep', ['1'], { stdio: 'ignore' })

  const remaining = runningPids(patterns)
  if (remaining.length > 0) {
    spawnSync('kill', ['-9', ...remaining], { stdio: 'ignore' })
  }
}

function runningPids(patterns) {
  const pids = new Set()
  for (const pattern of patterns) {
    const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
    if (result.status !== 0) continue
    for (const pid of result.stdout.split('\n')) {
      const trimmed = pid.trim()
      if (trimmed) pids.add(trimmed)
    }
  }
  return [...pids]
}
