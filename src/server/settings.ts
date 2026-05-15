import { readFileSync } from 'node:fs'
import { Context, Data, Effect, Layer } from 'effect'
import type { KiriSettings, RuntimeKind } from '~/lib/contracts'
import { kiriSettingsSchema } from '~/lib/contracts'
import {
  KiriConfigService,
  type KiriConfigApi,
  getKiriConfig,
} from './kiri-config'

export type KiriSettingsApi = {
  readonly get: Effect.Effect<KiriSettings, KiriSettingsError>
  readonly getRuntime: (
    runtime: RuntimeKind,
  ) => Effect.Effect<KiriSettings['runtimes'][RuntimeKind], KiriSettingsError>
  readonly assertConfiguredModel: (
    runtime: RuntimeKind,
    model: string,
  ) => Effect.Effect<void, KiriSettingsError>
}

export class KiriSettingsError extends Data.TaggedError('KiriSettingsError')<{
  readonly message: string
  readonly path?: string
  readonly cause?: unknown
}> {}

export class KiriSettingsService extends Context.Tag('@kiri/KiriSettings')<
  KiriSettingsService,
  KiriSettingsApi
>() {
  static readonly layerFromConfig = Layer.effect(
    KiriSettingsService,
    Effect.gen(function* () {
      const config = yield* KiriConfigService
      return KiriSettingsService.of(makeKiriSettingsService({ config }))
    }),
  )

  static readonly layer = KiriSettingsService.layerFromConfig.pipe(
    Layer.provide(KiriConfigService.layer),
  )
}

export function makeKiriSettingsService(input: {
  readonly config: KiriConfigApi
  readonly readTextFile?: (path: string) => string
}): KiriSettingsApi {
  const readTextFile = input.readTextFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const get = Effect.gen(function* () {
    const config = yield* input.config.get.pipe(
      Effect.mapError((error) => new KiriSettingsError({
        message: error.message,
        cause: error,
      })),
    )
    return yield* loadSettingsEffect(config.settingsPath, readTextFile)
  })
  const getRuntime = (runtime: RuntimeKind) =>
    get.pipe(Effect.map((settings) => settings.runtimes[runtime]))

  return {
    get,
    getRuntime,
    assertConfiguredModel: (runtime, model) =>
      getRuntime(runtime).pipe(
        Effect.flatMap((settings) =>
          settings.models.includes(model)
            ? Effect.void
            : Effect.fail(new KiriSettingsError({
              message: `Model ${model} is not configured for ${runtime}`,
            })),
        ),
      ),
  }
}

export function getSettings(): KiriSettings {
  return loadSettings(getKiriConfig().settingsPath)
}

export function loadSettings(
  settingsPath: string,
  readTextFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): KiriSettings {
  return parseSettings(settingsPath, readTextFile(settingsPath))
}

function parseSettings(_settingsPath: string, raw: string): KiriSettings {
  const parsed = kiriSettingsSchema.parse(JSON.parse(raw))
  validateSettings(parsed)
  return parsed
}

export function getRuntimeSettings(runtime: RuntimeKind) {
  return getSettings().runtimes[runtime]
}

export function assertConfiguredModel(runtime: RuntimeKind, model: string) {
  const settings = getRuntimeSettings(runtime)
  if (!settings.models.includes(model)) {
    throw new Error(`Model ${model} is not configured for ${runtime}`)
  }
}

function loadSettingsEffect(
  settingsPath: string,
  readTextFile: (path: string) => string,
) {
  return Effect.try({
    try: () => loadSettings(settingsPath, readTextFile),
    catch: (error) => toKiriSettingsError(settingsPath, error),
  })
}

function validateSettings(settings: KiriSettings) {
  for (const [runtime, config] of Object.entries(settings.runtimes)) {
    if (!new Set(config.models).has(config.defaultModel)) {
      throw new Error(
        `settings.json ${runtime}.defaultModel must be listed in ${runtime}.models`,
      )
    }
  }
}

function toKiriSettingsError(settingsPath: string, error: unknown) {
  return new KiriSettingsError({
    message: error instanceof Error ? error.message : 'Failed to load Kiri settings',
    path: settingsPath,
    cause: error,
  })
}
