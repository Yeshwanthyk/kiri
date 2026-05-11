import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import { PiRpcProcessAdapter } from './pi-rpc'
import {
  appendUserMessage,
  createForkedSession,
  getAgentLaunchConfig,
  getAgentThinkingLevel,
  recordAgentInfoEvent,
  recordPiTimelineEvent,
  recordPiMessages,
  resetSession,
  setAgentStatus,
} from './db'
import { collectGitDiffArtifacts } from './git-diff'
import {
  captureRuntimeDiffs,
  enqueueAgentTurn,
} from './runtime-lifecycle'
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
  await enqueueAgentTurn(config.id, queues, () =>
    promptPiAgentNow(config, promptWithSavedImages(config.id, input.text, input.images ?? [])),
  )
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
  archivePiSessionFiles(config.sessionDir)
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

  appendUserMessage({ agentId: config.id, text })
  setAgentStatus(config.id, 'running')
  let stopRecordingEvents: (() => void) | undefined
  try {
    adapter.start()
    const thinkingLevel = getAgentThinkingLevel(config.id)
    if (thinkingLevel) await adapter.setThinkingLevel(thinkingLevel)
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
    captureRuntimeDiffs(config.id, () => collectGitDiffArtifacts(config.cwd))
  } finally {
    stopRecordingEvents?.()
    setAgentStatus(config.id, 'idle')
  }
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

  throw new Error('This session is not currently running in this Aether server process')
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

function archivePiSessionFiles(sessionDir: string) {
  if (!existsSync(sessionDir)) return
  const sessionFiles = readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
  if (!sessionFiles.length) return

  const archiveDir = join(sessionDir, '.archive', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(archiveDir, { recursive: true })
  for (const file of sessionFiles) {
    renameSync(join(sessionDir, file), join(archiveDir, file))
  }
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

  const dir = join(process.cwd(), '.aether', 'attachments', safePathSegment(agentId))
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
