import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import { PiRpcProcessAdapter } from './pi-rpc'
import {
  appendUserMessage,
  createForkedSession,
  getAgentLaunchConfig,
  recordAgentInfoEvent,
  recordPiTimelineEvent,
  recordPiMessages,
  replaceAgentDiffArtifacts,
  resetSession,
  setAgentStatus,
} from './db'
import { getRuntimeSettings } from './settings'

const adapters = new Map<string, PiRpcProcessAdapter>()
const adapterKeys = new Map<string, string>()
const queues = new Map<string, Promise<void>>()

export async function promptPiAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'pi') {
    throw new Error(`${config.runtime} agents can be configured, but only Pi can run chat today`)
  }
  // Register the live adapter before the queued turn starts so immediate steer/interrupt
  // requests from the composer can find the process target.
  getOrCreatePiAdapter(config)
  const previous = queues.get(config.id) ?? Promise.resolve()
  const next = previous.then(() =>
    promptPiAgentNow(config, promptWithSavedImages(config.id, input.text, input.images ?? [])),
  )
  queues.set(
    config.id,
    next.catch(() => {
      // Keep the queue alive after a failed turn.
    }),
  )
  await next
}

export async function steerPiAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  const adapter = await waitForLivePiAdapter(config)
  const text = promptWithSavedImages(config.id, input.text, input.images ?? [])
  await adapter.steer(text)
  appendUserMessage({ agentId: config.id, text })
}

export async function interruptPiAgent(input: { agentId: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  const adapter = await waitForLivePiAdapter(config)
  await adapter.abort()
}

export async function setPiThinkingLevel(input: {
  agentId: string
  level?: ThinkingLevel
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'pi') {
    throw new Error(`${config.runtime} agents do not support /thinking yet`)
  }

  const adapter = getOrCreatePiAdapter(config)
  adapter.start()
  const level = input.level ?? await adapter.cycleThinkingLevel()
  if (!level) throw new Error('No thinking levels available for this Pi model')
  if (input.level) await adapter.setThinkingLevel(input.level)

  recordAgentInfoEvent({
    agentId: config.id,
    kind: 'thinking_level',
    label: 'Thinking level changed',
    detail: level,
  })
  return level
}

export async function resetPiSession(input: { agentId: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'pi') {
    throw new Error(`${config.runtime} agents do not support /new yet`)
  }
  stopAdapter(config.id)
  resetSession(config.id)
}

export async function forkPiSession(input: { agentId: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime !== 'pi') {
    throw new Error(`${config.runtime} agents do not support /fork yet`)
  }
  const adapter = getOrCreatePiAdapter(config)
  adapter.start()
  try {
    await adapter.clone()
    const state = await adapter.getState()
    if (!state.sessionFile) {
      throw new Error('Pi did not return a cloned session file')
    }
    return createForkedSession({
      sourceAgentId: config.id,
      sessionFile: state.sessionFile,
    })
  } finally {
    stopAdapter(config.id)
  }
}

async function promptPiAgentNow(
  config: ReturnType<typeof getAgentLaunchConfig>,
  text: string,
) {
  if (config.runtime !== 'pi') {
    throw new Error(`${config.runtime} agents can be configured, but only Pi can run chat today`)
  }

  const adapter = getOrCreatePiAdapter(config)

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

async function waitForLivePiAdapter(config: ReturnType<typeof getAgentLaunchConfig>) {
  if (config.runtime !== 'pi') {
    throw new Error(`${config.runtime} agents can be configured, but only Pi can run chat today`)
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const adapter = adapters.get(config.id)
    if (adapter) return adapter
    await sleep(100)
  }

  throw new Error('This session is not currently running in this Pican server process')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stopAdapter(agentId: string) {
  const adapter = adapters.get(agentId)
  adapter?.stop()
  adapters.delete(agentId)
  adapterKeys.delete(agentId)
  queues.delete(agentId)
}

function getOrCreatePiAdapter(config: ReturnType<typeof getAgentLaunchConfig>) {
  let adapter = adapters.get(config.id)
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
  return adapter
}

function promptWithSavedImages(agentId: string, text: string, images: SendMessageImage[]) {
  if (images.length === 0) return text

  const paths = images.map((image, index) => savePromptImage(agentId, image, index))
  return `${text.trim()}\n\nAttached image files:\n${paths
    .map((path) => `- ${path}`)
    .join('\n')}\n\nUse these file paths if you need to inspect the images.`
}

function savePromptImage(agentId: string, image: SendMessageImage, index: number) {
  const bytes = Buffer.from(image.data, 'base64')
  if (bytes.length > 5 * 1024 * 1024) {
    throw new Error(`Image "${image.name}" is larger than 5MB`)
  }

  const dir = join(process.cwd(), '.pican', 'attachments', safePathSegment(agentId))
  mkdirSync(dir, { recursive: true })
  const extension = imageExtension(image)
  const path = join(
    dir,
    `${Date.now()}-${index + 1}-${safePathSegment(image.name, 'image')}${extension}`,
  )
  writeFileSync(path, bytes, { flag: 'wx' })
  return path
}

function imageExtension(image: SendMessageImage) {
  const existing = extname(image.name).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(existing)) return ''
  if (image.mimeType === 'image/png') return '.png'
  if (image.mimeType === 'image/webp') return '.webp'
  if (image.mimeType === 'image/gif') return '.gif'
  return '.jpg'
}

function safePathSegment(value: string, fallback = 'attachment') {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || fallback
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
