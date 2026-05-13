import { readFileSync } from 'node:fs'
import type { KiriSettings, RuntimeKind } from '~/lib/contracts'
import { kiriSettingsSchema } from '~/lib/contracts'
import { getKiriConfig } from './kiri-config'

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
