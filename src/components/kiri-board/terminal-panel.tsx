'use client'

import { useServerFn } from '@tanstack/react-start'
import { Columns2, KeyboardOff, Plus } from 'lucide-react'
import * as React from 'react'
import type { AgentCell, ProjectRow, SaveTerminalLayoutInput, TerminalConfig, TerminalLayout, TerminalMode } from '~/lib/contracts'
import { saveTerminalLayoutMutation, terminalConfigQuery } from '~/server/workspace'
import type { ThemeMode } from '~/theme/kiri-themes'
import {
  chatFontSizes,
  monoFonts,
  type ChatTypographySettings,
} from './storage'

const wheelDeltaLine = 1
const wheelDeltaPage = 2
const fallbackCols = 100
const fallbackRows = 30
const mainTerminalInstanceId = 'main'
const maxRenderedHistoryRows = 800
const terminalScrollBottomTolerance = 4
const terminalResizeDebounceMs = 90
const terminalMeasureSample = '0'.repeat(80)

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
  readonly mouseBasic?: boolean
  readonly mouseSgr?: boolean
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
  | { readonly type: 'metric'; readonly terminalId: string; readonly metric: TerminalMetric }
  | { readonly type: 'error'; readonly terminalId?: string | null; readonly message: string }

type TerminalMetric = {
  readonly name: string
  readonly value: number
  readonly unit: string
}

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
  readonly frameCount: number
  readonly patchCount: number
  readonly snapshotCount: number
  readonly metricCount: number
  readonly lastFrameType: string
  readonly lastFrameProcessMs: number
  readonly lastRenderedRows: number
  readonly lastMetricName: string
  readonly lastMetricValue: number
  readonly lastMetricUnit: string
}

type TerminalRuntimeMetrics = {
  readonly frameCount: number
  readonly patchCount: number
  readonly snapshotCount: number
  readonly metricCount: number
  readonly lastFrameType: string
  readonly lastFrameProcessMs: number
  readonly lastRenderedRows: number
  readonly lastMetricName: string
  readonly lastMetricValue: number
  readonly lastMetricUnit: string
}

type TerminalRenderMetrics = {
  readonly cellWidth: number
  readonly lineHeight: number
}

type TerminalHostMeasurement = TerminalRenderMetrics & {
  readonly cols: number
  readonly rows: number
}

const emptyRuntimeMetrics: TerminalRuntimeMetrics = {
  frameCount: 0,
  patchCount: 0,
  snapshotCount: 0,
  metricCount: 0,
  lastFrameType: '',
  lastFrameProcessMs: 0,
  lastRenderedRows: 0,
  lastMetricName: '',
  lastMetricValue: 0,
  lastMetricUnit: '',
}

const initialDebugSnapshot = terminalDebugSnapshot(emptySnapshot(fallbackCols, fallbackRows), null)

type GetTerminalConfig = (input: {
  readonly data: {
    readonly agentId: string
    readonly mode: TerminalMode
  }
}) => Promise<TerminalConfig>

type SaveTerminalLayout = (input: {
  readonly data: SaveTerminalLayoutInput
}) => Promise<unknown>

export function TerminalPanel({
  agent,
  focusRequest,
  mode,
  project,
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
  const saveTerminalLayout = useServerFn(saveTerminalLayoutMutation) as SaveTerminalLayout
  const saveTerminalLayoutRef = React.useRef(saveTerminalLayout)
  React.useEffect(() => {
    saveTerminalLayoutRef.current = saveTerminalLayout
  }, [saveTerminalLayout])
  const terminalOwnerKey = mode === 'runtime' ? `runtime:${agent.id}` : `shell:${project.id}`
  const storedLayout = (mode === 'runtime' ? agent.terminalLayout : project.terminalLayout) ?? null
  const storedLayoutKey = React.useMemo(() => JSON.stringify(storedLayout), [storedLayout])
  const persistedLayout = React.useMemo(
    () => terminalLayoutForMode(mode, agent, project),
    [mode, storedLayoutKey, terminalOwnerKey],
  )
  const persistedLayoutKey = React.useMemo(() => terminalLayoutKey(persistedLayout), [persistedLayout])
  const [layout, setLayout] = React.useState<TerminalLayout>(() => persistedLayout)
  const [paneStatuses, setPaneStatuses] = React.useState<Readonly<Record<string, string>>>({})
  const [paneDebugSnapshots, setPaneDebugSnapshots] = React.useState<Readonly<Record<string, TerminalDebugSnapshot>>>({})

  React.useEffect(() => {
    setLayout((current) => terminalLayoutKey(current) === persistedLayoutKey ? current : persistedLayout)
  }, [persistedLayout])

  React.useEffect(() => {
    if (terminalLayoutKey(layout) === persistedLayoutKey) return
    const timer = window.setTimeout(() => {
      const data = mode === 'runtime'
        ? { mode, agentId: agent.id, layout }
        : { mode, projectId: project.id, layout }
      void saveTerminalLayoutRef.current({ data })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [agent.id, layout, mode, persistedLayoutKey, project.id])

  const activeTab = layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? layout.tabs[0] ?? initialTerminalTab(labelForMode(mode))

  const label = mode === 'runtime' ? 'Agent terminal' : 'Shell terminal'
  const activePaneId = activeTab.activePaneId
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
    setLayout((current) => ({
      activeTabId: id,
      tabs: [...current.tabs, { id, title: `Term ${current.tabs.length + 1}`, activePaneId: id, paneIds: [id] }],
    }))
  }, [])
  const splitPane = React.useCallback(() => {
    const id = `pane-${Date.now().toString(36)}`
    setLayout((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => tab.id === activeTab.id
        ? { ...tab, activePaneId: id, paneIds: [...tab.paneIds, id] }
        : tab),
    }))
  }, [activeTab.id])
  const setActiveTabId = React.useCallback((tabId: string) => {
    setLayout((current) => current.activeTabId === tabId ? current : { ...current, activeTabId: tabId })
  }, [])
  const setActivePaneId = React.useCallback((paneId: string) => {
    setLayout((current) => {
      const active = current.tabs.find((tab) => tab.id === current.activeTabId)
      if (active?.activePaneId === paneId) return current
      return {
        ...current,
        tabs: current.tabs.map((tab) => tab.id === current.activeTabId
          ? { ...tab, activePaneId: paneId }
          : tab),
      }
    })
  }, [])

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
      data-terminal-frame-count={debugSnapshot.frameCount}
      data-terminal-patch-count={debugSnapshot.patchCount}
      data-terminal-snapshot-count={debugSnapshot.snapshotCount}
      data-terminal-metric-count={debugSnapshot.metricCount}
      data-terminal-last-frame-type={debugSnapshot.lastFrameType}
      data-terminal-last-frame-process-ms={debugSnapshot.lastFrameProcessMs.toFixed(3)}
      data-terminal-last-rendered-rows={debugSnapshot.lastRenderedRows}
      data-terminal-last-metric-name={debugSnapshot.lastMetricName}
      data-terminal-last-metric-value={debugSnapshot.lastMetricValue}
      data-terminal-last-metric-unit={debugSnapshot.lastMetricUnit}
      data-terminal-pane-count={activeTab.paneIds.length}
      data-terminal-active-tab-id={activeTab.id}
      data-terminal-active-pane-id={activePaneId}
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
        {layout.tabs.map((tab) => (
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
            active={paneId === activePaneId}
            focusRequest={focusRequest}
            getTerminalConfig={getTerminalConfig}
            instanceId={paneId}
            mode={mode}
            onDebugChange={handlePaneDebugChange}
            onFocusPane={setActivePaneId}
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
  id: string
  title: string
  activePaneId: string
  paneIds: string[]
}

function labelForMode(mode: TerminalMode) {
  return mode === 'runtime' ? 'Agent' : 'Shell'
}

function initialTerminalTab(title: string): TerminalTabState {
  return {
    id: mainTerminalInstanceId,
    title,
    activePaneId: mainTerminalInstanceId,
    paneIds: [mainTerminalInstanceId],
  }
}

function terminalLayoutForMode(
  mode: TerminalMode,
  agent: AgentCell,
  project: ProjectRow,
): TerminalLayout {
  return normalizeTerminalLayout(
    (mode === 'runtime' ? agent.terminalLayout : project.terminalLayout) ?? null,
    labelForMode(mode),
  )
}

function normalizeTerminalLayout(
  layout: TerminalLayout | null,
  title: string,
): TerminalLayout {
  if (!layout || layout.tabs.length === 0) {
    return { activeTabId: mainTerminalInstanceId, tabs: [initialTerminalTab(title)] }
  }
  const tabs = layout.tabs.map((tab, index) => {
    const paneIds = tab.paneIds.length > 0 ? [...new Set(tab.paneIds)] : [tab.id]
    const activePaneId = paneIds.includes(tab.activePaneId) ? tab.activePaneId : paneIds[0] ?? tab.id
    return {
      id: tab.id,
      title: tab.title || `Term ${index + 1}`,
      activePaneId,
      paneIds,
    }
  })
  const activeTabId = tabs.some((tab) => tab.id === layout.activeTabId)
    ? layout.activeTabId
    : tabs[0]?.id ?? mainTerminalInstanceId
  return { activeTabId, tabs }
}

function terminalLayoutKey(layout: TerminalLayout) {
  return JSON.stringify(layout)
}

function TerminalPane({
  agent,
  active,
  focusRequest,
  getTerminalConfig,
  instanceId,
  mode,
  onDebugChange,
  onFocusPane,
  onStatusChange,
  project,
  toggleFocusKey,
  typographyOptions,
  visible,
}: {
  readonly agent: AgentCell
  readonly active: boolean
  readonly focusRequest: number
  readonly getTerminalConfig: GetTerminalConfig
  readonly instanceId: string
  readonly mode: TerminalMode
  readonly onDebugChange: (paneId: string, debug: TerminalDebugSnapshot) => void
  readonly onFocusPane: (paneId: string) => void
  readonly onStatusChange: (paneId: string, status: string) => void
  readonly project: ProjectRow
  readonly toggleFocusKey: string
  readonly typographyOptions: ReturnType<typeof terminalTypographyOptions>
  readonly visible: boolean
}) {
  const getTerminalConfigRef = React.useRef(getTerminalConfig)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const socketRef = React.useRef<WebSocket | null>(null)
  const stickToBottomRef = React.useRef(true)
  const visibleRef = React.useRef(visible)
  const lastKnownSizeRef = React.useRef({ cols: fallbackCols, rows: fallbackRows })
  const renderMetricsRef = React.useRef<TerminalRenderMetrics>(fallbackTerminalRenderMetrics(typographyOptions.fontSize))
  const transcriptEnabledRef = React.useRef(false)
  const lineBufferRef = React.useRef('')
  const previousVisibleRef = React.useRef(visible)
  const [connectionGeneration, setConnectionGeneration] = React.useState(0)
  const [terminalFocused, setTerminalFocused] = React.useState(false)
  const [status, setStatus] = React.useState('Connecting')
  const [transcript, setTranscript] = React.useState<string | null>(null)
  const [snapshot, setSnapshot] = React.useState<TerminalSnapshot>(() => emptySnapshot(fallbackCols, fallbackRows))
  const [metrics, setMetrics] = React.useState<TerminalRuntimeMetrics>(emptyRuntimeMetrics)
  const [renderMetrics, setRenderMetrics] = React.useState<TerminalRenderMetrics>(() => renderMetricsRef.current)
  const debugSnapshot = terminalDebugSnapshot(snapshot, transcript, metrics)
  const syncRenderMetrics = React.useCallback((next: TerminalRenderMetrics) => {
    if (terminalRenderMetricsEqual(renderMetricsRef.current, next)) return
    renderMetricsRef.current = next
    setRenderMetrics(next)
  }, [])

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
    visibleRef.current = visible
  }, [visible])

  React.useEffect(() => {
    if (!visible) return
    const measurement = terminalVisibleMeasurementFromHost(hostRef.current)
    if (measurement) {
      syncRenderMetrics(measurement)
      lastKnownSizeRef.current = terminalSizeFromMeasurement(measurement)
      sendResize(socketRef.current, lastKnownSizeRef.current)
    }
    if (stickToBottomRef.current) scrollTerminalToBottomSoon(hostRef.current)
  }, [syncRenderMetrics, visible])

  React.useEffect(() => {
    if (!visible) return
    const measurement = terminalVisibleMeasurementFromHost(hostRef.current)
    if (!measurement) return
    syncRenderMetrics(measurement)
    lastKnownSizeRef.current = terminalSizeFromMeasurement(measurement)
    sendResize(socketRef.current, lastKnownSizeRef.current)
  }, [syncRenderMetrics, typographyOptions.fontFamily, typographyOptions.fontSize, visible])

  React.useLayoutEffect(() => {
    if (!visible || !stickToBottomRef.current) return
    scrollTerminalToBottomSoon(hostRef.current)
  }, [snapshot.bufferKind, snapshot.cols, snapshot.historySeq, snapshot.rows, snapshot.screenSeq, visible])

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
    let resizeAnimationFrame: number | null = null
    let resizeTimer: number | null = null
    let frameAnimationFrame: number | null = null
    let pendingFrameProcessMs = 0
    const pendingFrames: TerminalFrame[] = []
    let lastSentSize: { cols: number; rows: number } | null = null
    transcriptEnabledRef.current = window.localStorage.getItem('kiri:terminal-transcript') === '1'
    setTranscript(transcriptEnabledRef.current ? '' : null)
    setSnapshot(emptySnapshot(fallbackCols, fallbackRows))
    setMetrics(emptyRuntimeMetrics)
    setStatus('Loading')
    lineBufferRef.current = ''

    async function connect() {
      try {
        const terminalConfig = await getTerminalConfigRef.current({ data: { agentId: agent.id, mode } })
        if (disposed) return
        const host = hostRef.current
        const measurement = terminalVisibleMeasurementFromHost(host)
        if (measurement) syncRenderMetrics(measurement)
        const size = measurement ? terminalSizeFromMeasurement(measurement) : lastKnownSizeRef.current
        const url = terminalWebSocketUrl(terminalConfig, agent.id, size.cols, size.rows, instanceId)
        const socket = new WebSocket(url)
        socketRef.current = socket
        lastSentSize = size
        const deliverResize = (force = false) => {
          if (!visibleRef.current) return
          if (resizeAnimationFrame !== null) window.cancelAnimationFrame(resizeAnimationFrame)
          resizeAnimationFrame = window.requestAnimationFrame(() => {
            resizeAnimationFrame = null
            const measurement = terminalVisibleMeasurementFromHost(hostRef.current)
            if (!measurement) return
            syncRenderMetrics(measurement)
            const nextSize = terminalSizeFromMeasurement(measurement)
            lastKnownSizeRef.current = nextSize
            if (!force && terminalSizesEqual(lastSentSize, nextSize)) return
            if (sendResize(socket, nextSize)) lastSentSize = nextSize
          })
        }
        const scheduleResize = (force = false) => {
          if (force) {
            if (resizeTimer !== null) {
              window.clearTimeout(resizeTimer)
              resizeTimer = null
            }
            deliverResize(true)
            return
          }
          if (resizeTimer !== null) window.clearTimeout(resizeTimer)
          resizeTimer = window.setTimeout(() => {
            resizeTimer = null
            deliverResize(false)
          }, terminalResizeDebounceMs)
        }
        const flushFrames = () => {
          frameAnimationFrame = null
          const frames = pendingFrames.splice(0)
          const frameProcessMs = pendingFrameProcessMs
          pendingFrameProcessMs = 0
          if (frames.length === 0) return
          applyFrames(frames, setSnapshot, setStatus)
          recordTerminalFrames(setMetrics, frames, frameProcessMs)
        }
        const scheduleFrameFlush = () => {
          if (frameAnimationFrame !== null) return
          frameAnimationFrame = window.requestAnimationFrame(flushFrames)
        }
        socket.onopen = () => {
          if (disposed) return
          setStatus('Connected')
          const banner = mode === 'runtime'
            ? `kiri agent terminal · ${terminalConfig.runtime} · ${terminalConfig.model} · ${project.cwd}\n`
            : `kiri shell terminal · ${project.cwd}\n`
          appendTranscript(setTranscript, transcriptEnabledRef.current, banner)
          stickToBottomRef.current = true
          scheduleResize(true)
          scrollTerminalToBottomSoon(hostRef.current)
          void window.document.fonts?.ready.then(() => {
            if (!disposed) scheduleResize(true)
          })
        }
        socket.onmessage = (event) => {
          if (typeof event.data !== 'string') return
          const startedAt = performance.now()
          stickToBottomRef.current = stickToBottomRef.current || terminalHostIsNearBottom(hostRef.current)
          const frames = parseTerminalFrames(event.data, lineBufferRef)
          appendTranscript(setTranscript, transcriptEnabledRef.current, terminalTranscriptText(frames))
          pendingFrames.push(...frames)
          pendingFrameProcessMs += performance.now() - startedAt
          scheduleFrameFlush()
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
        resizeObserver = new ResizeObserver(() => scheduleResize())
        if (host) resizeObserver.observe(host)
      } catch (error) {
        if (disposed) return
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }

    void connect()

    return () => {
      disposed = true
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      if (resizeAnimationFrame !== null) window.cancelAnimationFrame(resizeAnimationFrame)
      if (frameAnimationFrame !== null) window.cancelAnimationFrame(frameAnimationFrame)
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
      data-terminal-frame-count={debugSnapshot.frameCount}
      data-terminal-patch-count={debugSnapshot.patchCount}
      data-terminal-snapshot-count={debugSnapshot.snapshotCount}
      data-terminal-metric-count={debugSnapshot.metricCount}
      data-terminal-last-frame-type={debugSnapshot.lastFrameType}
      data-terminal-last-frame-process-ms={debugSnapshot.lastFrameProcessMs.toFixed(3)}
      data-terminal-last-rendered-rows={debugSnapshot.lastRenderedRows}
      data-terminal-last-metric-name={debugSnapshot.lastMetricName}
      data-terminal-last-metric-value={debugSnapshot.lastMetricValue}
      data-terminal-last-metric-unit={debugSnapshot.lastMetricUnit}
      data-terminal-active={active ? 'true' : 'false'}
      data-testid={visible ? 'terminal-pane' : undefined}
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
          onFocusPane(instanceId)
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
          stickToBottomRef.current = true
          sendInput(socketRef.current, data)
          scrollTerminalToBottomSoon(hostRef.current)
        }}
        onPaste={(event) => {
          onFocusPane(instanceId)
          const text = event.clipboardData.getData('text')
          if (!text) return
          event.preventDefault()
          event.stopPropagation()
          stickToBottomRef.current = true
          sendPaste(socketRef.current, text, false)
          scrollTerminalToBottomSoon(hostRef.current)
        }}
        onWheel={(event) => {
          const host = hostRef.current
          if (!host || event.shiftKey) return
          const action = terminalWheelAction({
            deltaMode: event.deltaMode,
            deltaY: event.deltaY,
            mouseInput: terminalWheelMouseInput(event, host, snapshot, renderMetrics),
          })
          if (action.type === 'input') {
            event.preventDefault()
            event.stopPropagation()
            stickToBottomRef.current = true
            sendInput(socketRef.current, action.data)
            scrollTerminalToBottomSoon(host)
            return
          }
          if (action.type === 'none') return
          const before = host.scrollTop
          host.scrollTop += action.lines * terminalLineHeight(window.getComputedStyle(host).lineHeight, typographyOptions.fontSize)
          stickToBottomRef.current = terminalHostIsNearBottom(host)
          if (host.scrollTop !== before) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
        onScroll={() => {
          stickToBottomRef.current = terminalHostIsNearBottom(hostRef.current)
        }}
        onFocus={() => onFocusPane(instanceId)}
        onFocusCapture={() => setTerminalFocused(true)}
        onBlurCapture={() => setTerminalFocused(false)}
        onClick={() => onFocusPane(instanceId)}
      >
        <TerminalRows
          forceCursorVisible={active && terminalFocused}
          renderMetrics={renderMetrics}
          snapshot={snapshot}
        />
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

function TerminalRows({
  forceCursorVisible = false,
  renderMetrics,
  snapshot,
}: {
  readonly forceCursorVisible?: boolean
  readonly renderMetrics: TerminalRenderMetrics
  readonly snapshot: TerminalSnapshot
}) {
  const rows = React.useMemo(() => renderedTerminalRows(snapshot), [snapshot])
  const showCursor = terminalCursorShouldRender(snapshot.cursor, forceCursorVisible)
  return (
    <div
      className="terminal-screen"
      data-cols={snapshot.cols}
      data-rows={snapshot.rows}
      style={terminalScreenStyle(snapshot.cols, renderMetrics)}
    >
      {rows.map(({ key, row, screenRow }) => (
        <div
          key={key}
          className="terminal-row"
          data-row={row.row}
          data-terminal-underline-runs={terminalRowUnderlineRunCount(row)}
          data-terminal-underline-blank-runs={terminalRowUnderlineBlankRunCount(row)}
        >
          {showCursor && screenRow === snapshot.cursor.row
            ? terminalCursorRowParts(row.runs, snapshot.cursor.col).map((part, index) => part.kind === 'cursor' ? (
              <span
                key={`cursor-${index}`}
                className="terminal-cursor"
                data-terminal-inline-cursor="true"
                data-terminal-forced-cursor={!snapshot.cursor.visible ? 'true' : undefined}
                style={terminalInlineCursorStyle(renderMetrics)}
                aria-hidden="true"
              />
            ) : (
              <span
                key={`run-${index}`}
                className="terminal-run"
                style={cursorRowRunStyle(part.run)}
                data-terminal-underline={terminalRunHasVisibleUnderline(part.run) ? 'true' : undefined}
                data-terminal-blank-underline={terminalRunIsBlankUnderline(part.run) ? 'true' : undefined}
              >
                {part.run.text}
              </span>
            ))
            : row.runs.length === 0 ? '\u00a0' : row.runs.map((run, index) => (
              <span
                key={`${row.row}-${index}`}
                className="terminal-run"
                style={runStyle(run, renderMetrics)}
                data-terminal-underline={terminalRunHasVisibleUnderline(run) ? 'true' : undefined}
                data-terminal-blank-underline={terminalRunIsBlankUnderline(run) ? 'true' : undefined}
              >
                {run.text}
              </span>
            ))}
        </div>
      ))}
    </div>
  )
}

export function TerminalRowsForTests({ snapshot }: { readonly snapshot: TerminalSnapshot }) {
  return <TerminalRows renderMetrics={fallbackTerminalRenderMetrics(14)} snapshot={snapshot} />
}

function terminalCursorShouldRender(cursor: TerminalCursor, forceVisible: boolean) {
  return cursor.visible || forceVisible
}

export function terminalCursorShouldRenderForTests(cursor: TerminalCursor, forceVisible: boolean) {
  return terminalCursorShouldRender(cursor, forceVisible)
}

function renderedTerminalRows(snapshot: TerminalSnapshot) {
  return [
    ...snapshot.historyRows.slice(-maxRenderedHistoryRows).map((historyRow) => ({
      key: `history-${historyRow.id}`,
      row: historyRow.row,
      screenRow: null,
    })),
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

type TerminalWheelActionInput = Pick<WheelEvent, 'deltaMode' | 'deltaY'> & {
  readonly mouseInput: string | null
}

type TerminalWheelAction =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'scroll'; readonly lines: number }
  | { readonly type: 'none' }

export function terminalWheelActionForTests(input: TerminalWheelActionInput): TerminalWheelAction {
  return terminalWheelAction(input)
}

function terminalWheelAction(input: TerminalWheelActionInput): TerminalWheelAction {
  if (input.mouseInput !== null) return { type: 'input', data: input.mouseInput }
  const lines = terminalWheelScrollLines(input)
  return lines === 0 ? { type: 'none' } : { type: 'scroll', lines }
}

type TerminalWheelMouseInput = {
  readonly deltaY: number
  readonly clientX: number
  readonly clientY: number
  readonly hostRect: Pick<DOMRect, 'left' | 'top'>
  readonly paddingLeft: number
  readonly paddingTop: number
  readonly scrollTop: number
  readonly cellWidth: number
  readonly cols: number
  readonly rows: number
  readonly renderedHistoryRows: number
  readonly lineHeight: number
  readonly mouseBasic: boolean
  readonly mouseSgr: boolean
}

export function terminalWheelMouseInputForTests(input: TerminalWheelMouseInput) {
  return terminalWheelMouseSequence(input)
}

function terminalWheelMouseInput(
  event: React.WheelEvent,
  host: HTMLElement,
  snapshot: TerminalSnapshot,
  renderMetrics: TerminalRenderMetrics,
) {
  if (!snapshot.modes.mouseBasic) return null
  const style = window.getComputedStyle(host)
  return terminalWheelMouseSequence({
    deltaY: event.deltaY,
    clientX: event.clientX,
    clientY: event.clientY,
    hostRect: host.getBoundingClientRect(),
    paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
    paddingTop: Number.parseFloat(style.paddingTop) || 0,
    scrollTop: host.scrollTop,
    cellWidth: renderMetrics.cellWidth,
    cols: snapshot.cols,
    rows: snapshot.rows,
    renderedHistoryRows: snapshot.bufferKind === 'main'
      ? Math.min(snapshot.historyRows.length, maxRenderedHistoryRows)
      : 0,
    lineHeight: renderMetrics.lineHeight,
    mouseBasic: Boolean(snapshot.modes.mouseBasic),
    mouseSgr: Boolean(snapshot.modes.mouseSgr),
  })
}

function terminalWheelMouseSequence(input: TerminalWheelMouseInput) {
  if (!input.mouseBasic || input.deltaY === 0 || input.cols <= 0 || input.rows <= 0) return null
  const cellWidth = Math.max(1, input.cellWidth)
  const rowOffset = input.renderedHistoryRows * input.lineHeight
  const col = clampTerminalMouseCoord(
    Math.floor((input.clientX - input.hostRect.left - input.paddingLeft) / cellWidth) + 1,
    input.cols,
  )
  const row = clampTerminalMouseCoord(
    Math.floor((input.clientY - input.hostRect.top - input.paddingTop + input.scrollTop - rowOffset) / input.lineHeight) + 1,
    input.rows,
  )
  const button = input.deltaY < 0 ? 64 : 65
  if (input.mouseSgr) return `\x1b[<${button};${col};${row}M`
  const legacyMax = 223
  return `\x1b[M${String.fromCharCode(32 + button)}${String.fromCharCode(32 + Math.min(col, legacyMax))}${String.fromCharCode(32 + Math.min(row, legacyMax))}`
}

function clampTerminalMouseCoord(value: number, max: number) {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(1, value), Math.max(1, max))
}

export function applyTerminalFrameForTests(
  snapshot: TerminalSnapshot,
  frame: TerminalFrame,
) {
  if (frame.type === 'snapshot') return frame.snapshot
  if (frame.type === 'patch') return applyPatch(snapshot, frame.patch)
  return snapshot
}

export function applyTerminalFramesForTests(
  snapshot: TerminalSnapshot,
  frames: readonly TerminalFrame[],
) {
  return applyFramesToSnapshot(snapshot, frames)
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
  if (frame.type === 'metric') return
  if (frame.type === 'error') setStatus(frame.message)
}

function applyFrames(
  frames: readonly TerminalFrame[],
  setSnapshot: React.Dispatch<React.SetStateAction<TerminalSnapshot>>,
  setStatus: React.Dispatch<React.SetStateAction<string>>,
) {
  if (frames.some((frame) => frame.type === 'snapshot' || frame.type === 'patch')) {
    setSnapshot((current) => applyFramesToSnapshot(current, frames))
  }
  const status = terminalStatusFromFrames(frames)
  if (status) setStatus(status)
}

function applyFramesToSnapshot(
  snapshot: TerminalSnapshot,
  frames: readonly TerminalFrame[],
) {
  return frames.reduce(applyTerminalFrameForTests, snapshot)
}

function terminalStatusFromFrames(frames: readonly TerminalFrame[]) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]
    if (!frame) continue
    if (frame.type === 'status') return frame.status === 'running' ? 'Connected' : frame.status
    if (frame.type === 'error') return frame.message
  }
  return null
}

function recordTerminalFrames(
  setMetrics: React.Dispatch<React.SetStateAction<TerminalRuntimeMetrics>>,
  frames: readonly TerminalFrame[],
  frameProcessMs: number,
) {
  if (frames.length === 0) return
  const lastFrame = frames.at(-1)
  const lastMetric = [...frames].reverse()
    .find((frame): frame is Extract<TerminalFrame, { readonly type: 'metric' }> => frame.type === 'metric')
  const renderedRows = frames.reduce((count, frame) => {
    if (frame.type === 'snapshot') return count + frame.snapshot.rowsData.length + frame.snapshot.historyRows.length
    if (frame.type === 'patch') {
      return count + frame.patch.ops.filter((op) => op.op === 'replaceRow' || op.op === 'replaceCells').length
    }
    return count
  }, 0)
  setMetrics((current) => ({
    frameCount: current.frameCount + frames.length,
    patchCount: current.patchCount + frames.filter((frame) => frame.type === 'patch').length,
    snapshotCount: current.snapshotCount + frames.filter((frame) => frame.type === 'snapshot').length,
    metricCount: current.metricCount + frames.filter((frame) => frame.type === 'metric').length,
    lastFrameType: lastFrame?.type ?? current.lastFrameType,
    lastFrameProcessMs: Math.round(frameProcessMs * 1000) / 1000,
    lastRenderedRows: renderedRows,
    lastMetricName: lastMetric?.metric.name ?? current.lastMetricName,
    lastMetricValue: lastMetric?.metric.value ?? current.lastMetricValue,
    lastMetricUnit: lastMetric?.metric.unit ?? current.lastMetricUnit,
  }))
}

function terminalDebugSnapshot(
  snapshot: TerminalSnapshot,
  transcript: string | null,
  metrics: TerminalRuntimeMetrics = emptyRuntimeMetrics,
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
    frameCount: metrics.frameCount,
    patchCount: metrics.patchCount,
    snapshotCount: metrics.snapshotCount,
    metricCount: metrics.metricCount,
    lastFrameType: metrics.lastFrameType,
    lastFrameProcessMs: metrics.lastFrameProcessMs,
    lastRenderedRows: metrics.lastRenderedRows,
    lastMetricName: metrics.lastMetricName,
    lastMetricValue: metrics.lastMetricValue,
    lastMetricUnit: metrics.lastMetricUnit,
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
    left.alternateExitCount === right.alternateExitCount &&
    left.frameCount === right.frameCount &&
    left.patchCount === right.patchCount &&
    left.snapshotCount === right.snapshotCount &&
    left.metricCount === right.metricCount &&
    left.lastFrameType === right.lastFrameType &&
    left.lastFrameProcessMs === right.lastFrameProcessMs &&
    left.lastRenderedRows === right.lastRenderedRows &&
    left.lastMetricName === right.lastMetricName &&
    left.lastMetricValue === right.lastMetricValue &&
    left.lastMetricUnit === right.lastMetricUnit
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
    if (frame.type === 'metric') return ''
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
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }))
  return true
}

export function sendResizeForTests(
  socket: WebSocket | null,
  size: { readonly cols: number; readonly rows: number },
) {
  return sendResize(socket, size)
}

function terminalHostIsNearBottom(host: HTMLElement | null) {
  if (!host) return true
  return terminalScrollDistanceFromBottom({
    clientHeight: host.clientHeight,
    scrollHeight: host.scrollHeight,
    scrollTop: host.scrollTop,
  }) <= terminalScrollBottomTolerance
}

function terminalScrollDistanceFromBottom(input: {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}) {
  return Math.max(0, input.scrollHeight - input.scrollTop - input.clientHeight)
}

export function terminalHostIsNearBottomForTests(input: {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}) {
  return terminalScrollDistanceFromBottom(input) <= terminalScrollBottomTolerance
}

function scrollTerminalToBottomSoon(host: HTMLElement | null) {
  if (!host) return
  window.requestAnimationFrame(() => {
    host.scrollTop = host.scrollHeight
  })
}

function terminalSizesEqual(
  left: { readonly cols: number; readonly rows: number } | null,
  right: { readonly cols: number; readonly rows: number },
) {
  return left?.cols === right.cols && left.rows === right.rows
}

function terminalMeasurementFromHost(host: HTMLElement | null): TerminalHostMeasurement {
  if (!host) {
    const metrics = fallbackTerminalRenderMetrics(14)
    return { cols: fallbackCols, rows: fallbackRows, ...metrics }
  }
  const style = window.getComputedStyle(host)
  const fontSize = Number.parseFloat(style.fontSize) || 14
  const lineHeight = terminalLineHeight(style.lineHeight, fontSize)
  const cellWidth = terminalMeasuredCharWidth(host, style, fontSize)
  return terminalMeasurementFromMeasurements({
    width: host.clientWidth,
    height: host.clientHeight,
    paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
    paddingRight: Number.parseFloat(style.paddingRight) || 0,
    paddingTop: Number.parseFloat(style.paddingTop) || 0,
    paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
    charWidth: cellWidth,
    lineHeight,
  })
}

function terminalVisibleMeasurementFromHost(host: HTMLElement | null) {
  if (!host || !terminalCanMeasureHostSize(host)) return null
  return terminalMeasurementFromHost(host)
}

function terminalSizeFromMeasurement(measurement: TerminalHostMeasurement) {
  return { cols: measurement.cols, rows: measurement.rows }
}

function terminalCanMeasureHostSize(host: { readonly clientWidth: number; readonly clientHeight: number }) {
  return host.clientWidth > 0 && host.clientHeight > 0
}

export function terminalCanMeasureHostSizeForTests(input: {
  readonly clientWidth: number
  readonly clientHeight: number
}) {
  return terminalCanMeasureHostSize(input)
}

export function terminalSizeFromMeasurements(input: {
  readonly width: number
  readonly height: number
  readonly paddingLeft: number
  readonly paddingRight: number
  readonly paddingTop: number
  readonly paddingBottom: number
  readonly charWidth: number
  readonly lineHeight: number
}) {
  return terminalSizeFromMeasurement(terminalMeasurementFromMeasurements(input))
}

function terminalMeasurementFromMeasurements(input: {
  readonly width: number
  readonly height: number
  readonly paddingLeft: number
  readonly paddingRight: number
  readonly paddingTop: number
  readonly paddingBottom: number
  readonly charWidth: number
  readonly lineHeight: number
}): TerminalHostMeasurement {
  const contentWidth = Math.max(0, input.width - input.paddingLeft - input.paddingRight)
  const contentHeight = Math.max(0, input.height - input.paddingTop - input.paddingBottom)
  return {
    cols: Math.max(20, Math.floor(contentWidth / Math.max(1, input.charWidth))),
    rows: Math.max(6, Math.floor(contentHeight / Math.max(1, input.lineHeight))),
    cellWidth: Math.max(1, input.charWidth),
    lineHeight: Math.max(1, input.lineHeight),
  }
}

function fallbackTerminalRenderMetrics(fontSize: number): TerminalRenderMetrics {
  return {
    cellWidth: Math.max(1, fontSize * 0.62),
    lineHeight: Math.max(1, fontSize * 1.35),
  }
}

function terminalRenderMetricsEqual(left: TerminalRenderMetrics, right: TerminalRenderMetrics) {
  return Math.abs(left.cellWidth - right.cellWidth) < 0.01 &&
    Math.abs(left.lineHeight - right.lineHeight) < 0.01
}

function terminalLineHeight(lineHeight: string, fontSize: number) {
  const parsed = Number.parseFloat(lineHeight)
  return Number.isFinite(parsed) ? parsed : fontSize * 1.35
}

function terminalMeasuredCharWidth(host: HTMLElement, style: CSSStyleDeclaration, fontSize: number) {
  const ownerDocument = host.ownerDocument
  const probe = ownerDocument.createElement('span')
  probe.textContent = terminalMeasureSample
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.whiteSpace = 'pre'
  probe.style.fontFamily = style.fontFamily
  probe.style.fontSize = style.fontSize
  probe.style.fontWeight = style.fontWeight
  probe.style.fontStyle = style.fontStyle
  probe.style.letterSpacing = style.letterSpacing
  probe.style.lineHeight = style.lineHeight
  host.appendChild(probe)
  const width = probe.getBoundingClientRect().width / terminalMeasureSample.length
  probe.remove()
  return Number.isFinite(width) && width > 0 ? width : fontSize * 0.62
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
  col: number,
  runs: readonly CellRun[],
) {
  const existing = rows[rowIndex] ?? emptyRow(rowIndex)
  const cells = expandRunsToCells(existing.runs)
  const replacement = expandRunsToCells(runs)
  while (cells.length < col) cells.push({ text: ' ', style: {} })
  cells.splice(col, replacement.length, ...replacement)
  const nextRuns = coalesceCells(cells)
  return replaceRow(rows, {
    ...existing,
    runs: nextRuns,
    fingerprint: runFingerprint(nextRuns),
  })
}

type RenderCell = {
  readonly text: string
  readonly style: TerminalCellStyle
}

function expandRunsToCells(runs: readonly CellRun[]) {
  const cells: RenderCell[] = []
  for (const run of runs) {
    const chars = Array.from(run.text)
    const width = Math.max(run.width, chars.length)
    for (let index = 0; index < width; index += 1) {
      cells.push({ text: chars[index] ?? ' ', style: run.style })
    }
  }
  return cells
}

function coalesceCells(cells: readonly RenderCell[]) {
  const runs: CellRun[] = []
  for (const cell of cells) {
    const previous = runs.at(-1)
    if (previous && terminalStyleKey(previous.style) === terminalStyleKey(cell.style)) {
      runs[runs.length - 1] = {
        ...previous,
        text: `${previous.text}${cell.text}`,
        width: previous.width + 1,
      }
      continue
    }
    runs.push({ text: cell.text, width: 1, style: cell.style })
  }
  return runs
}

function terminalStyleKey(style: TerminalCellStyle) {
  return JSON.stringify(style)
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

function terminalScreenStyle(
  cols: number,
  renderMetrics: TerminalRenderMetrics = fallbackTerminalRenderMetrics(14),
): React.CSSProperties {
  const width = cols * renderMetrics.cellWidth
  return {
    width: `${width}px`,
    minWidth: `${width}px`,
    lineHeight: `${renderMetrics.lineHeight}px`,
  }
}

export function terminalScreenStyleForTests(
  cols: number,
  renderMetrics?: TerminalRenderMetrics,
) {
  return terminalScreenStyle(cols, renderMetrics)
}

function terminalRunHasVisibleUnderline(run: CellRun) {
  return run.style.underline === true && /\S/u.test(run.text)
}

export function terminalRunHasVisibleUnderlineForTests(run: CellRun) {
  return terminalRunHasVisibleUnderline(run)
}

function terminalRunIsBlankUnderline(run: CellRun) {
  return run.style.underline === true && !/\S/u.test(run.text)
}

export function terminalRunIsBlankUnderlineForTests(run: CellRun) {
  return terminalRunIsBlankUnderline(run)
}

function terminalRunCells(run: CellRun) {
  const cells = Array.from(run.text)
  const width = Math.max(run.width, cells.length)
  while (cells.length < width) cells.push(' ')
  return cells
}

export function terminalRunCellsForTests(run: CellRun) {
  return terminalRunCells(run)
}

type TerminalCursorRowPart =
  | { readonly kind: 'run'; readonly run: CellRun }
  | { readonly kind: 'cursor' }

function terminalCursorRowParts(runs: readonly CellRun[], cursorCol: number): readonly TerminalCursorRowPart[] {
  const parts: TerminalCursorRowPart[] = []
  let offset = 0
  let inserted = false

  const pushRun = (run: CellRun) => {
    if (run.text.length === 0 && run.width === 0) return
    parts.push({ kind: 'run', run })
  }

  for (const run of runs) {
    const cells = terminalRunCells(run)
    const runEnd = offset + cells.length
    if (!inserted && cursorCol <= runEnd) {
      const splitAt = Math.max(0, Math.min(cells.length, cursorCol - offset))
      pushRun({ text: cells.slice(0, splitAt).join(''), width: splitAt, style: run.style })
      parts.push({ kind: 'cursor' })
      pushRun({ text: cells.slice(splitAt).join(''), width: cells.length - splitAt, style: run.style })
      inserted = true
    } else {
      pushRun(run)
    }
    offset = runEnd
  }

  if (!inserted) {
    const spacerWidth = Math.max(0, cursorCol - offset)
    pushRun({ text: ' '.repeat(spacerWidth), width: spacerWidth, style: {} })
    parts.push({ kind: 'cursor' })
  }

  return parts
}

export function terminalCursorRowPartsForTests(runs: readonly CellRun[], cursorCol: number) {
  return terminalCursorRowParts(runs, cursorCol)
}

function terminalRowUnderlineRunCount(row: TerminalRow) {
  return row.runs.filter((run) => run.style.underline).length
}

export function terminalRowUnderlineRunCountForTests(row: TerminalRow) {
  return terminalRowUnderlineRunCount(row)
}

function terminalRowUnderlineBlankRunCount(row: TerminalRow) {
  return row.runs.filter(terminalRunIsBlankUnderline).length
}

export function terminalRowUnderlineBlankRunCountForTests(row: TerminalRow) {
  return terminalRowUnderlineBlankRunCount(row)
}

function runStyle(
  run: CellRun,
  renderMetrics: TerminalRenderMetrics = fallbackTerminalRenderMetrics(14),
): React.CSSProperties {
  const style = run.style
  const width = run.width * renderMetrics.cellWidth
  return {
    width: `${width}px`,
    minWidth: `${width}px`,
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    opacity: style.dim ? 0.68 : undefined,
    color: colorValue(style.inverse ? style.background : style.foreground),
    backgroundColor: colorValue(style.inverse ? style.foreground : style.background),
  }
}

function cursorRowRunStyle(run: CellRun): React.CSSProperties {
  const style = run.style
  return {
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    opacity: style.dim ? 0.68 : undefined,
    color: colorValue(style.inverse ? style.background : style.foreground),
    backgroundColor: colorValue(style.inverse ? style.foreground : style.background),
  }
}

function terminalInlineCursorStyle(renderMetrics: TerminalRenderMetrics): React.CSSProperties {
  return {
    width: `${renderMetrics.cellWidth}px`,
    marginRight: `${-renderMetrics.cellWidth}px`,
  }
}

export function terminalRunStyleForTests(
  run: CellRun,
  renderMetrics?: TerminalRenderMetrics,
) {
  return runStyle(run, renderMetrics)
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
