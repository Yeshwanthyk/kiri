import { readFileSync } from 'node:fs'
import { Context, Effect, Layer } from 'effect'
import type { KiriSettings, RuntimeKind } from '~/lib/contracts'
import { kiriSettingsSchema } from '~/lib/contracts'
import { getKiriConfig } from './kiri-config'

export type KiriSettingsApi = {
  readonly get: Effect.Effect<KiriSettings>
  readonly getRuntime: (runtime: RuntimeKind) => Effect.Effect<KiriSettings['runtimes'][RuntimeKind]>
  readonly assertConfiguredModel: (runtime: RuntimeKind, model: string) => Effect.Effect<void>
}

export class KiriSettingsService extends Context.Tag('@kiri/KiriSettings')<
  KiriSettingsService,
  KiriSettingsApi
>() {
  static readonly layer = Layer.sync(KiriSettingsService, () =>
    KiriSettingsService.of({
      get: Effect.sync(() => getSettings()),
      getRuntime: (runtime) => Effect.sync(() => getRuntimeSettings(runtime)),
      assertConfiguredModel: (runtime, model) => Effect.sync(() => {
        assertConfiguredModel(runtime, model)
      }),
    }),
  )
}

export function getSettings(): KiriSettings {
  const settingsPath = getKiriConfig().settingsPath
  const parsed = kiriSettingsSchema.parse(
    JSON.parse(readFileSync(settingsPath, 'utf8')),
  )

  for (const [runtime, config] of Object.entries(parsed.runtimes)) {
    if (!new Set(config.models).has(config.defaultModel)) {
      throw new Error(
        `settings.json ${runtime}.defaultModel must be listed in ${runtime}.models`,
      )
    }
  }

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
