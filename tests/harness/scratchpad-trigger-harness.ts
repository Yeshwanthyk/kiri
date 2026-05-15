import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const root = mkdtempSync(join(tmpdir(), 'kiri-scratchpad-trigger-'))

const outputSchema = z.object({
  ok: z.literal(true),
  terminalPromptCalls: z.number(),
  failedPromptCalls: z.number(),
  terminalTriggered: z.boolean(),
  failedSessionArchived: z.boolean(),
})

process.env.KIRI_ROOT_DIR = root
process.env.KIRI_DB_PATH = join(root, 'kiri.sqlite')
process.env.KIRI_STATE_DIR = join(root, 'state')
process.env.KIRI_SETTINGS_PATH = resolve(process.cwd(), 'settings.json')
process.env.KIRI_PI_SESSIONS_DIR = join(root, 'pi-sessions')
process.env.KIRI_RUNTIME_SESSIONS_DIR = join(root, 'runtime-sessions')

try {
  const [
    {
      addProjectSummary,
      addScratchpadBlockSummary,
      getScratchpadBlock,
      listSessionSummaries,
    },
    { triggerScratchpadSession },
  ] = await Promise.all([
    import('../../src/server/db'),
    import('../../src/server/scratchpad-trigger'),
  ])

  addProjectSummary({
    id: 'scratch',
    name: 'Scratch',
    cwd: process.cwd(),
  })

  let terminalPromptCalls = 0
  const terminalBlock = addScratchpadBlockSummary({
    projectId: 'scratch',
    body: 'terminal scratchpad body',
  })
  await triggerScratchpadSession({
    id: terminalBlock.id,
    projectId: 'scratch',
    runtime: 'codex',
    interfaceMode: 'terminal',
    model: 'gpt-5.5',
  }, async () => {
    terminalPromptCalls += 1
  })

  let failedPromptCalls = 0
  const failedBlock = addScratchpadBlockSummary({
    projectId: 'scratch',
    body: 'failed scratchpad body',
  })
  const originalError = console.error
  console.error = () => undefined
  const failed = await triggerScratchpadSession({
    id: failedBlock.id,
    projectId: 'scratch',
    runtime: 'codex',
    interfaceMode: 'gui',
    model: 'gpt-5.5',
  }, async () => {
    failedPromptCalls += 1
    throw new Error('prompt failed')
  })
  await new Promise((resolve) => setImmediate(resolve))
  console.error = originalError

  const failedSession = listSessionSummaries({ includeArchived: true })
    .find((session) => session.id === failed.agentId)
  const output = outputSchema.parse({
    ok: true,
    terminalPromptCalls,
    failedPromptCalls,
    terminalTriggered: getScratchpadBlock(terminalBlock.id)?.triggeredAgentId !== null,
    failedSessionArchived: failedSession?.archivedAt !== null,
  })

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
