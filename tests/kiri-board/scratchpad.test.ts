import { afterEach, describe, expect, it, vi } from 'vitest'
import { groupBlocksByDay } from '../../src/components/kiri-board/scratchpad'
import type { ScratchpadBlock } from '../../src/lib/contracts'

function block(id: string, createdAt: string): ScratchpadBlock {
  return {
    id,
    projectId: null,
    projectName: null,
    body: id,
    createdAt,
    triggeredAt: null,
    triggeredAgentId: null,
  }
}

describe('scratchpad helpers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('groups blocks by formatted day without reordering them', () => {
    vi.setSystemTime(new Date('2026-05-12T12:00:00.000Z'))

    const groups = groupBlocksByDay([
      block('today-a', '2026-05-12T10:00:00.000Z'),
      block('today-b', '2026-05-12T11:00:00.000Z'),
      block('yesterday', '2026-05-11T18:00:00.000Z'),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]?.label).toBe('Today')
    expect(groups[0]?.blocks.map((item) => item.id)).toEqual(['today-a', 'today-b'])
    expect(groups[1]?.label).toBe('Yesterday')
    expect(groups[1]?.blocks.map((item) => item.id)).toEqual(['yesterday'])

  })
})
