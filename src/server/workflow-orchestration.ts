import type {
  CreateWorkflowRunInput,
  RuntimeKind,
  SessionInterfaceMode,
  ThinkingLevel,
  WorkflowItemInput,
  WorkflowTerminalPaste,
} from '~/lib/contracts'
import {
  createWorkflowRunInputSchema,
  sessionInterfaceModeForRuntime,
} from '~/lib/contracts'
import {
  addScratchpadBlockSummary,
  addWorkflowRun,
  archiveWorkflowRun,
  completeScratchpadWorkflowItem,
  getWorkflowItem,
  getWorkflowRun,
  listProjectSummaries,
  listWorkflowRuns,
  recordWorkflowItemAttempt,
  restoreWorkflowRun,
  setWorkflowItemTracking,
  startSessionSummary,
} from './db'
import { getSettings } from './settings'

type NormalizedWorkflowItem = {
  readonly clientId: string | null
  readonly action: WorkflowItemInput['action']
  readonly title: string
  readonly body: string
  readonly runtime: RuntimeKind | null
  readonly interfaceMode: SessionInterfaceMode | null
  readonly model: string | null
  readonly thinkingLevel: ThinkingLevel | null
  readonly terminalPaste: WorkflowTerminalPaste | null
  readonly attachScratchpad: boolean
  readonly tracked: boolean
}

export function validateWorkflow(input: CreateWorkflowRunInput) {
  const parsed = createWorkflowRunInputSchema.parse(input)
  const items = normalizeWorkflowItems(parsed)
  return {
    valid: true,
    projectId: parsed.projectId,
    title: parsed.title,
    itemCount: items.length,
    launchCount: items.filter((item) => item.action === 'launch').length,
    scratchpadCount: items.filter((item) => item.attachScratchpad || item.action === 'scratchpad').length,
    warnings: workflowWarnings(items),
  }
}

export function createWorkflowRun(input: CreateWorkflowRunInput) {
  const parsed = createWorkflowRunInputSchema.parse(input)
  const items = normalizeWorkflowItems(parsed)
  const persistedItems = items.map((item) => {
    const block = item.attachScratchpad || item.action === 'scratchpad'
      ? addScratchpadBlockSummary({
        projectId: parsed.projectId,
        body: item.body,
      })
      : null
    return {
      clientId: item.clientId,
      action: item.action,
      title: item.title,
      body: item.body,
      runtime: item.runtime,
      interfaceMode: item.interfaceMode,
      model: item.model,
      thinkingLevel: item.thinkingLevel,
      terminalPaste: item.terminalPaste,
      scratchpadBlockId: block?.id ?? null,
      tracked: item.tracked,
    }
  })
  return addWorkflowRun({
    projectId: parsed.projectId,
    title: parsed.title,
    items: persistedItems,
  })
}

export function dispatchWorkflowRun(input: { readonly id: string }) {
  const run = getWorkflowRun(input.id)
  assertRunMutable(run)
  const results = run.items.map((item) => {
    if (!item.tracked) {
      return { itemId: item.id, status: 'skipped', reason: 'untracked' }
    }
    if (item.action === 'scratchpad') {
      const completed = completeScratchpadWorkflowItem(item.id)
      return {
        itemId: item.id,
        status: 'scratchpad_only',
        scratchpadBlockId: completed.scratchpadBlockId,
      }
    }
    if (item.activeAgentId) {
      return { itemId: item.id, status: 'skipped', reason: 'already_launched', agentId: item.activeAgentId }
    }
    return launchWorkflowItem(item)
  })
  const refreshed = getWorkflowRun(run.id)
  return {
    id: refreshed.id,
    status: refreshed.status,
    launched: results.filter((result) => result.status === 'launched').length,
    scratchpadOnly: results.filter((result) => result.status === 'scratchpad_only').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results,
  }
}

export function retriggerWorkflowItem(input: {
  readonly itemId: string
  readonly runtime?: RuntimeKind
  readonly interfaceMode?: SessionInterfaceMode
  readonly model?: string
  readonly thinkingLevel?: ThinkingLevel
  readonly terminalPaste?: WorkflowTerminalPaste
}) {
  const item = getWorkflowItem(input.itemId)
  const run = getWorkflowRun(item.runId)
  assertRunMutable(run)
  if (item.action !== 'launch') {
    throw new Error(`Workflow item is not launchable: ${item.id}`)
  }
  return launchWorkflowItem({
    ...item,
    runtime: input.runtime ?? item.runtime,
    interfaceMode: input.interfaceMode ?? item.interfaceMode,
    model: input.model ?? item.model,
    thinkingLevel: input.thinkingLevel ?? item.thinkingLevel,
    terminalPaste: input.terminalPaste ?? item.terminalPaste,
  })
}

export function trackWorkflowItem(input: { readonly itemId: string }) {
  const item = getWorkflowItem(input.itemId)
  assertRunMutable(getWorkflowRun(item.runId))
  return setWorkflowItemTracking(item.id, true)
}

export function untrackWorkflowItem(input: { readonly itemId: string }) {
  const item = getWorkflowItem(input.itemId)
  assertRunMutable(getWorkflowRun(item.runId))
  return setWorkflowItemTracking(item.id, false)
}

export {
  archiveWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  restoreWorkflowRun,
}

function launchWorkflowItem(item: {
  readonly id: string
  readonly runId: string
  readonly title: string
  readonly runtime: RuntimeKind | null
  readonly interfaceMode: SessionInterfaceMode | null
  readonly model: string | null
  readonly thinkingLevel: string | null
  readonly terminalPaste?: WorkflowTerminalPaste | null
}) {
  const run = getWorkflowRun(item.runId)
  try {
    const runtime = item.runtime ?? 'pi'
    const session = startSessionSummary({
      projectId: run.projectId,
      runtime,
      interfaceMode: item.interfaceMode ?? 'gui',
      model: item.model ?? undefined,
      title: item.title,
      thinkingLevel: parseThinkingLevel(item.thinkingLevel),
    })
    const attempt = recordWorkflowItemAttempt({
      itemId: item.id,
      agentId: session.id,
      status: 'launched',
    })
    return {
      itemId: item.id,
      status: 'launched',
      agentId: session.id,
      attemptId: attempt?.id ?? null,
    }
  } catch (error) {
    const attempt = recordWorkflowItemAttempt({
      itemId: item.id,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      itemId: item.id,
      status: 'failed',
      attemptId: attempt?.id ?? null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function normalizeWorkflowItems(input: CreateWorkflowRunInput): readonly NormalizedWorkflowItem[] {
  assertProjectExists(input.projectId)
  const settings = getSettings()
  const defaults = input.defaults

  return input.items.map((item) => {
    const attachScratchpad = item.action === 'scratchpad'
      ? true
      : item.attachScratchpad ?? defaults.attachScratchpad
    if (item.action === 'scratchpad') {
      return {
        clientId: item.id ?? null,
        action: item.action,
        title: item.title,
        body: item.body,
        runtime: null,
        interfaceMode: null,
        model: null,
        thinkingLevel: null,
        terminalPaste: null,
        attachScratchpad,
        tracked: item.tracked,
      }
    }

    const runtime = item.runtime ?? defaults.runtime ?? 'pi'
    const runtimeSettings = settings.runtimes[runtime]
    const model = item.model ?? defaults.model ?? runtimeSettings.defaultModel
    if (!runtimeSettings.models.includes(model)) {
      throw new Error(`Model ${model} is not configured for runtime ${runtime}`)
    }
    return {
      clientId: item.id ?? null,
      action: item.action,
      title: item.title,
      body: item.body,
      runtime,
      interfaceMode: sessionInterfaceModeForRuntime(
        runtime,
        item.interfaceMode ?? defaults.interfaceMode ?? 'gui',
      ),
      model,
      thinkingLevel: item.thinkingLevel ?? defaults.thinkingLevel ?? 'medium',
      terminalPaste: item.terminalPaste ?? defaults.terminalPaste ?? { submit: true },
      attachScratchpad,
      tracked: item.tracked,
    }
  })
}

function workflowWarnings(items: readonly NormalizedWorkflowItem[]) {
  return items.flatMap((item) =>
    item.action === 'launch' && item.interfaceMode === 'terminal'
      ? [{
        clientId: item.clientId,
        message: 'Terminal item will create a Kiri terminal session; prompt paste is handled during terminal dispatch.',
      }]
      : [])
}

function assertProjectExists(projectId: string) {
  const exists = listProjectSummaries(true).some((project) => project.id === projectId)
  if (!exists) throw new Error(`Project not found: ${projectId}`)
}

function assertRunMutable(run: { readonly id: string; readonly archivedAt: string | null }) {
  if (run.archivedAt) throw new Error(`Workflow run is archived: ${run.id}`)
}

function parseThinkingLevel(value: string | null | undefined): ThinkingLevel {
  switch (value) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value
    default:
      return 'medium'
  }
}
