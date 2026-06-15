import { existsSync, readFileSync } from 'node:fs'
import { Context, Data, Effect, Layer } from 'effect'
import type { KiriSettings, RuntimeKind, SessionInterfaceMode } from '~/lib/contracts'
import { kiriSettingsSchema, runtimeKinds, sessionInterfaceModeForRuntime } from '~/lib/contracts'
import bundledSettings from '../../settings.json' with { type: 'json' }
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
  readonly fileExists?: (path: string) => boolean
}): KiriSettingsApi {
  const readTextFile = input.readTextFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const fileExists = input.fileExists ?? existsSync
  const get = Effect.gen(function* () {
    const config = yield* input.config.get.pipe(
      Effect.mapError((error) => new KiriSettingsError({
        message: error.message,
        cause: error,
      })),
    )
    return yield* loadSettingsEffect(
      config.settingsPath,
      readTextFile,
      config.userSettingsPath,
      fileExists,
    )
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
  const config = getKiriConfig()
  return loadSettings(config.settingsPath, undefined, config.userSettingsPath)
}

export function loadSettings(
  settingsPath: string,
  readTextFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  userSettingsPath?: string,
  fileExists: (path: string) => boolean = existsSync,
): KiriSettings {
  const base = JSON.parse(readTextFile(settingsPath))
  const settings = userSettingsPath && fileExists(userSettingsPath)
    ? mergeSettings(base, JSON.parse(readTextFile(userSettingsPath)))
    : base
  return parseSettingsObject(settingsPath, settings)
}

function parseSettings(_settingsPath: string, raw: string): KiriSettings {
  return parseSettingsObject(_settingsPath, JSON.parse(raw))
}

function parseSettingsObject(_settingsPath: string, settings: unknown): KiriSettings {
  const parsed = kiriSettingsSchema.parse(normalizeSettings(settings))
  validateSettings(parsed)
  return parsed
}

export function getRuntimeSettings(runtime: RuntimeKind) {
  return getSettings().runtimes[runtime]
}

export function defaultRuntime(settings: KiriSettings = getSettings()): RuntimeKind {
  const runtime = runtimeKinds.find((kind) => Boolean(settings.runtimes[kind]))
  if (!runtime) throw new Error('No runtime configured')
  return runtime
}

export function normalizeConfiguredInterfaceMode(
  runtime: RuntimeKind,
  requested?: SessionInterfaceMode,
  settings: KiriSettings = getSettings(),
): SessionInterfaceMode {
  const runtimeSettings = settings.runtimes[runtime]
  const modes = runtimeSettings.interfaceModes?.length
    ? runtimeSettings.interfaceModes
    : [sessionInterfaceModeForRuntime(runtime)]
  if (requested && modes.includes(requested)) return requested
  if (runtimeSettings.defaultInterfaceMode && modes.includes(runtimeSettings.defaultInterfaceMode)) {
    return runtimeSettings.defaultInterfaceMode
  }
  const fallback = modes[0]
  if (!fallback) throw new Error(`Runtime ${runtime} must expose at least one interface mode`)
  return fallback
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
  userSettingsPath: string | undefined,
  fileExists: (path: string) => boolean,
) {
  return Effect.try({
    try: () => loadSettings(settingsPath, readTextFile, userSettingsPath, fileExists),
    catch: (error) => toKiriSettingsError(settingsPath, error),
  })
}

function mergeSettings(base: unknown, override: unknown): unknown {
  if (!isSettingsObject(base) || !isSettingsObject(override)) return override
  if (!isRecord(base.runtimes) || !isRecord(override.runtimes)) {
    return { ...base, ...override }
  }

  const runtimes: Record<string, unknown> = { ...base.runtimes }
  for (const [runtime, overrideRuntime] of Object.entries(override.runtimes)) {
    const baseRuntime = isRecord(runtimes[runtime]) ? runtimes[runtime] : {}
    const runtimePatch = isRecord(overrideRuntime) ? overrideRuntime : {}
    const replacesModels = Object.hasOwn(runtimePatch, 'models')
    const models = replacesModels
      ? uniqueStrings(arrayValue(runtimePatch.models))
      : arrayValue(baseRuntime.models)
    const defaultModel = mergedDefaultModel({
      baseRuntime,
      models,
      replacesModels,
      runtimePatch,
    })
    runtimes[runtime] = {
      ...baseRuntime,
      ...runtimePatch,
      models,
      defaultModel,
      contextWindows: {
        ...(isRecord(baseRuntime.contextWindows) ? baseRuntime.contextWindows : {}),
        ...(isRecord(runtimePatch.contextWindows) ? runtimePatch.contextWindows : {}),
      },
    }
  }

  return { ...base, ...override, runtimes }
}

function isSettingsObject(value: unknown): value is { readonly runtimes?: unknown } {
  return isRecord(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)]
}

function mergedDefaultModel(input: {
  readonly baseRuntime: Record<string, unknown>
  readonly models: readonly string[]
  readonly replacesModels: boolean
  readonly runtimePatch: Record<string, unknown>
}) {
  if (Object.hasOwn(input.runtimePatch, 'defaultModel')) return input.runtimePatch.defaultModel
  const baseDefaultModel = input.baseRuntime.defaultModel
  if (
    typeof baseDefaultModel === 'string'
    && (!input.replacesModels || input.models.includes(baseDefaultModel))
  ) {
    return baseDefaultModel
  }
  return input.models[0]
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

function normalizeSettings(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return settings
  }
  if (!('runtimes' in settings)) {
    return settings
  }
  const runtimes = settings.runtimes
  if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) {
    return settings
  }
  const defaults = kiriSettingsSchema.parse(bundledSettings)
  const normalizedRuntimes = { ...defaults.runtimes }
  for (const [runtime, runtimeSettings] of Object.entries(runtimes)) {
    const defaultRuntime: Record<string, unknown> = isRecord(defaults.runtimes[runtime as RuntimeKind])
      ? { ...defaults.runtimes[runtime as RuntimeKind] }
      : {}
    normalizedRuntimes[runtime as RuntimeKind] = isRecord(runtimeSettings)
      ? {
        ...defaultRuntime,
        ...runtimeSettings,
        contextWindows: {
          ...(isRecord(defaultRuntime.contextWindows) ? defaultRuntime.contextWindows : {}),
          ...(isRecord(runtimeSettings.contextWindows) ? runtimeSettings.contextWindows : {}),
        },
      }
      : runtimeSettings
  }
  return {
    ...settings,
    runtimes: normalizedRuntimes,
  }
}

function toKiriSettingsError(settingsPath: string, error: unknown) {
  return new KiriSettingsError({
    message: error instanceof Error ? error.message : 'Failed to load Kiri settings',
    path: settingsPath,
    cause: error,
  })
}
