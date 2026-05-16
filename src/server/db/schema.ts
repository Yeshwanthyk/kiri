import { z } from 'zod'
import {
  agentTaskSchema,
  agentStatusSchema,
  messageRoleSchema,
  runtimeKindSchema,
  sessionInterfaceModeSchema,
  timelineEventToneSchema,
} from '~/lib/contracts'

export const projectDbRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  position: z.number().int().nonnegative(),
  hiddenAt: z.string().nullable(),
})

const agentDbRowSchema = z.object({
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
  position: z.number().int().nonnegative(),
  preview: z.string().nullable(),
  messageCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.string().nullable(),
  diffCount: z.number().int().nonnegative(),
  threadId: z.string().nullable(),
  archivedAt: z.string().nullable(),
})

export const agentDetailDbRowSchema = agentDbRowSchema.extend({
  cwd: z.string(),
})

export const archivedSessionDbRowSchema = agentDbRowSchema.extend({
  projectName: z.string(),
  archivedAt: z.string(),
})

export const projectSummaryDbRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  hiddenAt: z.string().nullable(),
  sessionCount: z.number().int().nonnegative(),
})

export const sessionSummaryDbRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  runtime: runtimeKindSchema,
  interfaceMode: sessionInterfaceModeSchema.default('gui'),
  model: z.string(),
  status: agentStatusSchema,
  preview: z.string().nullable(),
  messageCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
})

export const messageDbRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  role: messageRoleSchema,
  text: z.string(),
  timestamp: z.string(),
})

export const timelineEventDbRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  kind: z.string(),
  tone: timelineEventToneSchema,
  label: z.string(),
  detail: z.string().nullable(),
  timestamp: z.string(),
  payloadJson: z.string(),
})

export const agentTaskDbRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: agentTaskSchema.shape.status,
  source: runtimeKindSchema,
  updatedAt: z.string(),
  position: z.number().int().nonnegative(),
})

export const diffDbRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  path: z.string(),
  patch: z.string(),
  updatedAt: z.string(),
})

export const contextUsageDbRowSchema = z.object({
  agentId: z.string(),
  usedTokens: z.number().int().nonnegative(),
  windowTokens: z.number().int().positive().nullable(),
  updatedAt: z.string(),
  sessionFile: z.string().nullable(),
})

export const scratchpadBlockDbRowSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  triggeredAt: z.string().nullable(),
  triggeredAgentId: z.string().nullable(),
})

export const agentLaunchConfigSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runtime: runtimeKindSchema,
  sessionDir: z.string(),
  sessionFile: z.string().nullable(),
  model: z.string(),
  cwd: z.string(),
  runtimeStateJson: z.string().nullable().default(null),
})

export const idDbRowSchema = z.object({
  id: z.string(),
})

export const projectIdDbRowSchema = z.object({
  id: z.string(),
})

export const persistedSessionDbRowSchema = z.object({
  id: z.string(),
  slot: z.string(),
  sessionDir: z.string(),
  sessionFile: z.string().nullable(),
})

export const deletedSessionDbRowSchema = z.object({
  slot: z.string(),
})
