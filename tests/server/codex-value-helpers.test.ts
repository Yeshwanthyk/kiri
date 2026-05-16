import { describe, expect, it } from 'vitest'
import {
  commandText,
  normalizeTaskStatus,
  numberValue,
  objectValue,
  stringArray,
  timestampFromMs,
} from '~/server/codex-value-helpers'

describe('codex value helpers', () => {
  it('normalizes object, number, string-array, and timestamp values', () => {
    expect(objectValue({ ok: true })).toEqual({ ok: true })
    expect(objectValue(['nope'])).toEqual({})
    expect(numberValue(3)).toBe(3)
    expect(numberValue('3')).toBeUndefined()
    expect(stringArray(['a', 1, 'b'])).toEqual(['a', 'b'])
    expect(timestampFromMs(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(timestampFromMs('0')).toBeUndefined()
  })

  it('keeps task status normalization stable', () => {
    expect(normalizeTaskStatus('in_progress')).toBe('inProgress')
    expect(normalizeTaskStatus('pending')).toBe('pending')
    expect(normalizeTaskStatus('inProgress')).toBe('inProgress')
    expect(normalizeTaskStatus('completed')).toBe('completed')
    expect(normalizeTaskStatus('failed')).toBe('failed')
    expect(normalizeTaskStatus('wat')).toBeUndefined()
  })

  it('formats command text with optional aggregated output', () => {
    const readString = (value: unknown) => typeof value === 'string' ? value : undefined

    expect(commandText({ command: 'pnpm test' }, readString)).toBe('pnpm test')
    expect(commandText({ command: 'pnpm test', aggregatedOutput: 'ok' }, readString))
      .toBe('pnpm test\nok')
    expect(commandText({}, readString)).toBe('Command')
  })
})
