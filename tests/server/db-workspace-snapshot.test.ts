import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { KiriSettings, ScratchpadBlock } from '../../src/lib/contracts'
import { defaultUiPreferences } from '../../src/lib/ui-preferences'

import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject, hideProjectRow } from '../../src/server/db/projects'
import { insertSessionRow, archiveSessionRow } from '../../src/server/db/sessions'
import {
  setAgentRuntimeState,
  upsertAgentContextUsage,
} from '../../src/server/db/runtime-state'
import { readWorkspaceRevision, readWorkspaceSnapshot } from '../../src/server/db/workspace-snapshot'

const settings: KiriSettings = {
  runtimes: {
    pi: {
      models: ['test-model'],
      defaultModel: 'test-model',
      contextWindows: { 'test-model': 200 },
    },
    codex: {
      models: ['codex-model'],
      defaultModel: 'codex-model',
      contextWindows: { 'codex-model': 400 },
    },
    claude: {
      models: ['claude-model'],
      defaultModel: 'claude-model',
      contextWindows: { 'claude-model': 800 },
    },
    opencode: {
      models: ['opencode-model'],
      defaultModel: 'opencode-model',
      contextWindows: { 'opencode-model': 600 },
    },
  },
}

describe('workspace snapshot projection', () => {
  it('projects visible, hidden, archived, context, pending question, and selection state', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-workspace-snapshot-'))
    const cwd = join(root, 'project')
    const hiddenCwd = join(root, 'hidden-project')
    mkdirSync(cwd)
    mkdirSync(hiddenCwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const hiddenProjectId = insertProject(database, {
        name: 'Hidden Project',
        cwd: hiddenCwd,
      })
      hideProjectRow(database, hiddenProjectId)
      const agentId = insertSessionRow(database, {
        projectId,
        title: 'Active Session',
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        now: () => '2026-01-01T00:00:00.000Z',
        slotTimestampMs: () => 10,
        slotSuffix: () => 'aaaaaa',
      })
      const archivedAgentId = insertSessionRow(database, {
        projectId,
        title: 'Archived Session',
        runtime: 'codex',
        interfaceMode: 'gui',
        model: 'codex-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        now: () => '2026-01-01T00:00:01.000Z',
        slotTimestampMs: () => 11,
        slotSuffix: () => 'bbbbbb',
      })
      archiveSessionRow(database, archivedAgentId)

      const thread = database
        .prepare('SELECT id FROM threads WHERE agent_id = ? AND active = 1')
        .get(agentId) as { id: string }
      database
        .prepare('UPDATE threads SET preview = ?, message_count = ?, updated_at = ? WHERE id = ?')
        .run('Latest answer', 3, '2026-01-02T00:00:00.000Z', thread.id)
      upsertAgentContextUsage(database, {
        agentId,
        usedTokens: 50,
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
      setAgentRuntimeState(database, agentId, {
        pendingQuestion: {
          requestId: 'request-1',
          questions: [{
            id: 'q1',
            header: 'Choose',
            question: 'Pick one',
            options: [{ label: 'A', description: 'Alpha' }],
          }],
        },
      })
      const scratchpadBlocks: ScratchpadBlock[] = [{
        id: 'scratch-1',
        projectId,
        projectName: 'Project One',
        body: 'Draft',
        createdAt: '2026-01-03T00:00:00.000Z',
        triggeredAt: null,
        triggeredAgentId: null,
      }]

      const snapshot = readWorkspaceSnapshot(database, {
        settings,
        preferences: defaultUiPreferences,
        scratchpadBlocks,
      })

      expect(snapshot.selected).toEqual({ projectId, agentId })
      expect(snapshot.projects).toHaveLength(1)
      expect(snapshot.projects[0]).toMatchObject({
        id: projectId,
        name: 'Project One',
      })
      expect(snapshot.hiddenProjects).toHaveLength(1)
      expect(snapshot.hiddenProjects[0]).toMatchObject({
        id: hiddenProjectId,
        name: 'Hidden Project',
      })
      expect(snapshot.projects[0]?.agents).toHaveLength(1)
      expect(snapshot.projects[0]?.agents[0]).toMatchObject({
        id: agentId,
        title: 'Active Session',
        preview: 'Latest answer',
        messageCount: 3,
        contextUsage: {
          usedTokens: 50,
          remainingTokens: 150,
          windowTokens: 200,
          usedPercent: 25,
        },
        pendingQuestion: { requestId: 'request-1' },
      })
      expect(snapshot.archivedSessions).toHaveLength(1)
      expect(snapshot.archivedSessions[0]).toMatchObject({
        id: archivedAgentId,
        projectName: 'Project One',
        title: 'Archived Session',
      })
      expect(snapshot.scratchpadBlocks).toEqual(scratchpadBlocks)
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('changes the cheap revision when projected workspace state changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-workspace-revision-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const before = readWorkspaceRevision(database, {
        settings,
        preferences: defaultUiPreferences,
      })

      const agentId = insertSessionRow(database, {
        projectId,
        title: 'Active Session',
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        now: () => '2026-01-01T00:00:00.000Z',
        slotTimestampMs: () => 10,
        slotSuffix: () => 'aaaaaa',
      })
      const afterSession = readWorkspaceRevision(database, {
        settings,
        preferences: defaultUiPreferences,
      })
      setAgentRuntimeState(database, agentId, {
        pendingQuestion: {
          requestId: 'request-2',
          questions: [],
        },
      })
      const afterRuntimeState = readWorkspaceRevision(database, {
        settings,
        preferences: defaultUiPreferences,
      })
      database
        .prepare('UPDATE threads SET preview = ?, message_count = ?, updated_at = ? WHERE agent_id = ?')
        .run('Updated preview', 2, '2026-01-02T00:00:00.000Z', agentId)
      const afterThread = readWorkspaceRevision(database, {
        settings,
        preferences: defaultUiPreferences,
      })
      upsertAgentContextUsage(database, {
        agentId,
        usedTokens: 25,
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
      const afterContext = readWorkspaceRevision(database, {
        settings,
        preferences: defaultUiPreferences,
      })
      database
        .prepare('INSERT INTO scratchpad_blocks (id, project_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run('scratch-1', projectId, 'Draft', '2026-01-03T00:00:00.000Z')
      const afterScratchpad = readWorkspaceRevision(database, {
        settings,
        preferences: defaultUiPreferences,
      })
      database
        .prepare(
          `
            UPDATE scratchpad_blocks
            SET triggered_at = ?, triggered_agent_id = ?
            WHERE id = ?
          `,
        )
        .run('2026-01-04T00:00:00.000Z', agentId, 'scratch-1')
      const afterScratchpadTriggered = readWorkspaceRevision(database, {
        settings,
        preferences: defaultUiPreferences,
      })
      database
        .prepare('DELETE FROM scratchpad_blocks WHERE id = ?')
        .run('scratch-1')
      const afterScratchpadDelete = readWorkspaceRevision(database, {
        settings,
        preferences: defaultUiPreferences,
      })

      expect(afterSession.revision).not.toBe(before.revision)
      expect(afterRuntimeState.revision).not.toBe(afterSession.revision)
      expect(afterThread.revision).not.toBe(afterRuntimeState.revision)
      expect(afterContext.revision).not.toBe(afterThread.revision)
      expect(afterScratchpad.revision).not.toBe(afterContext.revision)
      expect(afterScratchpadTriggered.revision).not.toBe(afterScratchpad.revision)
      expect(afterScratchpadDelete.revision).not.toBe(afterScratchpadTriggered.revision)
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
