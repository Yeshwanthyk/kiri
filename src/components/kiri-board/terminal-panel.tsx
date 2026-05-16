'use client'

import '@xterm/xterm/css/xterm.css'
import { useServerFn } from '@tanstack/react-start'
import { KeyboardOff } from 'lucide-react'
import * as React from 'react'
import type { AgentCell, ProjectRow, TerminalConfig, TerminalMode } from '~/lib/contracts'
import { terminalConfigQuery } from '~/server/workspace'
import type { ThemeMode } from '~/theme/kiri-themes'

type XTermTerminalInstance = InstanceType<(typeof import('@xterm/xterm'))['Terminal']>
type XTermFitAddonInstance = InstanceType<(typeof import('@xterm/addon-fit'))['FitAddon']>
type TerminalDisposable = { dispose: () => void }

export function TerminalPanel({
  agent,
  focusRequest,
  mode,
  project,
  themeMode,
  toggleFocusKey,
  visible,
}: {
  agent: AgentCell
  focusRequest: number
  mode: TerminalMode
  project: ProjectRow
  themeMode: ThemeMode
  toggleFocusKey: string
  visible: boolean
}) {
  const getTerminalConfig = useServerFn(terminalConfigQuery)
  const getTerminalConfigRef = React.useRef(getTerminalConfig)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const terminalRef = React.useRef<XTermTerminalInstance | null>(null)
  const fitAddonRef = React.useRef<XTermFitAddonInstance | null>(null)
  const themeModeRef = React.useRef(themeMode)
  const transcriptEnabledRef = React.useRef(false)
  const [status, setStatus] = React.useState('Connecting')
  const [transcript, setTranscript] = React.useState<string | null>(null)

  React.useEffect(() => {
    getTerminalConfigRef.current = getTerminalConfig
  }, [getTerminalConfig])

  React.useEffect(() => {
    themeModeRef.current = themeMode
  }, [themeMode])

  React.useEffect(() => {
    if (!visible) return
    fitAddonRef.current?.fit()
  }, [visible])

  React.useEffect(() => {
    if (focusRequest === 0 || !visible) return
    terminalRef.current?.focus()
  }, [focusRequest, visible])

  React.useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let term: XTermTerminalInstance | null = null
    let fitAddon: XTermFitAddonInstance | null = null
    let resizeObserver: ResizeObserver | null = null
    let pendingWrite = ''
    let writeFrame: number | null = null
    const terminalDisposables: TerminalDisposable[] = []

    function enqueueWrite(data: string) {
      if (!term) return
      pendingWrite += data
      if (writeFrame !== null) return
      writeFrame = window.requestAnimationFrame(() => {
        writeFrame = null
        const chunk = pendingWrite
        pendingWrite = ''
        term?.write(chunk)
      })
    }

    function appendTranscript(data: string) {
      if (!transcriptEnabledRef.current) return
      appendTerminalTranscript(setTranscript, data)
    }

    async function connect() {
      const host = hostRef.current
      if (!host) return
      host.textContent = ''
      transcriptEnabledRef.current = window.localStorage.getItem('kiri:terminal-transcript') === '1'
      setTranscript(transcriptEnabledRef.current ? '' : null)
      setStatus('Loading')

      try {
        const [{ Terminal }, { FitAddon }, terminalConfig] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          getTerminalConfigRef.current({ data: { agentId: agent.id, mode } }),
        ])
        if (disposed) return

        term = new Terminal({
          fontSize: 13,
          fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          cursorBlink: true,
          convertEol: true,
          scrollback: 1000,
          theme: terminalTheme(),
        })
        terminalRef.current = term
        fitAddon = new FitAddon()
        fitAddonRef.current = fitAddon
        term.loadAddon(fitAddon)
        term.open(host)
        term.attachCustomKeyEventHandler((event) => {
          if (isTerminalToggleFocusEvent(event, toggleFocusKey)) {
            term?.blur()
            return false
          }
          return true
        })
        fitAddon.fit()
        resizeObserver = new ResizeObserver(() => {
          fitAddon?.fit()
          if (socket?.readyState === WebSocket.OPEN && term) {
            socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          }
        })
        resizeObserver.observe(host)

        const url = terminalWebSocketUrl(terminalConfig, agent.id, term.cols, term.rows)
        socket = new WebSocket(url)
        socket.onopen = () => {
          if (!term || !socket) return
          setStatus('Connected')
          socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          const banner = mode === 'runtime'
            ? `kiri agent terminal · ${terminalConfig.runtime} · ${terminalConfig.model} · ${project.cwd}\r\n\r\n`
            : `kiri shell terminal · ${project.cwd}\r\n\r\n`
          enqueueWrite(banner)
          appendTranscript(banner)
        }
        socket.onmessage = (event) => {
          if (typeof event.data === 'string') {
            enqueueWrite(event.data)
            appendTranscript(event.data)
          }
        }
        socket.onclose = () => {
          if (!disposed) {
            setStatus('Closed')
            appendTranscript('\r\n[kiri terminal socket closed]\r\n')
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
      if (writeFrame !== null) window.cancelAnimationFrame(writeFrame)
      resizeObserver?.disconnect()
      for (const disposable of terminalDisposables) {
        disposable.dispose()
      }
      fitAddon?.dispose()
      fitAddonRef.current = null
      terminalRef.current = null
      transcriptEnabledRef.current = false
      term?.dispose()
    }
  }, [agent.id, mode, project.cwd, toggleFocusKey])

  const label = mode === 'runtime' ? 'Agent terminal' : 'Shell terminal'
  const toggleFocusLabel = `Toggle terminal focus (Shift+${formatTerminalKey(toggleFocusKey)})`
  return (
    <section className="terminal-panel" data-testid="terminal-panel" hidden={!visible}>
      <div className="terminal-header">
        <div>
          <strong>{label}</strong>
          <span>{project.cwd}</span>
          <span>{mode === 'runtime' ? `${agent.runtime} · ${agent.model}` : project.name}</span>
        </div>
        <div className="terminal-header-actions">
          <button
            type="button"
            aria-label={toggleFocusLabel}
            title={toggleFocusLabel}
            onClick={() => terminalRef.current?.blur()}
          >
            <KeyboardOff size={13} aria-hidden="true" />
          </button>
          <span className="terminal-status">{status}</span>
        </div>
      </div>
      <div ref={hostRef} className="terminal-host" />
      {transcript !== null ? (
        <pre className="terminal-transcript" data-testid="terminal-transcript" aria-live="polite">
          {transcript}
        </pre>
      ) : null}
    </section>
  )
}

function isTerminalToggleFocusEvent(event: KeyboardEvent, key: string) {
  return event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    terminalEventKey(event) === key
}

function terminalEventKey(event: KeyboardEvent) {
  return event.key.toLowerCase()
}

function formatTerminalKey(key: string) {
  if (key === 'tab') return 'Tab'
  if (key.startsWith('arrow')) return key.replace('arrow', 'Arrow ')
  return key.toUpperCase()
}

function appendTerminalTranscript(
  setTranscript: React.Dispatch<React.SetStateAction<string | null>>,
  data: string,
) {
  setTranscript((current) => `${current ?? ''}${data}`.slice(-8_000))
}

function terminalWebSocketUrl(
  config: TerminalConfig,
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
  url.searchParams.set('mode', config.mode)
  url.searchParams.set('cols', String(cols))
  url.searchParams.set('rows', String(rows))
  url.searchParams.set('token', config.token)
  return url.toString()
}

function terminalTheme() {
  return {
    background: '#101216',
    foreground: '#e6e8ef',
    cursor: '#f5c15c',
    cursorAccent: '#101216',
    selectionBackground: '#334155',
    black: '#101216',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#f5c15c',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#2dd4bf',
    white: '#e6e8ef',
    brightBlack: '#64748b',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#facc15',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#f8fafc',
  }
}
