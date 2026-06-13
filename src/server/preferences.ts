import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Context, Data, Effect, Layer } from 'effect'
import type {
  ChatTypographySettings,
  KeymapSettings,
  UiPreferences,
} from '~/lib/ui-preferences'
import {
  defaultUiPreferences,
  normalizeKeymapSettings,
  uiPreferencesSchema,
} from '~/lib/ui-preferences'
import type { ThemeSelection } from '~/theme/kiri-themes'
import {
  KiriConfigService,
  type KiriConfigApi,
  getKiriConfig,
} from './kiri-config'

export class UiPreferencesError extends Data.TaggedError('UiPreferencesError')<{
  readonly message: string
  readonly path?: string
  readonly cause?: unknown
}> {}

export type UiPreferencesApi = {
  readonly get: Effect.Effect<UiPreferences, UiPreferencesError>
  readonly setTheme: (theme: ThemeSelection) => Effect.Effect<UiPreferences, UiPreferencesError>
  readonly setKeymap: (keymap: KeymapSettings) => Effect.Effect<UiPreferences, UiPreferencesError>
  readonly setChatTypography: (
    chatTypography: ChatTypographySettings,
  ) => Effect.Effect<UiPreferences, UiPreferencesError>
  readonly setAgentByProject: (
    agentByProject: Record<string, string>,
  ) => Effect.Effect<UiPreferences, UiPreferencesError>
}

export type PreferencesFileSystem = {
  readonly exists: (path: string) => boolean
  readonly readTextFile: (path: string) => string
  readonly mkdirp: (path: string) => void
  readonly writeTextFile: (path: string, value: string) => void
  readonly rename: (from: string, to: string) => void
  readonly tempSuffix: () => string
}

const nodePreferencesFileSystem: PreferencesFileSystem = {
  exists: existsSync,
  readTextFile: (path) => readFileSync(path, 'utf8'),
  mkdirp: (path) => mkdirSync(path, { recursive: true }),
  writeTextFile: writeFileSync,
  rename: renameSync,
  tempSuffix: () => `${process.pid}.${Date.now()}`,
}

export class UiPreferencesService extends Context.Tag('@kiri/UiPreferences')<
  UiPreferencesService,
  UiPreferencesApi
>() {
  static readonly layerFromConfig = Layer.effect(
    UiPreferencesService,
    Effect.gen(function* () {
      const config = yield* KiriConfigService
      return UiPreferencesService.of(makeUiPreferencesService({ config }))
    }),
  )

  static readonly layer = UiPreferencesService.layerFromConfig.pipe(
    Layer.provide(KiriConfigService.layer),
  )
}

export function makeUiPreferencesService(input: {
  readonly config: KiriConfigApi
  readonly fs?: PreferencesFileSystem
}): UiPreferencesApi {
  const fs = input.fs ?? nodePreferencesFileSystem
  const getPath = input.config.get.pipe(
    Effect.map((config) => config.preferencesPath),
    Effect.mapError((error) => new UiPreferencesError({
      message: error.message,
      cause: error,
    })),
  )
  const withPath = <A>(
    run: (preferencesPath: string) => A,
  ): Effect.Effect<A, UiPreferencesError> =>
    getPath.pipe(
      Effect.flatMap((preferencesPath) =>
        Effect.try({
          try: () => run(preferencesPath),
          catch: (error) => toUiPreferencesError(preferencesPath, error),
        }),
      ),
    )

  return {
    get: withPath((preferencesPath) => readUiPreferences(preferencesPath, fs)),
    setTheme: (theme) =>
      withPath((preferencesPath) =>
        updateUiPreferencesWithFs((current) => ({ ...current, theme }), preferencesPath, fs)
      ),
    setKeymap: (keymap) =>
      withPath((preferencesPath) =>
        updateUiPreferencesWithFs((current) => ({ ...current, keymap }), preferencesPath, fs)
      ),
    setChatTypography: (chatTypography) =>
      withPath((preferencesPath) =>
        updateUiPreferencesWithFs(
          (current) => ({ ...current, chatTypography }),
          preferencesPath,
          fs,
        )
      ),
    setAgentByProject: (agentByProject) =>
      withPath((preferencesPath) =>
        updateUiPreferencesWithFs(
          (current) => ({ ...current, agentByProject }),
          preferencesPath,
          fs,
        )
      ),
  }
}

export function getUiPreferences(preferencesPath = getKiriConfig().preferencesPath): UiPreferences {
  return readUiPreferences(preferencesPath, nodePreferencesFileSystem)
}

export function setThemePreference(
  theme: ThemeSelection,
  preferencesPath = getKiriConfig().preferencesPath,
): UiPreferences {
  return updateUiPreferences((current) => ({ ...current, theme }), preferencesPath)
}

export function setKeymapPreference(
  keymap: KeymapSettings,
  preferencesPath = getKiriConfig().preferencesPath,
): UiPreferences {
  return updateUiPreferences((current) => ({ ...current, keymap }), preferencesPath)
}

export function setChatTypographyPreference(
  chatTypography: ChatTypographySettings,
  preferencesPath = getKiriConfig().preferencesPath,
): UiPreferences {
  return updateUiPreferences((current) => ({ ...current, chatTypography }), preferencesPath)
}

export function setAgentByProjectPreference(
  agentByProject: Record<string, string>,
  preferencesPath = getKiriConfig().preferencesPath,
): UiPreferences {
  return updateUiPreferences((current) => ({ ...current, agentByProject }), preferencesPath)
}

function updateUiPreferences(
  update: (current: UiPreferences) => UiPreferences,
  preferencesPath: string,
): UiPreferences {
  return updateUiPreferencesWithFs(update, preferencesPath, nodePreferencesFileSystem)
}

function updateUiPreferencesWithFs(
  update: (current: UiPreferences) => UiPreferences,
  preferencesPath: string,
  fs: PreferencesFileSystem,
): UiPreferences {
  const current = readUiPreferences(preferencesPath, fs)
  const next = uiPreferencesSchema.parse(update(current))
  writeUiPreferences(next, preferencesPath, fs)
  return next
}

function readUiPreferences(preferencesPath: string, fs: PreferencesFileSystem): UiPreferences {
  if (!fs.exists(preferencesPath)) return defaultUiPreferences
  const parsed = JSON.parse(fs.readTextFile(preferencesPath)) as unknown
  const preferences = uiPreferencesSchema.parse(parsed)
  return {
    ...preferences,
    keymap: normalizeKeymapSettings(preferences.keymap),
  }
}

function writeUiPreferences(
  preferences: UiPreferences,
  preferencesPath: string,
  fs: PreferencesFileSystem,
) {
  const next = uiPreferencesSchema.parse(preferences)
  fs.mkdirp(dirname(preferencesPath))
  const tempPath = `${preferencesPath}.${fs.tempSuffix()}.tmp`
  fs.writeTextFile(tempPath, `${JSON.stringify(next, null, 2)}\n`)
  fs.rename(tempPath, preferencesPath)
}

function toUiPreferencesError(preferencesPath: string, error: unknown) {
  return new UiPreferencesError({
    message: error instanceof Error ? error.message : 'Failed to update UI preferences',
    path: preferencesPath,
    cause: error,
  })
}
