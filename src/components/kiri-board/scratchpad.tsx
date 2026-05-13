import { Check, NotebookPen, Plus, Send, Trash2 } from 'lucide-react'
import * as React from 'react'
import type { ProjectRow, ScratchpadBlock } from '~/lib/contracts'
import { errorMessage, formatBlockDay, formatBlockTime } from './format'

type ScratchpadState = {
  draft: string
  manualProjectId: string | null
  pending: boolean
  error: string | null
  pendingId: string | null
}

type ScratchpadAction =
  | { type: 'draftChanged'; draft: string }
  | { type: 'projectChanged'; projectId: string }
  | { type: 'captureStarted' }
  | { type: 'captureSucceeded' }
  | { type: 'failed'; error: string }
  | { type: 'pendingFinished' }
  | { type: 'blockActionStarted'; id: string; clearError?: boolean }

const initialScratchpadState: ScratchpadState = {
  draft: '',
  manualProjectId: null,
  pending: false,
  error: null,
  pendingId: null,
}

function scratchpadReducer(state: ScratchpadState, action: ScratchpadAction): ScratchpadState {
  switch (action.type) {
    case 'draftChanged':
      return { ...state, draft: action.draft }
    case 'projectChanged':
      return { ...state, manualProjectId: action.projectId }
    case 'captureStarted':
      return { ...state, pending: true, error: null }
    case 'captureSucceeded':
      return { ...state, draft: '', pending: false }
    case 'failed':
      return { ...state, pending: false, error: action.error }
    case 'pendingFinished':
      return { ...state, pending: false, pendingId: null }
    case 'blockActionStarted':
      return {
        ...state,
        pendingId: action.id,
        error: action.clearError ? null : state.error,
      }
  }
}

export function ScratchpadHeader({ blockCount }: { blockCount: number }) {
  return (
    <header className="sidebar-header scratchpad-header">
      <div className="scratchpad-header-mark" aria-hidden="true">
        <NotebookPen size={16} />
      </div>
      <div className="scratchpad-header-text">
        <p className="settings-kicker">Scratchpad</p>
        <strong>Ideas across projects</strong>
      </div>
      <span className="scratchpad-header-count">
        {blockCount === 0 ? 'empty' : `${blockCount} block${blockCount === 1 ? '' : 's'}`}
      </span>
    </header>
  )
}

export function ScratchpadPanel({
  blocks,
  projects,
  selectedProjectId,
  onCapture,
  onDelete,
  onTrigger,
}: {
  blocks: ScratchpadBlock[]
  projects: ProjectRow[]
  selectedProjectId: string
  onCapture: (body: string, projectId: string | null) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onTrigger: (block: ScratchpadBlock) => Promise<void>
}) {
  const [state, dispatch] = React.useReducer(scratchpadReducer, initialScratchpadState)
  const captureRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    captureRef.current?.focus()
  }, [])

  async function submitCapture(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = state.draft.trim()
    if (!body) return
    dispatch({ type: 'captureStarted' })
    try {
      await onCapture(body, captureProjectId || null)
      dispatch({ type: 'captureSucceeded' })
      captureRef.current?.focus()
    } catch (cause) {
      dispatch({ type: 'failed', error: errorMessage(cause) })
    }
  }

  function onDraftKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const form = event.currentTarget.form
      if (form) form.requestSubmit()
    }
  }

  async function handleTrigger(block: ScratchpadBlock) {
    dispatch({ type: 'blockActionStarted', id: block.id, clearError: true })
    try {
      await onTrigger(block)
    } catch (cause) {
      dispatch({ type: 'failed', error: errorMessage(cause) })
      return
    } finally {
      dispatch({ type: 'pendingFinished' })
    }
  }

  async function handleDelete(id: string) {
    dispatch({ type: 'blockActionStarted', id })
    try {
      await onDelete(id)
    } finally {
      dispatch({ type: 'pendingFinished' })
    }
  }

  const grouped = React.useMemo(() => groupBlocksByDay(blocks), [blocks])
  const captureProjectId = state.manualProjectId ?? selectedProjectId

  return (
    <div className="scratchpad-panel" data-testid="scratchpad-panel">
      <form className="scratchpad-capture" onSubmit={submitCapture}>
        <textarea
          ref={captureRef}
          value={state.draft}
          onChange={(event) => dispatch({ type: 'draftChanged', draft: event.currentTarget.value })}
          onKeyDown={onDraftKeyDown}
          placeholder="Capture an idea. ⏎ to save, ⇧⏎ for a new line."
          rows={2}
          disabled={state.pending}
          data-testid="scratchpad-input"
        />
        <div className="scratchpad-capture-row">
          <label className="scratchpad-capture-project">
            <span>tag</span>
            <select
              value={captureProjectId}
              disabled={state.pending}
              onChange={(event) => dispatch({
                type: 'projectChanged',
                projectId: event.currentTarget.value,
              })}
            >
              <option value="">unassigned</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={state.pending || state.draft.trim().length === 0}>
            <Plus size={13} />
            Capture
          </button>
        </div>
        {state.error ? <p className="scratchpad-error" role="status">{state.error}</p> : null}
      </form>

      <div className="scratchpad-list" role="list">
        {blocks.length === 0 ? (
          <div className="scratchpad-empty">
            <p className="settings-kicker">Empty</p>
            <p>Capture an idea above. Trigger it into any project, any runtime.</p>
          </div>
        ) : (
          grouped.map((group) => (
            <section key={group.key} className="scratchpad-group">
              <p className="scratchpad-day">{group.label}</p>
              {group.blocks.map((block) => (
                <article
                  key={block.id}
                  className={`scratchpad-block ${block.triggeredAt ? 'triggered' : ''}`}
                  role="listitem"
                  data-testid="scratchpad-block"
                >
                  <header className="scratchpad-block-head">
                    <span className="scratchpad-block-kicker">
                      {block.projectName ?? 'unassigned'}
                    </span>
                    <span className="scratchpad-block-time">{formatBlockTime(block.createdAt)}</span>
                  </header>
                  <p className="scratchpad-block-body">{block.body}</p>
                  <footer className="scratchpad-block-actions">
                    {block.triggeredAt ? (
                      <span className="scratchpad-block-state">
                        <Check size={12} aria-hidden="true" /> sent
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="scratchpad-block-trigger"
                      onClick={() => void handleTrigger(block)}
                      disabled={state.pendingId === block.id}
                    >
                      <Send size={12} aria-hidden="true" />
                      {block.triggeredAt ? 'Re-trigger' : 'Trigger'}
                    </button>
                    <button
                      type="button"
                      className="scratchpad-block-delete"
                      onClick={() => void handleDelete(block.id)}
                      disabled={state.pendingId === block.id}
                      aria-label="Delete block"
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </footer>
                </article>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  )
}

export function groupBlocksByDay(blocks: ScratchpadBlock[]) {
  const groups = new Map<string, { key: string; label: string; blocks: ScratchpadBlock[] }>()
  for (const block of blocks) {
    const label = formatBlockDay(block.createdAt)
    const entry = groups.get(label)
    if (entry) {
      entry.blocks.push(block)
    } else {
      groups.set(label, { key: label, label, blocks: [block] })
    }
  }
  return Array.from(groups.values())
}
