import { describe, expect, it } from 'vitest'
import { summarizeTasks } from '../../src/components/kiri-board/task-progress'
import type { AgentTask } from '../../src/lib/contracts'

function task(id: string, status: AgentTask['status']): AgentTask {
  return {
    id,
    title: id,
    status,
    source: 'codex',
    updatedAt: '2026-05-12T00:00:00.000Z',
  }
}

describe('task progress helpers', () => {
  it('prioritizes active work and counts terminal statuses', () => {
    const tasks = [
      task('done', 'completed'),
      task('pending', 'pending'),
      task('active', 'inProgress'),
      task('failed', 'failed'),
    ]

    expect(summarizeTasks(tasks)).toEqual({
      completed: 1,
      failed: 1,
      active: tasks[2],
    })
  })

  it('falls back to pending and then the first task', () => {
    const pendingTasks = [task('done', 'completed'), task('pending', 'pending')]
    const finishedTasks = [task('done', 'completed'), task('failed', 'failed')]

    expect(summarizeTasks(pendingTasks).active).toBe(pendingTasks[1])
    expect(summarizeTasks(finishedTasks).active).toBe(finishedTasks[0])
  })
})

