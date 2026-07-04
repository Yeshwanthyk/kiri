import { Effect } from 'effect'
import { z } from 'zod'
import { controlProtocolVersion } from '@kiri/control/control-protocol'
import {
  addProjectInputSchema,
  addScratchpadBlockInputSchema,
  agentDetailInputSchema,
  interruptMessageInputSchema,
  listAgentEventsInputSchema,
  agentPromptInputSchema,
  agentStatusSetInputSchema,
  agentTasksReplaceInputSchema,
  createWorkflowRunInputSchema,
  deleteProjectInputSchema,
  deleteSessionInputSchema,
  deleteScratchpadBlockInputSchema,
  hardDeleteSessionInputSchema,
  hideProjectInputSchema,
  kiriOperationRequestSchema,
  kiriReadOperations,
  kiriWriteOperations,
  knowledgeAddInputSchema,
  knowledgeListInputSchema,
  knowledgeMarkSeenInputSchema,
  knowledgeSearchInputSchema,
  knowledgeUpdateInputSchema,
  listWorkflowRunsInputSchema,
  renameSessionInputSchema,
  restoreSessionInputSchema,
  runtimeKindSchema,
  spawnSessionInputSchema,
  startSessionInputSchema,
  terminalInputSchema,
  terminalKeysInputSchema,
  terminalReadInputSchema,
  terminalTargetSchema,
  terminalWaitForInputSchema,
  taskListInputSchema,
  triggerScratchpadBlockInputSchema,
  workflowAwaitInputSchema,
  unhideProjectInputSchema,
  workflowItemOperationInputSchema,
  workflowRunOperationInputSchema,
  type KiriOperation,
  type KiriOperationError,
  type KiriOperationOptions,
  type KiriOperationResponse,
} from '~/lib/contracts'
import type { KiriControlApi } from './kiri-control'
import { kiriVersion } from '~/lib/version'

const emptyParamsSchema = z.object({})

const listModelsParamsSchema = z.object({
  runtime: runtimeKindSchema.optional(),
})
const listProjectsParamsSchema = z.object({
  includeHidden: z.boolean().default(false),
})
const listSessionsParamsSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  includeArchived: z.boolean().default(false),
})
const listScratchpadParamsSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
})
const idParamsSchema = z.object({
  id: z.string().trim().min(1),
})
const agentIdParamsSchema = z.object({
  agentId: z.string().trim().min(1),
})

const operationParamSchemas = {
  'operations.list': emptyParamsSchema,
  'context.show': emptyParamsSchema,
  'model.list': listModelsParamsSchema,
  'project.list': listProjectsParamsSchema,
  'session.list': listSessionsParamsSchema,
  'agent.detail': agentDetailInputSchema,
  'agent.events.list': listAgentEventsInputSchema,
  'task.list': taskListInputSchema,
  'knowledge.list': knowledgeListInputSchema,
  'knowledge.search': knowledgeSearchInputSchema,
  'scratchpad.list': listScratchpadParamsSchema,
  'terminal.read': terminalReadInputSchema,
  'terminal.list': emptyParamsSchema,
  'terminal.wait-for': terminalWaitForInputSchema,
  'workflow.list': listWorkflowRunsInputSchema,
  'workflow.show': idParamsSchema,
  'workflow.validate': createWorkflowRunInputSchema,
  'project.add': addProjectInputSchema,
  'project.hide': hideProjectInputSchema,
  'project.unhide': unhideProjectInputSchema,
  'project.delete': deleteProjectInputSchema,
  'session.create': startSessionInputSchema,
  'session.spawn': spawnSessionInputSchema,
  'session.rename': renameSessionInputSchema,
  'session.archive': deleteSessionInputSchema,
  'session.restore': restoreSessionInputSchema,
  'session.delete': hardDeleteSessionInputSchema,
  'agent.prompt': agentPromptInputSchema,
  'agent.interrupt': interruptMessageInputSchema,
  'agent.status.set': agentStatusSetInputSchema,
  'agent.tasks.replace': agentTasksReplaceInputSchema,
  'terminal.input': terminalInputSchema,
  'terminal.keys': terminalKeysInputSchema,
  'terminal.spawn': agentIdParamsSchema,
  'terminal.kill': terminalTargetSchema,
  'knowledge.add': knowledgeAddInputSchema,
  'knowledge.update': knowledgeUpdateInputSchema,
  'knowledge.delete': idParamsSchema,
  'knowledge.markSeen': knowledgeMarkSeenInputSchema,
  'scratchpad.add': addScratchpadBlockInputSchema,
  'scratchpad.delete': deleteScratchpadBlockInputSchema,
  'scratchpad.trigger': triggerScratchpadBlockInputSchema,
  'workflow.create': createWorkflowRunInputSchema,
  'workflow.dispatch': workflowRunOperationInputSchema,
  'workflow.await': workflowAwaitInputSchema,
  'workflow.retrigger': workflowItemOperationInputSchema,
  'workflow.track': workflowItemOperationInputSchema,
  'workflow.untrack': workflowItemOperationInputSchema,
  'workflow.archive': workflowRunOperationInputSchema,
  'workflow.restore': workflowRunOperationInputSchema,
} satisfies Record<KiriOperation, z.ZodType>

export const kiriOperationJsonSchemas = Object.fromEntries(
  Object.entries(operationParamSchemas).map(([operation, schema]) => [
    operation,
    z.toJSONSchema(schema),
  ]),
) as Record<KiriOperation, unknown>

const operationRecipes = {
  decisionTree: {
    rule: 'Choose the first matching intent; do not compose lower-level operations when a higher-level operation matches.',
    preflight: [
      'Call operations.list when unsure which operation exists or what recipe to follow.',
      'Call model.list for the selected runtime before passing model; otherwise omit model.',
      'Use session.id/agentId returned by Kiri responses; do not invent ids.',
    ],
    intents: [
      { intent: 'start one new worker with a prompt', operation: 'session.spawn' },
      { intent: 'create an empty session only', operation: 'session.create' },
      { intent: 'continue an existing GUI session', operation: 'agent.prompt' },
      { intent: 'drive an existing terminal session', operation: 'terminal.input' },
      { intent: 'start from a saved scratchpad block', operation: 'scratchpad.trigger' },
      { intent: 'launch multiple tracked workers', operations: ['workflow.create', 'workflow.dispatch'] },
      { intent: 'wait for workflow check-ins', operation: 'workflow.await' },
    ],
    successChecks: [
      'session.spawn requires delivery.accepted === true.',
      'agent.prompt requires accepted === true.',
      'terminal.input requires queued === true; spawned may be false in CI or when spawn:false.',
      'workflow.dispatch launch results require prompt.accepted === true or terminalPaste.queued === true.',
      'scratchpad.trigger success means Kiri created the session, delivered or queued the block, and marked the block triggered.',
    ],
    never: [
      'Do not use workflow for a single new worker; use session.spawn.',
      'Do not use session.create plus agent.prompt for new prompted work; use session.spawn.',
      'Do not pass a model id from one runtime to another runtime.',
    ],
  },
  startTask: {
    use: 'Create a Kiri session and immediately deliver the first prompt.',
    operation: 'session.spawn',
    params: {
      projectId: 'project-id',
      runtime: 'codex',
      model: 'gpt-5.5',
      title: 'Short action title',
      text: 'Task prompt',
    },
    notes: [
      'Prefer this over session.create plus agent.prompt for new work.',
      'Omit model when unsure; model ids are runtime-local.',
      'For terminal sessions, set interfaceMode:"terminal"; text is queued and terminalSpawn defaults true.',
    ],
  },
  createOnly: {
    use: 'Create a blank session without starting work.',
    operation: 'session.create',
    params: {
      projectId: 'project-id',
      runtime: 'codex',
      title: 'Short title',
    },
  },
  promptExisting: {
    use: 'Send or steer an existing GUI-capable session.',
    operation: 'agent.prompt',
    params: {
      agentId: 'session-id',
      text: 'Prompt text',
      mode: 'prompt',
    },
  },
  driveTerminal: {
    use: 'Type into an existing terminal interface session.',
    operation: 'terminal.input',
    params: {
      agentId: 'session-id',
      text: 'Terminal input',
      submit: true,
      spawn: true,
    },
  },
  triggerScratchpad: {
    use: 'Start a session from a saved scratchpad block.',
    operation: 'scratchpad.trigger',
    params: {
      id: 'block-id',
      projectId: 'project-id',
      runtime: 'codex',
      title: 'Short title',
    },
  },
  workflow: {
    use: 'Launch multiple tracked tasks or scratchpad-only notes as one durable run.',
    operations: ['workflow.create', 'workflow.dispatch', 'workflow.await', 'workflow.show'],
    createParams: {
      projectId: 'project-id',
      title: 'Workflow title',
      defaults: {
        runtime: 'codex',
        model: 'gpt-5.5',
        attachScratchpad: true,
      },
      items: [{
        id: 'impl',
        action: 'launch',
        title: 'Implement',
        body: 'Task prompt',
        tracked: true,
      }],
    },
    notes: [
      'workflow.dispatch delivers GUI item bodies through agent.prompt.',
      'Terminal item bodies are queued and then delivered through the Kiri terminal flow.',
      'Use workflow.await for tracked worker check-ins instead of polling each session.',
    ],
  },
  renameCurrentSession: {
    use: 'Keep the Kiri title accurate when a session title is generic or stale.',
    operation: 'session.rename',
    params: {
      agentId: 'current-session-id',
      title: 'Short accurate title',
    },
  },
  modelRule: {
    use: 'Avoid runtime/model mismatch.',
    operation: 'model.list',
    params: {
      runtime: 'codex',
    },
    notes: [
      'Model ids are scoped to the selected runtime.',
      'Example: codex uses gpt-5.5; pi may use openai-codex/gpt-5.5.',
    ],
  },
} as const

export async function runKiriOperation(
  control: KiriControlApi,
  request: unknown,
): Promise<KiriOperationResponse> {
  const parsed = kiriOperationRequestSchema.safeParse(request)
  if (!parsed.success) {
    return failedOperation('operations.list', validationError(parsed.error))
  }

  const { operation, params, options } = parsed.data
  try {
    const result = await dispatchOperation(control, operation, params, options)
    return {
      ok: true,
      operation,
      result,
    }
  } catch (error) {
    return failedOperation(operation, operationError(error))
  }
}

export function readOperationRequest(input: {
  readonly operation: unknown
  readonly params?: unknown
  readonly options?: unknown
}) {
  return kiriOperationRequestSchema.parse({
    operation: input.operation,
    params: input.params ?? {},
    options: input.options ?? {},
  })
}

function dispatchOperation(
  control: KiriControlApi,
  operation: KiriOperation,
  params: Record<string, unknown>,
  options: KiriOperationOptions,
) {
  if ((kiriReadOperations as readonly string[]).includes(operation)) {
    return dispatchReadOperation(control, operation, params, options)
  }
  if ((kiriWriteOperations as readonly string[]).includes(operation)) {
    return dispatchWriteOperation(control, operation, params, options)
  }
  throw new Error(`Unsupported operation: ${operation}`)
}

async function dispatchReadOperation(
  control: KiriControlApi,
  operation: KiriOperation,
  params: Record<string, unknown>,
  options: KiriOperationOptions,
) {
  switch (operation) {
    case 'operations.list':
      return shapeResult({
        read: kiriReadOperations,
        write: kiriWriteOperations,
        schemas: kiriOperationJsonSchemas,
        protocol: {
          version: controlProtocolVersion,
          appVersion: kiriVersion,
        },
        recipes: operationRecipes,
      }, options)
    case 'context.show':
      return shapeResult(await run(control.getContext()), options)
    case 'model.list': {
      const input = parseParams(listModelsParamsSchema, params)
      return shapeResult(await run(control.listModels(input.runtime)), options)
    }
    case 'project.list': {
      const input = parseParams(listProjectsParamsSchema, params)
      return shapeResult(await run(control.listProjects(input.includeHidden)), options)
    }
    case 'session.list': {
      const input = parseParams(listSessionsParamsSchema, params)
      return shapeResult(await run(control.listSessions({
        projectId: input.projectId,
        includeArchived: input.includeArchived,
      })), options)
    }
    case 'agent.detail':
      return shapeResult(await run(control.agentDetail(parseParams(agentDetailInputSchema, params))), options)
    case 'agent.events.list':
      return shapeResult(await run(control.listAgentEvents(parseParams(listAgentEventsInputSchema, params))), options)
    case 'task.list':
      return shapeResult(await run(control.listTasks(parseParams(taskListInputSchema, params))), options)
    case 'knowledge.list':
      return shapeResult(await run(control.listKnowledge(parseParams(knowledgeListInputSchema, params))), options)
    case 'knowledge.search':
      return shapeResult(await run(control.searchKnowledge(parseParams(knowledgeSearchInputSchema, params))), options)
    case 'scratchpad.list': {
      const input = parseParams(listScratchpadParamsSchema, params)
      return shapeResult(await run(control.listScratchpad({ projectId: input.projectId })), options)
    }
    case 'terminal.read':
      return shapeResult(await run(control.terminalRead(parseParams(terminalReadInputSchema, params))), options)
    case 'terminal.list':
      return shapeResult(await run(control.terminalList()), options)
    case 'terminal.wait-for':
      return shapeResult(await run(control.terminalWaitFor(parseParams(terminalWaitForInputSchema, params))), options)
    case 'workflow.list': {
      const input = parseParams(listWorkflowRunsInputSchema, params)
      return shapeResult(await run(control.listWorkflowRuns(input)), options)
    }
    case 'workflow.show':
      return shapeResult(await run(control.getWorkflowRun(parseParams(idParamsSchema, params).id)), options)
    case 'workflow.validate':
      return shapeResult(await run(control.validateWorkflow(parseParams(createWorkflowRunInputSchema, params))), options)
    default:
      throw new Error(`Unsupported read operation: ${operation}`)
  }
}

async function dispatchWriteOperation(
  control: KiriControlApi,
  operation: KiriOperation,
  params: Record<string, unknown>,
  options: KiriOperationOptions,
) {
  let result: unknown
  switch (operation) {
    case 'project.add':
      result = await run(control.addProject(parseParams(addProjectInputSchema, params)))
      break
    case 'project.hide':
      result = await run(control.hideProject(parseParams(hideProjectInputSchema, params).id))
      break
    case 'project.unhide':
      result = await run(control.unhideProject(parseParams(unhideProjectInputSchema, params).id))
      break
    case 'project.delete':
      result = await run(control.deleteProject(parseParams(deleteProjectInputSchema, params).id))
      break
    case 'session.create':
      result = await run(control.startSession(parseParams(startSessionInputSchema, params)))
      break
    case 'session.spawn':
      result = await run(control.spawnSession(parseParams(spawnSessionInputSchema, params)))
      break
    case 'session.rename':
      result = await run(control.renameSession(parseParams(renameSessionInputSchema, params)))
      break
    case 'session.archive':
      result = await run(control.deleteSession(parseParams(deleteSessionInputSchema, params).agentId))
      break
    case 'session.restore':
      result = await run(control.restoreSession(parseParams(restoreSessionInputSchema, params)))
      break
    case 'session.delete':
      result = await run(control.hardDeleteSession(parseParams(hardDeleteSessionInputSchema, params)))
      break
    case 'agent.prompt':
      result = await run(control.agentPrompt(parseParams(agentPromptInputSchema, params)))
      break
    case 'agent.interrupt':
      result = await run(control.agentInterrupt(parseParams(interruptMessageInputSchema, params)))
      break
    case 'agent.status.set':
      result = await run(control.setAgentStatus(parseParams(agentStatusSetInputSchema, params)))
      break
    case 'agent.tasks.replace':
      result = await run(control.replaceAgentTasks(parseParams(agentTasksReplaceInputSchema, params)))
      break
    case 'terminal.input':
      result = await run(control.terminalInput(parseParams(terminalInputSchema, params)))
      break
    case 'terminal.keys':
      result = await run(control.terminalKeys(parseParams(terminalKeysInputSchema, params)))
      break
    case 'terminal.spawn':
      result = await run(control.terminalSpawn(parseParams(agentIdParamsSchema, params)))
      break
    case 'terminal.kill':
      result = await run(control.terminalKill(parseParams(terminalTargetSchema, params)))
      break
    case 'knowledge.add':
      result = await run(control.addKnowledge(parseParams(knowledgeAddInputSchema, params)))
      break
    case 'knowledge.update':
      result = await run(control.updateKnowledge(parseParams(knowledgeUpdateInputSchema, params)))
      break
    case 'knowledge.delete':
      result = await run(control.deleteKnowledge(parseParams(idParamsSchema, params).id))
      break
    case 'knowledge.markSeen':
      result = await run(control.markKnowledgeSeen(parseParams(knowledgeMarkSeenInputSchema, params)))
      break
    case 'scratchpad.add':
      result = await run(control.addScratchpad(parseParams(addScratchpadBlockInputSchema, params)))
      break
    case 'scratchpad.delete':
      result = await run(control.deleteScratchpad(parseParams(deleteScratchpadBlockInputSchema, params).id))
      break
    case 'scratchpad.trigger':
      result = await run(control.triggerScratchpad(parseParams(triggerScratchpadBlockInputSchema, params)))
      break
    case 'workflow.create':
      result = await run(control.createWorkflowRun(parseParams(createWorkflowRunInputSchema, params)))
      break
    case 'workflow.dispatch':
      result = await run(control.dispatchWorkflowRun(parseParams(workflowRunOperationInputSchema, params)))
      break
    case 'workflow.await':
      result = await run(control.workflowAwait(parseParams(workflowAwaitInputSchema, params)))
      break
    case 'workflow.retrigger':
      result = await run(control.retriggerWorkflowItem(parseParams(workflowItemOperationInputSchema, params)))
      break
    case 'workflow.track':
      result = await run(control.trackWorkflowItem(parseParams(workflowItemOperationInputSchema, params)))
      break
    case 'workflow.untrack':
      result = await run(control.untrackWorkflowItem(parseParams(workflowItemOperationInputSchema, params)))
      break
    case 'workflow.archive':
      result = await run(control.archiveWorkflowRun(parseParams(workflowRunOperationInputSchema, params)))
      break
    case 'workflow.restore':
      result = await run(control.restoreWorkflowRun(parseParams(workflowRunOperationInputSchema, params)))
      break
    default:
      throw new Error(`Unsupported write operation: ${operation}`)
  }

  if (!options.includeContext) return shapeResult(result, options)
  return shapeResult({
    value: result,
    context: await run(control.getContext()),
  }, options)
}

function run<A>(effect: Effect.Effect<A, unknown>) {
  return Effect.runPromise(effect)
}

function parseParams<SchemaType extends z.ZodTypeAny>(
  schema: SchemaType,
  params: Record<string, unknown>,
): z.infer<SchemaType> {
  const parsed = schema.safeParse(params)
  if (parsed.success) return parsed.data
  throw new KiriOperationThrownError(validationError(parsed.error))
}

function shapeResult(value: unknown, options: KiriOperationOptions) {
  const withLimit = applyLimit(value, options.limit)
  if (!options.fields?.length) return withLimit
  return applyFields(withLimit, options.fields)
}

function applyLimit(value: unknown, limit: number | undefined): unknown {
  if (!limit) return value
  if (Array.isArray(value)) return value.slice(0, limit)
  if (value && typeof value === 'object' && 'items' in value && Array.isArray(value.items)) {
    return { ...value, items: value.items.slice(0, limit) }
  }
  return value
}

function applyFields(value: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => pickFields(item, fields))
  return pickFields(value, fields)
}

function pickFields(value: unknown, fields: readonly string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  return Object.fromEntries(fields.flatMap((field) =>
    field in source ? [[field, source[field]]] : []))
}

function failedOperation(
  operation: KiriOperation,
  error: KiriOperationError,
): KiriOperationResponse {
  return {
    ok: false,
    operation,
    error,
  }
}

function validationError(error: z.ZodError): KiriOperationError {
  const issue = error.issues[0]
  return {
    code: 'VALIDATION',
    message: issue?.message ?? 'Invalid operation request',
    path: issue?.path.join('.'),
  }
}

function operationError(error: unknown): KiriOperationError {
  if (error instanceof KiriOperationThrownError) return error.operationError
  if (isOperationError(error)) return error
  return {
    code: 'FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}

function isOperationError(error: unknown): error is KiriOperationError {
  return Boolean(error && typeof error === 'object' && 'code' in error && 'message' in error)
}

class KiriOperationThrownError extends Error {
  constructor(readonly operationError: KiriOperationError) {
    super(operationError.message)
  }
}
