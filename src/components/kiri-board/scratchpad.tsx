import { Check, NotebookPen, Plus, Send, Trash2 } from 'lucide-react'
import * as React from 'react'
import type { ProjectRow, RuntimeKind, ScratchpadBlock, SessionInterfaceMode, ThinkingLevel, WorkspaceSnapshot } from '~/lib/contracts'
import { errorMessage, formatBlockDay, formatBlockTime } from './format'
import { supportsThinking } from './slash-commands'
import {
  modelOptions,
  normalizeInterfaceMode,
  normalizeRuntimeModel,
  type RuntimeOption,
  runtimeOption,
  runtimeOptions,
} from './runtime-options'

const scratchpadThinkingLevels = ['off', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly ThinkingLevel[]

type ScratchpadState = {
  draft: string
  manualProjectId: string | null
  pending: boolean
  error: string | null
  notice: string | null
  pendingId: string | null
}

type ScratchpadAction =
  | { type: 'draftChanged'; draft: string }
  | { type: 'projectChanged'; projectId: string }
  | { type: 'captureStarted' }
  | { type: 'captureSucceeded' }
  | { type: 'failed'; error: string }
  | { type: 'noticeShown'; notice: string }
  | { type: 'noticeCleared' }
  | { type: 'pendingFinished' }
  | { type: 'blockActionStarted'; id: string; clearError?: boolean }

const initialScratchpadState: ScratchpadState = {
  draft: '',
  manualProjectId: null,
  pending: false,
  error: null,
  notice: null,
  pendingId: null,
}

function scratchpadReducer(state: ScratchpadState, action: ScratchpadAction): ScratchpadState {
  switch (action.type) {
    case 'draftChanged':
      return { ...state, draft: action.draft }
    case 'projectChanged':
      return { ...state, manualProjectId: action.projectId }
    case 'captureStarted':
      return { ...state, pending: true, error: null, notice: null }
    case 'captureSucceeded':
      return { ...state, draft: '', pending: false }
    case 'failed':
      return { ...state, pending: false, error: action.error, notice: null }
    case 'noticeShown':
      return { ...state, notice: action.notice }
    case 'noticeCleared':
      return { ...state, notice: null }
    case 'pendingFinished':
      return { ...state, pending: false, pendingId: null }
    case 'blockActionStarted':
      return {
        ...state,
        pendingId: action.id,
        error: action.clearError ? null : state.error,
        notice: null,
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
  settings,
  selectedProjectId,
  onCapture,
  onDelete,
  onTrigger,
}: {
  blocks: ScratchpadBlock[]
  projects: ProjectRow[]
  settings: WorkspaceSnapshot['settings']
  selectedProjectId: string
  onCapture: (body: string, projectId: string | null) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onTrigger: (
    block: ScratchpadBlock,
    overrides?: {
      runtime?: RuntimeKind
      interfaceMode?: SessionInterfaceMode
      model?: string
      thinkingLevel?: ThinkingLevel
    },
  ) => Promise<void>
}) {
  const [state, dispatch] = React.useReducer(scratchpadReducer, initialScratchpadState)
  const triggerRuntimes = runtimeOptions(settings)
  const initialTriggerRuntime = initialScratchpadTriggerRuntime(triggerRuntimes)
  if (!initialTriggerRuntime) {
    throw new Error('At least one runtime must be configured')
  }
  const initialTriggerInterfaceMode = initialTriggerRuntime.interfaceModes.includes('terminal')
    ? 'terminal'
    : initialTriggerRuntime.defaultInterfaceMode
  const [triggerRuntime, setTriggerRuntime] = React.useState<RuntimeKind>(initialTriggerRuntime.runtime)
  const [triggerInterfaceMode, setTriggerInterfaceMode] = React.useState<SessionInterfaceMode>(
    initialTriggerInterfaceMode,
  )
  const [triggerModel, setTriggerModel] = React.useState(initialTriggerRuntime.defaultModel)
  const [triggerThinkingLevel, setTriggerThinkingLevel] = React.useState<ThinkingLevel>('medium')
  const captureRef = React.useRef<HTMLTextAreaElement>(null)
  const selectedTriggerRuntime = runtimeOption(settings, triggerRuntime)
  const triggerModels = modelOptions(settings, triggerRuntime)
  const triggerSupportsThinking = supportsThinking(triggerRuntime)
  const triggerInterfaceModes = selectedTriggerRuntime.interfaceModes
  const selectedTriggerInterfaceMode = normalizeInterfaceMode(
    triggerRuntime,
    settings.runtimes[triggerRuntime],
    triggerInterfaceMode,
  )

  React.useEffect(() => {
    captureRef.current?.focus()
  }, [])

  React.useEffect(() => {
    const nextModel = normalizeRuntimeModel(settings, triggerRuntime, triggerModel)
    if (nextModel !== triggerModel) setTriggerModel(nextModel)
  }, [settings, triggerModel, triggerModels, triggerRuntime])

  React.useEffect(() => {
    if (!state.notice) return undefined
    const timeout = window.setTimeout(() => {
      dispatch({ type: 'noticeCleared' })
    }, 4000)
    return () => window.clearTimeout(timeout)
  }, [state.notice])

  function updateTriggerRuntime(runtime: RuntimeKind) {
    setTriggerRuntime(runtime)
    setTriggerModel(settings.runtimes[runtime].defaultModel)
    setTriggerInterfaceMode((current) =>
      current === 'terminal'
        ? normalizeInterfaceMode(runtime, settings.runtimes[runtime], 'terminal')
        : normalizeInterfaceMode(runtime, settings.runtimes[runtime], current))
  }

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
    if (event.key === 'Escape') {
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const form = event.currentTarget.form
      if (form) form.requestSubmit()
    }
  }

  async function handleTrigger(block: ScratchpadBlock) {
    dispatch({ type: 'blockActionStarted', id: block.id, clearError: true })
    const targetProject = projects.find((project) => project.id === block.projectId)?.name
      ?? projects.find((project) => project.id === selectedProjectId)?.name
      ?? 'project'
    dispatch({
      type: 'noticeShown',
      notice: `Starting ${triggerRuntime} in ${targetProject}`,
    })
    try {
      await onTrigger(block, {
        runtime: triggerRuntime,
        interfaceMode: selectedTriggerInterfaceMode,
        model: triggerModel,
        thinkingLevel: triggerThinkingLevel,
      })
      dispatch({
        type: 'noticeShown',
        notice: `Started ${triggerRuntime} in ${targetProject}`,
      })
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
  const targetProjects = React.useMemo(() => {
    const selected = projects.find((project) => project.id === selectedProjectId)
    return [
      ...(selected ? [selected] : []),
      ...projects.filter((project) => project.id !== selectedProjectId),
    ]
  }, [projects, selectedProjectId])

  return (
    <div className="scratchpad-panel" data-testid="scratchpad-panel">
      {state.notice ? (
        <div className="scratchpad-toast" role="status" aria-live="polite">
          <Check size={13} aria-hidden="true" />
          {state.notice}
        </div>
      ) : null}
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
          <div className="scratchpad-capture-project" aria-label="Scratchpad target">
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
                    onClick={() => dispatch({
                      type: 'projectChanged',
                      projectId: project.id,
                    })}
                    role="radio"
                    aria-checked={active}
                  >
                    {index === 0 ? 'current' : project.name}
                  </button>
                )
              })}
              <button
                type="button"
                className="scratchpad-target-chip"
                data-active={captureProjectId === '' ? 'true' : undefined}
                disabled={state.pending}
                onClick={() => dispatch({
                  type: 'projectChanged',
                  projectId: '',
                })}
                role="radio"
                aria-checked={captureProjectId === ''}
              >
                unassigned
              </button>
            </div>
          </div>
          <button type="submit" disabled={state.pending || state.draft.trim().length === 0}>
            <Plus size={13} />
            Capture
          </button>
        </div>
        {state.error ? <p className="scratchpad-error" role="status">{state.error}</p> : null}
      </form>

      <section className="scratchpad-trigger-config" aria-label="Scratchpad trigger profile">
        <div className="scratchpad-trigger-head">
          <span>trigger as</span>
          <strong>{selectedTriggerInterfaceMode} · {triggerRuntime} · {triggerModel} · {triggerThinkingLevel}</strong>
        </div>
        <div className="scratchpad-trigger-row" role="radiogroup" aria-label="Trigger interface">
          {triggerInterfaceModes.map((mode) => {
            const active = selectedTriggerInterfaceMode === mode
            return (
              <button
                key={mode}
                type="button"
                className="scratchpad-trigger-chip"
                data-active={active ? 'true' : undefined}
                onClick={() => setTriggerInterfaceMode(mode)}
                disabled={state.pendingId !== null}
                role="radio"
                aria-checked={active}
              >
                {mode}
              </button>
            )
          })}
        </div>
        <div className="scratchpad-trigger-row" role="radiogroup" aria-label="Trigger runtime">
          {triggerRuntimes.map((option) => {
            const active = triggerRuntime === option.runtime
            return (
              <button
                key={option.runtime}
                type="button"
                className="scratchpad-trigger-chip"
                data-active={active ? 'true' : undefined}
                onClick={() => updateTriggerRuntime(option.runtime)}
                disabled={state.pendingId !== null}
                role="radio"
                aria-checked={active}
              >
                {option.label}
              </button>
            )
          })}
        </div>
        <div className="scratchpad-trigger-row" role="radiogroup" aria-label="Trigger model">
          {triggerModels.map((model) => {
            const active = triggerModel === model.model
            return (
              <button
                key={model.model}
                type="button"
                className="scratchpad-trigger-chip scratchpad-trigger-model"
                data-active={active ? 'true' : undefined}
                onClick={() => setTriggerModel(model.model)}
                disabled={state.pendingId !== null}
                role="radio"
                aria-checked={active}
              >
                <span>{model.model}</span>
                {model.contextLabel ? <code>{model.contextLabel}</code> : null}
              </button>
            )
          })}
        </div>
        <div
          className="scratchpad-trigger-row"
          data-disabled={triggerSupportsThinking ? undefined : 'true'}
          role="radiogroup"
          aria-label="Trigger thinking level"
        >
          {scratchpadThinkingLevels.map((level) => {
            const active = triggerThinkingLevel === level
            return (
              <button
                key={level}
                type="button"
                className="scratchpad-trigger-chip"
                data-active={active ? 'true' : undefined}
                onClick={() => setTriggerThinkingLevel(level)}
                disabled={state.pendingId !== null || !triggerSupportsThinking}
                role="radio"
                aria-checked={active}
              >
                {level}
              </button>
            )
          })}
        </div>
      </section>

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
                      {state.pendingId === block.id ? 'Starting' : block.triggeredAt ? 'Re-trigger' : 'Trigger'}
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

function initialScratchpadTriggerRuntime(options: readonly RuntimeOption[]) {
  return options.find((option) => option.runtime === 'codex' && option.interfaceModes.includes('terminal'))
    ?? options.find((option) => option.interfaceModes.includes('terminal'))
    ?? options[0]
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
