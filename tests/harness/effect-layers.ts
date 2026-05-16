import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Effect, Layer } from 'effect'
import { z } from 'zod'

const root = mkdtempSync(join(tmpdir(), 'kiri-effect-layers-'))

const outputSchema = z.object({
  ok: z.literal(true),
  dbOpen: z.literal(true),
  defaultPiModel: z.string().min(1),
  runtimeKinds: z.array(z.string()).min(3),
  codexPromptRegistered: z.literal(true),
})

process.env.KIRI_ROOT_DIR = root
process.env.KIRI_DB_PATH = join(root, 'kiri.sqlite')
process.env.KIRI_STATE_DIR = join(root, 'state')
process.env.KIRI_SETTINGS_PATH = resolve(process.cwd(), 'settings.json')
process.env.KIRI_PI_SESSIONS_DIR = join(root, 'pi-sessions')
process.env.KIRI_RUNTIME_SESSIONS_DIR = join(root, 'runtime-sessions')

try {
  const [
    { KiriDbService },
    { KiriSettingsService },
    { RuntimeRegistry },
    { RuntimeBinariesService },
  ] = await Promise.all([
    import('../../src/server/db'),
    import('../../src/server/settings'),
    import('../../src/server/provider-runtime'),
    import('../../src/server/runtime-binaries'),
  ])

  const layer = Layer.mergeAll(
    KiriDbService.layer,
    KiriSettingsService.layer,
    RuntimeRegistry.layer.pipe(Layer.provide(RuntimeBinariesService.layer)),
  )
  const result = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* KiriDbService
    const settings = yield* KiriSettingsService
    const registry = yield* RuntimeRegistry
    const database = yield* db.get
    const kiriSettings = yield* settings.get
    const adapters = yield* registry.list
    const databaseOpen = Reflect.get(database, 'open')

    return outputSchema.parse({
      ok: true,
      dbOpen: Boolean(databaseOpen),
      defaultPiModel: kiriSettings.runtimes.pi.defaultModel,
      runtimeKinds: Object.keys(adapters).sort(),
      codexPromptRegistered: typeof adapters.codex.prompt === 'function',
    })
  }).pipe(Effect.provide(layer)))

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
