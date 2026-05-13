import { describe, expect, it } from 'vitest'
import {
  errorMessage,
  formatElapsed,
  formatKeyShort,
  formatThinkingLevel,
  formatTokenCount,
  projectNameFromPath,
  projectSummary,
} from '../../src/components/kiri-board/format'

describe('kiri-board formatting helpers', () => {
  it('formats compact keyboard labels', () => {
    expect(formatKeyShort('arrowdown')).toBe('Down')
    expect(formatKeyShort('k')).toBe('K')
    expect(formatKeyShort('')).toBe('')
  })

  it('formats durations and token counts for dense UI labels', () => {
    expect(formatElapsed(9)).toBe('0:09')
    expect(formatElapsed(75)).toBe('1:15')
    expect(formatElapsed(3_661)).toBe('1:01:01')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1_250)).toBe('1.3K')
    expect(formatTokenCount(2_100_000)).toBe('2.1M')
  })

  it('normalizes thinking level copy without changing persisted values', () => {
    expect(formatThinkingLevel('minimal')).toBe('low')
    expect(formatThinkingLevel('xhigh')).toBe('xhigh')
  })

  it('formats project labels from registry values', () => {
    expect(projectNameFromPath('/Users/yesh/Documents/personal/pican/')).toBe('pican')
    expect(projectSummary({ name: 'Kiri', agents: [] })).toBe('Kiri · 0 sessions')
    expect(projectSummary({ name: 'Kiri', agents: [{}] })).toBe('Kiri · 1 session')
  })

  it('keeps unknown errors terse for UI surfaces', () => {
    expect(errorMessage(new Error('Nope'))).toBe('Nope')
    expect(errorMessage('Nope')).toBe('Request failed')
  })
})

