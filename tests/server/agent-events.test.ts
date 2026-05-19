import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '~/server/db/migrations'
import { listAgentEvents } from '~/server/db/agent-events'
import {
  hydrateProjectionMessages,
  recordPiLiveMessages,
  recordRuntimeMessageRow,
} from '~/server/db/timeline-writes'
import { setAgentStatus } from '~/server/db/runtime-state'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

describe('agent events', () => {
  it('records message creates, updates, and status changes in sequence', () => {
    const database = testDatabase()

    recordRuntimeMessageRow(database, {
      agentId: 'agent-1',
      id: 'message-1',
      role: 'assistant',
      text: 'First',
      timestamp: '2026-05-19T00:00:00.000Z',
    })
    recordRuntimeMessageRow(database, {
      agentId: 'agent-1',
      id: 'message-1',
      role: 'assistant',
      text: 'First edited',
      timestamp: '2026-05-19T00:00:01.000Z',
    })
    setAgentStatus(database, 'agent-1', 'running')

    const events = listAgentEvents(database, { agentId: 'agent-1' })

    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, 'agent.message.created'],
      [2, 'agent.message.updated'],
      [3, 'agent.status.changed'],
    ])
    expect(events[1]?.payload).toMatchObject({
      messageId: 'message-1',
      role: 'assistant',
      text: 'First edited',
    })
  })

  it('lists events after a stored cursor', () => {
    const database = testDatabase()
    recordRuntimeMessageRow(database, {
      agentId: 'agent-1',
      id: 'message-1',
      role: 'assistant',
      text: 'First',
      timestamp: '2026-05-19T00:00:00.000Z',
    })
    recordRuntimeMessageRow(database, {
      agentId: 'agent-1',
      id: 'message-2',
      role: 'assistant',
      text: 'Second',
      timestamp: '2026-05-19T00:00:01.000Z',
    })

    expect(
      listAgentEvents(database, {
        agentId: 'agent-1',
        afterSequence: 1,
      }).map((event) => event.payload.text),
    ).toEqual(['Second'])
  })

  it('does not duplicate events when final projection replaces live messages', () => {
    const database = testDatabase()
    database
      .prepare('INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at) VALUES (?, ?, 1, ?, 0, ?)')
      .run('thread-agent-1', 'agent-1', 'Ready.', '2026-05-19T00:00:00.000Z')

    recordPiLiveMessages(database, {
      agentId: 'agent-1',
      promptText: 'go',
      turnStartedAt: 1_779_148_800,
      turnCompletedAt: 1_779_148_801,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'done' },
      ],
    })
    hydrateProjectionMessages(database, 'agent-1', {
      preview: 'done',
      updatedAt: '2026-05-19T00:00:02.000Z',
      messages: [{
        id: 'jsonl-message-1',
        role: 'assistant',
        text: 'done',
        timestamp: '2026-05-19T00:00:02.000Z',
      }],
    })

    expect(listAgentEvents(database, { agentId: 'agent-1' })).toHaveLength(1)
  })

  it('emits only the new tail when a later projection refreshes the transcript', () => {
    const database = testDatabase()
    database
      .prepare('INSERT INTO threads (id, agent_id, active, preview, message_count, updated_at) VALUES (?, ?, 1, ?, 0, ?)')
      .run('thread-agent-1', 'agent-1', 'Ready.', '2026-05-19T00:00:00.000Z')

    hydrateProjectionMessages(database, 'agent-1', {
      preview: 'first',
      updatedAt: '2026-05-19T00:00:01.000Z',
      messages: [{
        id: 'jsonl-message-1',
        role: 'assistant',
        text: 'first',
        timestamp: '2026-05-19T00:00:01.000Z',
      }],
    })
    hydrateProjectionMessages(database, 'agent-1', {
      preview: 'second',
      updatedAt: '2026-05-19T00:00:02.000Z',
      messages: [
        {
          id: 'jsonl-message-1',
          role: 'assistant',
          text: 'first',
          timestamp: '2026-05-19T00:00:01.000Z',
        },
        {
          id: 'jsonl-message-2',
          role: 'assistant',
          text: 'second',
          timestamp: '2026-05-19T00:00:02.000Z',
        },
      ],
    })

    expect(
      listAgentEvents(database, { agentId: 'agent-1' }).map((event) => event.payload.text),
    ).toEqual(['first', 'second'])
  })
})

function testDatabase() {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  migrate(database)
  database.prepare('INSERT INTO projects (id, name, cwd, position) VALUES (?, ?, ?, ?)').run('project-1', 'Project', '/tmp/project', 0)
  database
    .prepare(
      `
        INSERT INTO agent_slots (
          id, project_id, slot, title, runtime, interface_mode, model,
          status, session_dir, position
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run('agent-1', 'project-1', 'session-1', 'Session', 'codex', 'gui', 'gpt-5.5', 'idle', '/tmp/session', 0)
  return database
}
