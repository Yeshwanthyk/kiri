import { Context, Effect, Layer } from 'effect'
import {
  appendUserMessage,
  clearRuntimeContextUsage,
  recordRuntimeContextUsage,
  recordRuntimeMessage,
  recordRuntimeTimelineEvent,
  replaceAgentTasks,
  setAgentPendingQuestion,
  setAgentRuntimeState,
  setAgentStatus,
} from './db'
import type { RuntimeLifecycleProjection, RuntimeProjectionEvent } from './runtime-lifecycle'

export class RuntimeProjector extends Context.Tag('@kiri/RuntimeProjector')<
  RuntimeProjector,
  RuntimeLifecycleProjection
>() {
  static readonly liveLayer = Layer.succeed(RuntimeProjector, makeDbRuntimeProjector())
}

function makeDbRuntimeProjector(): RuntimeLifecycleProjection {
  return {
    project: (event) => Effect.sync(() => {
      projectRuntimeEventToDb(event)
    }),
  }
}

function projectRuntimeEventToDb(event: RuntimeProjectionEvent) {
  if (event.type === 'status') {
    setAgentStatus(event.agentId, event.status)
    return
  }
  if (event.type === 'userMessage') {
    appendUserMessage({ agentId: event.agentId, text: event.text })
    return
  }
  if (event.type === 'runtimeMessage') {
    recordRuntimeMessage({
      agentId: event.agentId,
      id: event.id,
      role: event.role,
      text: event.text,
      timestamp: event.timestamp,
    })
    return
  }
  if (event.type === 'timelineEvent') {
    recordRuntimeTimelineEvent(event.value)
    return
  }
  if (event.type === 'contextUsage') {
    recordRuntimeContextUsage(event.value)
    return
  }
  if (event.type === 'clearContextUsage') {
    clearRuntimeContextUsage(event.agentId)
    return
  }
  if (event.type === 'pendingQuestion') {
    setAgentPendingQuestion(event.agentId, event.value)
    return
  }
  if (event.type === 'tasksUpdated') {
    replaceAgentTasks({
      agentId: event.agentId,
      source: event.source,
      tasks: event.tasks,
      updatedAt: event.updatedAt,
    })
    return
  }
  if (event.type === 'runtimeState') {
    setAgentRuntimeState(event.agentId, runtimeStateWithoutUndefined(event.state))
    return
  }
  if (event.type === 'fileOperationStarted' || event.type === 'fileOperationCompleted') {
    recordRuntimeTimelineEvent(fileOperationTimelineEvent(event))
  }
}

function fileOperationTimelineEvent(
  event: Extract<RuntimeProjectionEvent, {
    type: 'fileOperationStarted' | 'fileOperationCompleted'
  }>,
): Parameters<typeof recordRuntimeTimelineEvent>[0] {
  const status = event.type === 'fileOperationStarted' ? 'started' : event.status
  const path = event.path ? ` ${event.path}` : ''
  const label = `${event.toolName} ${status}`
  return {
    agentId: event.agentId,
    kind: event.type,
    tone: event.type === 'fileOperationCompleted' && event.status === 'failed' ? 'error' : 'tool',
    label,
    detail: event.summary ?? `${event.toolName}${path}`,
    payload: event,
  }
}

export function runtimeStateWithoutUndefined<T extends Record<string, unknown>>(state: T) {
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => value !== undefined),
  )
}
