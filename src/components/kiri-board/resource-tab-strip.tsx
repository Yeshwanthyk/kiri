'use client'

import { NotebookPen, Plus, X } from 'lucide-react'
import * as React from 'react'
import type { AgentResource, ProjectResource, ResourceId } from './resource-tabs'

type ResourceTabStripProps = {
  readonly resources: readonly ProjectResource[]
  readonly activeResourceId: ResourceId | null
  readonly agentTitles: ReadonlyMap<string, string>
  readonly onSelectResource: (resourceId: ResourceId) => void
  readonly onMoveResource: (resourceId: ResourceId, toIndex: number) => void
  readonly onCloseAgent: (agentId: string) => void
  readonly onRenameAgent: (agentId: string, title: string) => Promise<void>
  readonly onAddTerminal: () => void
  readonly terminalDisabled?: boolean
  readonly onOpenScratchpad: () => void
  readonly onStartSession: () => void
}

export function ResourceTabStrip({
  resources,
  activeResourceId,
  agentTitles,
  onSelectResource,
  onMoveResource,
  onCloseAgent,
  onRenameAgent,
  onAddTerminal,
  terminalDisabled = false,
  onOpenScratchpad,
  onStartSession,
}: ResourceTabStripProps) {
  const tabResources = resources.filter((resource): resource is AgentResource => resource.kind === 'agent')
  const terminalActive = activeResourceId?.startsWith('terminal:') ?? false
  const stripRef = React.useRef<HTMLDivElement | null>(null)
  const dragRef = React.useRef<{
    readonly pointerId: number
    readonly resourceId: ResourceId
    readonly startX: number
    dragging: boolean
  } | null>(null)
  const [draggingResourceId, setDraggingResourceId] = React.useState<ResourceId | null>(null)
  const [dropTargetResourceId, setDropTargetResourceId] = React.useState<ResourceId | null>(null)
  const [suppressedClickResourceId, setSuppressedClickResourceId] = React.useState<ResourceId | null>(null)
  const [editingResourceId, setEditingResourceId] = React.useState<ResourceId | null>(null)
  const [renameDraft, setRenameDraft] = React.useState('')
  const [renamePending, setRenamePending] = React.useState(false)
  const renameInputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (!editingResourceId) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [editingResourceId])

  function selectResource(resourceId: ResourceId) {
    if (suppressedClickResourceId === resourceId) {
      setSuppressedClickResourceId(null)
      return
    }
    onSelectResource(resourceId)
  }

  function startDrag(event: React.PointerEvent<HTMLElement>, resourceId: ResourceId) {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('.resource-tab-close, .resource-tab-title-input')) return
    dragRef.current = {
      pointerId: event.pointerId,
      resourceId,
      startX: event.clientX,
      dragging: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function updateDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.dragging && Math.abs(event.clientX - drag.startX) < 6) return
    drag.dragging = true
    setDraggingResourceId(drag.resourceId)
    setDropTargetResourceId(resourceIdAtPoint(event.clientX) ?? drag.resourceId)
  }

  function finishDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (drag.dragging) {
      const targetId = resourceIdAtPoint(event.clientX)
      const targetIndex = resources.findIndex((resource) => resource.id === targetId)
      if (targetIndex >= 0) onMoveResource(drag.resourceId, targetIndex)
      setSuppressedClickResourceId(drag.resourceId)
    }
    dragRef.current = null
    setDraggingResourceId(null)
    setDropTargetResourceId(null)
  }

  function cancelDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (drag?.pointerId === event.pointerId) {
      dragRef.current = null
      setDraggingResourceId(null)
      setDropTargetResourceId(null)
    }
  }

  function resourceIdAtPoint(clientX: number) {
    const tabs = Array.from(
      stripRef.current?.querySelectorAll<HTMLElement>('[data-resource-id]') ?? [],
    )
    if (tabs.length === 0) return null
    for (const tab of tabs) {
      const rect = tab.getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) {
        return tab.dataset.resourceId as ResourceId
      }
    }
    return tabs[tabs.length - 1]?.dataset.resourceId as ResourceId | undefined
  }

  function beginRename(resource: AgentResource, label: string) {
    setEditingResourceId(resource.id)
    setRenameDraft(label)
  }

  async function commitRename(resource: AgentResource, currentLabel: string) {
    const nextTitle = renameDraft.trim()
    if (!nextTitle || nextTitle === currentLabel) {
      setEditingResourceId(null)
      setRenameDraft('')
      return
    }
    setRenamePending(true)
    try {
      await onRenameAgent(resource.agentId, nextTitle)
      setEditingResourceId(null)
      setRenameDraft('')
    } finally {
      setRenamePending(false)
    }
  }

  return (
    <div className="resource-tabs-bar" data-testid="resource-tab-strip">
      <div
        ref={stripRef}
        className="resource-tab-strip"
        role="tablist"
        aria-label="Project resources"
      >
        {tabResources.map((resource) => {
          const label = resourceLabel(resource, agentTitles)
          const dragging = resource.id === draggingResourceId
          const dropTarget = resource.id === dropTargetResourceId && resource.id !== draggingResourceId
          const editing = resource.id === editingResourceId && resource.kind === 'agent'
          return (
            <div
              key={resource.id}
              className={`resource-tab-shell ${resource.id === activeResourceId ? 'active' : ''} ${dragging ? 'dragging' : ''} ${dropTarget ? 'drop-target' : ''}`}
              data-resource-kind={resource.kind}
              data-resource-id={resource.id}
              aria-grabbed={dragging}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('.resource-tab-close')) return
                if ((event.target as HTMLElement).closest('.resource-tab-title-input')) return
                selectResource(resource.id)
              }}
              onDoubleClick={() => {
                if (resource.kind === 'agent') beginRename(resource, label)
              }}
              onPointerDown={(event) => startDrag(event, resource.id)}
              onPointerMove={updateDrag}
              onPointerUp={finishDrag}
              onPointerCancel={cancelDrag}
            >
              {editing ? (
                <input
                  ref={renameInputRef}
                  className="resource-tab-title-input"
                  value={renameDraft}
                  disabled={renamePending}
                  aria-label={`Rename ${label}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setRenameDraft(event.currentTarget.value)}
                  onBlur={() => void commitRename(resource, label)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void commitRename(resource, label)
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditingResourceId(null)
                      setRenameDraft('')
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={resource.id === activeResourceId}
                  className="resource-tab"
                  data-testid={`resource-tab-${resource.kind}`}
                >
                  <span className="resource-dot" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              )}
              {resource.kind === 'agent' ? (
                <button
                  type="button"
                  className="resource-tab-close"
                  aria-label={`Close ${label}`}
                  title={`Close ${label}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseAgent(resource.agentId)
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="resource-add-actions" aria-label="Add resource">
        <button type="button" onClick={onStartSession} aria-label="Start agent">
          <Plus size={14} aria-hidden="true" />
          agent
        </button>
        <button
          type="button"
          onClick={onAddTerminal}
          aria-label="Open terminal resource"
          aria-pressed={terminalActive}
          data-active={terminalActive ? 'true' : 'false'}
          data-testid="resource-terminal-action"
          disabled={terminalDisabled}
        >
          <span className="resource-action-icon" aria-hidden="true">
            {terminalActive ? <span className="resource-dot resource-terminal-dot" /> : <Plus size={14} />}
          </span>
          terminal
        </button>
        <button type="button" onClick={onOpenScratchpad} aria-label="Open scratchpad">
          <NotebookPen size={14} aria-hidden="true" />
          scratchpad
        </button>
      </div>
    </div>
  )
}

function resourceLabel(resource: ProjectResource, agentTitles: ReadonlyMap<string, string>) {
  if (resource.kind === 'agent') return agentTitles.get(resource.agentId) ?? 'agent'
  return resource.title
}
