'use client'

import { Check, NotebookPen, Plus, Trash2 } from 'lucide-react'
import * as React from 'react'
import type { KnowledgeAddInput, KnowledgeEntry, ProjectRow } from '~/lib/contracts'
import { errorMessage, formatBlockTime } from './format'

type KnowledgeState = {
  title: string
  problem: string
  answer: string
  tags: string
  manualProjectId: string | null
  pending: boolean
  pendingId: string | null
  error: string | null
  notice: string | null
}

type KnowledgeAction =
  | { type: 'titleChanged'; title: string }
  | { type: 'problemChanged'; problem: string }
  | { type: 'answerChanged'; answer: string }
  | { type: 'tagsChanged'; tags: string }
  | { type: 'projectChanged'; projectId: string }
  | { type: 'captureStarted' }
  | { type: 'captureSucceeded' }
  | { type: 'blockActionStarted'; id: string }
  | { type: 'pendingFinished' }
  | { type: 'failed'; error: string }
  | { type: 'noticeShown'; notice: string }
  | { type: 'noticeCleared' }

const initialKnowledgeState: KnowledgeState = {
  title: '',
  problem: '',
  answer: '',
  tags: '',
  manualProjectId: null,
  pending: false,
  pendingId: null,
  error: null,
  notice: null,
}

function knowledgeReducer(state: KnowledgeState, action: KnowledgeAction): KnowledgeState {
  switch (action.type) {
    case 'titleChanged':
      return { ...state, title: action.title }
    case 'problemChanged':
      return { ...state, problem: action.problem }
    case 'answerChanged':
      return { ...state, answer: action.answer }
    case 'tagsChanged':
      return { ...state, tags: action.tags }
    case 'projectChanged':
      return { ...state, manualProjectId: action.projectId }
    case 'captureStarted':
      return { ...state, pending: true, error: null, notice: null }
    case 'captureSucceeded':
      return { ...state, title: '', problem: '', answer: '', tags: '', pending: false }
    case 'blockActionStarted':
      return { ...state, pendingId: action.id, error: null, notice: null }
    case 'pendingFinished':
      return { ...state, pending: false, pendingId: null }
    case 'failed':
      return { ...state, pending: false, pendingId: null, error: action.error, notice: null }
    case 'noticeShown':
      return { ...state, notice: action.notice }
    case 'noticeCleared':
      return { ...state, notice: null }
  }
}

export function KnowledgeHeader({ entryCount }: { entryCount: number }) {
  return (
    <header className="sidebar-header scratchpad-header">
      <div className="scratchpad-header-mark" aria-hidden="true">
        <NotebookPen size={16} />
      </div>
      <div className="scratchpad-header-text">
        <p className="settings-kicker">Knowledge</p>
        <strong>Reusable project answers</strong>
      </div>
      <span className="scratchpad-header-count">
        {entryCount === 0 ? 'empty' : `${entryCount} item${entryCount === 1 ? '' : 's'}`}
      </span>
    </header>
  )
}

export function KnowledgePanel({
  entries,
  projects,
  selectedProjectId,
  onCapture,
  onDelete,
}: {
  entries: readonly KnowledgeEntry[]
  projects: readonly ProjectRow[]
  selectedProjectId: string
  onCapture: (input: KnowledgeAddInput) => Promise<KnowledgeEntry>
  onDelete: (id: string) => Promise<void>
}) {
  const [state, dispatch] = React.useReducer(knowledgeReducer, initialKnowledgeState)
  const captureProjectId = state.manualProjectId ?? selectedProjectId
  const targetProjects = React.useMemo(() => {
    const selected = projects.find((project) => project.id === selectedProjectId)
    return [
      ...(selected ? [selected] : []),
      ...projects.filter((project) => project.id !== selectedProjectId),
    ]
  }, [projects, selectedProjectId])
  const grouped = React.useMemo(() => groupEntriesByProject(entries, projects), [entries, projects])

  React.useEffect(() => {
    if (!state.notice) return undefined
    const timeout = window.setTimeout(() => dispatch({ type: 'noticeCleared' }), 4000)
    return () => window.clearTimeout(timeout)
  }, [state.notice])

  async function submitCapture(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = {
      projectId: captureProjectId,
      title: state.title.trim(),
      problem: state.problem.trim(),
      answer: state.answer.trim(),
      tags: state.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    }
    if (!input.title || !input.problem || !input.answer) return
    dispatch({ type: 'captureStarted' })
    try {
      await onCapture(input)
      dispatch({ type: 'captureSucceeded' })
      dispatch({ type: 'noticeShown', notice: 'Saved knowledge' })
    } catch (cause) {
      dispatch({ type: 'failed', error: errorMessage(cause) })
    }
  }

  async function deleteEntry(id: string) {
    dispatch({ type: 'blockActionStarted', id })
    try {
      await onDelete(id)
      dispatch({ type: 'noticeShown', notice: 'Deleted knowledge' })
    } catch (cause) {
      dispatch({ type: 'failed', error: errorMessage(cause) })
    } finally {
      dispatch({ type: 'pendingFinished' })
    }
  }

  return (
    <div className="scratchpad-panel knowledge-panel" data-testid="knowledge-panel">
      {state.notice ? (
        <div className="scratchpad-toast" role="status" aria-live="polite">
          <Check size={13} aria-hidden="true" />
          {state.notice}
        </div>
      ) : null}
      <form className="scratchpad-capture knowledge-capture" onSubmit={(event) => void submitCapture(event)}>
        <input
          className="knowledge-input"
          value={state.title}
          onChange={(event) => dispatch({ type: 'titleChanged', title: event.currentTarget.value })}
          placeholder="Title"
          disabled={state.pending}
          data-testid="knowledge-title-input"
        />
        <textarea
          value={state.problem}
          onChange={(event) => dispatch({ type: 'problemChanged', problem: event.currentTarget.value })}
          placeholder="Problem"
          rows={2}
          disabled={state.pending}
          data-testid="knowledge-problem-input"
        />
        <textarea
          value={state.answer}
          onChange={(event) => dispatch({ type: 'answerChanged', answer: event.currentTarget.value })}
          placeholder="Answer"
          rows={3}
          disabled={state.pending}
          data-testid="knowledge-answer-input"
        />
        <input
          className="knowledge-input"
          value={state.tags}
          onChange={(event) => dispatch({ type: 'tagsChanged', tags: event.currentTarget.value })}
          placeholder="tags"
          disabled={state.pending}
        />
        <div className="scratchpad-capture-row">
          <div className="scratchpad-capture-project" aria-label="Knowledge target">
            <span>target</span>
            <div className="scratchpad-target-list" role="radiogroup">
              {targetProjects.map((project, index) => {
                const active = captureProjectId === project.id
                return (
                  <button
                    key={project.id}
                    type="button"
                    className="scratchpad-target-chip"
                    data-active={active ? 'true' : undefined}
                    disabled={state.pending}
                    onClick={() => dispatch({ type: 'projectChanged', projectId: project.id })}
                    role="radio"
                    aria-checked={active}
                  >
                    {index === 0 ? 'current' : project.name}
                  </button>
                )
              })}
            </div>
          </div>
          <button
            type="submit"
            disabled={state.pending || !state.title.trim() || !state.problem.trim() || !state.answer.trim()}
          >
            <Plus size={13} />
            Save
          </button>
        </div>
        {state.error ? <p className="scratchpad-error" role="status">{state.error}</p> : null}
      </form>
      <div className="scratchpad-list" role="list">
        {entries.length === 0 ? (
          <div className="scratchpad-empty">
            <p className="settings-kicker">Empty</p>
            <p>No saved answers yet.</p>
          </div>
        ) : (
          grouped.map((group) => (
            <section key={group.projectId} className="scratchpad-group">
              <p className="scratchpad-day">{group.label}</p>
              {group.entries.map((entry) => (
                <article key={entry.id} className="scratchpad-block knowledge-entry" role="listitem">
                  <header className="scratchpad-block-head">
                    <span className="scratchpad-block-kicker">{entry.tags.join(', ') || 'untagged'}</span>
                    <span className="scratchpad-block-time">{formatBlockTime(entry.updatedAt)}</span>
                  </header>
                  <h3>{entry.title}</h3>
                  <p className="scratchpad-block-body">{entry.problem}</p>
                  <p className="knowledge-answer">{entry.answer}</p>
                  <footer className="scratchpad-block-actions">
                    <button
                      type="button"
                      className="scratchpad-block-delete"
                      aria-label={`Delete ${entry.title}`}
                      title={`Delete ${entry.title}`}
                      disabled={state.pendingId === entry.id}
                      onClick={() => void deleteEntry(entry.id)}
                    >
                      <Trash2 size={13} aria-hidden="true" />
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

function groupEntriesByProject(entries: readonly KnowledgeEntry[], projects: readonly ProjectRow[]) {
  const projectNames = new Map(projects.map((project) => [project.id, project.name] as const))
  const groups = new Map<string, KnowledgeEntry[]>()
  for (const entry of entries) {
    const group = groups.get(entry.projectId)
    if (group) group.push(entry)
    else groups.set(entry.projectId, [entry])
  }
  return [...groups.entries()].map(([projectId, groupEntries]) => ({
    projectId,
    label: projectNames.get(projectId) ?? projectId,
    entries: groupEntries,
  }))
}
