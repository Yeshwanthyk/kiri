import { z } from 'zod'
import {
  agentByProjectSchema,
  chatTypographySchema,
  keymapSettingsSchema,
  themeSelectionSchema,
  uiPreferencesSchema,
} from './ui-preferences'

export const runtimeKinds = ['pi', 'codex', 'claude', 'opencode'] as const
export const runtimeKindSchema = z.enum(runtimeKinds)
export type RuntimeKind = z.infer<typeof runtimeKindSchema>

export const sessionInterfaceModes = ['gui', 'terminal'] as const
export const sessionInterfaceModeSchema = z.enum(sessionInterfaceModes)
export type SessionInterfaceMode = z.infer<typeof sessionInterfaceModeSchema>

export function sessionInterfaceModeForRuntime(
  runtime: RuntimeKind,
  interfaceMode?: SessionInterfaceMode,
): SessionInterfaceMode {
  switch (runtime) {
    case 'claude':
    case 'opencode':
      return 'terminal'
    case 'codex':
    case 'pi':
      return interfaceMode ?? 'gui'
    default:
      return assertNeverRuntime(runtime)
  }
}

const terminalModes = ['runtime', 'shell'] as const
export const terminalModeSchema = z.enum(terminalModes)
export type TerminalMode = z.infer<typeof terminalModeSchema>

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const thinkingLevelSchema = z.enum(thinkingLevels)
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>

const agentStatuses = [
  'idle',
  'running',
  'queued',
  'blocked',
  'failed',
] as const
export const agentStatusSchema = z.enum(agentStatuses)
export type AgentStatus = z.infer<typeof agentStatusSchema>

const messageRoles = [
  'user',
  'assistant',
  'tool',
  'system',
  'summary',
] as const
export const messageRoleSchema = z.enum(messageRoles)
export type MessageRole = z.infer<typeof messageRoleSchema>

export const boardMessageSchema = z.object({
  id: z.string(),
  role: messageRoleSchema,
  text: z.string(),
  timestamp: z.string(),
})
export type BoardMessage = z.infer<typeof boardMessageSchema>

const timelineEventTones = ['thinking', 'tool', 'info', 'error'] as const
export const timelineEventToneSchema = z.enum(timelineEventTones)
export type TimelineEventTone = z.infer<typeof timelineEventToneSchema>

const timelineEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  tone: timelineEventToneSchema,
  label: z.string(),
  detail: z.string().nullable(),
  path: z.string().optional(),
  timestamp: z.string(),
})
export type TimelineEvent = z.infer<typeof timelineEventSchema>

const boardTimelineItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    id: z.string(),
    timestamp: z.string(),
    message: boardMessageSchema,
  }),
  z.object({
    type: z.literal('event'),
    id: z.string(),
    timestamp: z.string(),
    event: timelineEventSchema,
  }),
])
type BoardTimelineItem = z.infer<typeof boardTimelineItemSchema>

const diffArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  patch: z.string(),
  updatedAt: z.string(),
})
export type DiffArtifact = z.infer<typeof diffArtifactSchema>

const contextUsageSchema = z.object({
  usedTokens: z.number().int().nonnegative(),
  remainingTokens: z.number().int().nonnegative(),
  windowTokens: z.number().int().positive(),
  usedPercent: z.number().min(0).max(100),
})
export type ContextUsage = z.infer<typeof contextUsageSchema>

export const pendingQuestionSchema = z.object({
  requestId: z.string().trim().min(1),
  questions: z.array(z.object({
    id: z.string().trim().min(1),
    header: z.string().trim().min(1),
    question: z.string().trim().min(1),
    options: z.array(z.object({
      label: z.string(),
      description: z.string(),
    })).default([]),
    multiSelect: z.boolean().default(false),
  })).min(1),
})
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>

const agentTaskStatuses = ['pending', 'inProgress', 'completed', 'failed'] as const
const agentTaskStatusSchema = z.enum(agentTaskStatuses)
type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>

export const agentTaskSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  status: agentTaskStatusSchema,
  source: runtimeKindSchema,
  updatedAt: z.string(),
})
export type AgentTask = z.infer<typeof agentTaskSchema>

const agentDetailPageSchema = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})

const agentCellSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  slot: z.string(),
  title: z.string(),
  runtime: runtimeKindSchema,
  interfaceMode: sessionInterfaceModeSchema.default('gui'),
  model: z.string(),
  status: agentStatusSchema,
  sessionDir: z.string(),
  sessionFile: z.string().nullable(),
  preview: z.string(),
  messageCount: z.number().int().nonnegative(),
  diffCount: z.number().int().nonnegative(),
  contextUsage: contextUsageSchema.nullable().default(null),
  pendingQuestion: pendingQuestionSchema.nullable().default(null),
  updatedAt: z.string(),
  isSession: z.boolean(),
  messages: z.array(boardMessageSchema),
  timelineEvents: z.array(timelineEventSchema).default([]),
  timeline: z.array(boardTimelineItemSchema).default([]),
  timelinePage: agentDetailPageSchema.optional(),
  diffs: z.array(diffArtifactSchema),
  tasks: z.array(agentTaskSchema).default([]),
})
export type AgentCell = z.infer<typeof agentCellSchema>

const archivedSessionSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  runtime: runtimeKindSchema,
  interfaceMode: sessionInterfaceModeSchema.default('gui'),
  model: z.string(),
  status: agentStatusSchema,
  preview: z.string(),
  messageCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
  archivedAt: z.string(),
})
export type ArchivedSessionSummary = z.infer<typeof archivedSessionSummarySchema>

export const agentDetailInputSchema = z.object({
  agentId: z.string().trim().min(1),
  limit: z.number().int().positive().max(500).default(500),
  offset: z.number().int().nonnegative().max(100_000).default(0),
})
type AgentDetailInput = z.infer<typeof agentDetailInputSchema>

export const agentDetailSchema = z.lazy(() => agentCellSchema)
export type AgentDetail = z.infer<typeof agentDetailSchema>

export const agentEventTypes = [
  'agent.status.changed',
  'agent.turn.started',
  'agent.turn.completed',
  'agent.turn.failed',
  'agent.message.created',
  'agent.message.updated',
  'agent.tool.started',
  'agent.tool.completed',
  'agent.diff.updated',
  'agent.question.requested',
] as const
export const agentEventTypeSchema = z.enum(agentEventTypes)
export type AgentEventType = z.infer<typeof agentEventTypeSchema>

export const agentEventSchema = z.object({
  id: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  sequence: z.number().int().positive(),
  type: agentEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
export type AgentEvent = z.infer<typeof agentEventSchema>

export const listAgentEventsInputSchema = z.object({
  agentId: z.string().trim().min(1),
  afterSequence: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(500).default(100),
})
export type ListAgentEventsInput = z.infer<typeof listAgentEventsInputSchema>

const runtimeSettingsSchema = z.object({
  models: z.array(z.string().trim().min(1)).min(1),
  defaultModel: z.string().trim().min(1),
  contextWindows: z.record(z.string(), z.number().int().positive()).optional(),
})
type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>
const runtimeSettingsSchemaByKind = {
  pi: runtimeSettingsSchema,
  codex: runtimeSettingsSchema,
  claude: runtimeSettingsSchema,
  opencode: runtimeSettingsSchema,
} satisfies Record<RuntimeKind, typeof runtimeSettingsSchema>

export const kiriSettingsSchema = z.object({
  runtimes: z.object(runtimeSettingsSchemaByKind),
})
export type KiriSettings = z.infer<typeof kiriSettingsSchema>

function assertNeverRuntime(runtime: never): never {
  throw new Error(`Unhandled runtime: ${String(runtime)}`)
}

const projectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  position: z.number().int().nonnegative(),
  hiddenAt: z.string().nullable(),
  agents: z.array(agentCellSchema),
})
export type ProjectRow = z.infer<typeof projectRowSchema>

const scratchpadBlockSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  triggeredAt: z.string().nullable(),
  triggeredAgentId: z.string().nullable(),
})
export type ScratchpadBlock = z.infer<typeof scratchpadBlockSchema>

export const workspaceSnapshotSchema = z.object({
  settings: kiriSettingsSchema,
  preferences: uiPreferencesSchema,
  projects: z.array(projectRowSchema),
  hiddenProjects: z.array(projectRowSchema),
  archivedSessions: z.array(archivedSessionSummarySchema).default([]),
  scratchpadBlocks: z.array(scratchpadBlockSchema).default([]),
  selected: z.object({
    projectId: z.string(),
    agentId: z.string(),
  }),
})
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>

export const setThemePreferenceInputSchema = themeSelectionSchema
export const setKeymapPreferenceInputSchema = keymapSettingsSchema
export const setChatTypographyPreferenceInputSchema = chatTypographySchema
export const setAgentByProjectPreferenceInputSchema = agentByProjectSchema

export const addProjectInputSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
})
export type AddProjectInput = z.infer<typeof addProjectInputSchema>

export const deleteProjectInputSchema = z.object({
  id: z.string().trim().min(1),
})
type DeleteProjectInput = z.infer<typeof deleteProjectInputSchema>

export const hideProjectInputSchema = z.object({
  id: z.string().trim().min(1),
})
type HideProjectInput = z.infer<typeof hideProjectInputSchema>

export const reorderProjectsInputSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1),
})
export type ReorderProjectsInput = z.infer<typeof reorderProjectsInputSchema>

export const unhideProjectInputSchema = z.object({
  id: z.string().trim().min(1),
})
type UnhideProjectInput = z.infer<typeof unhideProjectInputSchema>

const sendMessageImageSchema = z.object({
  name: z.string().trim().min(1).max(160),
  mimeType: z.string().trim().regex(/^image\/(png|jpeg|jpg|webp|gif)$/),
  data: z.string().trim().min(1).max(7_000_000),
})
export type SendMessageImage = z.infer<typeof sendMessageImageSchema>

export const sendMessageInputSchema = z.object({
  agentId: z.string().trim().min(1),
  text: z.string().trim().min(1),
  images: z.array(sendMessageImageSchema).max(4).default([]),
})
type SendMessageInput = z.infer<typeof sendMessageInputSchema>

export const agentPromptInputSchema = z.object({
  agentId: z.string().trim().min(1),
  text: z.string().trim().min(1).max(40_000),
  images: z.array(sendMessageImageSchema).max(4).default([]),
  mode: z.enum(['prompt', 'steer']).default('prompt'),
})
export type AgentPromptInput = z.infer<typeof agentPromptInputSchema>

export const terminalInputSchema = z.object({
  agentId: z.string().trim().min(1),
  text: z.string().trim().min(1).max(40_000),
  submit: z.boolean().default(true),
  spawn: z.boolean().default(true),
})
export type TerminalInput = z.infer<typeof terminalInputSchema>

export const steerMessageInputSchema = z.object({
  agentId: z.string().trim().min(1),
  text: z.string().trim().min(1),
  images: z.array(sendMessageImageSchema).max(4).default([]),
})
type SteerMessageInput = z.infer<typeof steerMessageInputSchema>

export const interruptMessageInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
type InterruptMessageInput = z.infer<typeof interruptMessageInputSchema>

export const setThinkingLevelInputSchema = z.object({
  agentId: z.string().trim().min(1),
  level: thinkingLevelSchema.optional(),
})
type SetThinkingLevelInput = z.infer<typeof setThinkingLevelInputSchema>

export const resetSessionInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
type ResetSessionInput = z.infer<typeof resetSessionInputSchema>

export const forkSessionInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
type ForkSessionInput = z.infer<typeof forkSessionInputSchema>

const reviewTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('uncommittedChanges'),
  }),
  z.object({
    type: z.literal('baseBranch'),
    branch: z.string().trim().min(1),
  }),
])
export type ReviewTarget = z.infer<typeof reviewTargetSchema>

export const reviewSessionInputSchema = z.object({
  agentId: z.string().trim().min(1),
  target: reviewTargetSchema,
})
type ReviewSessionInput = z.infer<typeof reviewSessionInputSchema>

export const terminalConfigInputSchema = z.object({
  agentId: z.string().trim().min(1),
  mode: terminalModeSchema.default('shell'),
})
type TerminalConfigInput = z.infer<typeof terminalConfigInputSchema>

export const refreshTerminalDiffsInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
type RefreshTerminalDiffsInput = z.infer<typeof refreshTerminalDiffsInputSchema>

const terminalConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().nonnegative(),
  path: z.string(),
  token: z.string(),
  mode: terminalModeSchema,
  runtime: runtimeKindSchema,
  model: z.string(),
})
export type TerminalConfig = z.infer<typeof terminalConfigSchema>

export const answerQuestionInputSchema = z.object({
  agentId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  answers: z.record(z.string(), z.union([
    z.string(),
    z.array(z.string()),
  ])),
})
export type AnswerQuestionInput = z.infer<typeof answerQuestionInputSchema>

export const startSessionInputSchema = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().optional(),
  runtime: runtimeKindSchema.optional(),
  interfaceMode: sessionInterfaceModeSchema.default('gui'),
  model: z.string().trim().optional(),
  thinkingLevel: thinkingLevelSchema.default('medium'),
})
export type StartSessionInput = z.infer<typeof startSessionInputSchema>

export const deleteSessionInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
export type DeleteSessionInput = z.infer<typeof deleteSessionInputSchema>

export const restoreSessionInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
export type RestoreSessionInput = z.infer<typeof restoreSessionInputSchema>

export const renameSessionInputSchema = z.object({
  agentId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(160),
})
type RenameSessionInput = z.infer<typeof renameSessionInputSchema>

export const addScratchpadBlockInputSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  projectId: z.string().trim().min(1).nullable().default(null),
})
export type AddScratchpadBlockInput = z.infer<typeof addScratchpadBlockInputSchema>

export const deleteScratchpadBlockInputSchema = z.object({
  id: z.string().trim().min(1),
})
type DeleteScratchpadBlockInput = z.infer<typeof deleteScratchpadBlockInputSchema>

export const triggerScratchpadBlockInputSchema = z.object({
  id: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  runtime: runtimeKindSchema.optional(),
  interfaceMode: sessionInterfaceModeSchema.optional(),
  model: z.string().trim().optional(),
  title: z.string().trim().optional(),
  thinkingLevel: thinkingLevelSchema.default('medium'),
})
type TriggerScratchpadBlockInput = z.infer<typeof triggerScratchpadBlockInputSchema>

export const kiriReadOperations = [
  'operations.list',
  'context.show',
  'model.list',
  'project.list',
  'session.list',
  'agent.detail',
  'agent.events.list',
  'scratchpad.list',
  'workflow.list',
  'workflow.show',
] as const
export const kiriReadOperationSchema = z.enum(kiriReadOperations)
export type KiriReadOperation = z.infer<typeof kiriReadOperationSchema>

export const kiriWriteOperations = [
  'project.add',
  'project.hide',
  'project.unhide',
  'project.delete',
  'session.create',
  'session.rename',
  'session.archive',
  'session.restore',
  'agent.prompt',
  'terminal.input',
  'scratchpad.add',
  'scratchpad.delete',
  'scratchpad.trigger',
  'workflow.validate',
  'workflow.create',
  'workflow.dispatch',
  'workflow.retrigger',
  'workflow.track',
  'workflow.untrack',
  'workflow.archive',
  'workflow.restore',
] as const
export const kiriWriteOperationSchema = z.enum(kiriWriteOperations)
export type KiriWriteOperation = z.infer<typeof kiriWriteOperationSchema>

export const kiriOperationSchema = z.union([
  kiriReadOperationSchema,
  kiriWriteOperationSchema,
])
export type KiriOperation = z.infer<typeof kiriOperationSchema>

export const kiriOperationOptionsSchema = z.object({
  compact: z.boolean().default(true),
  fields: z.array(z.string().trim().min(1)).optional(),
  includeContext: z.boolean().default(false),
  limit: z.number().int().positive().max(500).optional(),
})
export type KiriOperationOptions = z.infer<typeof kiriOperationOptionsSchema>

export const kiriOperationRequestSchema = z.object({
  operation: kiriOperationSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  options: kiriOperationOptionsSchema.default({
    compact: true,
    includeContext: false,
  }),
})
export type KiriOperationRequest = z.infer<typeof kiriOperationRequestSchema>

export const kiriOperationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
})
export type KiriOperationError = z.infer<typeof kiriOperationErrorSchema>

export const kiriOperationResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    operation: kiriOperationSchema,
    result: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    operation: kiriOperationSchema,
    error: kiriOperationErrorSchema,
  }),
])
export type KiriOperationResponse = z.infer<typeof kiriOperationResponseSchema>

export const workflowItemActions = ['launch', 'scratchpad'] as const
export const workflowItemActionSchema = z.enum(workflowItemActions)
export type WorkflowItemAction = z.infer<typeof workflowItemActionSchema>

export const workflowRunStatuses = [
  'validated',
  'running',
  'completed',
  'failed',
  'archived',
] as const
export const workflowRunStatusSchema = z.enum(workflowRunStatuses)
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>

export const workflowItemStatuses = [
  'pending',
  'running',
  'completed',
  'failed',
  'untracked',
] as const
export const workflowItemStatusSchema = z.enum(workflowItemStatuses)
export type WorkflowItemStatus = z.infer<typeof workflowItemStatusSchema>

export const workflowAttemptStatuses = [
  'launched',
  'failed',
] as const
export const workflowAttemptStatusSchema = z.enum(workflowAttemptStatuses)
export type WorkflowAttemptStatus = z.infer<typeof workflowAttemptStatusSchema>

export const workflowTerminalPasteSchema = z.object({
  submit: z.boolean().default(true),
})
export type WorkflowTerminalPaste = z.infer<typeof workflowTerminalPasteSchema>

export const workflowDefaultsSchema = z.object({
  runtime: runtimeKindSchema.optional(),
  interfaceMode: sessionInterfaceModeSchema.optional(),
  model: z.string().trim().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  attachScratchpad: z.boolean().default(true),
  terminalPaste: workflowTerminalPasteSchema.optional(),
}).default({ attachScratchpad: true })
export type WorkflowDefaults = z.infer<typeof workflowDefaultsSchema>

const workflowBaseItemInputSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(4000),
  tracked: z.boolean().default(true),
  attachScratchpad: z.boolean().optional(),
})

export const workflowLaunchItemInputSchema = workflowBaseItemInputSchema.extend({
  action: z.literal('launch'),
  runtime: runtimeKindSchema.optional(),
  interfaceMode: sessionInterfaceModeSchema.optional(),
  model: z.string().trim().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  terminalPaste: workflowTerminalPasteSchema.optional(),
})

export const workflowScratchpadItemInputSchema = workflowBaseItemInputSchema.extend({
  action: z.literal('scratchpad'),
})

export const workflowItemInputSchema = z.discriminatedUnion('action', [
  workflowLaunchItemInputSchema,
  workflowScratchpadItemInputSchema,
])
export type WorkflowItemInput = z.infer<typeof workflowItemInputSchema>

export const createWorkflowRunInputSchema = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(160),
  defaults: workflowDefaultsSchema,
  items: z.array(workflowItemInputSchema).min(1).max(50),
})
export type CreateWorkflowRunInput = z.infer<typeof createWorkflowRunInputSchema>

export const workflowRunOperationInputSchema = z.object({
  id: z.string().trim().min(1),
})
export type WorkflowRunOperationInput = z.infer<typeof workflowRunOperationInputSchema>

export const workflowItemOperationInputSchema = z.object({
  itemId: z.string().trim().min(1),
  runtime: runtimeKindSchema.optional(),
  interfaceMode: sessionInterfaceModeSchema.optional(),
  model: z.string().trim().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  terminalPaste: workflowTerminalPasteSchema.optional(),
})
export type WorkflowItemOperationInput = z.infer<typeof workflowItemOperationInputSchema>

export const listWorkflowRunsInputSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  includeArchived: z.boolean().default(false),
})
export type ListWorkflowRunsInput = z.infer<typeof listWorkflowRunsInputSchema>

export type AgentRuntimeState = {
  kind: RuntimeKind
  sessionId?: string
  sessionFile?: string
  isStreaming: boolean
  messageCount: number
  pendingMessageCount: number
}
