import { readFileSync } from 'node:fs'
import type { AetherSettings, RuntimeKind } from '~/lib/contracts'
import { aetherSettingsSchema } from '~/lib/contracts'
import { getAetherConfig } from './aether-config'

export function getSettings(): AetherSettings {
  const settingsPath = getAetherConfig().settingsPath
  const parsed = aetherSettingsSchema.parse(
    JSON.parse(readFileSync(settingsPath, 'utf8')),
  )

  for (const [runtime, config] of Object.entries(parsed.runtimes)) {
    if (!config.models.includes(config.defaultModel)) {
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
