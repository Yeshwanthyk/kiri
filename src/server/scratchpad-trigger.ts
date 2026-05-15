import type {
  RuntimeKind,
  ScratchpadBlock,
  SessionInterfaceMode,
  ThinkingLevel,
} from '~/lib/contracts'
import { sessionInterfaceModeForRuntime } from '~/lib/contracts'
import {
  deleteSessionSummary,
  getScratchpadBlock,
  listSessionSummaries,
  markScratchpadBlockTriggered,
  startSessionAndGetId,
} from './db'
import { promptAgent } from './runtime'

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

export async function triggerScratchpadSession(
  input: TriggerScratchpadInput,
  prompt: typeof promptAgent = promptAgent,
): Promise<TriggerScratchpadResult> {
  const block = getScratchpadBlock(input.id)
  if (!block) throw new Error(`Scratchpad block not found: ${input.id}`)

  const runtime = input.runtime ?? 'pi'
  const interfaceMode = sessionInterfaceModeForRuntime(runtime, input.interfaceMode ?? 'gui')
  const agentId = startSessionAndGetId({
    projectId: input.projectId,
    runtime,
    interfaceMode,
    model: input.model,
    title: input.title,
    thinkingLevel: input.thinkingLevel ?? 'medium',
  })

  markScratchpadBlockTriggered(input.id, agentId)

  if (interfaceMode !== 'terminal') {
    void prompt({ agentId, text: block.body, images: [] }).catch((error) => {
      try {
        deleteSessionSummary({ agentId })
      } catch {
        // The prompt failure is the primary signal; cleanup is best effort.
      }
      console.error('Scratchpad trigger prompt failed', error)
    })
  }

  const session = listSessionSummaries({ includeArchived: true })
    .find((candidate) => candidate.id === agentId)
  if (!session) throw new Error(`Session not found: ${agentId}`)
  return { agentId, session, block }
}
