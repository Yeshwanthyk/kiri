'use client'

import { Columns2, Plus, Rows2, X } from 'lucide-react'
import * as React from 'react'
import type { AgentCell, ProjectRow } from '~/lib/contracts'
import type { ThemeMode } from '~/theme/kiri-themes'
import type { ChatTypographySettings } from './storage'
import {
  closePane,
  focusAdjacentPane,
  focusPane,
  makeTerminalLayoutIdGenerator,
  newTab,
  parseTerminalLayout,
  selectTabAt,
  selectTab,
  setSplitRatio,
  splitPane,
  type PaneNode,
  type TerminalLayout,
} from './terminal-layout'
import { TerminalPanel } from './terminal-panel'

const idGenerator = makeTerminalLayoutIdGenerator()

function layoutStorageKey(projectId: string) {
  return `kiri:terminal-layout:${projectId}`
}

// The shell terminal workspace: tabs and splits over detached kiriterm
// sessions. Layout lives in localStorage per project; every pane reattaches
// to its session (full scrollback) on remount, so the UI is disposable.
export function TerminalWorkspace({
  agent,
  focusRequest,
  project,
  themeMode,
  toggleFocusKey,
  typography,
  visible,
}: {
  agent: AgentCell
  focusRequest: number
  project: ProjectRow
  themeMode: ThemeMode
  toggleFocusKey: string
  typography: ChatTypographySettings
  visible: boolean
}) {
  const [layout, setLayout] = React.useState<TerminalLayout>(() =>
    parseTerminalLayout(
      typeof window === 'undefined' ? null : window.localStorage.getItem(layoutStorageKey(project.id)),
      idGenerator,
    ))

  React.useEffect(() => {
    setLayout(parseTerminalLayout(
      window.localStorage.getItem(layoutStorageKey(project.id)),
      idGenerator,
    ))
  }, [project.id])

  React.useEffect(() => {
    window.localStorage.setItem(layoutStorageKey(project.id), JSON.stringify(layout))
  }, [layout, project.id])

  const onKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (!event.metaKey && !event.ctrlKey) return
    const key = event.key.toLowerCase()
    const update = (next: (current: TerminalLayout) => TerminalLayout) => {
      event.preventDefault()
      event.stopPropagation()
      setLayout(next)
    }
    if (key === 'd' && !event.altKey) {
      update((current) => splitPane(
        current,
        current.activePaneId,
        event.shiftKey ? 'column' : 'row',
        idGenerator,
      ))
      return
    }
    if (key === 't' && !event.shiftKey && !event.altKey) {
      update((current) => newTab(current, idGenerator))
      return
    }
    if (key === 'w' && event.shiftKey && !event.altKey) {
      update((current) => closePane(current, current.activePaneId, idGenerator))
      return
    }
    if ((key === 'arrowleft' || key === 'arrowright') && event.altKey) {
      update((current) => focusAdjacentPane(current, key === 'arrowright' ? 1 : -1))
      return
    }
    if (!event.shiftKey && !event.altKey && /^[1-9]$/.test(key)) {
      update((current) => selectTabAt(current, Number(key) - 1))
    }
  }, [])

  return (
    <section
      className="terminal-panel terminal-workspace"
      data-testid={visible ? 'terminal-panel' : undefined}
      hidden={!visible}
      onKeyDownCapture={onKeyDown}
    >
      <div className="terminal-header">
        <div>
          <strong>Shell terminal</strong>
          <span>{project.cwd}</span>
        </div>
        <div className="terminal-workspace-tabs" role="tablist" aria-label="Terminal tabs">
          {layout.tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === layout.activeTabId}
              className={tab.id === layout.activeTabId ? 'active' : ''}
              onClick={() => setLayout((current) => selectTab(current, tab.id))}
            >
              {index + 1}
            </button>
          ))}
          <button
            type="button"
            aria-label="New terminal tab (Cmd+T)"
            title="New terminal tab (Cmd+T)"
            onClick={() => setLayout((current) => newTab(current, idGenerator))}
          >
            <Plus size={13} aria-hidden="true" />
          </button>
        </div>
        <div className="terminal-header-actions">
          <button
            type="button"
            aria-label="Split right (Cmd+D)"
            title="Split right (Cmd+D)"
            onClick={() => setLayout((current) =>
              splitPane(current, current.activePaneId, 'row', idGenerator))}
          >
            <Columns2 size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Split down (Cmd+Shift+D)"
            title="Split down (Cmd+Shift+D)"
            onClick={() => setLayout((current) =>
              splitPane(current, current.activePaneId, 'column', idGenerator))}
          >
            <Rows2 size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Close pane (Cmd+Shift+W)"
            title="Close pane (Cmd+Shift+W)"
            onClick={() => setLayout((current) =>
              closePane(current, current.activePaneId, idGenerator))}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
      {layout.tabs.map((tab) => (
        <div
          key={tab.id}
          className="terminal-workspace-surface"
          hidden={tab.id !== layout.activeTabId}
        >
          <WorkspaceNode
            node={tab.root}
            layout={layout}
            setLayout={setLayout}
            tabVisible={visible && tab.id === layout.activeTabId}
            agent={agent}
            project={project}
            themeMode={themeMode}
            typography={typography}
            toggleFocusKey={toggleFocusKey}
            focusRequest={focusRequest}
          />
        </div>
      ))}
    </section>
  )
}

function WorkspaceNode({
  node,
  layout,
  setLayout,
  tabVisible,
  agent,
  project,
  themeMode,
  typography,
  toggleFocusKey,
  focusRequest,
}: {
  node: PaneNode
  layout: TerminalLayout
  setLayout: React.Dispatch<React.SetStateAction<TerminalLayout>>
  tabVisible: boolean
  agent: AgentCell
  project: ProjectRow
  themeMode: ThemeMode
  typography: ChatTypographySettings
  toggleFocusKey: string
  focusRequest: number
}) {
  if (node.kind === 'leaf') {
    const active = layout.activePaneId === node.id
    return (
      <div
        className={active ? 'terminal-pane active' : 'terminal-pane'}
        data-testid={tabVisible ? 'terminal-pane' : undefined}
        onMouseDownCapture={() => {
          setLayout((current) => focusPane(current, node.id))
        }}
      >
        <TerminalPanel
          key={`terminal-${project.id}-shell-${node.termId}`}
          agent={agent}
          focusRequest={active ? focusRequest : 0}
          toggleFocusKey={toggleFocusKey}
          typography={typography}
          mode="shell"
          termId={node.termId}
          project={project}
          themeMode={themeMode}
          visible={tabVisible}
          embedded
        />
      </div>
    )
  }

  const isRow = node.direction === 'row'
  const template = `minmax(0, ${node.ratio}fr) 4px minmax(0, ${1 - node.ratio}fr)`
  return (
    <div
      className={isRow ? 'terminal-split row' : 'terminal-split column'}
      style={isRow ? { gridTemplateColumns: template } : { gridTemplateRows: template }}
    >
      <WorkspaceNode
        node={node.a}
        layout={layout}
        setLayout={setLayout}
        tabVisible={tabVisible}
        agent={agent}
        project={project}
        themeMode={themeMode}
        typography={typography}
        toggleFocusKey={toggleFocusKey}
        focusRequest={focusRequest}
      />
      <SplitDivider node={node} setLayout={setLayout} />
      <WorkspaceNode
        node={node.b}
        layout={layout}
        setLayout={setLayout}
        tabVisible={tabVisible}
        agent={agent}
        project={project}
        themeMode={themeMode}
        typography={typography}
        toggleFocusKey={toggleFocusKey}
        focusRequest={focusRequest}
      />
    </div>
  )
}

function SplitDivider({
  node,
  setLayout,
}: {
  node: Extract<PaneNode, { kind: 'split' }>
  setLayout: React.Dispatch<React.SetStateAction<TerminalLayout>>
}) {
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const container = event.currentTarget.parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    const isRow = node.direction === 'row'
    const onMove = (move: PointerEvent) => {
      const ratio = isRow
        ? (move.clientX - rect.left) / rect.width
        : (move.clientY - rect.top) / rect.height
      setLayout((current) => setSplitRatio(current, node.id, ratio))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div
      className="terminal-split-divider"
      role="separator"
      aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
    />
  )
}
