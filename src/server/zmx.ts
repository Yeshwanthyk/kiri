import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export type ZmxListEntry = {
  readonly name: string
  readonly pid?: number
  readonly clients?: number
  readonly created?: number
  readonly raw: string
}

export type ZmxExecFile = (
  file: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly env?: NodeJS.ProcessEnv },
) => Promise<{ readonly stdout: string; readonly stderr: string }>

const kiriZmxPrefix = 'kiri-'
const namePrefixLength = 12
const digestLength = 24

export function zmxEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.KIRI_ZMX === '1'
}

export function zmxSessionName(key: string) {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, digestLength)
  const readable = key
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, namePrefixLength) || 'session'
  return `${kiriZmxPrefix}${readable}-${digest}`
}

export function isKiriZmxSession(name: string) {
  return name.startsWith(kiriZmxPrefix)
}

export function zmxAttachArgv(
  name: string,
  command: string,
  args: readonly string[],
) {
  return ['attach', name, command, ...args]
}

export function resolveZmxBinary(input: {
  readonly env?: NodeJS.ProcessEnv
  readonly exists?: (path: string) => boolean
} = {}) {
  const env = input.env ?? process.env
  if (!zmxEnabled(env)) return null
  const override = env.KIRI_ZMX_BIN?.trim()
  if (override) return executableExists(override, input.exists) ? override : null
  return findOnPath('zmx', env, input.exists)
}

export function parseZmxListOutput(output: string): ZmxListEntry[] {
  const entries: ZmxListEntry[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const raw = rawLine.trim()
    if (!raw) continue
    const line = raw.startsWith('→ ') ? raw.slice(2).trim() : raw
    if (!line.includes('=')) {
      entries.push({ name: line, raw: rawLine })
      continue
    }
    const fields = new Map<string, string>()
    for (const part of line.split('\t')) {
      const separator = part.indexOf('=')
      if (separator <= 0) continue
      fields.set(part.slice(0, separator), part.slice(separator + 1))
    }
    const name = fields.get('name')
    if (!name) continue
    entries.push({
      name,
      raw: rawLine,
      ...numberField(fields, 'pid'),
      ...numberField(fields, 'clients'),
      ...numberField(fields, 'created'),
    })
  }
  return entries
}

export async function zmxListSessions(input: {
  readonly binary: string
  readonly env?: NodeJS.ProcessEnv
  readonly execFile?: ZmxExecFile
}) {
  const result = await execZmx(input, ['list', '--short'])
  return parseZmxListOutput(result.stdout).map((entry) => entry.name)
}

export async function zmxKillSession(input: {
  readonly binary: string
  readonly name: string
  readonly env?: NodeJS.ProcessEnv
  readonly force?: boolean
  readonly execFile?: ZmxExecFile
}) {
  await execZmx(input, ['kill', input.name, ...(input.force ? ['--force'] : [])])
}

export async function zmxSend(input: {
  readonly binary: string
  readonly name: string
  readonly data: string
  readonly env?: NodeJS.ProcessEnv
  readonly execFile?: ZmxExecFile
}) {
  await execZmx(input, ['send', input.name, input.data])
}

function numberField(fields: Map<string, string>, key: 'pid' | 'clients' | 'created') {
  const value = fields.get(key)
  if (!value || !/^\d+$/.test(value)) return {}
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? { [key]: parsed } : {}
}

function executableExists(path: string, exists?: (path: string) => boolean) {
  if (exists) return exists(path)
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  exists?: (path: string) => boolean,
) {
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (!entry) continue
    const candidate = isAbsolute(command) ? command : join(entry, command)
    if (executableExists(candidate, exists)) return candidate
  }
  return null
}

function execZmx(
  input: { readonly binary: string; readonly env?: NodeJS.ProcessEnv; readonly execFile?: ZmxExecFile },
  args: readonly string[],
) {
  const run = input.execFile ?? execFileUtf8
  return run(input.binary, args, { encoding: 'utf8', env: input.env })
}

function execFileUtf8(
  file: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly env?: NodeJS.ProcessEnv },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(error instanceof Error ? error : new Error('zmx command failed'))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}
