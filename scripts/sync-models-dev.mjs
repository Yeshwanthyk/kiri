import { readFile, writeFile } from 'node:fs/promises'

const settingsPath = new URL('../settings.json', import.meta.url)
const catalogPath = new URL('../models.dev.local.json', import.meta.url)

const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
const providerAliases = catalog.providerAliases ?? {}

let updated = 0

for (const runtime of Object.values(settings.runtimes)) {
  runtime.contextWindows ??= {}

  for (const model of runtime.models) {
    const windowTokens = contextWindowForModel(catalog, model)
    if (!windowTokens) continue

    if (runtime.contextWindows[model] !== windowTokens) {
      runtime.contextWindows[model] = windowTokens
      updated += 1
    }
  }
}

await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
console.log(
  `Updated ${updated} context window${updated === 1 ? '' : 's'} from models.dev.local.json`,
)

function contextWindowForModel(catalog, model) {
  const { provider, id } = splitModel(model)
  const providerKeys = provider ? [providerAliases[provider] ?? provider] : inferredProviders(id)

  for (const providerKey of providerKeys) {
    const modelEntry = catalog[providerKey]?.models?.[id]
    const context = modelEntry?.limit?.context
    if (Number.isInteger(context) && context > 0) return context
  }

  return undefined
}

function splitModel(model) {
  const separator = model.indexOf('/')
  if (separator === -1) return { provider: undefined, id: model }
  return {
    provider: model.slice(0, separator),
    id: model.slice(separator + 1),
  }
}

function inferredProviders(modelId) {
  if (modelId.startsWith('gpt-')) return ['openai-codex', 'openai']
  if (modelId.startsWith('claude-')) return ['anthropic']
  return []
}
