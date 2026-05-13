'use client'

import { useServerFn } from '@tanstack/react-start'
import * as React from 'react'
import type { AgentCell, ProjectRow } from '~/lib/contracts'
import { terminalConfigQuery } from '~/server/workspace'
import type { ThemeMode } from '~/theme/kiri-themes'

type GhosttyTerminalInstance = InstanceType<(typeof import('ghostty-web'))['Terminal']>
type GhosttyFitAddonInstance = InstanceType<(typeof import('ghostty-web'))['FitAddon']>
type TerminalDisposable = { dispose: () => void }

export function TerminalPanel({
  agent,
  project,
  themeMode,
}: {
  agent: AgentCell
  project: ProjectRow
  themeMode: ThemeMode
}) {
  const getTerminalConfig = useServerFn(terminalConfigQuery)
  const getTerminalConfigRef = React.useRef(getTerminalConfig)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = React.useState('Connecting')
  const [transcript, setTranscript] = React.useState('')

  React.useEffect(() => {
    getTerminalConfigRef.current = getTerminalConfig
  }, [getTerminalConfig])

  React.useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let term: GhosttyTerminalInstance | null = null
    let fitAddon: GhosttyFitAddonInstance | null = null
    const terminalDisposables: TerminalDisposable[] = []

    async function connect() {
      const host = hostRef.current
      if (!host) return
      host.textContent = ''
      setTranscript('')
      setStatus('Loading')

      try {
        const [{ init, Terminal, FitAddon }, terminalConfig] = await Promise.all([
          import('ghostty-web'),
          getTerminalConfigRef.current({ data: { agentId: agent.id } }),
        ])
        if (disposed) return

        await init()
        if (disposed) return

        term = new Terminal({
          fontSize: 13,
          fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          cursorBlink: true,
          theme: terminalTheme(themeMode),
        })
        fitAddon = new FitAddon()
        term.loadAddon(fitAddon)
        term.open(host)
        term.attachCustomKeyEventHandler((event) => {
          if (
            event.key === 'Escape' &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            term?.blur()
            return true
          }
          return false
        })
        fitAddon.fit()
        fitAddon.observeResize?.()

        const url = terminalWebSocketUrl(terminalConfig, agent.id, term.cols, term.rows)
        socket = new WebSocket(url)
        socket.onopen = () => {
          if (!term || !socket) return
          setStatus('Connected')
          socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          const banner = `kiri terminal · ${project.cwd}\r\n\r\n`
          term.write(banner)
          appendTerminalTranscript(setTranscript, banner)
        }
        socket.onmessage = (event) => {
          if (typeof event.data === 'string') {
            term?.write(event.data)
            appendTerminalTranscript(setTranscript, event.data)
          }
        }
        socket.onclose = () => {
          if (!disposed) {
            setStatus('Closed')
            appendTerminalTranscript(setTranscript, '\r\n[kiri terminal socket closed]\r\n')
          }
        }
        socket.onerror = () => {
          if (!disposed) setStatus('Connection failed')
        }
        terminalDisposables.push(
          term.onData((data) => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'input', data }))
            }
          }),
          term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'resize', cols, rows }))
            }
          }),
        )
      } catch (error) {
        if (disposed) return
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }

    void connect()

    return () => {
      disposed = true
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onclose = null
        socket.onerror = null
      }
      socket?.close()
      for (const disposable of terminalDisposables) {
        disposable.dispose()
      }
      fitAddon?.dispose()
      term?.dispose()
    }
  }, [agent.id, project.cwd, themeMode])

  return (
    <section className="terminal-panel" data-testid="terminal-panel">
      <div className="terminal-header">
        <div>
          <strong>{project.name}</strong>
          <span>{project.cwd}</span>
        </div>
        <span className="terminal-status">{status}</span>
      </div>
      <div ref={hostRef} className="terminal-host" />
      <pre className="terminal-transcript" data-testid="terminal-transcript" aria-live="polite">
        {transcript}
      </pre>
    </section>
  )
}

function appendTerminalTranscript(
  setTranscript: React.Dispatch<React.SetStateAction<string>>,
  data: string,
) {
  setTranscript((current) => `${current}${data}`.slice(-8_000))
}

function terminalWebSocketUrl(
  config: { host: string; port: number; path: string; token?: string },
  agentId: string,
  cols: number,
  rows: number,
) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const pageHost = window.location.hostname
  const isLocalPage = pageHost === 'localhost' || pageHost === '127.0.0.1' || pageHost === '::1'
  const host =
    !isLocalPage && (config.host === '127.0.0.1' || config.host === '0.0.0.0')
      ? pageHost
      : config.host
  const url = new URL(`${protocol}//${host}:${config.port}${config.path}`)
  url.searchParams.set('agentId', agentId)
  url.searchParams.set('cols', String(cols))
  url.searchParams.set('rows', String(rows))
  if (config.token) url.searchParams.set('token', config.token)
  return url.toString()
}

function terminalTheme(themeMode: ThemeMode) {
  if (themeMode === 'dark') {
    return {
      background: '#101216',
      foreground: '#e6e8ef',
      cursor: '#f5c15c',
      selectionBackground: '#334155',
    }
  }
  return {
    background: '#fbfaf7',
    foreground: '#1f2937',
    cursor: '#9a5b00',
    selectionBackground: '#d7e3ee',
  }
}
