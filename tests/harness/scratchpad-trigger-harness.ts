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
  failedRuntimeStateCleaned: z.boolean(),
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
    {
      __unsafeClearCodexRuntimeStateForTest,
      __unsafeRetainCodexRuntimeStateForTest,
      codexRuntimeRetainedStateStats,
    },
  ] = await Promise.all([
    import('../../src/server/db'),
    import('../../src/server/scratchpad-trigger'),
    import('../../src/server/codex-runtime'),
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
  }, () => {
    terminalPromptCalls += 1
    return Promise.resolve()
  })

  let failedPromptCalls = 0
  const failedBlock = addScratchpadBlockSummary({
    projectId: 'scratch',
    body: 'failed scratchpad body',
  })
  __unsafeClearCodexRuntimeStateForTest()
  const originalError = console.error
  console.error = () => undefined
  const failed = await triggerScratchpadSession({
    id: failedBlock.id,
    projectId: 'scratch',
    runtime: 'codex',
    interfaceMode: 'gui',
    model: 'gpt-5.5',
  }, ({ agentId }) => {
    failedPromptCalls += 1
    __unsafeRetainCodexRuntimeStateForTest({
      agentId,
      threadId: `thread-${agentId}`,
      turnId: `turn-${agentId}`,
    })
    return Promise.reject(new Error('prompt failed'))
  })
  await new Promise((resolve) => setImmediate(resolve))
  console.error = originalError

  const failedSession = listSessionSummaries({ includeArchived: true })
    .find((session) => session.id === failed.agentId)
  const failedRuntimeStats = codexRuntimeRetainedStateStats()
  const output = outputSchema.parse({
    ok: true,
    terminalPromptCalls,
    failedPromptCalls,
    terminalTriggered: getScratchpadBlock(terminalBlock.id)?.triggeredAgentId !== null,
    failedSessionArchived: failedSession !== undefined && failedSession.archivedAt !== null,
    failedRuntimeStateCleaned:
      failedRuntimeStats.threadAgents === 0 &&
      failedRuntimeStats.agentThreads === 0 &&
      failedRuntimeStats.threadTurns === 0 &&
      failedRuntimeStats.queues === 0 &&
      failedRuntimeStats.sessionGenerations === 0 &&
      failedRuntimeStats.repoDiffRefreshedTurns === 0,
  })

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
