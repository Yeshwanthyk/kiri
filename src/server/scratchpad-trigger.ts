import type {
  RuntimeKind,
  ScratchpadBlock,
  SessionInterfaceMode,
  ThinkingLevel,
} from '~/lib/contracts'
import { Context, Data, Effect, Either, Layer } from 'effect'
import {
  getScratchpadBlock,
  listSessionSummaries,
  markScratchpadBlockTriggered,
  queueAgentTerminalInput,
  startSessionAndGetId,
} from './db'
import { deleteSessionSummaryWithRuntimeCleanup } from './runtime-cleanup'
import { promptAgent } from './runtime'
import { defaultRuntime, getSettings, normalizeConfiguredInterfaceMode } from './settings'
import { pasteAgentRuntimeTerminal } from './terminal-server'

type TriggerScratchpadInput = {
  readonly id: string
  readonly projectId: string
  readonly runtime?: RuntimeKind
  readonly interfaceMode?: SessionInterfaceMode
  readonly model?: string
  readonly title?: string
  readonly thinkingLevel?: ThinkingLevel
}

type TriggerScratchpadSession = {
  readonly id: string
  readonly projectId: string
  readonly projectName: string
  readonly title: string
  readonly runtime: RuntimeKind
  readonly interfaceMode: SessionInterfaceMode
  readonly model: string
  readonly status: 'idle' | 'running' | 'queued' | 'blocked' | 'failed'
  readonly preview: string
  readonly messageCount: number
  readonly updatedAt: string
  readonly archivedAt: string | null
}

export type TriggerScratchpadResult = {
  readonly agentId: string
  readonly session: TriggerScratchpadSession
  readonly block: ScratchpadBlock
}

class ScratchpadTriggerError extends Data.TaggedError('ScratchpadTriggerError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type ScratchpadTriggerServiceApi = {
  readonly trigger: (input: TriggerScratchpadInput) => Effect.Effect<
    TriggerScratchpadResult,
    ScratchpadTriggerError
  >
}

class ScratchpadTriggerService extends Context.Tag('@kiri/ScratchpadTrigger')<
  ScratchpadTriggerService,
  ScratchpadTriggerServiceApi
>() {
  static readonly layer = Layer.sync(ScratchpadTriggerService, () =>
    ScratchpadTriggerService.of(makeScratchpadTriggerService(liveScratchpadTriggerDependencies)))
}

export type ScratchpadTriggerDependencies = {
  readonly getScratchpadBlock: (id: string) => ScratchpadBlock | null | undefined
  readonly startSessionAndGetId: (input: {
    readonly projectId: string
    readonly runtime: RuntimeKind
    readonly interfaceMode: SessionInterfaceMode
    readonly model?: string
    readonly title?: string
    readonly thinkingLevel?: ThinkingLevel
  }) => string
  readonly markScratchpadBlockTriggered: (id: string, agentId: string) => void
  readonly listSessionSummaries: (input: { readonly includeArchived: true }) => readonly TriggerScratchpadSession[]
  readonly deleteSessionSummary: (input: { readonly agentId: string }) => unknown
  readonly promptAgent: typeof promptAgent
  readonly queueAgentTerminalInput: typeof queueAgentTerminalInput
  readonly pasteAgentRuntimeTerminal: typeof pasteAgentRuntimeTerminal
  readonly spawnTerminalOnTrigger: boolean
  readonly reportPromptFailure: (error: unknown) => void
}

const liveScratchpadTriggerDependencies: ScratchpadTriggerDependencies = {
  getScratchpadBlock,
  startSessionAndGetId,
  markScratchpadBlockTriggered,
  listSessionSummaries,
  deleteSessionSummary: deleteSessionSummaryWithRuntimeCleanup,
  promptAgent,
  queueAgentTerminalInput,
  pasteAgentRuntimeTerminal,
  spawnTerminalOnTrigger: true,
  reportPromptFailure: (error) => console.error('Scratchpad trigger prompt failed', error),
}

export function makeScratchpadTriggerService(
  dependencies: ScratchpadTriggerDependencies,
): ScratchpadTriggerServiceApi {
  return {
    trigger: Effect.fn('ScratchpadTrigger.trigger')(function* (input) {
      return yield* Effect.tryPromise({
        try: () => triggerScratchpadSessionWithDeps(input, dependencies),
        catch: normalizeScratchpadTriggerError,
      })
    }),
  }
}

export async function triggerScratchpadSession(
  input: TriggerScratchpadInput,
  prompt: typeof promptAgent = promptAgent,
): Promise<TriggerScratchpadResult> {
  return triggerScratchpadSessionWithDependencies(input, prompt, false)
}

export async function triggerScratchpadSessionAndSpawn(
  input: TriggerScratchpadInput,
  prompt: typeof promptAgent = promptAgent,
): Promise<TriggerScratchpadResult> {
  return triggerScratchpadSessionWithDependencies(input, prompt, true)
}

async function triggerScratchpadSessionWithDependencies(
  input: TriggerScratchpadInput,
  prompt: typeof promptAgent,
  spawnTerminalOnTrigger: boolean,
): Promise<TriggerScratchpadResult> {
  const result = await Effect.runPromise(
    ScratchpadTriggerService.pipe(
      Effect.flatMap((service) => service.trigger(input)),
      Effect.provide(Layer.sync(ScratchpadTriggerService, () =>
        ScratchpadTriggerService.of(makeScratchpadTriggerService({
          ...liveScratchpadTriggerDependencies,
          promptAgent: prompt,
          spawnTerminalOnTrigger,
        }))),
      ),
      Effect.either,
    ),
  )
  if (Either.isRight(result)) return result.right
  throw normalizeScratchpadTriggerFailure(result.left)
}

async function triggerScratchpadSessionWithDeps(
  input: TriggerScratchpadInput,
  dependencies: ScratchpadTriggerDependencies,
): Promise<TriggerScratchpadResult> {
  const block = dependencies.getScratchpadBlock(input.id)
  if (!block) throw new Error(`Scratchpad block not found: ${input.id}`)

  const settings = getSettings()
  const runtime = input.runtime ?? defaultRuntime(settings)
  const interfaceMode = normalizeConfiguredInterfaceMode(runtime, input.interfaceMode, settings)
  const agentId = dependencies.startSessionAndGetId({
    projectId: input.projectId,
    runtime,
    interfaceMode,
    model: input.model,
    title: input.title,
    thinkingLevel: input.thinkingLevel,
  })

  try {
    dependencies.markScratchpadBlockTriggered(input.id, agentId)
  } catch (error) {
    try {
      dependencies.deleteSessionSummary({ agentId })
    } catch {
      // The mark failure is the primary signal; cleanup is best effort.
    }
    throw error
  }

  if (interfaceMode === 'terminal') {
    dependencies.queueAgentTerminalInput({
      agentId,
      text: block.body,
      submit: true,
    })
    if (dependencies.spawnTerminalOnTrigger) {
      await dependencies.pasteAgentRuntimeTerminal({ agentId }).catch((error) => {
        dependencies.reportPromptFailure(error)
      })
    }
  } else {
    void dependencies.promptAgent({ agentId, text: block.body, images: [] }).catch((error) => {
      try {
        dependencies.deleteSessionSummary({ agentId })
      } catch {
        // The prompt failure is the primary signal; cleanup is best effort.
      }
      dependencies.reportPromptFailure(error)
    })
  }

  const session = dependencies.listSessionSummaries({ includeArchived: true })
    .find((candidate) => candidate.id === agentId)
  if (!session) throw new Error(`Session not found: ${agentId}`)
  return { agentId, session, block }
}

function normalizeScratchpadTriggerError(error: unknown) {
  return new ScratchpadTriggerError({
    message: error instanceof Error ? error.message : 'Scratchpad trigger failed',
    cause: error,
  })
}

function normalizeScratchpadTriggerFailure(error: unknown) {
  if (error instanceof ScratchpadTriggerError && error.cause instanceof Error) {
    return error.cause
  }
  if (error instanceof Error) return error
  return new ScratchpadTriggerError({
    message: 'Scratchpad trigger failed',
    cause: error,
  })
}
