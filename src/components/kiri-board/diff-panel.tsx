'use client'

import { PatchDiff } from '@pierre/diffs/react'
import type { GitStatus } from '@pierre/trees'
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react'
import { ArrowLeft, ArrowRight, Columns2, GitPullRequest, Maximize2, Minimize2, Rows3 } from 'lucide-react'
import * as React from 'react'
import type { AgentCell, DiffArtifact } from '~/lib/contracts'
import type { ThemeMode } from '~/theme/kiri-themes'
import { normalizeDiffPath } from './timeline'
import { isEditableTarget } from './board-types'

type DiffStyle = 'unified' | 'split'

export function DiffPanel({ agent, themeMode }: { agent: AgentCell; themeMode: ThemeMode }) {
  const [selectedDiffId, setSelectedDiffId] = React.useState<string | null>(null)
  const [diffStyle, setDiffStyle] = React.useState<DiffStyle>('unified')
  const [fullscreen, setFullscreen] = React.useState(false)
  const diffBodyRef = React.useRef<HTMLDivElement | null>(null)
  const diff =
    agent.diffs.find((item) => item.id === selectedDiffId) ?? agent.diffs[0]
  const selectedIndex = diff
    ? Math.max(0, agent.diffs.findIndex((item) => item.id === diff.id))
    : -1
  const diffByPath = React.useMemo(
    () => new Map(agent.diffs.map((item) => [normalizeDiffPath(item.path), item])),
    [agent.diffs],
  )

  React.useEffect(() => {
    setSelectedDiffId(null)
    setFullscreen(false)
  }, [agent.id, agent.diffs.length])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'escape' && fullscreen) {
        event.preventDefault()
        setFullscreen(false)
        return
      }
      if (key === 'f') {
        event.preventDefault()
        setFullscreen((value) => !value)
        return
      }
      if (key === 'h') {
        event.preventDefault()
        selectRelative(-1)
        return
      }
      if (key === 'l') {
        event.preventDefault()
        selectRelative(1)
        return
      }
      if (key === 'j') {
        event.preventDefault()
        scrollDiff(320)
        return
      }
      if (key === 'k') {
        event.preventDefault()
        scrollDiff(-320)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreen, selectedIndex, agent.diffs])

  function selectIndex(index: number) {
    if (!agent.diffs.length) return
    const nextIndex = Math.max(0, Math.min(index, agent.diffs.length - 1))
    setSelectedDiffId(agent.diffs[nextIndex]?.id ?? null)
  }

  function selectRelative(delta: -1 | 1) {
    if (!agent.diffs.length || selectedIndex === -1) return
    const nextIndex = (selectedIndex + delta + agent.diffs.length) % agent.diffs.length
    selectIndex(nextIndex)
  }

  function scrollDiff(delta: number) {
    diffBodyRef.current?.scrollBy({ top: delta, behavior: 'smooth' })
  }

  if (!diff) {
    return (
      <div className="empty-panel" data-testid="diff-panel">
        <GitPullRequest size={18} />
        <span>No diffs for this agent yet.</span>
      </div>
    )
  }

  return (
    <div
      className={`diff-panel${fullscreen ? ' fullscreen' : ''}`}
      data-testid="diff-panel"
    >
      <div className="diff-header">
        <div>
          <strong>{agent.diffs.length} file{agent.diffs.length === 1 ? '' : 's'}</strong>
          <span>{diff.path}</span>
        </div>
        <div className="diff-toolbar" aria-label="Diff controls">
          <button
            type="button"
            onClick={() => selectRelative(-1)}
            aria-label="Previous changed file"
            title="Previous file"
          >
            <ArrowLeft size={14} />
          </button>
          <span className="diff-index">{selectedIndex + 1}/{agent.diffs.length}</span>
          <button
            type="button"
            onClick={() => selectRelative(1)}
            aria-label="Next changed file"
            title="Next file"
          >
            <ArrowRight size={14} />
          </button>
          <div className="diff-view-toggle" role="group" aria-label="Diff layout">
            <button
              type="button"
              className={diffStyle === 'unified' ? 'active' : ''}
              onClick={() => setDiffStyle('unified')}
              aria-label="Unified diff"
              title="Unified"
            >
              <Rows3 size={14} />
            </button>
            <button
              type="button"
              className={diffStyle === 'split' ? 'active' : ''}
              onClick={() => setDiffStyle('split')}
              aria-label="Split diff"
              title="Split"
            >
              <Columns2 size={14} />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setFullscreen((value) => !value)}
            aria-label={fullscreen ? 'Exit fullscreen diffs' : 'Fullscreen diffs'}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
      <div className="diff-body">
        <DiffFileTree
          diffs={agent.diffs}
          selectedPath={normalizeDiffPath(diff.path)}
          onSelectPath={(path) => {
            const next = diffByPath.get(path)
            if (next) setSelectedDiffId(next.id)
          }}
        />
        <div className="pierre-host" ref={diffBodyRef}>
          <PatchDiff
            key={`${diff.id}:${diffStyle}:${themeMode}`}
            patch={diff.patch}
            disableWorkerPool
            options={{
              diffStyle,
              overflow: 'wrap',
              themeType: themeMode,
            }}
          />
        </div>
      </div>
    </div>
  )
}

function DiffFileTree({
  diffs,
  selectedPath,
  onSelectPath,
}: {
  diffs: DiffArtifact[]
  selectedPath: string
  onSelectPath: (path: string) => void
}) {
  const paths = React.useMemo(
    () => diffs.map((diff) => normalizeDiffPath(diff.path)),
    [diffs],
  )
  const statusByPath = React.useMemo(
    () => new Map(
      diffs.map((diff) => [
        normalizeDiffPath(diff.path),
        diffGitStatus(diff.patch),
      ]),
    ),
    [diffs],
  )
  const pathSignature = paths.join('\0')
  const selectablePathsRef = React.useRef(new Set(paths))
  const onSelectPathRef = React.useRef(onSelectPath)
  const selectedPathRef = React.useRef(selectedPath)
  selectablePathsRef.current = new Set(paths)
  onSelectPathRef.current = onSelectPath
  selectedPathRef.current = selectedPath
  const { model } = useFileTree({
    density: 'compact',
    flattenEmptyDirectories: false,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    onSelectionChange: (selectedPaths) => {
      const nextPath = selectedPaths[0]
      if (
        nextPath &&
        nextPath !== selectedPathRef.current &&
        selectablePathsRef.current.has(nextPath)
      ) {
        onSelectPathRef.current(nextPath)
      }
    },
    paths,
    renderRowDecoration: ({ item }) => {
      if (item.kind !== 'file') return null
      const status = statusByPath.get(item.path)
      if (!status) return null
      return {
        text: diffGitStatusLabel(status),
        title: `Changed file: ${diffGitStatusTitle(status)}`,
      }
    },
    search: diffs.length > 8,
    unsafeCSS: diffTreeUnsafeCSS,
  })

  React.useEffect(() => {
    model.resetPaths(paths)
  }, [model, pathSignature, paths])

  React.useEffect(() => {
    if (!selectedPath) return
    const selectedPaths = model.getSelectedPaths()
    if (selectedPaths.length === 1 && selectedPaths[0] === selectedPath) return
    for (const path of selectedPaths) {
      model.getItem(path)?.deselect()
    }
    const item = model.getItem(selectedPath)
    if (item) {
      item.select()
      item.focus()
      return
    }
    model.focusNearestPath(selectedPath)
  }, [model, selectedPath])

  return (
    <aside className="diff-tree-pane" aria-label="Changed files">
      <PierreFileTree
        model={model}
        header={<span className="diff-tree-header">Changed files</span>}
        style={diffTreeStyle}
      />
    </aside>
  )
}

const diffTreeStyle: React.CSSProperties = {
  height: '100%',
  minHeight: 0,
  width: '100%',
  '--trees-bg-override': 'var(--panel-2)',
  '--trees-bg-muted-override': 'color-mix(in oklab, var(--paper) 7%, var(--panel-2))',
  '--trees-border-color-override': 'transparent',
  '--trees-border-radius-override': '6px',
  '--trees-fg-override': 'var(--ink)',
  '--trees-muted-fg-override': 'var(--muted)',
  '--trees-font-family-override': 'var(--font-mono)',
  '--trees-font-size-override': '12px',
  '--trees-item-padding-x-override': '6px',
  '--trees-padding-inline-override': '10px',
  '--trees-level-gap-override': '7px',
  '--trees-icon-width-override': '14px',
  '--trees-git-lane-width-override': '0px',
  '--trees-selected-bg-override': 'var(--accent-soft)',
  '--trees-selected-fg-override': 'var(--accent)',
} as React.CSSProperties

const diffTreeUnsafeCSS = `
  [data-type='item'] {
    letter-spacing: 0;
  }

  [data-item-section='content'] {
    flex: 1 1 auto;
  }

  [data-item-section='decoration'] {
    flex: 0 0 18px;
    color: var(--trees-status-modified);
    font-weight: var(--trees-font-weight-semibold);
  }

  [data-item-section='spacing-item'] {
    opacity: 0.45;
  }

  :host(:hover) [data-item-section='spacing-item'] {
    opacity: 0.7;
  }
`

function diffGitStatus(patch: string): GitStatus {
  if (/^(?:new file mode|--- \/dev\/null$)/m.test(patch)) return 'added'
  if (/^(?:deleted file mode|\+\+\+ \/dev\/null$)/m.test(patch)) return 'deleted'
  if (/^rename (?:from|to) /m.test(patch)) return 'renamed'
  return 'modified'
}

function diffGitStatusLabel(status: GitStatus) {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'ignored':
      return ''
    case 'modified':
      return 'M'
  }
}
function diffGitStatusTitle(status: GitStatus) {
  switch (status) {
    case 'added':
      return 'added'
    case 'deleted':
      return 'deleted'
    case 'ignored':
      return 'ignored'
    case 'renamed':
      return 'renamed'
    case 'untracked':
      return 'untracked'
    case 'modified':
      return 'modified'
  }
}
