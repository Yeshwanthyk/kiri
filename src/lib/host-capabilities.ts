type HostMode = 'web' | 'desktop'

type KiriHostInfo = {
  readonly mode: HostMode
  readonly platform: string
}

export type KiriHostBridge = {
  readonly getHostInfo?: () => Promise<KiriHostInfo>
  readonly pickFolder?: () => Promise<string | null>
  readonly openExternal?: (url: string) => Promise<void>
  readonly revealPath?: (path: string) => Promise<void>
  readonly onMenuAction?: (handler: (actionId: string) => void) => () => void
}

declare global {
  interface Window {
    readonly kiriHost?: KiriHostBridge
  }
}

export function getKiriHostBridge() {
  if (typeof window === 'undefined') return undefined
  return window.kiriHost
}

export async function pickProjectDirectory(
  fallback: () => Promise<string>,
  bridge: KiriHostBridge | undefined = getKiriHostBridge(),
) {
  if (bridge?.pickFolder) {
    const picked = await bridge.pickFolder()
    if (picked) return picked
    throw new Error('Project directory selection canceled')
  }
  return fallback()
}
