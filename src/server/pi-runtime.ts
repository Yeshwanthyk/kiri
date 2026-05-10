import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { PiRpcProcessAdapter } from './pi-rpc'
import {
  appendUserMessage,
  getAgentLaunchConfig,
  recordPiTimelineEvent,
  recordPiMessages,
  replaceAgentDiffArtifacts,
  setAgentStatus,
} from './db'
import { getRuntimeSettings } from './settings'

const adapters = new Map<string, PiRpcProcessAdapter>()
const adapterKeys = new Map<string, string>()
const queues = new Map<string, Promise<void>>()

export async function promptPiAgent(input: { agentId: string; text: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  const previous = queues.get(config.id) ?? Promise.resolve()
  const next = previous.then(() => promptPiAgentNow(config, input.text))
  queues.set(
    config.id,
    next.catch(() => {
      // Keep the queue alive after a failed turn.
    }),
  )
  await next
}

async function promptPiAgentNow(
  config: ReturnType<typeof getAgentLaunchConfig>,
  text: string,
) {
  let adapter = adapters.get(config.id)
  if (config.runtime !== 'pi') {
    throw new Error(`${config.runtime} agents can be configured, but only Pi can run chat today`)
  }

  const settings = getRuntimeSettings(config.runtime)
  const adapterKey = JSON.stringify({
    cwd: config.cwd,
    sessionDir: config.sessionDir,
    sessionFile: config.sessionFile,
    model: config.model,
    models: settings.models,
  })
  if (adapter && adapterKeys.get(config.id) !== adapterKey) {
    adapter.stop()
    adapters.delete(config.id)
    adapterKeys.delete(config.id)
    adapter = undefined
  }

  if (!adapter) {
    adapter = new PiRpcProcessAdapter({
      cwd: config.cwd,
      sessionDir: config.sessionDir,
      sessionFile: config.sessionFile ?? undefined,
      model: config.model,
      models: settings.models,
    })
    adapters.set(config.id, adapter)
    adapterKeys.set(config.id, adapterKey)
  }

  setAgentStatus(config.id, 'running')
  appendUserMessage({ agentId: config.id, text })
  let stopRecordingEvents: (() => void) | undefined
  try {
    adapter.start()
    stopRecordingEvents = adapter.onEvent((event) => {
      try {
        recordPiTimelineEvent({ agentId: config.id, event })
      } catch {
        // Runtime events are observability data; the turn transcript remains authoritative.
      }
    })
    const before = await adapter.getState()
    const turnStartedAt = Date.now()
    const messages = await adapter.promptAndWait(text)
    const turnCompletedAt = Date.now()
    const after = await adapter.getState()
    recordPiMessages({
      agentId: config.id,
      promptText: text,
      messages,
      turnStartedAt,
      turnCompletedAt,
      sessionFile: after.sessionFile ?? before.sessionFile,
    })
    try {
      replaceAgentDiffArtifacts({
        agentId: config.id,
        diffs: collectGitDiffArtifacts(config.cwd),
      })
    } catch {
      // Diff capture is a projection for the UI; chat persistence is authoritative.
    }
  } finally {
    stopRecordingEvents?.()
    setAgentStatus(config.id, 'idle')
  }
}

type RuntimeDiffArtifact = {
  title: string
  path: string
  patch: string
}

function collectGitDiffArtifacts(cwd: string): RuntimeDiffArtifact[] {
  if (!isGitWorkTree(cwd)) return []
  const patches = [
    ...splitGitPatch(runGit(cwd, [
      'diff',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--binary',
      '--',
    ])),
    ...untrackedFiles(cwd).flatMap((path) =>
      splitGitPatch(runGitAllowExit(cwd, [
        'diff',
        '--no-ext-diff',
        '--no-index',
        '--',
        '/dev/null',
        path,
      ])),
    ),
  ]
  return patches
    .map((patch) => {
      const path = diffPath(patch)
      if (!path || shouldSkipDiffPath(path)) return null
      return {
        title: basename(path),
        path,
        patch,
      }
    })
    .filter((diff): diff is RuntimeDiffArtifact => diff !== null)
}

function isGitWorkTree(cwd: string) {
  try {
    return runGit(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
  } catch {
    return false
  }
}

function untrackedFiles(cwd: string) {
  return runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter((path) => path.length > 0 && !shouldSkipDiffPath(path))
}

function shouldSkipDiffPath(path: string) {
  return ['.pi/', '.pican/', 'node_modules/', 'dist/'].some((prefix) =>
    path.startsWith(prefix),
  )
}

function splitGitPatch(patch: string) {
  const trimmed = patch.trim()
  if (!trimmed) return []
  return trimmed
    .split(/\n(?=diff --git )/)
    .map((section) => section.trim())
    .filter((section) => section.startsWith('diff --git '))
}

function diffPath(patch: string) {
  const match = /^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/m.exec(patch)
  if (!match) return null
  return cleanDiffPath(match[2] ?? match[1] ?? '')
}

function cleanDiffPath(path: string) {
  return path
    .replace(/^"|"$/g, '')
    .replace(/^b\//, '')
    .trim()
}

function runGit(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function runGitAllowExit(cwd: string, args: string[]) {
  try {
    return runGit(cwd, args)
  } catch (error) {
    const output = (error as { stdout?: Buffer | string }).stdout
    if (Buffer.isBuffer(output)) return output.toString('utf8')
    if (typeof output === 'string') return output
    return ''
  }
}
