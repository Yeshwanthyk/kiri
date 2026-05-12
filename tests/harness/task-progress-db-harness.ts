import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'aether-task-progress-'))

process.env.AETHER_ROOT_DIR = process.cwd()
process.env.AETHER_DB_PATH = join(root, 'aether.sqlite')
process.env.AETHER_STATE_DIR = join(root, 'state')
process.env.AETHER_SETTINGS_PATH = resolve(process.cwd(), 'settings.json')
process.env.AETHER_PI_SESSIONS_DIR = join(root, 'pi-sessions')
process.env.AETHER_RUNTIME_SESSIONS_DIR = join(root, 'runtime-sessions')

try {
  const {
    addProjectSummary,
    getAgentDetail,
    replaceAgentTasks,
    resetSession,
    startSessionAndGetId,
  } = await import('../../src/server/db')

  addProjectSummary({
    id: 'tasks',
    name: 'Tasks',
    cwd: process.cwd(),
  })
  const agentId = startSessionAndGetId({
    projectId: 'tasks',
    runtime: 'codex',
    model: 'gpt-5.5',
    thinkingLevel: 'medium',
  })
  replaceAgentTasks({
    agentId,
    source: 'codex',
    updatedAt: '2026-05-11T12:00:00.000Z',
    tasks: [{
      id: '1',
      title: 'Visible before reset',
      status: 'inProgress',
      source: 'codex',
      updatedAt: '2026-05-11T12:00:00.000Z',
    }],
  })

  const beforeReset = getAgentDetail({ agentId }).tasks.length
  resetSession(agentId)
  const afterReset = getAgentDetail({ agentId }).tasks.length

  console.log(JSON.stringify({ ok: true, beforeReset, afterReset }))
} finally {
  rmSync(root, { recursive: true, force: true })
}
