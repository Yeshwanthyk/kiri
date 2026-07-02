type HostMode = 'web' | 'desktop'

type KiriHostInfo = {
  readonly mode: HostMode
  readonly platform: string
}

export type BrowserBounds = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type BrowserNavState = {
  readonly browserId: string
  readonly url: string
  readonly title: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly isLoading: boolean
  readonly favicon: string | null
}

export type BrowserShortcutInput = {
  readonly browserId: string
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
  readonly release?: boolean
}

export type KiriBrowserBridge = {
  readonly create: (browserId: string, url: string) => void
  readonly setBounds: (browserId: string, bounds: BrowserBounds | null) => void
  readonly navigate: (browserId: string, url: string) => void
  readonly goBack: (browserId: string) => void
  readonly goForward: (browserId: string) => void
  readonly reload: (browserId: string) => void
  readonly stop: (browserId: string) => void
  readonly focusHost: () => void
  readonly destroy: (browserId: string) => void
  readonly onState: (handler: (state: BrowserNavState) => void) => () => void
  readonly onShortcut: (handler: (input: BrowserShortcutInput) => void) => () => void
}

export type KiriHostBridge = {
  readonly getHostInfo?: () => Promise<KiriHostInfo>
  readonly pickFolder?: () => Promise<string | null>
  readonly openExternal?: (url: string) => Promise<void>
  readonly revealPath?: (path: string) => Promise<void>
  readonly onMenuAction?: (handler: (actionId: string) => void) => () => void
  readonly browser?: KiriBrowserBridge
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

export function getKiriBrowserBridge() {
  return getKiriHostBridge()?.browser
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
