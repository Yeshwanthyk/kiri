import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentStatus, KiriSettings } from '../../src/lib/contracts'

import { openKiriDatabase } from '../../src/server/db/connection'
import { insertProject } from '../../src/server/db/projects'
import { insertSessionRow } from '../../src/server/db/sessions'
import {
  clearAgentContextUsage,
  clearAgentRuntimeState,
  getAgentLaunchConfig,
  getAgentRuntimeState,
  getAgentThinkingLevel,
  isAgentArchived,
  queueAgentTerminalInput,
  readContextUsage,
  readPendingQuestion,
  requeueAgentTerminalInputs,
  setAgentPendingQuestion,
  setAgentRuntimeState,
  setAgentStatus,
  takeAgentTerminalInputs,
  upsertAgentContextUsage,
} from '../../src/server/db/runtime-state'

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

describe('runtime state repository', () => {
  it('preserves launch config, runtime json, status, context usage, pending question, and thinking-level semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-runtime-state-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        thinkingLevel: 'low',
        sessionDirForSlot: (slot) => join(root, 'sessions', slot),
        now: () => '2026-01-01T00:00:00.000Z',
        slotTimestampMs: () => 10,
        slotSuffix: () => 'aaaaaa',
      })

      expect(getAgentLaunchConfig(database, agentId)).toMatchObject({
        id: agentId,
        projectId,
        runtime: 'pi',
        model: 'test-model',
        cwd,
        runtimeStateJson: null,
      })
      expect(getAgentRuntimeState(database, agentId)).toEqual({})

      setAgentRuntimeState(database, agentId, {
        threadId: 'thread-1',
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
      expect(getAgentRuntimeState(database, agentId)).toMatchObject({ threadId: 'thread-1' })
      expect(readPendingQuestion(database, agentId)).toMatchObject({ requestId: 'request-1' })
      setAgentPendingQuestion(database, agentId, {
        requestId: 'request-2',
        questions: [{
          id: 'q2',
          header: 'Confirm',
          question: 'Proceed?',
          options: [],
          multiSelect: false,
        }],
      })
      expect(getAgentRuntimeState(database, agentId)).toMatchObject({ threadId: 'thread-1' })
      expect(readPendingQuestion(database, agentId)).toMatchObject({ requestId: 'request-2' })
      setAgentPendingQuestion(database, agentId, null)
      expect(getAgentRuntimeState(database, agentId)).toMatchObject({ threadId: 'thread-1' })
      expect(readPendingQuestion(database, agentId)).toBeNull()

      clearAgentRuntimeState(database, agentId)
      expect(getAgentRuntimeState(database, agentId)).toEqual({})
      database
        .prepare('UPDATE agent_slots SET runtime_state_json = ? WHERE id = ?')
        .run('{not-json', agentId)
      expect(() => getAgentRuntimeState(database, agentId)).toThrow(
        `Invalid runtime state JSON for agent ${agentId}`,
      )
      clearAgentRuntimeState(database, agentId)

      setAgentStatus(database, agentId, 'running')
      expect(database.prepare('SELECT status FROM agent_slots WHERE id = ?').get(agentId))
        .toEqual({ status: 'running' })
      expect(() => setAgentStatus(database, agentId, 'unknown' as AgentStatus)).toThrow()

      upsertAgentContextUsage(database, { agentId, usedTokens: undefined })
      expect(database.prepare('SELECT COUNT(*) AS count FROM agent_context_usage').get())
        .toEqual({ count: 0 })
      upsertAgentContextUsage(database, {
        agentId,
        usedTokens: 50,
        windowTokens: 100,
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
      upsertAgentContextUsage(database, {
        agentId,
        usedTokens: 60,
        updatedAt: '2026-01-03T00:00:00.000Z',
      })
      const persistedUsage = database
        .prepare('SELECT used_tokens AS usedTokens, window_tokens AS windowTokens FROM agent_context_usage WHERE agent_id = ?')
        .get(agentId) as { usedTokens: number; windowTokens: number | null }
      expect(readContextUsage({ runtime: 'pi', model: 'test-model' }, settings, persistedUsage))
        .toEqual({
          usedTokens: 60,
          remainingTokens: 40,
          windowTokens: 100,
          usedPercent: 60,
        })
      expect(
        readContextUsage(
          { runtime: 'pi', model: 'test-model' },
          settings,
          { usedTokens: 250, windowTokens: null },
        ),
      ).toEqual({
        usedTokens: 250,
        remainingTokens: 0,
        windowTokens: 200,
        usedPercent: 100,
      })
      expect(
        readContextUsage(
          { runtime: 'pi', model: 'unknown-model' },
          settings,
          { usedTokens: 50, windowTokens: null },
        ),
      ).toBeNull()

      expect(getAgentThinkingLevel(database, agentId)).toBe('low')
      clearAgentContextUsage(database, agentId)
      expect(database.prepare('SELECT COUNT(*) AS count FROM agent_context_usage').get())
        .toEqual({ count: 0 })

      queueAgentTerminalInput(database, agentId, {
        text: 'first',
        submit: true,
        createdAt: '2026-01-04T00:00:00.000Z',
      })
      queueAgentTerminalInput(database, agentId, {
        text: 'second',
        submit: false,
        createdAt: '2026-01-04T00:00:01.000Z',
      })
      expect(takeAgentTerminalInputs(database, agentId)).toEqual([{
        text: 'first',
        submit: true,
        createdAt: '2026-01-04T00:00:00.000Z',
      }, {
        text: 'second',
        submit: false,
        createdAt: '2026-01-04T00:00:01.000Z',
      }])
      expect(takeAgentTerminalInputs(database, agentId)).toEqual([])
      requeueAgentTerminalInputs(database, agentId, [{
        text: 'retry',
        submit: true,
        createdAt: '2026-01-04T00:00:02.000Z',
      }])
      expect(takeAgentTerminalInputs(database, agentId)).toEqual([{
        text: 'retry',
        submit: true,
        createdAt: '2026-01-04T00:00:02.000Z',
      }])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps archived launch configs hidden', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-runtime-archive-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'test-model',
        sessionDirForSlot: (slot) => join(root, slot),
      })
      database
        .prepare('UPDATE agent_slots SET archived_at = ? WHERE id = ?')
        .run('2026-01-01T00:00:00.000Z', agentId)

      expect(() => getAgentLaunchConfig(database, agentId)).toThrow(
        `Agent not found: ${agentId}`,
      )
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores runtime state, pending question, status, and context writes for archived agents', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiri-db-runtime-archived-writes-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)

    const database = openKiriDatabase(join(root, 'kiri.sqlite'))
    try {
      const projectId = insertProject(database, { name: 'Project One', cwd })
      const agentId = insertSessionRow(database, {
        projectId,
        runtime: 'codex',
        interfaceMode: 'gui',
        model: 'codex-model',
        sessionDirForSlot: (slot) => join(root, slot),
      })
      setAgentRuntimeState(database, agentId, { threadId: 'thread-1' })
      database
        .prepare('UPDATE agent_slots SET archived_at = ? WHERE id = ?')
        .run('2026-01-01T00:00:00.000Z', agentId)

      expect(isAgentArchived(database, agentId)).toBe(true)

      setAgentRuntimeState(database, agentId, { threadId: 'thread-2' })
      setAgentPendingQuestion(database, agentId, {
        requestId: 'request-1',
        questions: [{
          id: 'q1',
          header: 'Confirm',
          question: 'Proceed?',
          options: [],
          multiSelect: false,
        }],
      })
      clearAgentRuntimeState(database, agentId)
      setAgentStatus(database, agentId, 'running')
      upsertAgentContextUsage(database, { agentId, usedTokens: 75 })

      expect(getAgentRuntimeState(database, agentId)).toEqual({ threadId: 'thread-1' })
      expect(readPendingQuestion(database, agentId)).toBeNull()
      expect(
        database.prepare('SELECT status FROM agent_slots WHERE id = ?').get(agentId),
      ).toEqual({ status: 'idle' })
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM agent_context_usage WHERE agent_id = ?').get(agentId),
      ).toEqual({ count: 0 })
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM agent_events WHERE agent_id = ?').get(agentId),
      ).toEqual({ count: 0 })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
