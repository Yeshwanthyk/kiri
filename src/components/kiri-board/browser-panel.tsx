'use client'

import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  LoaderCircle,
  RotateCw,
  X,
} from 'lucide-react'
import * as React from 'react'
import {
  getKiriBrowserBridge,
  type BrowserNavState,
  type KiriBrowserBridge,
} from '~/lib/host-capabilities'
import type { BrowserResource } from './resource-tabs'

export function BrowserPanel({
  resource,
  visible,
}: {
  resource: BrowserResource
  visible: boolean
}) {
  const initialUrlRef = React.useRef(resource.url)
  const anchorRef = React.useRef<HTMLDivElement | null>(null)
  const [bridge, setBridge] = React.useState<KiriBrowserBridge | undefined>(undefined)
  const [navState, setNavState] = React.useState<BrowserNavState | null>(null)
  const [draftUrl, setDraftUrl] = React.useState(resource.url)
  const [editingUrl, setEditingUrl] = React.useState(false)

  React.useEffect(() => {
    setBridge(getKiriBrowserBridge())
  }, [])

  React.useEffect(() => {
    if (!bridge) return
    bridge.create(resource.browserId, initialUrlRef.current)
    return () => {
      bridge.setBounds(resource.browserId, null)
      bridge.destroy(resource.browserId)
    }
  }, [bridge, resource.browserId])

  React.useEffect(() => {
    if (!bridge) return
    return bridge.onState((state) => {
      if (state.browserId === resource.browserId) setNavState(state)
    })
  }, [bridge, resource.browserId])

  React.useEffect(() => {
    if (editingUrl) return
    setDraftUrl(navState?.url || resource.url)
  }, [editingUrl, navState?.url, resource.url])

  const syncBounds = React.useCallback(() => {
    if (!bridge) return
    const anchor = anchorRef.current
    if (!visible || !anchor) {
      bridge.setBounds(resource.browserId, null)
      return
    }
    const rect = anchor.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      bridge.setBounds(resource.browserId, null)
      return
    }
    bridge.setBounds(resource.browserId, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    })
  }, [bridge, resource.browserId, visible])

  React.useEffect(() => {
    syncBounds()
  }, [syncBounds])

  React.useEffect(() => {
    if (!bridge) return
    const anchor = anchorRef.current
    if (!anchor) return
    const observer = new ResizeObserver(syncBounds)
    observer.observe(anchor)
    const frame = window.requestAnimationFrame(syncBounds)
    window.addEventListener('resize', syncBounds)
    window.addEventListener('scroll', syncBounds, true)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', syncBounds)
      window.removeEventListener('scroll', syncBounds, true)
      bridge.setBounds(resource.browserId, null)
    }
  }, [bridge, resource.browserId, syncBounds])

  const canGoBack = navState?.canGoBack ?? false
  const canGoForward = navState?.canGoForward ?? false
  const loading = navState?.isLoading ?? false

  function submitUrl(event: React.FormEvent) {
    event.preventDefault()
    const target = normalizeBrowserInput(draftUrl)
    if (!target || !bridge) return
    setDraftUrl(target)
    setEditingUrl(false)
    bridge.navigate(resource.browserId, target)
  }

  return (
    <section
      className="browser-panel"
      data-testid={visible ? 'browser-panel' : undefined}
      hidden={!visible}
    >
      <form className="browser-toolbar" onSubmit={submitUrl}>
        <div className="browser-nav-actions">
          <button
            type="button"
            onClick={() => bridge?.goBack(resource.browserId)}
            disabled={!bridge || !canGoBack}
            aria-label="Go back"
            title="Go back"
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => bridge?.goForward(resource.browserId)}
            disabled={!bridge || !canGoForward}
            aria-label="Go forward"
            title="Go forward"
          >
            <ArrowRight size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => loading ? bridge?.stop(resource.browserId) : bridge?.reload(resource.browserId)}
            disabled={!bridge}
            aria-label={loading ? 'Stop loading' : 'Reload'}
            title={loading ? 'Stop loading' : 'Reload'}
          >
            {loading ? <X size={14} aria-hidden="true" /> : <RotateCw size={14} aria-hidden="true" />}
          </button>
        </div>
        <label className="browser-omnibar">
          {navState?.favicon ? (
            <img src={navState.favicon} alt="" aria-hidden="true" />
          ) : loading ? (
            <LoaderCircle size={14} aria-hidden="true" />
          ) : (
            <Globe2 size={14} aria-hidden="true" />
          )}
          <input
            value={draftUrl}
            spellCheck={false}
            inputMode="url"
            aria-label="Browser URL"
            disabled={!bridge}
            onFocus={() => setEditingUrl(true)}
            onBlur={() => {
              setEditingUrl(false)
              setDraftUrl(navState?.url || resource.url)
            }}
            onChange={(event) => setDraftUrl(event.currentTarget.value)}
          />
        </label>
      </form>
      {bridge ? (
        <div
          ref={anchorRef}
          className="browser-view-anchor"
          aria-hidden="true"
        />
      ) : (
        <div className="browser-fallback" role="status">
          Browser is desktop-only.
        </div>
      )}
    </section>
  )
}

function normalizeBrowserInput(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).toString()
  } catch {
    // continue below
  }
  if (!/\s/.test(trimmed) && trimmed.includes('.')) {
    return `https://${trimmed}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}
