'use client'

import { useServerFn } from '@tanstack/react-start'
import { Columns2, KeyboardOff, Plus } from 'lucide-react'
import * as React from 'react'
import type { AgentCell, ProjectRow, TerminalConfig, TerminalMode } from '~/lib/contracts'
import { terminalConfigQuery } from '~/server/workspace'
import type { ThemeMode } from '~/theme/kiri-themes'
import {
  chatFontSizes,
  monoFonts,
  type ChatTypographySettings,
} from './storage'

const wheelDeltaPixel = 0
const wheelDeltaLine = 1
const wheelDeltaPage = 2
const fallbackCols = 100
const fallbackRows = 30
const mainTerminalInstanceId = 'main'
const maxRenderedHistoryRows = 800
const initialDebugSnapshot = terminalDebugSnapshot(emptySnapshot(fallbackCols, fallbackRows), null)

type TerminalSnapshot = {
  readonly cols: number
  readonly rows: number
  readonly screenSeq: number
  readonly historySeq: number
  readonly bufferKind: 'main' | 'alternate'
  readonly cursor: TerminalCursor
  readonly modes: TerminalModes
  readonly viewport: TerminalViewport
  readonly historyRows: readonly TerminalHistoryRow[]
  readonly rowsData: readonly TerminalRow[]
}

type TerminalCursor = {
  readonly row: number
  readonly col: number
  readonly visible: boolean
}

type TerminalModes = {
  readonly bracketedPaste: boolean
  readonly cursorVisible: boolean
}

type TerminalViewport = {
  readonly historyOffset: number
  readonly visibleRows: number
}

type TerminalHistoryRow = {
  readonly id: number
  readonly row: TerminalRow
}

type TerminalRow = {
  readonly row: number
  readonly runs: readonly CellRun[]
  readonly fingerprint: number
}

type CellRun = {
  readonly text: string
  readonly width: number
  readonly style: TerminalCellStyle
}

type TerminalCellStyle = {
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly inverse?: boolean
  readonly foreground?: TerminalColor | null
  readonly background?: TerminalColor | null
}

type TerminalColor =
  | { readonly kind: 'palette'; readonly index: number }
  | { readonly kind: 'rgb'; readonly r: number; readonly g: number; readonly b: number }

type TerminalFrame =
  | { readonly type: 'snapshot'; readonly terminalId: string; readonly snapshot: TerminalSnapshot }
  | { readonly type: 'patch'; readonly terminalId: string; readonly patch: TerminalFramePatch }
  | { readonly type: 'status'; readonly terminalId: string; readonly status: string }
  | { readonly type: 'error'; readonly terminalId?: string | null; readonly message: string }

type TerminalFramePatch = {
  readonly cols: number
  readonly rows: number
  readonly screenSeq: number
  readonly historySeq: number
  readonly historyDelta?: {
    readonly historySeq: number
    readonly trimmed: number
    readonly rows: readonly TerminalHistoryRow[]
  } | null
  readonly ops: readonly TerminalPatchOp[]
}

type TerminalPatchOp =
  | { readonly op: 'replaceRow'; readonly row: TerminalRow }
  | { readonly op: 'replaceCells'; readonly row: number; readonly col: number; readonly runs: readonly CellRun[] }
  | { readonly op: 'insertRows'; readonly row: number; readonly count: number }
  | { readonly op: 'deleteRows'; readonly row: number; readonly count: number }
  | { readonly op: 'setSize'; readonly cols: number; readonly rows: number }
  | { readonly op: 'setCursor'; readonly cursor: TerminalCursor }
  | { readonly op: 'setModes'; readonly modes: TerminalModes }
  | { readonly op: 'setBufferKind'; readonly bufferKind: 'main' | 'alternate' }
  | { readonly op: 'setViewport'; readonly viewport: TerminalViewport }
  | { readonly op: 'reset' }

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

type GetTerminalConfig = (input: {
  readonly data: {
    readonly agentId: string
    readonly mode: TerminalMode
  }
}) => Promise<TerminalConfig>

export function TerminalPanel({
  agent,
  focusRequest,
  mode,
  project,
  themeMode: _themeMode,
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
  const getTerminalConfig = useServerFn(terminalConfigQuery) as GetTerminalConfig
  const [tabs, setTabs] = React.useState<readonly TerminalTabState[]>(() => [initialTerminalTab(labelForMode(mode))])
  const [activeTabId, setActiveTabId] = React.useState(mainTerminalInstanceId)
  const [paneStatuses, setPaneStatuses] = React.useState<Readonly<Record<string, string>>>({})
  const [paneDebugSnapshots, setPaneDebugSnapshots] = React.useState<Readonly<Record<string, TerminalDebugSnapshot>>>({})

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? initialTerminalTab(labelForMode(mode))

  const label = mode === 'runtime' ? 'Agent terminal' : 'Shell terminal'
  const activePaneId = activeTab.paneIds[0] ?? mainTerminalInstanceId
  const status = paneStatuses[activePaneId] ?? 'Connecting'
  const debugSnapshot = paneDebugSnapshots[activePaneId] ?? initialDebugSnapshot
  const toggleFocusLabel = `Release terminal focus (${formatTerminalKey(toggleFocusKey)})`
  const typographyOptions = terminalTypographyOptions(typography)
  const handlePaneStatusChange = React.useCallback((paneId: string, nextStatus: string) => {
    setPaneStatuses((current) => current[paneId] === nextStatus
      ? current
      : { ...current, [paneId]: nextStatus })
  }, [])
  const handlePaneDebugChange = React.useCallback((paneId: string, nextDebugSnapshot: TerminalDebugSnapshot) => {
    setPaneDebugSnapshots((current) => terminalDebugSnapshotsEqual(current[paneId], nextDebugSnapshot)
      ? current
      : { ...current, [paneId]: nextDebugSnapshot })
  }, [])
  const addTab = React.useCallback(() => {
    const id = `tab-${Date.now().toString(36)}`
    setTabs((current) => [...current, { id, title: `Term ${current.length + 1}`, paneIds: [id] }])
    setActiveTabId(id)
  }, [])
  const splitPane = React.useCallback(() => {
    const id = `pane-${Date.now().toString(36)}`
    setTabs((current) => current.map((tab) => tab.id === activeTab.id
      ? { ...tab, paneIds: [...tab.paneIds, id] }
      : tab))
  }, [activeTab.id])

  return (
    <section
      className="terminal-panel"
      data-terminal-mode={mode}
      data-terminal-buffer-type={debugSnapshot.bufferType}
      data-terminal-base-y={debugSnapshot.baseY}
      data-terminal-viewport-y={debugSnapshot.viewportY}
      data-terminal-buffer-length={debugSnapshot.length}
      data-terminal-replay-bytes={debugSnapshot.replayBytes}
      data-terminal-clear-scrollback-count={debugSnapshot.clearScrollbackCount}
      data-terminal-reset-count={debugSnapshot.resetCount}
      data-terminal-alternate-enter-count={debugSnapshot.alternateEnterCount}
      data-terminal-alternate-exit-count={debugSnapshot.alternateExitCount}
      data-terminal-pane-count={activeTab.paneIds.length}
      data-testid={visible ? 'terminal-panel' : undefined}
      hidden={!visible}
    >
      <div className="terminal-header">
        <div>
          <strong>{label}</strong>
          <span>{project.cwd}</span>
          <span>{mode === 'runtime' ? `${agent.runtime} · ${agent.model}` : project.name}</span>
        </div>
        <div className="terminal-header-actions">
          <button type="button" aria-label="New terminal tab" title="New terminal tab" data-testid="terminal-new-tab" onClick={addTab}>
            <Plus size={13} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Split terminal pane" title="Split terminal pane" data-testid="terminal-split-pane" onClick={splitPane}>
            <Columns2 size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={toggleFocusLabel}
            title={toggleFocusLabel}
            onClick={() => document.activeElement instanceof HTMLElement && document.activeElement.blur()}
          >
            <KeyboardOff size={13} aria-hidden="true" />
          </button>
          <span className="terminal-status">{status}</span>
        </div>
      </div>
      <div className="terminal-tabs" role="tablist" aria-label={`${label} tabs`}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab.id}
            data-testid="terminal-tab"
            onClick={() => setActiveTabId(tab.id)}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <div
        className="terminal-pane-grid"
        data-terminal-pane-count={activeTab.paneIds.length}
      >
        {activeTab.paneIds.map((paneId) => (
          <TerminalPane
            key={`${agent.id}-${mode}-${paneId}`}
            agent={agent}
            focusRequest={focusRequest}
            getTerminalConfig={getTerminalConfig}
            instanceId={paneId}
            label={label}
            mode={mode}
            onDebugChange={handlePaneDebugChange}
            onStatusChange={handlePaneStatusChange}
            project={project}
            toggleFocusKey={toggleFocusKey}
            typographyOptions={typographyOptions}
            visible={visible}
          />
        ))}
      </div>
    </section>
  )
}

type TerminalTabState = {
  readonly id: string
  readonly title: string
  readonly paneIds: readonly string[]
}

function labelForMode(mode: TerminalMode) {
  return mode === 'runtime' ? 'Agent' : 'Shell'
}

function initialTerminalTab(title: string): TerminalTabState {
  return {
    id: mainTerminalInstanceId,
    title,
    paneIds: [mainTerminalInstanceId],
  }
}

function TerminalPane({
  agent,
  focusRequest,
  getTerminalConfig,
  instanceId,
  label,
  mode,
  onDebugChange,
  onStatusChange,
  project,
  toggleFocusKey,
  typographyOptions,
  visible,
}: {
  readonly agent: AgentCell
  readonly focusRequest: number
  readonly getTerminalConfig: GetTerminalConfig
  readonly instanceId: string
  readonly label: string
  readonly mode: TerminalMode
  readonly onDebugChange: (paneId: string, debug: TerminalDebugSnapshot) => void
  readonly onStatusChange: (paneId: string, status: string) => void
  readonly project: ProjectRow
  readonly toggleFocusKey: string
  readonly typographyOptions: ReturnType<typeof terminalTypographyOptions>
  readonly visible: boolean
}) {
  const getTerminalConfigRef = React.useRef(getTerminalConfig)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const socketRef = React.useRef<WebSocket | null>(null)
  const transcriptEnabledRef = React.useRef(false)
  const lineBufferRef = React.useRef('')
  const previousVisibleRef = React.useRef(visible)
  const [connectionGeneration, setConnectionGeneration] = React.useState(0)
  const [status, setStatus] = React.useState('Connecting')
  const [transcript, setTranscript] = React.useState<string | null>(null)
  const [snapshot, setSnapshot] = React.useState<TerminalSnapshot>(() => emptySnapshot(fallbackCols, fallbackRows))
  const debugSnapshot = terminalDebugSnapshot(snapshot, transcript)

  React.useEffect(() => {
    onStatusChange(instanceId, status)
  }, [instanceId, onStatusChange, status])

  React.useEffect(() => {
    onDebugChange(instanceId, debugSnapshot)
  }, [debugSnapshot, instanceId, onDebugChange])

  React.useEffect(() => {
    getTerminalConfigRef.current = getTerminalConfig
  }, [getTerminalConfig])

  React.useEffect(() => {
    if (focusRequest === 0 || !visible) return
    hostRef.current?.focus()
  }, [focusRequest, visible])

  React.useEffect(() => {
    if (!visible) return
    sendResize(socketRef.current, terminalSizeFromHost(hostRef.current))
  }, [visible])

  React.useEffect(() => {
    const wasVisible = previousVisibleRef.current
    previousVisibleRef.current = visible
    if (!wasVisible && visible && status === 'Closed') {
      setConnectionGeneration((generation) => generation + 1)
    }
  }, [status, visible])

  React.useEffect(() => {
    let disposed = false
    let resizeObserver: ResizeObserver | null = null
    transcriptEnabledRef.current = window.localStorage.getItem('kiri:terminal-transcript') === '1'
    setTranscript(transcriptEnabledRef.current ? '' : null)
    setSnapshot(emptySnapshot(fallbackCols, fallbackRows))
    setStatus('Loading')
    lineBufferRef.current = ''

    async function connect() {
      try {
        const terminalConfig = await getTerminalConfigRef.current({ data: { agentId: agent.id, mode } })
        if (disposed) return
        const host = hostRef.current
        const size = terminalSizeFromHost(host)
        const url = terminalWebSocketUrl(terminalConfig, agent.id, size.cols, size.rows, instanceId)
        const socket = new WebSocket(url)
        socketRef.current = socket
        socket.onopen = () => {
          if (disposed) return
          setStatus('Connected')
          const banner = mode === 'runtime'
            ? `kiri agent terminal · ${terminalConfig.runtime} · ${terminalConfig.model} · ${project.cwd}\n`
            : `kiri shell terminal · ${project.cwd}\n`
          appendTranscript(setTranscript, transcriptEnabledRef.current, banner)
          sendResize(socket, terminalSizeFromHost(hostRef.current))
        }
        socket.onmessage = (event) => {
          if (typeof event.data !== 'string') return
          const frames = parseTerminalFrames(event.data, lineBufferRef)
          appendTranscript(setTranscript, transcriptEnabledRef.current, terminalTranscriptText(frames))
          for (const frame of frames) {
            applyFrame(frame, setSnapshot, setStatus)
          }
        }
        socket.onclose = () => {
          if (!disposed) {
            setStatus('Closed')
            appendTranscript(setTranscript, transcriptEnabledRef.current, '\n[kiri terminal socket closed]\n')
          }
        }
        socket.onerror = () => {
          if (!disposed) setStatus('Connection failed')
        }
        resizeObserver = new ResizeObserver(() => {
          sendResize(socket, terminalSizeFromHost(hostRef.current))
        })
        if (host) resizeObserver.observe(host)
      } catch (error) {
        if (disposed) return
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }

    void connect()

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      const socket = socketRef.current
      socketRef.current = null
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onclose = null
        socket.onerror = null
        socket.close()
      }
    }
  }, [agent.id, connectionGeneration, instanceId, mode, project.cwd])

  return (
    <div
      className="terminal-pane"
      data-terminal-buffer-type={debugSnapshot.bufferType}
      data-terminal-base-y={debugSnapshot.baseY}
      data-terminal-viewport-y={debugSnapshot.viewportY}
      data-terminal-buffer-length={debugSnapshot.length}
      data-terminal-replay-bytes={debugSnapshot.replayBytes}
      data-terminal-clear-scrollback-count={debugSnapshot.clearScrollbackCount}
      data-terminal-reset-count={debugSnapshot.resetCount}
      data-terminal-alternate-enter-count={debugSnapshot.alternateEnterCount}
      data-terminal-alternate-exit-count={debugSnapshot.alternateExitCount}
    >
      <div className="terminal-pane-status">{status}</div>
      <div
        ref={hostRef}
        className="terminal-host kiri-terminal-host"
        data-testid={visible ? 'terminal-host' : undefined}
        role="textbox"
        tabIndex={0}
        aria-label="Terminal input"
        style={{
          fontSize: typographyOptions.fontSize,
          fontFamily: typographyOptions.fontFamily,
        }}
        onKeyDown={(event) => {
          if (isTerminalToggleFocusEvent(event, toggleFocusKey)) {
            hostRef.current?.blur()
            event.preventDefault()
            event.stopPropagation()
            return
          }
          const data = terminalKeyData(event)
          if (!data) return
          event.preventDefault()
          event.stopPropagation()
          sendInput(socketRef.current, data)
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData('text')
          if (!text) return
          event.preventDefault()
          event.stopPropagation()
          sendPaste(socketRef.current, text, false)
        }}
      >
        <TerminalRows snapshot={snapshot} />
      </div>
      {transcript !== null ? (
        <pre
          className="terminal-transcript"
          data-testid={visible ? 'terminal-transcript' : undefined}
          aria-live={visible ? 'polite' : 'off'}
        >
          {transcript}
        </pre>
      ) : null}
    </div>
  )
}

function TerminalRows({ snapshot }: { readonly snapshot: TerminalSnapshot }) {
  return (
    <div
      className="terminal-screen"
      data-cols={snapshot.cols}
      data-rows={snapshot.rows}
    >
      {renderedTerminalRows(snapshot).map(({ key, row, screenRow }) => (
        <div
          key={key}
          className="terminal-row"
          data-row={row.row}
        >
          {row.runs.length === 0 ? '\u00a0' : row.runs.map((run, index) => (
            <span
              key={`${row.row}-${index}`}
              className="terminal-run"
              style={runStyle(run.style)}
            >
              {run.text}
            </span>
          ))}
          {snapshot.cursor.visible && screenRow === snapshot.cursor.row ? (
            <span
              className="terminal-cursor"
              style={{ left: `${snapshot.cursor.col}ch` }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}

function renderedTerminalRows(snapshot: TerminalSnapshot) {
  return [
    ...snapshot.historyRows.map((historyRow) => ({
      key: `history-${historyRow.id}`,
      row: historyRow.row,
      screenRow: null,
    })).slice(-maxRenderedHistoryRows),
    ...snapshot.rowsData.map((row) => ({
      key: `screen-${row.row}`,
      row,
      screenRow: row.row,
    })),
  ]
}

export function terminalRenderedRowsForTests(snapshot: TerminalSnapshot) {
  return renderedTerminalRows(snapshot)
}

export function terminalTypographyOptions(settings: ChatTypographySettings) {
  const tokens = chatFontSizes[settings.fontSize]
  return {
    fontSize: Number.parseInt(tokens.size, 10),
    fontFamily: monoFonts[settings.monoFont].stack,
  }
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

export function applyTerminalFrameForTests(
  snapshot: TerminalSnapshot,
  frame: TerminalFrame,
) {
  if (frame.type === 'snapshot') return frame.snapshot
  if (frame.type === 'patch') return applyPatch(snapshot, frame.patch)
  return snapshot
}

export function parseTerminalFramesForTests(data: string, initialBuffer = '') {
  const buffer = { current: initialBuffer }
  return {
    frames: parseTerminalFrames(data, buffer),
    buffer: buffer.current,
  }
}

function applyFrame(
  frame: TerminalFrame,
  setSnapshot: React.Dispatch<React.SetStateAction<TerminalSnapshot>>,
  setStatus: React.Dispatch<React.SetStateAction<string>>,
) {
  if (frame.type === 'snapshot') {
    setSnapshot(frame.snapshot)
    return
  }
  if (frame.type === 'patch') {
    setSnapshot((current) => applyPatch(current, frame.patch))
    return
  }
  if (frame.type === 'status') {
    setStatus(frame.status === 'running' ? 'Connected' : frame.status)
    return
  }
  if (frame.type === 'error') setStatus(frame.message)
}

function terminalDebugSnapshot(
  snapshot: TerminalSnapshot,
  transcript: string | null,
): TerminalDebugSnapshot {
  return {
    bufferType: snapshot.bufferKind === 'alternate' ? 'alternate' : 'normal',
    baseY: snapshot.historyRows.length,
    viewportY: snapshot.viewport.historyOffset,
    length: snapshot.historyRows.length + snapshot.rowsData.length,
    replayBytes: transcript?.length ?? 0,
    clearScrollbackCount: 0,
    resetCount: 0,
    alternateEnterCount: snapshot.bufferKind === 'alternate' ? 1 : 0,
    alternateExitCount: 0,
  }
}

function terminalDebugSnapshotsEqual(
  left: TerminalDebugSnapshot | undefined,
  right: TerminalDebugSnapshot,
) {
  if (!left) return false
  return left.bufferType === right.bufferType &&
    left.baseY === right.baseY &&
    left.viewportY === right.viewportY &&
    left.length === right.length &&
    left.replayBytes === right.replayBytes &&
    left.clearScrollbackCount === right.clearScrollbackCount &&
    left.resetCount === right.resetCount &&
    left.alternateEnterCount === right.alternateEnterCount &&
    left.alternateExitCount === right.alternateExitCount
}

function applyPatch(snapshot: TerminalSnapshot, patch: TerminalFramePatch): TerminalSnapshot {
  let rowsData = [...snapshot.rowsData]
  let historyRows = [...snapshot.historyRows]
  let next: TerminalSnapshot = {
    ...snapshot,
    cols: patch.cols,
    rows: patch.rows,
    screenSeq: patch.screenSeq,
    historySeq: patch.historySeq,
  }
  if (patch.historyDelta) {
    historyRows = historyRows.slice(patch.historyDelta.trimmed)
    historyRows.push(...patch.historyDelta.rows)
  }
  for (const op of patch.ops) {
    switch (op.op) {
      case 'replaceRow':
        rowsData = replaceRow(rowsData, op.row)
        break
      case 'insertRows':
        rowsData.splice(op.row, 0, ...Array.from({ length: op.count }, (_, index) => emptyRow(op.row + index)))
        rowsData = reindexRows(rowsData)
        break
      case 'deleteRows':
        rowsData.splice(op.row, op.count)
        rowsData = reindexRows(rowsData)
        break
      case 'setSize':
        rowsData = reindexRows(rowsData.slice(0, op.rows))
        while (rowsData.length < op.rows) rowsData.push(emptyRow(rowsData.length))
        next = { ...next, cols: op.cols, rows: op.rows }
        break
      case 'setCursor':
        next = { ...next, cursor: op.cursor }
        break
      case 'setModes':
        next = { ...next, modes: op.modes }
        break
      case 'setBufferKind':
        next = { ...next, bufferKind: op.bufferKind }
        break
      case 'setViewport':
        next = { ...next, viewport: op.viewport }
        break
      case 'reset':
        rowsData = Array.from({ length: patch.rows }, (_, row) => emptyRow(row))
        historyRows = []
        break
      case 'replaceCells':
        rowsData = replaceCells(rowsData, op.row, op.col, op.runs)
        break
    }
  }
  return { ...next, historyRows, rowsData }
}

function parseTerminalFrames(
  data: string,
  lineBufferRef: React.MutableRefObject<string>,
) {
  lineBufferRef.current += data
  const frames: TerminalFrame[] = []
  let newline = lineBufferRef.current.indexOf('\n')
  while (newline !== -1) {
    const line = lineBufferRef.current.slice(0, newline)
    lineBufferRef.current = lineBufferRef.current.slice(newline + 1)
    if (line.trim()) {
      try {
        frames.push(JSON.parse(line) as TerminalFrame)
      } catch {
        // Ignore non-frame output from old test doubles.
      }
    }
    newline = lineBufferRef.current.indexOf('\n')
  }
  return frames
}

function terminalTranscriptText(frames: readonly TerminalFrame[]) {
  return frames.map((frame) => {
    if (frame.type === 'snapshot') return rowsTranscript(frame.snapshot.historyRows.map((row) => row.row), frame.snapshot.rowsData)
    if (frame.type === 'patch') return frame.patch.ops
      .filter((op): op is Extract<TerminalPatchOp, { readonly op: 'replaceRow' }> => op.op === 'replaceRow')
      .map((op) => rowTranscript(op.row))
      .filter(Boolean)
      .join('\n')
    if (frame.type === 'status') return frame.status === 'running' ? '' : `[${frame.status}]`
    return `[error] ${frame.message}`
  }).filter(Boolean).join('\n')
}

function rowsTranscript(...rowGroups: readonly (readonly TerminalRow[])[]) {
  return rowGroups
    .flat()
    .map(rowTranscript)
    .filter(Boolean)
    .join('\n')
}

function rowTranscript(row: TerminalRow) {
  return row.runs.map((run) => run.text).join('').trimEnd()
}

function terminalKeyData(event: React.KeyboardEvent) {
  if (event.metaKey) return null
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0)
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
  }
  if (event.key.length === 1) return event.key
  switch (event.key) {
    case 'Enter': return '\r'
    case 'Backspace': return '\x7f'
    case 'Tab': return '\t'
    case 'Escape': return '\x1b'
    case 'ArrowUp': return '\x1b[A'
    case 'ArrowDown': return '\x1b[B'
    case 'ArrowRight': return '\x1b[C'
    case 'ArrowLeft': return '\x1b[D'
    default: return null
  }
}

function sendInput(socket: WebSocket | null, data: string) {
  if (socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'input', data }))
}

function sendPaste(socket: WebSocket | null, text: string, submit: boolean) {
  if (socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'paste', text, submit }))
}

function sendResize(socket: WebSocket | null, size: { readonly cols: number; readonly rows: number }) {
  if (socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }))
}

function terminalSizeFromHost(host: HTMLElement | null) {
  if (!host) return { cols: fallbackCols, rows: fallbackRows }
  const style = window.getComputedStyle(host)
  const fontSize = Number.parseFloat(style.fontSize) || 14
  const cols = Math.max(20, Math.floor(host.clientWidth / (fontSize * 0.62)))
  const rows = Math.max(6, Math.floor(host.clientHeight / (fontSize * 1.35)))
  return { cols, rows }
}

function terminalWebSocketUrl(
  config: TerminalConfig,
  agentId: string,
  cols: number,
  rows: number,
  instanceId: string,
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
  url.searchParams.set('instanceId', instanceId)
  url.searchParams.set('token', config.token)
  return url.toString()
}

function emptySnapshot(cols: number, rows: number): TerminalSnapshot {
  return {
    cols,
    rows,
    screenSeq: 0,
    historySeq: 0,
    bufferKind: 'main',
    cursor: { row: 0, col: 0, visible: true },
    modes: { bracketedPaste: false, cursorVisible: true },
    viewport: { historyOffset: 0, visibleRows: rows },
    historyRows: [],
    rowsData: Array.from({ length: rows }, (_, row) => emptyRow(row)),
  }
}

function emptyRow(row: number): TerminalRow {
  return { row, runs: [], fingerprint: 0 }
}

function replaceRow(rows: readonly TerminalRow[], row: TerminalRow) {
  const next = [...rows]
  while (next.length <= row.row) next.push(emptyRow(next.length))
  next[row.row] = row
  return next
}

function replaceCells(
  rows: readonly TerminalRow[],
  rowIndex: number,
  _col: number,
  runs: readonly CellRun[],
) {
  const existing = rows[rowIndex] ?? emptyRow(rowIndex)
  return replaceRow(rows, {
    ...existing,
    runs,
    fingerprint: runFingerprint(runs),
  })
}

function runFingerprint(runs: readonly CellRun[]) {
  let value = 5381
  for (const run of runs) {
    for (let index = 0; index < run.text.length; index += 1) {
      value = ((value << 5) + value) ^ run.text.charCodeAt(index)
    }
    value = ((value << 5) + value) ^ run.width
  }
  return value >>> 0
}

function reindexRows(rows: readonly TerminalRow[]) {
  return rows.map((row, index) => ({ ...row, row: index }))
}

function runStyle(style: TerminalCellStyle): React.CSSProperties {
  return {
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecoration: style.underline ? 'underline' : undefined,
    opacity: style.dim ? 0.68 : undefined,
    color: colorValue(style.inverse ? style.background : style.foreground),
    backgroundColor: colorValue(style.inverse ? style.foreground : style.background),
  }
}

function colorValue(color: TerminalColor | null | undefined) {
  if (!color) return undefined
  if (color.kind === 'rgb') return `rgb(${color.r} ${color.g} ${color.b})`
  return terminalPaletteColor(color.index)
}

export function terminalColorValueForTests(color: TerminalColor | null | undefined) {
  return colorValue(color)
}

function terminalPaletteColor(index: number) {
  if (index >= 0 && index < terminalPalette.length) return terminalPalette[index]
  if (index >= 16 && index <= 231) {
    const value = index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(value / 36)] ?? 0
    const g = steps[Math.floor((value % 36) / 6)] ?? 0
    const b = steps[value % 6] ?? 0
    return `rgb(${r} ${g} ${b})`
  }
  if (index >= 232 && index <= 255) {
    const level = 8 + ((index - 232) * 10)
    return `rgb(${level} ${level} ${level})`
  }
  return undefined
}

const terminalPalette = [
  '#101216',
  '#ef4444',
  '#22c55e',
  '#f5c15c',
  '#60a5fa',
  '#c084fc',
  '#2dd4bf',
  '#e6e8ef',
  '#64748b',
  '#f87171',
  '#4ade80',
  '#facc15',
  '#93c5fd',
  '#d8b4fe',
  '#67e8f9',
  '#f8fafc',
]

function isTerminalToggleFocusEvent(event: React.KeyboardEvent, key: string) {
  return event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    terminalEventKey(event) === key
}

function terminalEventKey(event: React.KeyboardEvent) {
  return event.key.toLowerCase()
}

function formatTerminalKey(key: string) {
  if (key === 'tab') return 'Tab'
  if (key.startsWith('arrow')) return key.replace('arrow', 'Arrow ')
  return key.toUpperCase()
}

function appendTranscript(
  setTranscript: React.Dispatch<React.SetStateAction<string | null>>,
  enabled: boolean,
  data: string,
) {
  if (!enabled) return
  setTranscript((current) => `${current ?? ''}${data}`.slice(-8_000))
}
