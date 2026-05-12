import { z } from 'zod'

export const runtimeKinds = ['pi', 'codex', 'claude', 'opencode'] as const
export const runtimeKindSchema = z.enum(runtimeKinds)
export type RuntimeKind = z.infer<typeof runtimeKindSchema>

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const thinkingLevelSchema = z.enum(thinkingLevels)
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>

export const agentStatuses = [
  'idle',
  'running',
  'queued',
  'blocked',
  'failed',
] as const
export const agentStatusSchema = z.enum(agentStatuses)
export type AgentStatus = z.infer<typeof agentStatusSchema>

export const messageRoles = [
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

export const timelineEventTones = ['thinking', 'tool', 'info', 'error'] as const
export const timelineEventToneSchema = z.enum(timelineEventTones)
export type TimelineEventTone = z.infer<typeof timelineEventToneSchema>

export const timelineEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  tone: timelineEventToneSchema,
  label: z.string(),
  detail: z.string().nullable(),
  path: z.string().optional(),
  timestamp: z.string(),
})
export type TimelineEvent = z.infer<typeof timelineEventSchema>

export const boardTimelineItemSchema = z.discriminatedUnion('type', [
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
export type BoardTimelineItem = z.infer<typeof boardTimelineItemSchema>

export const diffArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  patch: z.string(),
  updatedAt: z.string(),
})
export type DiffArtifact = z.infer<typeof diffArtifactSchema>

export const contextUsageSchema = z.object({
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

export const agentTaskStatuses = ['pending', 'inProgress', 'completed', 'failed'] as const
export const agentTaskStatusSchema = z.enum(agentTaskStatuses)
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>

export const agentTaskSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  status: agentTaskStatusSchema,
  source: runtimeKindSchema,
  updatedAt: z.string(),
})
export type AgentTask = z.infer<typeof agentTaskSchema>

export const agentCellSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  slot: z.string(),
  title: z.string(),
  runtime: runtimeKindSchema,
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
  diffs: z.array(diffArtifactSchema),
  tasks: z.array(agentTaskSchema).default([]),
})
export type AgentCell = z.infer<typeof agentCellSchema>

export const archivedSessionSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  runtime: runtimeKindSchema,
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
})
export type AgentDetailInput = z.infer<typeof agentDetailInputSchema>

export const agentDetailSchema = agentCellSchema
export type AgentDetail = z.infer<typeof agentDetailSchema>

export const runtimeSettingsSchema = z.object({
  models: z.array(z.string().trim().min(1)).min(1),
  defaultModel: z.string().trim().min(1),
  contextWindows: z.record(z.string(), z.number().int().positive()).optional(),
})
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>

export const titleGenerationSettingsSchema = z.object({
  enabled: z.boolean(),
  runtime: runtimeKindSchema,
  model: z.string().trim().min(1),
  timeoutMs: z.number().int().positive().max(10_000),
}).optional()
export type TitleGenerationSettings = z.infer<typeof titleGenerationSettingsSchema>

export const aetherSettingsSchema = z.object({
  runtimes: z.object({
    pi: runtimeSettingsSchema,
    codex: runtimeSettingsSchema,
    claude: runtimeSettingsSchema,
    opencode: runtimeSettingsSchema,
  }),
  titleGeneration: titleGenerationSettingsSchema,
})
export type AetherSettings = z.infer<typeof aetherSettingsSchema>

export const projectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  position: z.number().int().nonnegative(),
  hiddenAt: z.string().nullable(),
  agents: z.array(agentCellSchema),
})
export type ProjectRow = z.infer<typeof projectRowSchema>

export const scratchpadBlockSchema = z.object({
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
  settings: aetherSettingsSchema,
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

export const addProjectInputSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
})
export type AddProjectInput = z.infer<typeof addProjectInputSchema>

export const deleteProjectInputSchema = z.object({
  id: z.string().trim().min(1),
})
export type DeleteProjectInput = z.infer<typeof deleteProjectInputSchema>

export const hideProjectInputSchema = z.object({
  id: z.string().trim().min(1),
})
export type HideProjectInput = z.infer<typeof hideProjectInputSchema>

export const unhideProjectInputSchema = z.object({
  id: z.string().trim().min(1),
})
export type UnhideProjectInput = z.infer<typeof unhideProjectInputSchema>

export const sendMessageImageSchema = z.object({
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
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>

export const steerMessageInputSchema = z.object({
  agentId: z.string().trim().min(1),
  text: z.string().trim().min(1),
  images: z.array(sendMessageImageSchema).max(4).default([]),
})
export type SteerMessageInput = z.infer<typeof steerMessageInputSchema>

export const interruptMessageInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
export type InterruptMessageInput = z.infer<typeof interruptMessageInputSchema>

export const setThinkingLevelInputSchema = z.object({
  agentId: z.string().trim().min(1),
  level: thinkingLevelSchema.optional(),
})
export type SetThinkingLevelInput = z.infer<typeof setThinkingLevelInputSchema>

export const resetSessionInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
export type ResetSessionInput = z.infer<typeof resetSessionInputSchema>

export const forkSessionInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
export type ForkSessionInput = z.infer<typeof forkSessionInputSchema>

export const reviewTargetSchema = z.discriminatedUnion('type', [
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
export type ReviewSessionInput = z.infer<typeof reviewSessionInputSchema>

export const terminalConfigInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
export type TerminalConfigInput = z.infer<typeof terminalConfigInputSchema>

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
export type RenameSessionInput = z.infer<typeof renameSessionInputSchema>

export const addScratchpadBlockInputSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  projectId: z.string().trim().min(1).nullable().default(null),
})
export type AddScratchpadBlockInput = z.infer<typeof addScratchpadBlockInputSchema>

export const deleteScratchpadBlockInputSchema = z.object({
  id: z.string().trim().min(1),
})
export type DeleteScratchpadBlockInput = z.infer<typeof deleteScratchpadBlockInputSchema>

export const triggerScratchpadBlockInputSchema = z.object({
  id: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  runtime: runtimeKindSchema.optional(),
  model: z.string().trim().optional(),
  title: z.string().trim().optional(),
  thinkingLevel: thinkingLevelSchema.default('medium'),
})
export type TriggerScratchpadBlockInput = z.infer<typeof triggerScratchpadBlockInputSchema>

export type AgentRuntimeState = {
  kind: RuntimeKind
  sessionId?: string
  sessionFile?: string
  isStreaming: boolean
  messageCount: number
  pendingMessageCount: number
}
