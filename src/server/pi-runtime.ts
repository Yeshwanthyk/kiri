import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { Effect } from 'effect'
import type { SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import { PiRpcProcessAdapter, PiRpcProcessError } from './pi-rpc'
import {
  fileOperationFromPiEvent,
  fileOperationStatusFromEvent,
  isFileOperationCompletionEvent,
} from './runtime-file-operations'
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
import { attachmentDirPath, getKiriConfig } from './kiri-config'
import { collectGitDiffArtifacts } from './git-diff'
import {
  captureRuntimeDiffs,
  enqueueAgentTurn,
  projectRuntimeEvent,
  RuntimeLifecycleError,
  runRuntimeLifecyclePromise,
  runRuntimeLifecycleSync,
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
  await runRuntimeLifecyclePromise(enqueueAgentTurn(config.id, queues, () =>
    promptPiAgentNow(config, promptWithSavedImages(config.id, input.text, input.images ?? [])),
  ))
}

export async function steerPiAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  await runRuntimeLifecyclePromise(steerPiAgentEffect(input))
}

export async function interruptPiAgent(input: { agentId: string }) {
  await runRuntimeLifecyclePromise(interruptPiAgentEffect(input))
}

export async function setPiThinkingLevel(input: {
  agentId: string
  level?: ThinkingLevel
}) {
  return runRuntimeLifecyclePromise(setPiThinkingLevelEffect(input))
}

export async function resetPiSession(input: { agentId: string }) {
  await runRuntimeLifecyclePromise(resetPiSessionEffect(input))
}

export async function forkPiSession(input: { agentId: string }) {
  return runRuntimeLifecyclePromise(forkPiSessionEffect(input))
}

async function promptPiAgentNow(
  config: ReturnType<typeof getAgentLaunchConfig>,
  text: string,
) {
  await runRuntimeLifecyclePromise(promptPiAgentNowEffect(config, text))
}

function steerPiAgentEffect(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  return Effect.gen(function* () {
    const config = yield* Effect.sync(() => getAgentLaunchConfig(input.agentId))
    yield* requirePiRuntime(config, 'can be configured, but only Pi can run chat today')
    const adapter = yield* waitForLivePiAdapterEffect(config)
    const text = yield* Effect.sync(() =>
      promptWithSavedImages(config.id, input.text, input.images ?? []))
    yield* piRpcEffect(adapter.steerEffect(text))
    yield* Effect.sync(() => {
      appendUserMessage({ agentId: config.id, text })
    })
  })
}

function interruptPiAgentEffect(input: { agentId: string }) {
  return Effect.gen(function* () {
    const config = yield* Effect.sync(() => getAgentLaunchConfig(input.agentId))
    yield* requirePiRuntime(config, 'can be configured, but only Pi can run chat today')
    const adapter = yield* waitForLivePiAdapterEffect(config)
    yield* piRpcEffect(adapter.abortEffect())
  })
}

function setPiThinkingLevelEffect(input: {
  agentId: string
  level?: ThinkingLevel
}) {
  return Effect.gen(function* () {
    const config = yield* Effect.sync(() => getAgentLaunchConfig(input.agentId))
    yield* requirePiRuntime(config, 'agents do not support /thinking yet')
    const adapter = yield* Effect.sync(() => getOrCreatePiAdapter(config))
    yield* piRpcEffect(adapter.startEffect())
    const level = input.level ?? (yield* piRpcEffect(adapter.cycleThinkingLevelEffect()))
    if (!level) {
      return yield* runtimeFailure(new Error('No thinking levels available for this Pi model'))
    }
    if (input.level) yield* piRpcEffect(adapter.setThinkingLevelEffect(input.level))

    yield* Effect.sync(() => {
      recordAgentInfoEvent({
        agentId: config.id,
        kind: 'thinking_level',
        label: 'Thinking level changed',
        detail: level,
      })
    })
    return level
  })
}

function resetPiSessionEffect(input: { agentId: string }) {
  return Effect.gen(function* () {
    const config = yield* Effect.sync(() => getAgentLaunchConfig(input.agentId))
    yield* requirePiRuntime(config, 'agents do not support /new yet')
    yield* Effect.sync(() => {
      stopAdapter(config.id)
      archivePiSessionFiles(config.sessionDir)
      resetSession(config.id)
    })
  })
}

function forkPiSessionEffect(input: { agentId: string }) {
  return Effect.gen(function* () {
    const config = yield* Effect.sync(() => getAgentLaunchConfig(input.agentId))
    yield* requirePiRuntime(config, 'agents do not support /fork yet')
    const adapter = yield* Effect.sync(() => getOrCreatePiAdapter(config))
    yield* piRpcEffect(adapter.startEffect())
    return yield* Effect.gen(function* () {
      yield* piRpcEffect(adapter.cloneEffect())
      const state = yield* piRpcEffect(adapter.getStateEffect())
      if (!state.sessionFile) {
        return yield* runtimeFailure(new Error('Pi did not return a cloned session file'))
      }
      const sessionFile = state.sessionFile
      return yield* Effect.sync(() =>
        createForkedSession({
          sourceAgentId: config.id,
          sessionFile,
        }))
    }).pipe(
      Effect.ensuring(Effect.sync(() => {
        stopAdapter(config.id)
      })),
    )
  })
}

function promptPiAgentNowEffect(
  config: ReturnType<typeof getAgentLaunchConfig>,
  text: string,
) {
  return Effect.gen(function* () {
    yield* requirePiRuntime(config, 'can be configured, but only Pi can run chat today')
    const adapter = yield* Effect.sync(() => getOrCreatePiAdapter(config))
    yield* Effect.sync(() => {
      appendUserMessage({ agentId: config.id, text })
      setAgentStatus(config.id, 'running')
    })

    let stopRecordingEvents: (() => void) | undefined
    yield* Effect.gen(function* () {
      yield* piRpcEffect(adapter.startEffect())
      const thinkingLevel = getAgentThinkingLevel(config.id)
      if (thinkingLevel) yield* piRpcEffect(adapter.setThinkingLevelEffect(thinkingLevel))
      stopRecordingEvents = adapter.onEvent((event) => {
        try {
          recordPiTimelineEvent({ agentId: config.id, event })
          recordPiFileOperationEvent(config.id, config.cwd, event)
        } catch {
          // Runtime events are observability data; the turn transcript remains authoritative.
        }
      })
      const before = yield* piRpcEffect(adapter.getStateEffect())
      const turnStartedAt = Date.now()
      const messages = yield* piRpcEffect(adapter.promptAndWaitEffect(text))
      const turnCompletedAt = Date.now()
      const after = yield* piRpcEffect(adapter.getStateEffect())
      yield* Effect.sync(() => {
        recordPiMessages({
          agentId: config.id,
          promptText: text,
          messages,
          turnStartedAt,
          turnCompletedAt,
          sessionFile: after.sessionFile ?? before.sessionFile,
        })
      })
      yield* captureRuntimeDiffs(config.id, () => collectGitDiffArtifacts(config.cwd))
    }).pipe(
      Effect.ensuring(Effect.sync(() => {
        stopRecordingEvents?.()
        setAgentStatus(config.id, 'idle')
      })),
    )
  })
}

function recordPiFileOperationEvent(agentId: string, cwd: string, event: Record<string, unknown>) {
  const operation = fileOperationFromPiEvent(event)
  if (!operation) return
  const completed = isFileOperationCompletionEvent(event)
  runRuntimeLifecycleSync(projectRuntimeEvent(completed
    ? {
        type: 'fileOperationCompleted',
        agentId,
        status: fileOperationStatusFromEvent(event),
        ...operation,
      }
    : {
        type: 'fileOperationStarted',
        agentId,
        ...operation,
      }))
  if (completed) {
    runRuntimeLifecycleSync(captureRuntimeDiffs(agentId, () => collectGitDiffArtifacts(cwd)))
  }
}

async function waitForLivePiAdapter(config: ReturnType<typeof getAgentLaunchConfig>) {
  if (config.runtime !== 'pi') {
    throw new Error(`${config.runtime} agents can be configured, but only Pi can run chat today`)
  }

  return waitForLivePiAdapterAttempt(config.id, 30)
}

async function waitForLivePiAdapterAttempt(agentId: string, attemptsRemaining: number): Promise<PiRpcProcessAdapter> {
  const adapter = adapters.get(agentId)
  if (adapter) return adapter
  if (attemptsRemaining <= 0) {
    throw new Error('This session is not currently running in this kiri server process')
  }
  await sleep(100)
  return waitForLivePiAdapterAttempt(agentId, attemptsRemaining - 1)
}

function waitForLivePiAdapterEffect(config: ReturnType<typeof getAgentLaunchConfig>) {
  return Effect.tryPromise({
    try: () => waitForLivePiAdapter(config),
    catch: (cause) => new RuntimeLifecycleError({
      message: 'Runtime turn failed',
      cause,
    }),
  })
}

function requirePiRuntime(
  config: ReturnType<typeof getAgentLaunchConfig>,
  message: string,
) {
  return config.runtime === 'pi'
    ? Effect.void
    : runtimeFailure(new Error(`${config.runtime} ${message}`))
}

function piRpcEffect<A>(
  effect: Effect.Effect<A, PiRpcProcessError, never>,
) {
  return effect.pipe(
    Effect.mapError((error) => new RuntimeLifecycleError({
      message: 'Runtime turn failed',
      cause: error.cause,
    })),
  )
}

function runtimeFailure(error: Error) {
  return Effect.fail(new RuntimeLifecycleError({
    message: 'Runtime turn failed',
    cause: error,
  }))
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
    .flatMap((entry) => entry.isFile() && entry.name.endsWith('.jsonl') ? [entry.name] : [])
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

  const dir = attachmentDirPath(getKiriConfig(), agentId)
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
