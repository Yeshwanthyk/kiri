import { Option, Schema } from 'effect'

const JsonRpcIdSchema = Schema.Union(Schema.String, Schema.Number)
export type JsonRpcId = typeof JsonRpcIdSchema.Type

type JsonRpcRequest = {
  id: JsonRpcId
  method: string
  params?: unknown
}

type JsonRpcNotification = {
  method: string
  params?: unknown
}

export type JsonRpcResponse = {
  id: JsonRpcId
  result?: unknown
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}

export type CodexServerMessage = JsonRpcRequest | JsonRpcNotification

const UnknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

const CodexTurnSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  items: Schema.optional(Schema.Array(Schema.Unknown)),
})

export type CodexTurn = typeof CodexTurnSchema.Type

const CodexThreadSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  status: Schema.optional(UnknownRecord),
  turns: Schema.optional(Schema.Array(CodexTurnSchema)),
})

export const ThreadResponseSchema = Schema.Struct({
  thread: CodexThreadSchema,
})

export const TurnStartResponseSchema = Schema.Struct({
  turn: CodexTurnSchema,
})

export const ReviewStartResponseSchema = Schema.Struct({
  turn: CodexTurnSchema,
  reviewThreadId: Schema.String,
})

const TokenUsageSchema = Schema.Struct({
  total: UnknownRecord,
  last: UnknownRecord,
  modelContextWindow: Schema.optional(Schema.Number),
})

export const ThreadTokenUsageUpdatedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  tokenUsage: TokenUsageSchema,
})

export const ThreadCompactedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.NullOr(Schema.String)),
})

export const TurnDiffUpdatedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  diff: Schema.optional(Schema.String),
})

const CodexPlanStepSchema = Schema.Struct({
  step: Schema.String,
  status: Schema.optional(Schema.String),
})

export const TurnPlanUpdatedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  explanation: Schema.optional(Schema.NullOr(Schema.String)),
  plan: Schema.Array(CodexPlanStepSchema),
})

export const TurnCompletedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  turn: CodexTurnSchema,
})

export const TurnStartedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  turn: Schema.optional(CodexTurnSchema),
})

export const ItemCompletedParamsSchema = Schema.Struct({
  threadId: Schema.String,
  item: Schema.Unknown,
  completedAtMs: Schema.optional(Schema.Number),
})

export type DecodableSchema<A> = Schema.Schema<A, A, never>

export function parseResponse(value: unknown): JsonRpcResponse | null {
  const object = objectValue(value)
  const id = decodeUnknownOption(JsonRpcIdSchema, object.id)
  if (id === undefined) return null
  if (!('result' in object) && !('error' in object)) return null
  const error = objectValue(object.error)
  return {
    id,
    result: object.result,
    error: object.error
      ? {
          code: numberValue(error.code),
          message: stringValue(error.message),
          data: error.data,
        }
      : undefined,
  }
}

export function parseServerMessage(value: unknown): CodexServerMessage | null {
  const object = objectValue(value)
  const method = stringValue(object.method)
  if (!method) return null
  const id = decodeUnknownOption(JsonRpcIdSchema, object.id)
  if (id === undefined) return { method, params: object.params }
  return { id, method, params: object.params }
}

export function decodeServerParams<A>(
  message: CodexServerMessage,
  schema: DecodableSchema<A>,
) {
  return decodeUnknownOption(schema, message.params)
}

function decodeUnknownOption<A>(schema: DecodableSchema<A>, value: unknown) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value))
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === 'number' ? value : undefined
}
