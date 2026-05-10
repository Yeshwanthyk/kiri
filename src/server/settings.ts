import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PicanSettings, RuntimeKind } from '~/lib/contracts'
import { picanSettingsSchema } from '~/lib/contracts'

const settingsPath = join(process.cwd(), 'settings.json')

export function getSettings(): PicanSettings {
  const parsed = picanSettingsSchema.parse(
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
