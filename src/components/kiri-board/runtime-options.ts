import type { RuntimeKind, SessionInterfaceMode, WorkspaceSnapshot } from '~/lib/contracts'
import { formatTokenCount } from './format'

type RuntimeSettings = WorkspaceSnapshot['settings']['runtimes'][RuntimeKind]

export type RuntimeOption = {
  readonly runtime: RuntimeKind
  readonly label: string
  readonly meta: string
  readonly detail: string
  readonly defaultModel: string
  readonly interfaceModes: readonly SessionInterfaceMode[]
  readonly defaultInterfaceMode: SessionInterfaceMode
}

export type ModelOption = {
  readonly model: string
  readonly contextWindow: number | null
  readonly contextLabel: string | null
}

export function runtimeOptions(settings: WorkspaceSnapshot['settings']): readonly RuntimeOption[] {
  return (Object.keys(settings.runtimes) as RuntimeKind[]).map((runtime) => {
    const runtimeSettings = settings.runtimes[runtime]
    const interfaceModes = runtimeInterfaceModes(runtime, runtimeSettings)
    const defaultInterfaceMode = normalizeInterfaceMode(
      runtime,
      runtimeSettings,
      runtimeSettings.defaultInterfaceMode ?? firstInterfaceMode(runtime, interfaceModes),
    )
    return {
      runtime,
      label: runtimeSettings.label ?? runtime,
      meta: runtimeSettings.meta ?? interfaceModes.join('/'),
      detail: runtimeSettings.detail ?? runtimeSettings.defaultModel,
      defaultModel: runtimeSettings.defaultModel,
      interfaceModes,
      defaultInterfaceMode,
    }
  })
}

export function runtimeOption(
  settings: WorkspaceSnapshot['settings'],
  runtime: RuntimeKind,
): RuntimeOption {
  const options = runtimeOptions(settings)
  const selected = options.find((option) => option.runtime === runtime)
  if (selected) return selected
  const fallback = options[0]
  if (!fallback) {
    throw new Error('At least one runtime must be configured')
  }
  return fallback
}

export function modelOptions(
  settings: WorkspaceSnapshot['settings'],
  runtime: RuntimeKind,
): readonly ModelOption[] {
  const runtimeSettings = settings.runtimes[runtime]
  return runtimeSettings.models.map((model) => {
    const contextWindow = runtimeSettings.contextWindows?.[model] ?? null
    return {
      model,
      contextWindow,
      contextLabel: contextWindow ? formatTokenCount(contextWindow) : null,
    }
  })
}

export function normalizeRuntimeModel(
  settings: WorkspaceSnapshot['settings'],
  runtime: RuntimeKind,
  model: string,
): string {
  const runtimeSettings = settings.runtimes[runtime]
  return runtimeSettings.models.includes(model) ? model : runtimeSettings.defaultModel
}

export function normalizeInterfaceMode(
  runtime: RuntimeKind,
  runtimeSettings: RuntimeSettings,
  requested: SessionInterfaceMode,
): SessionInterfaceMode {
  const modes = runtimeInterfaceModes(runtime, runtimeSettings)
  if (modes.includes(requested)) return requested
  if (runtimeSettings.defaultInterfaceMode && modes.includes(runtimeSettings.defaultInterfaceMode)) {
    return runtimeSettings.defaultInterfaceMode
  }
  const fallback = modes[0]
  if (!fallback) {
    throw new Error(`Runtime ${runtime} must expose at least one interface mode`)
  }
  return fallback
}

function runtimeInterfaceModes(
  runtime: RuntimeKind,
  runtimeSettings: RuntimeSettings,
): readonly SessionInterfaceMode[] {
  if (!runtimeSettings.interfaceModes?.length) {
    throw new Error(`Runtime ${runtime} must define interfaceModes in settings`)
  }
  return runtimeSettings.interfaceModes
}

function firstInterfaceMode(
  runtime: RuntimeKind,
  modes: readonly SessionInterfaceMode[],
): SessionInterfaceMode {
  const mode = modes[0]
  if (!mode) {
    throw new Error(`Runtime ${runtime} must expose at least one interface mode`)
  }
  return mode
}
