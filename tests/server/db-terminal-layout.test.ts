import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import { insertSessionRow } from '../../src/server/db/sessions'
import {
  readAgentRuntimeTerminalLayout,
  readProjectShellTerminalLayout,
  upsertTerminalLayout,
} from '../../src/server/db/terminal-layout'

const layout = {
  activeTabId: 'main',
  tabs: [{
    id: 'main',
    title: 'Shell',
    activePaneId: 'main',
    paneIds: ['main'],
  }],
}

describe('terminal layout persistence', () => {
  it('stores shell layouts by project and runtime layouts by agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-terminal-layout-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)
    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        title: 'Agent',
        runtime: 'codex',
        interfaceMode: 'terminal',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
      })

      upsertTerminalLayout(database, { mode: 'shell', projectId, layout }, () => '2026-01-01T00:00:00.000Z')
      upsertTerminalLayout(database, {
        mode: 'runtime',
        agentId,
        layout: {
          activeTabId: 'tab-b',
          tabs: [
            { id: 'main', title: 'Agent', activePaneId: 'main', paneIds: ['main'] },
            { id: 'tab-b', title: 'Term 2', activePaneId: 'pane-b', paneIds: ['pane-b'] },
          ],
        },
      }, () => '2026-01-01T00:00:01.000Z')

      expect(readProjectShellTerminalLayout(database, projectId)?.layout).toEqual(layout)
      expect(readAgentRuntimeTerminalLayout(database, agentId)?.layout.activeTabId).toBe('tab-b')

      expect(() => upsertTerminalLayout(database, {
        mode: 'shell',
        agentId,
        layout,
      })).toThrow(/shell terminal layouts require projectId only/)

      expect(() => upsertTerminalLayout(database, {
        mode: 'runtime',
        agentId,
        layout: {
          activeTabId: 'main',
          tabs: [
            { id: 'main', title: 'Agent', activePaneId: 'main', paneIds: ['main'] },
            { id: 'main', title: 'Duplicate', activePaneId: 'pane-b', paneIds: ['pane-b'] },
          ],
        },
      })).toThrow(/tab ids must be unique/)
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
