import { z } from 'zod'

export const readModelKinds = [
  'workspace.summary',
  'agent.timeline.summary',
  'diff.summary',
] as const
export const readModelKindSchema = z.enum(readModelKinds)
export type ReadModelKind = z.infer<typeof readModelKindSchema>

export const readModelContractVersion = 1

const readModelBaseEntrySchema = {
  entityId: z.string().trim().min(1),
  revision: z.string().trim().min(1),
  updatedAt: z.string(),
}

export const workspaceSummaryPayloadSchema = z.object({
  projectCount: z.number().int().nonnegative(),
  hiddenProjectCount: z.number().int().nonnegative(),
  activeAgentCount: z.number().int().nonnegative(),
  archivedAgentCount: z.number().int().nonnegative(),
  scratchpadBlockCount: z.number().int().nonnegative(),
  totalMessages: z.number().int().nonnegative(),
  totalDiffs: z.number().int().nonnegative(),
})

export const agentTimelineSummaryPayloadSchema = z.object({
  agentId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  preview: z.string(),
  messageCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  diffCount: z.number().int().nonnegative(),
  latestTimelineAt: z.string(),
})

export const diffSummaryPayloadSchema = z.object({
  id: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  title: z.string(),
  path: z.string(),
})

export const readModelEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    ...readModelBaseEntrySchema,
    kind: z.literal('workspace.summary'),
    payload: workspaceSummaryPayloadSchema,
  }),
  z.object({
    ...readModelBaseEntrySchema,
    kind: z.literal('agent.timeline.summary'),
    payload: agentTimelineSummaryPayloadSchema,
  }),
  z.object({
    ...readModelBaseEntrySchema,
    kind: z.literal('diff.summary'),
    payload: diffSummaryPayloadSchema,
  }),
])
export type ReadModelEntry = z.infer<typeof readModelEntrySchema>
export type ReadModelCandidate = Omit<ReadModelEntry, 'revision'>

export const readModelIndexContractSchema = z.object({
  version: z.literal(readModelContractVersion),
  entries: z.array(readModelEntrySchema),
})
export type ReadModelIndexContract = z.infer<typeof readModelIndexContractSchema>
