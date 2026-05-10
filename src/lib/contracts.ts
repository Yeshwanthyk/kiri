import { z } from 'zod'

export const runtimeKindSchema = z.enum(['pi', 'codex', 'claude', 'opencode'])
export type RuntimeKind = z.infer<typeof runtimeKindSchema>

export const agentStatusSchema = z.enum([
  'idle',
  'running',
  'queued',
  'blocked',
  'failed',
])
export type AgentStatus = z.infer<typeof agentStatusSchema>

export const messageRoleSchema = z.enum([
  'user',
  'assistant',
  'tool',
  'system',
  'summary',
])
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
  messages: z.array(boardMessageSchema),
  diffs: z.array(diffArtifactSchema),
})
export type AgentCell = z.infer<typeof agentCellSchema>

export const projectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  position: z.number().int().nonnegative(),
  agents: z.array(agentCellSchema),
})
export type ProjectRow = z.infer<typeof projectRowSchema>

export const workspaceSnapshotSchema = z.object({
  projects: z.array(projectRowSchema),
  selected: z.object({
    projectId: z.string(),
    agentId: z.string(),
  }),
})
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>

export type AgentRuntimeState = {
  kind: RuntimeKind
  sessionId?: string
  sessionFile?: string
  isStreaming: boolean
  messageCount: number
  pendingMessageCount: number
}
