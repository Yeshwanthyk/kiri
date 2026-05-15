import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'kiri-runtime-command-public-'))

process.env.KIRI_ROOT_DIR = root
process.env.KIRI_DB_PATH = join(root, 'kiri.sqlite')
process.env.KIRI_STATE_DIR = join(root, 'state')
process.env.KIRI_SETTINGS_PATH = resolve(process.cwd(), 'settings.json')
process.env.KIRI_PI_SESSIONS_DIR = join(root, 'pi-sessions')
process.env.KIRI_RUNTIME_SESSIONS_DIR = join(root, 'runtime-sessions')

try {
  const [
    { addProjectSummary, startSessionAndGetId },
    { RuntimeCommandError, resetAgentSession },
  ] = await Promise.all([
    import('../../src/server/db'),
    import('../../src/server/runtime'),
  ])

  addProjectSummary({
    id: 'runtime-public',
    name: 'Runtime Public',
    cwd: process.cwd(),
  })
  const agentId = startSessionAndGetId({
    projectId: 'runtime-public',
    runtime: 'claude',
    interfaceMode: 'terminal',
    model: 'claude-sonnet-4-5',
    thinkingLevel: 'medium',
  })

  try {
    await resetAgentSession({ agentId })
    throw new Error('Expected resetAgentSession to reject')
  } catch (error) {
    console.log(JSON.stringify({
      ok: true,
      ctor: error?.constructor?.name,
      isError: error instanceof Error,
      isRuntimeCommandError: error instanceof RuntimeCommandError,
      message: error instanceof Error ? error.message : String(error),
    }))
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
