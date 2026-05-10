import { z } from 'zod'

export const runtimeKinds = ['pi', 'codex', 'claude', 'opencode'] as const
export const runtimeKindSchema = z.enum(runtimeKinds)
export type RuntimeKind = z.infer<typeof runtimeKindSchema>

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

export const diffArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  patch: z.string(),
  updatedAt: z.string(),
})
export type DiffArtifact = z.infer<typeof diffArtifactSchema>

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
  updatedAt: z.string(),
  isSession: z.boolean(),
  messages: z.array(boardMessageSchema),
  diffs: z.array(diffArtifactSchema),
})
export type AgentCell = z.infer<typeof agentCellSchema>

export const runtimeSettingsSchema = z.object({
  models: z.array(z.string().trim().min(1)).min(1),
  defaultModel: z.string().trim().min(1),
})
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>

export const picanSettingsSchema = z.object({
  runtimes: z.object({
    pi: runtimeSettingsSchema,
    codex: runtimeSettingsSchema,
    claude: runtimeSettingsSchema,
    opencode: runtimeSettingsSchema,
  }),
})
export type PicanSettings = z.infer<typeof picanSettingsSchema>

export const projectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  position: z.number().int().nonnegative(),
  agents: z.array(agentCellSchema),
})
export type ProjectRow = z.infer<typeof projectRowSchema>

export const workspaceSnapshotSchema = z.object({
  settings: picanSettingsSchema,
  projects: z.array(projectRowSchema),
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

export const sendMessageInputSchema = z.object({
  agentId: z.string().trim().min(1),
  text: z.string().trim().min(1),
})
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>

export const startSessionInputSchema = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().optional(),
  runtime: runtimeKindSchema.optional(),
  model: z.string().trim().optional(),
})
export type StartSessionInput = z.infer<typeof startSessionInputSchema>

export const deleteSessionInputSchema = z.object({
  agentId: z.string().trim().min(1),
})
export type DeleteSessionInput = z.infer<typeof deleteSessionInputSchema>

export type AgentRuntimeState = {
  kind: RuntimeKind
  sessionId?: string
  sessionFile?: string
  isStreaming: boolean
  messageCount: number
  pendingMessageCount: number
}
