type HostMode = 'web' | 'desktop'

type AetherHostInfo = {
  readonly mode: HostMode
  readonly platform: string
}

export type AetherHostBridge = {
  readonly getHostInfo?: () => Promise<AetherHostInfo>
  readonly pickFolder?: () => Promise<string | null>
  readonly openExternal?: (url: string) => Promise<void>
  readonly revealPath?: (path: string) => Promise<void>
  readonly onMenuAction?: (handler: (actionId: string) => void) => () => void
}

declare global {
  interface Window {
    readonly aetherHost?: AetherHostBridge
  }
}

export function getAetherHostBridge() {
  if (typeof window === 'undefined') return undefined
  return window.aetherHost
}

export async function pickProjectDirectory(
  fallback: () => Promise<string>,
  bridge: AetherHostBridge | undefined = getAetherHostBridge(),
) {
  if (bridge?.pickFolder) {
    const picked = await bridge.pickFolder()
    if (picked) return picked
    throw new Error('Project directory selection canceled')
  }
  return fallback()
}
