import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DESKTOP_PATH_ENTRIES = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
]

export function resolveRuntimeExecutable(command: string, configuredPath?: string) {
  const explicit = configuredPath?.trim()
  if (explicit) return explicit
  return executableOnPath(command) ?? firstExistingPath(DESKTOP_PATH_ENTRIES.map((entry) => join(entry, command))) ?? command
}

export function runtimeProcessEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = process.env.PATH ?? ''
  const entries = [...DESKTOP_PATH_ENTRIES, ...path.split(delimiter).filter(Boolean)]
  return {
    ...process.env,
    ...extra,
    PATH: Array.from(new Set(entries)).join(delimiter),
  }
}

function executableOnPath(command: string) {
  for (const entry of process.env.PATH?.split(delimiter) ?? []) {
    if (!entry) continue
    const candidate = join(entry, command)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function firstExistingPath(paths: ReadonlyArray<string>) {
  return paths.find((path) => existsSync(path))
}
