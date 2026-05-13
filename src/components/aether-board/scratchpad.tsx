import { Check, NotebookPen, Plus, Send, Trash2 } from 'lucide-react'
import * as React from 'react'
import type { ProjectRow, ScratchpadBlock } from '~/lib/contracts'
import { errorMessage, formatBlockDay, formatBlockTime } from './format'

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
  const [draft, setDraft] = React.useState('')
  const [captureProjectId, setCaptureProjectId] = React.useState<string>(selectedProjectId)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const captureRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    if (selectedProjectId) setCaptureProjectId(selectedProjectId)
  }, [selectedProjectId])

  React.useEffect(() => {
    captureRef.current?.focus()
  }, [])

  async function submitCapture(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = draft.trim()
    if (!body) return
    setPending(true)
    setError(null)
    try {
      await onCapture(body, captureProjectId || null)
      setDraft('')
      captureRef.current?.focus()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
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
    setPendingId(block.id)
    setError(null)
    try {
      await onTrigger(block)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPendingId(null)
    }
  }

  async function handleDelete(id: string) {
    setPendingId(id)
    try {
      await onDelete(id)
    } finally {
      setPendingId(null)
    }
  }

  const grouped = React.useMemo(() => groupBlocksByDay(blocks), [blocks])

  return (
    <div className="scratchpad-panel" data-testid="scratchpad-panel">
      <form className="scratchpad-capture" onSubmit={submitCapture}>
        <textarea
          ref={captureRef}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onDraftKeyDown}
          placeholder="Capture an idea. ⏎ to save, ⇧⏎ for a new line."
          rows={2}
          disabled={pending}
          data-testid="scratchpad-input"
        />
        <div className="scratchpad-capture-row">
          <label className="scratchpad-capture-project">
            <span>tag</span>
            <select
              value={captureProjectId}
              disabled={pending}
              onChange={(event) => setCaptureProjectId(event.currentTarget.value)}
            >
              <option value="">unassigned</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={pending || draft.trim().length === 0}>
            <Plus size={13} />
            Capture
          </button>
        </div>
        {error ? <p className="scratchpad-error" role="status">{error}</p> : null}
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
                      disabled={pendingId === block.id}
                    >
                      <Send size={12} aria-hidden="true" />
                      {block.triggeredAt ? 'Re-trigger' : 'Trigger'}
                    </button>
                    <button
                      type="button"
                      className="scratchpad-block-delete"
                      onClick={() => void handleDelete(block.id)}
                      disabled={pendingId === block.id}
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

