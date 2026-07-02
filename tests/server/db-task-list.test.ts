import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { listActiveThreadTasks } from '../../src/server/db/agent-detail'
import { hydrateCodexTerminalTasksRows } from '../../src/server/db/codex-terminal-tasks'
import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import { setAgentRuntimeState } from '../../src/server/db/runtime-state'
import { archiveSessionRow, insertSessionRow } from '../../src/server/db/sessions'
import { replaceAgentTasksRows } from '../../src/server/db/timeline-writes'

describe('task list repository', () => {
  it('lists active thread tasks across sessions and excludes archived sessions by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-task-list-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const firstAgentId = insertSessionRow(database, {
        projectId,
        title: 'Claude work',
        runtime: 'claude',
        interfaceMode: 'terminal',
        model: 'claude-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        slotTimestampMs: () => 10,
        slotSuffix: () => 'aaaaaa',
      })
      const secondAgentId = insertSessionRow(database, {
        projectId,
        title: 'Codex work',
        runtime: 'codex',
        interfaceMode: 'gui',
        model: 'codex-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        slotTimestampMs: () => 11,
        slotSuffix: () => 'bbbbbb',
      })
      replaceAgentTasksRows(database, {
        agentId: firstAgentId,
        source: 'claude',
        tasks: [{
          id: 'todo-1',
          title: 'Consume Claude todos',
          status: 'inProgress',
          source: 'claude',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      })
      replaceAgentTasksRows(database, {
        agentId: secondAgentId,
        source: 'codex',
        tasks: [{
          id: 'todo-2',
          title: 'Ship Codex task list',
          status: 'pending',
          source: 'codex',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      })

      expect(listActiveThreadTasks(database, { projectId, includeArchived: false }))
        .toMatchObject([{
          agentId: firstAgentId,
          agentTitle: 'Claude work',
          tasks: [{ id: 'todo-1', source: 'claude' }],
        }, {
          agentId: secondAgentId,
          agentTitle: 'Codex work',
          tasks: [{ id: 'todo-2', source: 'codex' }],
        }])

      archiveSessionRow(database, firstAgentId)
      expect(listActiveThreadTasks(database, { projectId, includeArchived: false }).map((item) => item.agentId))
        .toEqual([secondAgentId])
      expect(listActiveThreadTasks(database, { projectId, includeArchived: true }).map((item) => item.agentId))
        .toEqual([firstAgentId, secondAgentId])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hydrates terminal-mode Codex plan tasks from the remembered session JSONL', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-task-list-codex-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const codexHome = join(root, 'codex-home')
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        title: 'Codex terminal',
        runtime: 'codex',
        interfaceMode: 'terminal',
        model: 'codex-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        slotTimestampMs: () => 10,
        slotSuffix: () => 'aaaaaa',
      })
      setAgentRuntimeState(database, agentId, { codexSessionId: 'codex-terminal-session' })
      writeCodexSessionWithPlan(codexHome, '2026/05/15/rollout-terminal.jsonl', {
        id: 'codex-terminal-session',
        cwd,
        updatedAt: '2026-01-01T00:00:00.000Z',
        plan: [
          { step: 'Parse terminal plan', status: 'completed' },
          { step: 'Project task rows', status: 'in_progress' },
        ],
      })

      hydrateCodexTerminalTasksRows(database, { projectId, codexHome })

      expect(listActiveThreadTasks(database, { projectId, includeArchived: false }))
        .toMatchObject([{
          agentId,
          agentTitle: 'Codex terminal',
          tasks: [
            {
              title: 'Parse terminal plan',
              status: 'completed',
              source: 'codex',
            },
            {
              title: 'Project task rows',
              status: 'inProgress',
              source: 'codex',
            },
          ],
        }])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function writeCodexSessionWithPlan(
  codexHome: string,
  relativePath: string,
  input: {
    readonly id: string
    readonly cwd: string
    readonly updatedAt: string
    readonly plan: ReadonlyArray<{ readonly step: string; readonly status: string }>
  },
) {
  const filePath = join(codexHome, 'sessions', relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: input.id, cwd: input.cwd },
    }),
    JSON.stringify({
      timestamp: input.updatedAt,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'update_plan',
        arguments: JSON.stringify({ plan: input.plan }),
      },
    }),
  ].join('\n'))
  const date = new Date(input.updatedAt)
  utimesSync(filePath, date, date)
}
