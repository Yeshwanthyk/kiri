import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const appName = 'kiri.app'
const appProcessName = 'kiri'
const arch = process.env.npm_config_arch ?? process.arch
const source = resolve(`dist/mac-${arch}`, appName)
const applicationsDir = join(homedir(), 'Applications')
const destination = join(applicationsDir, appName)
const appContentsDir = join(destination, 'Contents')

if (isMainModule()) {
  if (!existsSync(source)) {
    console.error(`Desktop app bundle not found: ${source}`)
    console.error('Run pnpm dist:desktop first.')
    process.exit(1)
  }

  terminateRunningApp(appContentsDir)

  mkdirSync(applicationsDir, { recursive: true })
  rmSync(destination, { recursive: true, force: true })

  const copyResult = spawnSync('ditto', ['--rsrc', '--extattr', source, destination], {
    stdio: 'inherit',
  })
  if (copyResult.status !== 0) {
    process.exit(copyResult.status ?? 1)
  }

  const result = spawnSync('open', [destination], {
    env: openAppEnv(),
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  console.log(`Installed and opened ${destination}`)
}

export function terminateRunningApp(contentsDir) {
  const firstPass = runningPids(contentsDir)
  if (firstPass.length === 0) return

  spawnSync('kill', firstPass, { stdio: 'ignore' })
  spawnSync('sleep', ['1'], { stdio: 'ignore' })

  const remaining = runningPids(contentsDir)
  if (remaining.length > 0) {
    spawnSync('kill', ['-9', ...remaining], { stdio: 'ignore' })
  }
}

export function runningPids(contentsDir) {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (result.status !== 0) return []
  return runningPidsFromPs(result.stdout, contentsDir)
}

export function runningPidsFromPs(output, contentsDir) {
  return output
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/)
      if (!match) return []
      const [, pid, command] = match
      return commandBelongsToAppBundle(command, contentsDir) ? [pid] : []
    })
}

export function commandBelongsToAppBundle(command, contentsDir) {
  return command.startsWith(`${contentsDir}/`)
}

function openAppEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  delete env.ELECTRON_ENABLE_LOGGING
  return env
}

function isMainModule() {
  return process.argv[1] === fileURLToPath(import.meta.url)
}
