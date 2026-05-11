import type { AgentStatus, ThinkingLevel, TimelineEventTone } from '~/lib/contracts'
import {
  appendUserMessage,
  recordRuntimeTimelineEvent,
  replaceAgentDiffArtifacts,
  setAgentRuntimeState,
  setAgentStatus,
} from './db'
import type { RuntimeDiffArtifact } from './git-diff'

export type RuntimeLifecycleProjection = {
  appendUserMessage: typeof appendUserMessage
  recordRuntimeTimelineEvent: typeof recordRuntimeTimelineEvent
  replaceAgentDiffArtifacts: typeof replaceAgentDiffArtifacts
  setAgentRuntimeState: typeof setAgentRuntimeState
  setAgentStatus: typeof setAgentStatus
}

export type RuntimeErrorEvent = {
  kind: string
  label: string
  tone?: TimelineEventTone
}

const defaultProjection: RuntimeLifecycleProjection = {
  appendUserMessage,
  recordRuntimeTimelineEvent,
  replaceAgentDiffArtifacts,
  setAgentRuntimeState,
  setAgentStatus,
}

export async function enqueueAgentTurn(
  agentId: string,
  queues: Map<string, Promise<void>>,
  run: () => Promise<void>,
) {
  const previous = queues.get(agentId) ?? Promise.resolve()
  const next = previous.then(run)
  queues.set(agentId, next.catch(() => {}))
  await next
}

export function nextThinkingLevel(current: ThinkingLevel | null) {
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
  const index = current ? levels.indexOf(current) : -1
  return levels[(index + 1) % levels.length]
}

export function runtimeStateWithoutUndefined<T extends Record<string, unknown>>(state: T) {
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => value !== undefined),
  )
}

export function setRuntimeState(
  agentId: string,
  state: Record<string, unknown>,
  projection: Pick<RuntimeLifecycleProjection, 'setAgentRuntimeState'> = defaultProjection,
) {
  projection.setAgentRuntimeState(agentId, runtimeStateWithoutUndefined(state))
}

export function setRuntimeStatus(
  agentId: string,
  status: AgentStatus,
  projection: Pick<RuntimeLifecycleProjection, 'setAgentStatus'> = defaultProjection,
) {
  projection.setAgentStatus(agentId, status)
}

export function recordRuntimeError(
  agentId: string,
  error: unknown,
  event: RuntimeErrorEvent,
  projection: Pick<RuntimeLifecycleProjection, 'recordRuntimeTimelineEvent'> = defaultProjection,
) {
  projection.recordRuntimeTimelineEvent({
    agentId,
    kind: event.kind,
    tone: event.tone ?? 'error',
    label: event.label,
    detail: error instanceof Error ? error.message : String(error),
  })
}

export function captureRuntimeDiffs(
  agentId: string,
  collect: () => RuntimeDiffArtifact[],
  projection: Pick<RuntimeLifecycleProjection, 'replaceAgentDiffArtifacts'> = defaultProjection,
) {
  try {
    projection.replaceAgentDiffArtifacts({
      agentId,
      diffs: collect(),
    })
  } catch {
    // Diff capture is an observability projection; runtime transcripts remain authoritative.
  }
}

export async function runAgentTurnLifecycle<T>(input: {
  agentId: string
  displayText: string
  errorEvent: RuntimeErrorEvent
  run: () => Promise<T>
  onSuccess?: (result: T) => void | Promise<void>
  onError?: (error: unknown) => void | Promise<void>
  isCurrent?: () => boolean
  successStatus?: AgentStatus | null | ((result: T) => AgentStatus | null)
  projection?: RuntimeLifecycleProjection
}) {
  const projection = input.projection ?? defaultProjection
  projection.setAgentStatus(input.agentId, 'running')
  projection.appendUserMessage({ agentId: input.agentId, text: input.displayText })

  try {
    const result = await input.run()
    if (input.isCurrent?.() === false) return result
    await input.onSuccess?.(result)
    const successStatus = typeof input.successStatus === 'function'
      ? input.successStatus(result)
      : input.successStatus ?? 'idle'
    if (successStatus) projection.setAgentStatus(input.agentId, successStatus)
    return result
  } catch (error) {
    if (input.isCurrent?.() === false) return undefined
    await input.onError?.(error)
    projection.setAgentStatus(input.agentId, 'failed')
    recordRuntimeError(input.agentId, error, input.errorEvent, projection)
    throw error
  }
}
