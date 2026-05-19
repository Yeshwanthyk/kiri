import { z } from 'zod'
import { boardMessageSchema, type BoardMessage } from '~/lib/contracts'

const claudeEntrySchema = z.object({
  type: z.string(),
  uuid: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  message: z.object({
    role: z.string().optional(),
    content: z.unknown().optional(),
  }).optional(),
})

export type ClaudeRuntimeState = {
  readonly claudeLastSeenUuid?: string
  readonly claudeLastSeenOffset?: number
}

export type ClaudeSessionProjection = {
  readonly sessionId: string
  readonly messages: BoardMessage[]
  readonly updatedAt?: string
  readonly nextState: ClaudeRuntimeState
}

export function projectClaudeSessionJsonl(input: {
  readonly content: string
  readonly sessionId: string
  readonly afterUuid?: string
  readonly offset?: number
}): ClaudeSessionProjection {
  const messages: BoardMessage[] = []
  const startsFromOffset = input.offset !== undefined && input.offset > 0
  let seenAfterCursor = startsFromOffset || input.afterUuid === undefined
  let foundAfterCursor = input.afterUuid === undefined || startsFromOffset
  let lastSeenUuid = input.afterUuid
  let lastSeenOffset = input.offset ?? 0
  let updatedAt: string | undefined

  for (const line of linesWithOffsets(input.content, input.offset ?? 0)) {
    const trimmed = line.text.trim()
    if (!line.complete) break

    if (!trimmed) {
      lastSeenOffset = line.endOffset
      continue
    }

    const parsed = parseClaudeEntry(trimmed)
    if (!parsed) {
      lastSeenOffset = line.endOffset
      continue
    }

    if (parsed.uuid === input.afterUuid) {
      seenAfterCursor = true
      foundAfterCursor = true
      lastSeenUuid = parsed.uuid
      lastSeenOffset = line.endOffset
      continue
    }

    if (!seenAfterCursor) {
      lastSeenOffset = line.endOffset
      continue
    }

    const message = claudeEntryToBoardMessage({
      entry: parsed,
      sessionId: input.sessionId,
    })
    if (message) {
      messages.push(message)
      updatedAt = message.timestamp
    }
    if (parsed.uuid) lastSeenUuid = parsed.uuid
    lastSeenOffset = line.endOffset
  }

  return {
    sessionId: input.sessionId,
    messages,
    ...(updatedAt ? { updatedAt } : {}),
    nextState: foundAfterCursor
      ? {
          ...(lastSeenUuid ? { claudeLastSeenUuid: lastSeenUuid } : {}),
          claudeLastSeenOffset: lastSeenOffset,
        }
      : {
          ...(input.afterUuid ? { claudeLastSeenUuid: input.afterUuid } : {}),
          ...(input.offset !== undefined ? { claudeLastSeenOffset: input.offset } : {}),
        },
  }
}

function claudeEntryToBoardMessage(input: {
  readonly entry: z.infer<typeof claudeEntrySchema>
  readonly sessionId: string
}) {
  if (input.entry.type !== 'assistant') return null
  if (!input.entry.uuid) return null
  if (input.entry.message?.role !== 'assistant') return null

  const text = claudeContentToText(input.entry.message.content)
  if (!text) return null

  return boardMessageSchema.parse({
    id: `claude:${input.sessionId}:${input.entry.uuid}`,
    role: 'assistant',
    text,
    timestamp: input.entry.timestamp ?? new Date(0).toISOString(),
  })
}

function claudeContentToText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  return content
    .flatMap((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return []
      const text = (part as Record<string, unknown>).text
      return typeof text === 'string' ? [text] : []
    })
    .join('\n')
    .trim()
}

function parseClaudeEntry(line: string) {
  try {
    return claudeEntrySchema.parse(JSON.parse(line))
  } catch {
    return null
  }
}

function linesWithOffsets(content: string, initialOffset: number) {
  const rows: Array<{ text: string; endOffset: number; complete: boolean }> = []
  let start = 0
  while (start < content.length) {
    const newline = content.indexOf('\n', start)
    const end = newline === -1 ? content.length : newline
    const text = content.slice(start, end)
    const complete = newline !== -1
    rows.push({
      text,
      endOffset: initialOffset + utf8ByteLength(content.slice(0, complete ? newline + 1 : start)),
      complete,
    })
    start = newline === -1 ? content.length : newline + 1
  }
  return rows
}

function utf8ByteLength(value: string) {
  return Buffer.byteLength(value, 'utf8')
}
