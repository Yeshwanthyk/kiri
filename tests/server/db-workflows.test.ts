import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import { insertScratchpadBlock } from '../../src/server/db/scratchpad'
import {
  getWorkflowRun,
  insertWorkflowRun,
  listWorkflowRuns,
  recordWorkflowItemAttempt,
  setWorkflowItemTracking,
  setWorkflowRunArchiveState,
} from '../../src/server/db/workflows'

describe('workflow repository', () => {
  it('persists runs, items, scratchpad links, attempts, tracking, and archive state', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-workflows-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { id: 'workflow-project', name: 'Workflow Project', cwd })
      const scratchpadBlockId = insertScratchpadBlock(database, {
        projectId,
        body: 'Scratchpad only item',
      })
      database
        .prepare(
          `
            INSERT INTO agent_slots (
              id, project_id, slot, title, runtime, interface_mode, model, status,
              session_dir, session_file, runtime_state_json, archived_at, position
            )
            VALUES (
              'agent-1', ?, 'session-1', 'Agent', 'pi', 'gui', 'openai-codex/gpt-5.5', 'idle',
              '/tmp/session-1', NULL, NULL, NULL, 0
            )
          `,
        )
        .run(projectId)

      const created = insertWorkflowRun(database, {
        id: 'workflow-1',
        projectId,
        title: 'Parallel workflow',
        items: [{
          id: 'workflow-item-1',
          clientId: 'build',
          action: 'launch',
          title: 'Build',
          body: 'Build the thing',
          runtime: 'pi',
          interfaceMode: 'gui',
          model: 'openai-codex/gpt-5.5',
          thinkingLevel: 'medium',
          terminalPaste: { submit: false },
          tracked: true,
        }, {
          id: 'workflow-item-2',
          clientId: 'note',
          action: 'scratchpad',
          title: 'Note',
          body: 'Scratchpad only item',
          scratchpadBlockId,
          tracked: false,
        }],
      })

      expect(created).toMatchObject({
        id: 'workflow-1',
        projectId,
        title: 'Parallel workflow',
        status: 'validated',
        itemCount: 2,
        launchedCount: 0,
        failedCount: 0,
      })
      expect(created.items.map((item) => ({
        id: item.id,
        action: item.action,
        status: item.status,
        tracked: item.tracked,
      }))).toEqual([{
        id: 'workflow-item-1',
        action: 'launch',
        status: 'pending',
        tracked: true,
      }, {
        id: 'workflow-item-2',
        action: 'scratchpad',
        status: 'untracked',
        tracked: false,
      }])
      expect(created.items[0]?.terminalPaste).toEqual({ submit: false })
      expect(created.items[1]?.scratchpadBlockId).toBe(scratchpadBlockId)

      expect(setWorkflowItemTracking(database, 'workflow-item-2', true)).toMatchObject({
        id: 'workflow-item-2',
        tracked: true,
        status: 'pending',
      })
      expect(recordWorkflowItemAttempt(database, {
        itemId: 'workflow-item-1',
        agentId: 'agent-1',
        status: 'launched',
      })).toMatchObject({
        agentId: 'agent-1',
        status: 'launched',
      })
      expect(getWorkflowRun(database, 'workflow-1')).toMatchObject({
        status: 'running',
        launchedCount: 1,
        failedCount: 0,
      })

      expect(setWorkflowItemTracking(database, 'workflow-item-1', false)).toMatchObject({
        id: 'workflow-item-1',
        tracked: false,
        status: 'untracked',
      })
      expect(recordWorkflowItemAttempt(database, {
        itemId: 'workflow-item-2',
        status: 'failed',
        error: 'No runtime',
      })).toMatchObject({
        agentId: null,
        status: 'failed',
        error: 'No runtime',
      })
      expect(listWorkflowRuns(database, { projectId, includeArchived: true })[0]).toMatchObject({
        id: 'workflow-1',
        status: 'failed',
        itemCount: 2,
        launchedCount: 1,
        failedCount: 1,
      })

      expect(setWorkflowRunArchiveState(database, 'workflow-1', true)).toMatchObject({
        status: 'archived',
        archivedAt: expect.any(String),
      })
      expect(listWorkflowRuns(database, { projectId })).toEqual([])
      expect(() =>
        recordWorkflowItemAttempt(database, {
          itemId: 'workflow-item-2',
          status: 'launched',
        }),
      ).toThrow('Workflow run is archived: workflow-1')
      expect(() => setWorkflowItemTracking(database, 'workflow-item-2', true))
        .toThrow('Workflow run is archived: workflow-1')
      expect(setWorkflowRunArchiveState(database, 'workflow-1', false)).toMatchObject({
        status: 'failed',
        archivedAt: null,
      })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
