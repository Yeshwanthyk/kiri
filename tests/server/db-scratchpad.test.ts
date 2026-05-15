import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openKiriDatabase } from '../../src/server/db/connection'
import { deleteProjectRow, insertProject } from '../../src/server/db/projects'
import {
  deleteScratchpadBlockRow,
  getScratchpadBlock,
  insertScratchpadBlock,
  listScratchpadBlocks,
  markScratchpadBlockTriggered,
} from '../../src/server/db/scratchpad'

describe('scratchpad repository', () => {
  it('preserves block list, add, get, trigger, filter, and delete semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-scratchpad-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      insertProject(database, { id: 'project-two', name: 'Project Two', cwd })
      const projectBlockId = insertScratchpadBlock(database, {
        projectId,
        body: '  project block  ',
      })
      const globalBlockId = insertScratchpadBlock(database, {
        projectId: null,
        body: 'global block',
      })

      expect(getScratchpadBlock(database, projectBlockId)).toMatchObject({
        id: projectBlockId,
        projectId,
        projectName: 'Project One',
        body: 'project block',
        triggeredAt: null,
        triggeredAgentId: null,
      })
      expect(listScratchpadBlocks(database).map((block) => block.id)).toEqual([
        globalBlockId,
        projectBlockId,
      ])
      expect(listScratchpadBlocks(database, { projectId }).map((block) => block.id)).toEqual([
        projectBlockId,
      ])

      database
        .prepare(
          `
            INSERT INTO agent_slots (
              id, project_id, slot, title, runtime, interface_mode, model, status,
              session_dir, session_file, runtime_state_json, archived_at, position
            )
            VALUES (
              'agent-1', ?, 'session-1', 'Agent', 'pi', 'gui', 'test-model', 'idle',
              '/tmp/session-1', NULL, NULL, NULL, 0
            )
          `,
        )
        .run(projectId)
      markScratchpadBlockTriggered(database, projectBlockId, 'agent-1')
      expect(getScratchpadBlock(database, projectBlockId)).toMatchObject({
        triggeredAgentId: 'agent-1',
      })
      expect(getScratchpadBlock(database, projectBlockId)?.triggeredAt).toEqual(expect.any(String))

      expect(() => markScratchpadBlockTriggered(database, globalBlockId, 'missing-agent'))
        .toThrow('FOREIGN KEY constraint failed')

      database.prepare('DELETE FROM agent_slots WHERE id = ?').run('agent-1')
      expect(getScratchpadBlock(database, projectBlockId)).toMatchObject({
        triggeredAgentId: null,
      })

      deleteProjectRow(database, projectId)
      expect(getScratchpadBlock(database, projectBlockId)).toMatchObject({
        projectId: null,
        projectName: null,
      })

      deleteScratchpadBlockRow(database, projectBlockId)
      expect(getScratchpadBlock(database, projectBlockId)).toBeUndefined()
      expect(listScratchpadBlocks(database).map((block) => block.id)).toEqual([globalBlockId])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps validation errors at the repository boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-scratchpad-validation-'))
    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      expect(() => insertScratchpadBlock(database, { projectId: null, body: '   ' })).toThrow(
        'Block body is required',
      )
      expect(() =>
        insertScratchpadBlock(database, {
          projectId: 'missing-project',
          body: 'body',
        }),
      ).toThrow('Project not found: missing-project')
      expect(() => deleteScratchpadBlockRow(database, '   ')).toThrow('Block id is required')
      expect(() => markScratchpadBlockTriggered(database, '   ', 'agent-1')).toThrow(
        'Block id is required',
      )
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
