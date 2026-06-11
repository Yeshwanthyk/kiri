import { Effect } from 'effect'
import { z } from 'zod'
import {
  addProjectInputSchema,
  addScratchpadBlockInputSchema,
  agentDetailInputSchema,
  listAgentEventsInputSchema,
  agentPromptInputSchema,
  createWorkflowRunInputSchema,
  deleteProjectInputSchema,
  deleteScratchpadBlockInputSchema,
  hideProjectInputSchema,
  kiriOperationOptionsSchema,
  kiriOperationRequestSchema,
  kiriReadOperations,
  kiriWriteOperations,
  listWorkflowRunsInputSchema,
  renameSessionInputSchema,
  restoreSessionInputSchema,
  runtimeKindSchema,
  startSessionInputSchema,
  terminalInputSchema,
  terminalKeysInputSchema,
  terminalReadInputSchema,
  terminalTargetSchema,
  terminalWaitForInputSchema,
  triggerScratchpadBlockInputSchema,
  workflowAwaitInputSchema,
  unhideProjectInputSchema,
  workflowItemOperationInputSchema,
  workflowRunOperationInputSchema,
  type KiriOperation,
  type KiriOperationError,
  type KiriOperationOptions,
  type KiriOperationRequest,
  type KiriOperationResponse,
} from '~/lib/contracts'
import type { KiriControlApi } from './kiri-control'

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
    case 'scratchpad.list': {
      const input = parseParams(listScratchpadParamsSchema, params)
      return shapeResult(await run(control.listScratchpad({ projectId: input.projectId })), options)
    }
    case 'terminal.read':
      return shapeResult(await run(control.terminalRead(parseParams(terminalReadInputSchema, params))), options)
    case 'terminal.list':
      return shapeResult(await run(control.terminalList()), options)
    case 'workflow.list': {
      const input = parseParams(listWorkflowRunsInputSchema, params)
      return shapeResult(await run(control.listWorkflowRuns(input)), options)
    }
    case 'workflow.show':
      return shapeResult(await run(control.getWorkflowRun(parseParams(idParamsSchema, params).id)), options)
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
    case 'session.rename':
      result = await run(control.renameSession(parseParams(renameSessionInputSchema, params)))
      break
    case 'session.archive':
      result = await run(control.deleteSession(parseParams(agentIdParamsSchema, params).agentId))
      break
    case 'session.restore':
      result = await run(control.restoreSession(parseParams(restoreSessionInputSchema, params)))
      break
    case 'agent.prompt':
      result = await run(control.agentPrompt(parseParams(agentPromptInputSchema, params)))
      break
    case 'terminal.input':
      result = await run(control.terminalInput(parseParams(terminalInputSchema, params)))
      break
    case 'terminal.keys':
      result = await run(control.terminalKeys(parseParams(terminalKeysInputSchema, params)))
      break
    case 'terminal.wait-for':
      result = await run(control.terminalWaitFor(parseParams(terminalWaitForInputSchema, params)))
      break
    case 'terminal.spawn':
      result = await run(control.terminalSpawn(parseParams(agentIdParamsSchema, params)))
      break
    case 'terminal.kill':
      result = await run(control.terminalKill(parseParams(terminalTargetSchema, params)))
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
    case 'workflow.validate':
      result = await run(control.validateWorkflow(parseParams(createWorkflowRunInputSchema, params)))
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
  throw validationError(parsed.error)
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
  if (isOperationError(error)) return error
  return {
    code: 'FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}

function isOperationError(error: unknown): error is KiriOperationError {
  return Boolean(error && typeof error === 'object' && 'code' in error && 'message' in error)
}
