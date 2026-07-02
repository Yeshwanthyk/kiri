import type { BoardMessage, TimelineEventTone } from '~/lib/contracts'
import { stringValue } from './codex-runtime-state'
import { commandText, objectValue, stringArray } from './codex-value-helpers'

export type CodexItemRecord =
  | {
    readonly type: 'message'
    readonly value: {
      readonly agentId: string
      readonly id: string
      readonly role: BoardMessage['role']
      readonly text: string
      readonly timestamp: string
    }
  }
  | {
    readonly type: 'timelineEvent'
    readonly value: {
      readonly agentId: string
      readonly kind: string
      readonly tone: TimelineEventTone
      readonly label: string
      readonly detail: string | null
      readonly payload: unknown
      readonly timestamp: string
    }
  }

export function codexItemRecord(
  agentId: string,
  item: unknown,
  timestamp: string,
): CodexItemRecord | null {
  const object = objectValue(item)
  const id = stringValue(object.id)
  const type = stringValue(object.type)
  if (!id || !type) return null

  if (type === 'agentMessage') {
    return {
      type: 'message',
      value: {
        agentId,
        id: `codex-${agentId}-${id}`,
        role: 'assistant',
        text: stringValue(object.text) ?? '',
        timestamp,
      },
    }
  }

  if (type === 'reasoning') {
    const text = [...stringArray(object.summary), ...stringArray(object.content)].join('\n')
    return {
      type: 'timelineEvent',
      value: {
        agentId,
        kind: 'codex_reasoning',
        tone: 'thinking',
        label: 'Reasoning',
        detail: text || null,
        payload: item,
        timestamp,
      },
    }
  }

  if (type === 'commandExecution') {
    return {
      type: 'message',
      value: {
        agentId,
        id: `codex-${agentId}-${id}`,
        role: 'tool',
        text: commandText(object, stringValue),
        timestamp,
      },
    }
  }

  return {
    type: 'timelineEvent',
    value: {
      agentId,
      kind: 'codex_unrecognized_item',
      tone: 'info',
      label: `Unrecognized item: ${type}`,
      detail: null,
      payload: item,
      timestamp,
    },
  }
}
