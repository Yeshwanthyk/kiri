import { runtimeKinds, type RuntimeKind, type SessionInterfaceMode, type WorkspaceSnapshot } from '~/lib/contracts'

type RuntimeSettings = WorkspaceSnapshot['settings']['runtimes'][RuntimeKind]

export type RuntimeOption = {
  readonly runtime: RuntimeKind
  readonly label: string
  readonly meta: string
  readonly detail: string
  readonly interfaceModes: readonly SessionInterfaceMode[]
  readonly defaultInterfaceMode: SessionInterfaceMode
}

export function runtimeOptions(settings: WorkspaceSnapshot['settings']): readonly RuntimeOption[] {
  return runtimeKinds.map((runtime) => {
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
      meta: formatInterfaceModes(interfaceModes),
      detail: runtimeSettings.detail ?? formatInterfaceModes(interfaceModes),
      interfaceModes,
      defaultInterfaceMode,
    }
  })
}

function formatInterfaceModes(modes: readonly SessionInterfaceMode[]) {
  return modes.map((mode) => mode === 'gui' ? 'GUI' : 'Terminal').join(' / ')
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
