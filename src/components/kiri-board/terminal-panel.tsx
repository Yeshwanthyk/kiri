'use client'

import '@xterm/xterm/css/xterm.css'
import { useServerFn } from '@tanstack/react-start'
import { KeyboardOff } from 'lucide-react'
import * as React from 'react'
import type { AgentCell, ProjectRow, TerminalConfig, TerminalMode } from '~/lib/contracts'
import { terminalConfigQuery } from '~/server/workspace'
import type { ThemeMode } from '~/theme/kiri-themes'
import {
  chatFontSizes,
  monoFonts,
  type ChatTypographySettings,
} from './storage'

type XTermTerminalInstance = InstanceType<(typeof import('@xterm/xterm'))['Terminal']>
type XTermFitAddonInstance = InstanceType<(typeof import('@xterm/addon-fit'))['FitAddon']>
type TerminalDisposable = { dispose: () => void }
const wheelDeltaPixel = 0
const wheelDeltaLine = 1
const wheelDeltaPage = 2
const terminalScrollbackRows = 10_000

type TerminalDebugSnapshot = {
  readonly bufferType: 'normal' | 'alternate'
  readonly baseY: number
  readonly viewportY: number
  readonly length: number
  readonly replayBytes: number
  readonly clearScrollbackCount: number
  readonly resetCount: number
  readonly alternateEnterCount: number
  readonly alternateExitCount: number
}

export function TerminalPanel({
  agent,
  focusRequest,
  mode,
  project,
  themeMode,
  toggleFocusKey,
  typography,
  visible,
}: {
  agent: AgentCell
  focusRequest: number
  mode: TerminalMode
  project: ProjectRow
  themeMode: ThemeMode
  toggleFocusKey: string
  typography: ChatTypographySettings
  visible: boolean
}) {
  const getTerminalConfig = useServerFn(terminalConfigQuery)
  const getTerminalConfigRef = React.useRef(getTerminalConfig)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const terminalRef = React.useRef<XTermTerminalInstance | null>(null)
  const fitAddonRef = React.useRef<XTermFitAddonInstance | null>(null)
  const themeModeRef = React.useRef(themeMode)
  const typographyRef = React.useRef(typography)
  const transcriptEnabledRef = React.useRef(false)
  const previousVisibleRef = React.useRef(visible)
  const debugEnabledRef = React.useRef(false)
  const replayBytesRef = React.useRef(0)
  const firstPayloadSeenRef = React.useRef(false)
  const sequenceCountsRef = React.useRef({
    clearScrollback: 0,
    reset: 0,
    alternateEnter: 0,
    alternateExit: 0,
  })
  const [status, setStatus] = React.useState('Connecting')
  const [transcript, setTranscript] = React.useState<string | null>(null)
  const [connectionGeneration, setConnectionGeneration] = React.useState(0)
  const [debugSnapshot, setDebugSnapshot] = React.useState<TerminalDebugSnapshot | null>(null)

  React.useEffect(() => {
    getTerminalConfigRef.current = getTerminalConfig
  }, [getTerminalConfig])

  React.useEffect(() => {
    themeModeRef.current = themeMode
  }, [themeMode])

  React.useEffect(() => {
    typographyRef.current = typography
    const term = terminalRef.current
    if (!term) return
    applyTerminalTypography(term, typography)
    fitAddonRef.current?.fit()
  }, [typography])

  React.useEffect(() => {
    if (!visible) return
    fitAddonRef.current?.fit()
  }, [visible])

  React.useEffect(() => {
    const wasVisible = previousVisibleRef.current
    previousVisibleRef.current = visible
    if (!wasVisible && visible && status === 'Closed') {
      setStatus('Connecting')
      setConnectionGeneration((generation) => generation + 1)
    }
  }, [status, visible])

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
    let debugFrame: number | null = null
    const terminalDisposables: TerminalDisposable[] = []

    function captureDebugSnapshot() {
      if (!debugEnabledRef.current || !term) return
      const buffer = term.buffer.active
      const counts = sequenceCountsRef.current
      setDebugSnapshot({
        bufferType: buffer.type,
        baseY: buffer.baseY,
        viewportY: buffer.viewportY,
        length: buffer.length,
        replayBytes: replayBytesRef.current,
        clearScrollbackCount: counts.clearScrollback,
        resetCount: counts.reset,
        alternateEnterCount: counts.alternateEnter,
        alternateExitCount: counts.alternateExit,
      })
    }

    function scheduleDebugSnapshot() {
      if (!debugEnabledRef.current || debugFrame !== null) return
      debugFrame = window.requestAnimationFrame(() => {
        debugFrame = null
        captureDebugSnapshot()
      })
    }

    function enqueueWrite(data: string) {
      if (!term) return
      pendingWrite += data
      if (writeFrame !== null) return
      writeFrame = window.requestAnimationFrame(() => {
        writeFrame = null
        const chunk = pendingWrite
        pendingWrite = ''
        term?.write(chunk, scheduleDebugSnapshot)
      })
    }

    function recordTerminalPayload(data: string) {
      if (!debugEnabledRef.current) return
      if (!firstPayloadSeenRef.current) {
        firstPayloadSeenRef.current = true
        replayBytesRef.current = data.length
      }
      const counts = sequenceCountsRef.current
      counts.clearScrollback += countOccurrences(data, '\x1b[3J')
      counts.reset += countOccurrences(data, '\x1bc')
      counts.alternateEnter += countOccurrences(data, '\x1b[?1049h')
      counts.alternateExit += countOccurrences(data, '\x1b[?1049l')
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
      debugEnabledRef.current = window.localStorage.getItem('kiri:terminal-debug') === '1'
      replayBytesRef.current = 0
      firstPayloadSeenRef.current = false
      sequenceCountsRef.current = {
        clearScrollback: 0,
        reset: 0,
        alternateEnter: 0,
        alternateExit: 0,
      }
      setDebugSnapshot(null)
      setTranscript(transcriptEnabledRef.current ? '' : null)
      setStatus('Loading')

      try {
        const [{ Terminal }, { FitAddon }, terminalConfig] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          getTerminalConfigRef.current({ data: { agentId: agent.id, mode } }),
        ])
        if (disposed) return

        const typographyOptions = terminalTypographyOptions(typographyRef.current)
        term = new Terminal({
          fontSize: typographyOptions.fontSize,
          fontFamily: typographyOptions.fontFamily,
          cursorBlink: true,
          convertEol: true,
          scrollback: terminalScrollbackRows,
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
        term.attachCustomWheelEventHandler((event) => {
          if (!terminalShouldCustomScrollWheel(term?.buffer.active)) return true
          const lines = terminalWheelScrollLines(event)
          if (lines === 0) return true
          event.preventDefault()
          event.stopPropagation()
          term?.scrollLines(lines)
          return false
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
            recordTerminalPayload(event.data)
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
          term.onScroll(() => {
            scheduleDebugSnapshot()
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
      if (debugFrame !== null) window.cancelAnimationFrame(debugFrame)
      resizeObserver?.disconnect()
      for (const disposable of terminalDisposables) {
        disposable.dispose()
      }
      fitAddon?.dispose()
      fitAddonRef.current = null
      terminalRef.current = null
      transcriptEnabledRef.current = false
      debugEnabledRef.current = false
      term?.dispose()
    }
  }, [agent.id, connectionGeneration, mode, project.cwd, toggleFocusKey])

  const label = mode === 'runtime' ? 'Agent terminal' : 'Shell terminal'
  const toggleFocusLabel = `Toggle terminal focus (Shift+${formatTerminalKey(toggleFocusKey)})`
  return (
    <section
      className="terminal-panel"
      data-terminal-mode={mode}
      data-testid={visible ? 'terminal-panel' : undefined}
      data-terminal-buffer-type={debugSnapshot?.bufferType}
      data-terminal-base-y={debugSnapshot?.baseY}
      data-terminal-viewport-y={debugSnapshot?.viewportY}
      data-terminal-buffer-length={debugSnapshot?.length}
      data-terminal-replay-bytes={debugSnapshot?.replayBytes}
      data-terminal-clear-scrollback-count={debugSnapshot?.clearScrollbackCount}
      data-terminal-reset-count={debugSnapshot?.resetCount}
      data-terminal-alternate-enter-count={debugSnapshot?.alternateEnterCount}
      data-terminal-alternate-exit-count={debugSnapshot?.alternateExitCount}
      hidden={!visible}
    >
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
        <pre
          className="terminal-transcript"
          data-testid={visible ? 'terminal-transcript' : undefined}
          aria-live={visible ? 'polite' : 'off'}
        >
          {transcript}
        </pre>
      ) : null}
    </section>
  )
}

export function terminalTypographyOptions(settings: ChatTypographySettings) {
  const tokens = chatFontSizes[settings.fontSize]
  return {
    fontSize: Number.parseInt(tokens.size, 10),
    fontFamily: monoFonts[settings.monoFont].stack,
  }
}

function applyTerminalTypography(
  term: XTermTerminalInstance,
  settings: ChatTypographySettings,
) {
  const options = terminalTypographyOptions(settings)
  term.options.fontSize = options.fontSize
  term.options.fontFamily = options.fontFamily
}

export function terminalWheelScrollLines(event: Pick<WheelEvent, 'deltaMode' | 'deltaY'>) {
  if (event.deltaY === 0) return 0
  const magnitude = Math.abs(event.deltaY)
  const lines = event.deltaMode === wheelDeltaPage
    ? 10
    : event.deltaMode === wheelDeltaLine
      ? Math.ceil(magnitude)
      : Math.ceil(magnitude / 40)
  return Math.sign(event.deltaY) * Math.max(1, lines)
}

export function terminalShouldCustomScrollWheel(
  buffer: { readonly type: 'normal' | 'alternate'; readonly baseY: number } | undefined,
) {
  return buffer?.type === 'normal' && buffer.baseY > 0
}

function countOccurrences(value: string, pattern: string) {
  let count = 0
  let index = value.indexOf(pattern)
  while (index !== -1) {
    count += 1
    index = value.indexOf(pattern, index + pattern.length)
  }
  return count
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
