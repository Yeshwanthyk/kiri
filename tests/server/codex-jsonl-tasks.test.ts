import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  codexPlanTasksFromPayload,
  readCodexPlanTasksFromJsonl,
} from '~/server/codex-jsonl-tasks'

describe('Codex JSONL task projection', () => {
  it('parses terminal Codex update_plan calls into AgentTask rows', () => {
    const projection = codexPlanTasksFromPayload({
      type: 'function_call',
      name: 'update_plan',
      arguments: JSON.stringify({
        plan: [
          { step: 'Inspect state', status: 'completed' },
          { step: 'Patch terminal task sync', status: 'in_progress' },
          { step: 'Run verification', status: 'pending' },
        ],
      }),
    }, '2026-01-01T00:00:00.000Z')

    expect(projection?.tasks).toMatchObject([
      {
        title: 'Inspect state',
        status: 'completed',
        source: 'codex',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        title: 'Patch terminal task sync',
        status: 'inProgress',
        source: 'codex',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        title: 'Run verification',
        status: 'pending',
        source: 'codex',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])
  })

  it('uses the latest update_plan call from a Codex JSONL file', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-codex-jsonl-tasks-'))
    const filePath = join(root, 'rollout.jsonl')
    try {
      writeFileSync(filePath, [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            arguments: JSON.stringify({
              plan: [{ step: 'Old step', status: 'pending' }],
            }),
          },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            arguments: JSON.stringify({
              plan: [{ step: 'Fresh step', status: 'completed' }],
            }),
          },
        }),
      ].join('\n'))

      expect(readCodexPlanTasksFromJsonl(filePath)?.tasks).toMatchObject([{
        title: 'Fresh step',
        status: 'completed',
        updatedAt: '2026-01-01T00:00:05.000Z',
      }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
