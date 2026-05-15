import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const root = mkdtempSync(join(tmpdir(), 'kiri-diff-refresh-public-'))
const cwd = join(root, 'repo')
mkdirSync(cwd, { recursive: true })

function git(args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const outputSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string(),
  diffCount: z.literal(1),
  diffPath: z.literal('app.ts'),
  snapshotAgentDiffCount: z.literal(1),
})

process.env.KIRI_ROOT_DIR = root
process.env.KIRI_DB_PATH = join(root, 'kiri.sqlite')
process.env.KIRI_STATE_DIR = join(root, 'state')
process.env.KIRI_SETTINGS_PATH = resolve(process.cwd(), 'settings.json')
process.env.KIRI_PI_SESSIONS_DIR = join(root, 'pi-sessions')
process.env.KIRI_RUNTIME_SESSIONS_DIR = join(root, 'runtime-sessions')

try {
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Kiri Test'])
  writeFileSync(join(cwd, 'app.ts'), 'export const value = 1\n')
  git(['add', 'app.ts'])
  git(['commit', '-m', 'initial'])
  writeFileSync(join(cwd, 'app.ts'), 'export const value = 2\n')

  const [
    {
      addProjectSummary,
      getAgentDetail,
      startSessionSummary,
    },
    { refreshTerminalSessionDiffs },
  ] = await Promise.all([
    import('../../src/server/db'),
    import('../../src/server/diff-refresh'),
  ])

  const project = addProjectSummary({ id: 'diff-project', name: 'Diff Project', cwd })
  const session = startSessionSummary({
    projectId: project.id,
    runtime: 'codex',
    interfaceMode: 'terminal',
    model: 'gpt-5.5',
    thinkingLevel: 'medium',
  })
  const snapshot = refreshTerminalSessionDiffs(session.id)
  const detail = getAgentDetail({ agentId: session.id, limit: 1 })
  const snapshotAgent = snapshot.projects
    .flatMap((row) => row.agents)
    .find((agent) => agent.id === session.id)

  const output = outputSchema.parse({
    ok: true,
    sessionId: session.id,
    diffCount: detail.diffs.length,
    diffPath: detail.diffs[0]?.path,
    snapshotAgentDiffCount: snapshotAgent?.diffCount,
  })
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
