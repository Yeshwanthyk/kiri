'use client'

import { ArrowLeft, Check, Copy, ExternalLink, RefreshCw, Smartphone } from 'lucide-react'
import * as React from 'react'
import {
  defaultThemeSelection,
  getKiriThemeTokens,
  kiriThemeNames,
  type KiriThemeName,
  type ThemeMode,
  type ThemeSelection,
} from '~/theme/kiri-themes'
import {
  formatKey,
  keymapGroups,
  keyOptions,
  type KeymapAction,
  type KeymapSettings,
} from './navigation'
import {
  chatFontSizes,
  defaultChatTypography,
  monoFonts,
  type ChatFontSize,
  type ChatTypographySettings,
  type MonoFont,
} from './storage'

export function SettingsScreen({
  keymap,
  themeSelection,
  chatTypography,
  onKeymapChange,
  onKeymapReset,
  onThemeChange,
  onChatTypographyChange,
  onClose,
}: {
  keymap: KeymapSettings
  themeSelection: ThemeSelection
  chatTypography: ChatTypographySettings
  onKeymapChange: (action: KeymapAction, value: string) => void
  onKeymapReset: () => void
  onThemeChange: (selection: ThemeSelection) => void
  onChatTypographyChange: (settings: ChatTypographySettings) => void
  onClose: () => void
}) {
  const keymapActionCount = keymapGroups.reduce((count, group) => count + group.rows.length, 1)
  return (
    <main className="settings-shell" data-testid="settings-page">
      <header className="settings-topbar">
        <button
          type="button"
          className="settings-back"
          onClick={onClose}
          aria-label="Back to board"
          data-testid="settings-back"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          board
        </button>
        <span className="settings-crumb">kiri / settings</span>
      </header>

      <div className="settings-layout" role="region" aria-label="Settings">
        <aside className="settings-index" aria-label="Settings sections">
          <div className="settings-index-head">
            <p className="settings-kicker">Settings</p>
            <h1>Control surface</h1>
            <p>Theme first, chat next, keyboard grouped by how your hands move.</p>
          </div>
          <nav className="settings-index-list">
            <a className="settings-index-item" data-primary="true" href="#settings-palette">
              <span>
                <strong>Palette</strong>
                <small>Theme and mode</small>
              </span>
              <span>{kiriThemeNames.length}</span>
            </a>
            <a className="settings-index-item" href="#settings-chat">
              <span>
                <strong>Chat</strong>
                <small>Size and code font</small>
              </span>
              <span>{Object.keys(monoFonts).length}</span>
            </a>
            <a className="settings-index-item" href="#settings-connect">
              <span>
                <strong>Connect</strong>
                <small>Phone board access</small>
              </span>
              <span>QR</span>
            </a>
            <a className="settings-index-item" href="#settings-keyboard">
              <span>
                <strong>Keyboard</strong>
                <small>Board, session, focus</small>
              </span>
              <span>{keymapActionCount}</span>
            </a>
          </nav>
        </aside>

        <div className="settings-main">
          <section
            id="settings-palette"
            className="settings-panel settings-panel--wide"
            data-panel="theme"
            aria-label="Theme"
          >
            <ThemeSettingsPanel selection={themeSelection} onChange={onThemeChange} />
          </section>

          <div className="settings-panel-row">
            <section
              id="settings-chat"
              className="settings-panel"
              data-panel="chat"
              aria-label="Chat reading size"
            >
              <ChatTypographySettingsPanel
                settings={chatTypography}
                onChange={onChatTypographyChange}
              />
            </section>

            <section
              id="settings-connect"
              className="settings-panel"
              data-panel="connect"
              aria-label="Connect phone"
            >
              <ConnectSettingsPanel />
            </section>
          </div>

          <div className="settings-panel-row settings-panel-row--single">
            <section
              id="settings-keyboard"
              className="settings-panel"
              data-panel="keymap"
              aria-label="Keymap"
            >
              <KeymapSettingsPanel
                keymap={keymap}
                onChange={onKeymapChange}
                onReset={onKeymapReset}
              />
            </section>
          </div>
        </div>
      </div>
    </main>
  )
}

type ConnectEndpoint = {
  readonly kind: string
  readonly label: string
  readonly url: string
}

type ConnectInfo = {
  readonly baseUrl: string
  readonly endpoints: readonly ConnectEndpoint[]
  readonly auth: {
    readonly pendingPairingTokens: number
    readonly activeSessions: number
  }
  readonly tailscale: {
    readonly available: boolean
    readonly dnsName?: string
    readonly error?: string
  }
}

type PairingLink = {
  readonly pairingUrl: string
  readonly expiresAt: string
}

function ConnectSettingsPanel() {
  const [info, setInfo] = React.useState<ConnectInfo | undefined>()
  const [selectedUrl, setSelectedUrl] = React.useState('')
  const [pairing, setPairing] = React.useState<PairingLink | undefined>()
  const [status, setStatus] = React.useState<string | undefined>()
  const [loading, setLoading] = React.useState(false)
  const [ownerToken, setOwnerToken] = React.useState('')

  React.useEffect(() => {
    const url = new URL(window.location.href)
    const token = url.searchParams.get('kiri_owner_token') ?? sessionStorage.getItem('kiri_owner_token') ?? ''
    if (token) {
      sessionStorage.setItem('kiri_owner_token', token)
      url.searchParams.delete('kiri_owner_token')
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
    setOwnerToken(token)
  }, [])

  const refresh = React.useCallback(async () => {
    if (!ownerToken) {
      setStatus('Open kiri from the desktop app to manage phone pairing.')
      return
    }
    setLoading(true)
    setStatus(undefined)
    try {
      const response = await fetch('/.well-known/kiri/connect', {
        cache: 'no-store',
        headers: ownerHeaders(ownerToken),
      })
      if (!response.ok) throw new Error(await responseErrorMessage(response))
      const next = await response.json() as ConnectInfo
      setInfo(next)
      setSelectedUrl((current) => current || preferredConnectUrl(next))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [ownerToken])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const createPairingLink = React.useCallback(async () => {
    if (!ownerToken) return
    setLoading(true)
    setStatus(undefined)
    try {
      const response = await fetch('/.well-known/kiri/connect/pairing-token', {
        method: 'POST',
        headers: ownerHeaders(ownerToken),
        body: JSON.stringify({ baseUrl: selectedUrl, label: 'phone' }),
      })
      if (!response.ok) throw new Error(await responseErrorMessage(response))
      const next = await response.json() as PairingLink
      setPairing(next)
      await navigator.clipboard?.writeText(next.pairingUrl)
      setStatus('Pairing link copied.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [ownerToken, selectedUrl])

  const enableTailscaleServe = React.useCallback(async () => {
    if (!ownerToken) return
    setLoading(true)
    setStatus(undefined)
    try {
      const response = await fetch('/.well-known/kiri/connect/tailscale-serve', {
        method: 'POST',
        headers: ownerHeaders(ownerToken),
        body: JSON.stringify({ enabled: true }),
      })
      if (!response.ok) throw new Error(await responseErrorMessage(response))
      setStatus('Tailscale Serve enabled.')
      setSelectedUrl('')
      await refresh()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [ownerToken, refresh])

  const endpoints = info?.endpoints.length
    ? info.endpoints
    : [{ kind: 'local', label: 'This Mac', url: info?.baseUrl ?? selectedUrl }]

  return (
    <>
      <header className="settings-lane-head">
        <div className="settings-lane-title">
          <p className="settings-kicker">Connect</p>
          <h2>Phone board</h2>
          <p>Pair a phone browser to this desktop board over Tailscale or the local network.</p>
        </div>
        <button
          type="button"
          className="settings-reset"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh connect status"
        >
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </header>

      <div className="connect-summary" aria-live="polite">
        <span>
          <Smartphone size={14} aria-hidden="true" />
          {info?.auth.activeSessions ?? 0} paired
        </span>
        <span>{info?.auth.pendingPairingTokens ?? 0} pending</span>
        <span data-ok={info?.tailscale.available ? 'true' : 'false'}>
          Tailscale {info?.tailscale.available ? 'ready' : 'not found'}
        </span>
      </div>

      <label className="connect-field">
        <span>Endpoint</span>
        <select value={selectedUrl} onChange={(event) => setSelectedUrl(event.currentTarget.value)}>
          {endpoints.map((endpoint) => (
            <option key={`${endpoint.kind}:${endpoint.url}`} value={endpoint.url}>
              {endpoint.label} · {endpoint.url}
            </option>
          ))}
        </select>
      </label>

      <div className="connect-actions">
        <button type="button" onClick={() => void createPairingLink()} disabled={loading || !selectedUrl || !ownerToken}>
          <Copy size={14} aria-hidden="true" />
          create link
        </button>
        <button type="button" onClick={() => void enableTailscaleServe()} disabled={loading || !ownerToken}>
          <ExternalLink size={14} aria-hidden="true" />
          serve
        </button>
      </div>

      {pairing ? (
        <div className="connect-link-box">
          <span>Expires {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          <a href={pairing.pairingUrl} target="_blank" rel="noreferrer">{pairing.pairingUrl}</a>
        </div>
      ) : null}

      {status ? <p className="connect-status">{status}</p> : null}
    </>
  )
}

function preferredConnectUrl(info: ConnectInfo) {
  return info.endpoints.find((endpoint) => endpoint.kind === 'tailscale-https')?.url ||
    info.endpoints[0]?.url ||
    info.baseUrl
}

function ownerHeaders(token: string) {
  return {
    'content-type': 'application/json',
    'x-kiri-owner-token': token,
  }
}

async function responseErrorMessage(response: Response) {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined
    if (typeof body?.error === 'string') return body.error
  }
  return `Connect endpoint unavailable (${response.status})`
}

function ThemeSettingsPanel({
  selection,
  onChange,
}: {
  selection: ThemeSelection
  onChange: (selection: ThemeSelection) => void
}) {
  return (
    <>
      <header className="settings-lane-head">
        <div className="settings-lane-title">
          <p className="settings-kicker">Theme</p>
          <h2>Palette</h2>
          <p>Pick a theme. Mode follows your selection across the board.</p>
        </div>
        <button
          type="button"
          className="settings-reset"
          onClick={() => onChange(defaultThemeSelection)}
          data-testid="theme-reset"
        >
          reset
        </button>
      </header>

      <div className="theme-mode-toggle" role="tablist" aria-label="Theme mode">
        {(['light', 'dark'] as ThemeMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={selection.mode === mode}
            data-active={selection.mode === mode}
            data-testid={`theme-mode-${mode}`}
            onClick={() => onChange({ ...selection, mode })}
          >
            {mode}
          </button>
        ))}
      </div>

      <div className="theme-grid" role="radiogroup" aria-label="Theme name">
        {kiriThemeNames.map((name) => (
          <ThemeCard
            key={name}
            name={name}
            mode={selection.mode}
            selected={selection.name === name}
            onSelect={() => onChange({ name, mode: selection.mode })}
          />
        ))}
      </div>
    </>
  )
}

function ThemeCard({
  name,
  mode,
  selected,
  onSelect,
}: {
  name: KiriThemeName
  mode: ThemeMode
  selected: boolean
  onSelect: () => void
}) {
  const tokens = getKiriThemeTokens({ name, mode })
  const cardStyle = {
    '--tc-paper': tokens.paper,
    '--tc-panel': tokens.panel,
    '--tc-ink': tokens.ink,
    '--tc-muted': tokens.muted,
    '--tc-line': tokens.line,
    '--tc-accent': tokens.accent,
    '--tc-warn': tokens.warn,
  } as React.CSSProperties
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-selected={selected}
      data-testid={`theme-card-${name}`}
      className="theme-card"
      style={cardStyle}
      onClick={onSelect}
    >
      <div className="theme-card-preview" aria-hidden="true">
        <div className="theme-card-rail">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="theme-card-board">
          <div className="row">
            <span className="chip accent" />
            <span className="chip" />
            <span className="chip muted" />
          </div>
          <div className="row">
            <span className="chip" />
            <span className="chip muted" />
            <span className="chip warn" />
          </div>
          <div className="row">
            <span className="chip accent" />
            <span className="chip" />
            <span className="chip muted" />
          </div>
        </div>
      </div>
      <div className="theme-card-meta">
        <span className="theme-card-name">{name}</span>
        <span className="theme-card-swatches" aria-hidden="true">
          <span style={{ background: tokens.accent }} />
          <span style={{ background: tokens.accent2 }} />
          <span style={{ background: tokens.paper }} />
          <span style={{ background: tokens.ink }} />
        </span>
        <span className="theme-card-check" aria-hidden="true">
          <Check size={10} strokeWidth={3} />
        </span>
      </div>
    </button>
  )
}

function ChatTypographySettingsPanel({
  settings,
  onChange,
}: {
  settings: ChatTypographySettings
  onChange: (settings: ChatTypographySettings) => void
}) {
  const current = chatFontSizes[settings.fontSize]
  const previewStyle = {
    '--chat-preview-size': current.size,
    '--chat-preview-line': current.lineHeight,
  } as React.CSSProperties
  return (
    <>
      <header className="settings-lane-head">
        <div className="settings-lane-title">
          <p className="settings-kicker">Typography</p>
          <h2>Reading size &amp; code font</h2>
          <p>Affects chat messages, the composer, inline code, and terminals.</p>
        </div>
        <button
          type="button"
          className="settings-reset"
          onClick={() => onChange(defaultChatTypography)}
          data-testid="chat-reset"
        >
          reset
        </button>
      </header>

      <div className="settings-subsection">
        <p className="settings-subsection-label">Chat reading size</p>
        <div className="chat-size-options" role="radiogroup" aria-label="Chat font size">
          {(Object.keys(chatFontSizes) as ChatFontSize[]).map((size) => {
            const option = chatFontSizes[size]
            const [label, spec] = option.label.split(' · ')
            const active = settings.fontSize === size
            return (
              <button
                key={size}
                type="button"
                role="radio"
                aria-checked={active}
                data-active={active}
                data-testid={`chat-size-${size}`}
                className="chat-size-option"
                onClick={() => onChange({ ...settings, fontSize: size })}
              >
                <strong>{label}</strong>
                <small>{spec}</small>
              </button>
            )
          })}
        </div>

        <div className="chat-size-preview" style={previewStyle} aria-live="polite">
          <p>
            The model is rendering a diff while you review the previous turn.
            This is roughly how chat copy will read at the selected size.
          </p>
          <small>preview · {current.size} / {current.lineHeight}</small>
        </div>
      </div>

      <div className="settings-subsection">
        <p className="settings-subsection-label">Chat code font</p>
        <div className="mono-font-options" role="radiogroup" aria-label="Code font">
          {(Object.keys(monoFonts) as MonoFont[]).map((key) => {
            const option = monoFonts[key]
            const active = settings.monoFont === key
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={active}
                data-active={active}
                data-testid={`mono-font-${key}`}
                className="mono-font-option"
                onClick={() => onChange({ ...settings, monoFont: key })}
                style={{ '--mono-preview-stack': option.stack } as React.CSSProperties}
              >
                <span className="mono-font-option-text">
                  <strong>{option.label}</strong>
                  <small>0Oo il1 =&gt; !=</small>
                </span>
                {active ? (
                  <span className="mono-font-check" aria-hidden="true">
                    <Check size={10} strokeWidth={3} />
                  </span>
                ) : (
                  <span className="mono-font-sample" aria-hidden="true">Aa 1·0</span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

function KeymapSettingsPanel({
  keymap,
  onChange,
  onReset,
}: {
  keymap: KeymapSettings
  onChange: (action: KeymapAction, value: string) => void
  onReset: () => void
}) {
  const conflicts = React.useMemo(() => {
    const counts = new Map<string, KeymapAction[]>()
    for (const [action, value] of Object.entries(keymap) as [KeymapAction, string][]) {
      const list = counts.get(value) ?? []
      list.push(action)
      counts.set(value, list)
    }
    const map = new Map<KeymapAction, KeymapAction[]>()
    for (const list of counts.values()) {
      if (list.length < 2) continue
      for (const action of list) {
        map.set(
          action,
          list.filter((other) => other !== action),
        )
      }
    }
    return map
  }, [keymap])

  const actionLabels = React.useMemo(() => {
    const labels: Partial<Record<KeymapAction, string>> = {}
    for (const group of keymapGroups) {
      for (const row of group.rows) labels[row.action] = row.label
    }
    return labels
  }, [])

  return (
    <>
      <header className="settings-lane-head">
        <div className="settings-lane-title">
          <p className="settings-kicker">Keymap</p>
          <h2>Shortcuts</h2>
          <p>Every action takes Shift plus the chosen key.</p>
        </div>
        <button
          type="button"
          className="settings-reset"
          onClick={onReset}
          data-testid="keymap-reset"
        >
          reset
        </button>
      </header>

      {keymapGroups.map((group) => (
        <div key={group.id} className="keymap-group">
          <p className="keymap-group-label">{group.label}</p>
          {group.rows.map((row) => {
            const conflict = conflicts.get(row.action)
            const conflictLabel = conflict
              ?.map((action) => actionLabels[action] ?? action)
              .join(', ')
            return (
              <div
                key={row.action}
                className="keymap-row"
                data-conflict={conflict ? 'true' : 'false'}
              >
                <select
                  value={keymap[row.action]}
                  onChange={(event) => onChange(row.action, event.currentTarget.value)}
                  data-testid={`keymap-${row.action}`}
                  aria-label={row.label}
                >
                  {keyOptions.map((key) => (
                    <option key={key} value={key}>
                      ⇧ {formatKey(key)}
                    </option>
                  ))}
                </select>
                <div className="keymap-row-meta">
                  <strong>{row.label}</strong>
                  <small>{conflict ? `Shared with ${conflictLabel}` : row.hint}</small>
                </div>
              </div>
            )
          })}
        </div>
      ))}

      <div className="keymap-static" aria-label="Command menu shortcut">
        <span className="keymap-static-chip">⌘K</span>
        <div className="keymap-row-meta">
          <strong>Command menu</strong>
          <small>Fixed binding · ⌘K or Ctrl+K</small>
        </div>
      </div>
    </>
  )
}
