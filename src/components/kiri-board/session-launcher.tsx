'use client'

import {
  Bot,
  Check,
  ChevronDown,
  Command,
  FolderOpen,
  Plus,
  Search,
} from 'lucide-react'
import * as React from 'react'
import type {
  ArchivedSessionSummary,
  ProjectRow,
  RuntimeKind,
  SessionInterfaceMode,
  ThinkingLevel,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import { errorMessage, formatAgo } from './format'
import { supportsThinking } from './slash-commands'
import { sessionThinkingLevels } from './board-types'
import { trapTabFocus, useFocusReturn } from './dialog-focus'
import { modelOptions, normalizeInterfaceMode, normalizeRuntimeModel, runtimeOption, runtimeOptions } from './runtime-options'

export function InlineSessionLauncher({
  project,
  projects,
  archivedSessions,
  selectedAgentId,
  settings,
  initialProjectId,
  initialRuntime,
  onStartSession,
  onResumeSession,
  onCancel,
}: {
  project: ProjectRow
  projects: ProjectRow[]
  archivedSessions: ArchivedSessionSummary[]
  selectedAgentId: string
  settings: WorkspaceSnapshot['settings']
  initialProjectId?: string
  initialRuntime?: RuntimeKind
  onStartSession: (input: {
    projectId: string
    runtime: RuntimeKind
    interfaceMode: SessionInterfaceMode
    model?: string
    title?: string
    thinkingLevel: ThinkingLevel
  }) => Promise<void>
  onResumeSession: (projectId: string, agentId: string, archived: boolean) => void | Promise<void>
  onCancel: () => void
}) {
  const [mode, setMode] = React.useState<'new' | 'resume'>('new')
  const [launchProjectId, setLaunchProjectId] = React.useState(initialProjectId ?? project.id)
  const [projectQuery, setProjectQuery] = React.useState('')
  const [projectPickerOpen, setProjectPickerOpen] = React.useState(false)
  const initialRuntimeOption = initialRuntime
    ? runtimeOption(settings, initialRuntime)
    : runtimeOptions(settings)[0]
  if (!initialRuntimeOption) {
    throw new Error('At least one runtime must be configured')
  }
  const initialLauncherRuntime = initialRuntimeOption.runtime
  const [runtime, setRuntime] = React.useState<RuntimeKind>(initialLauncherRuntime)
  const [interfaceMode, setInterfaceMode] = React.useState<SessionInterfaceMode>(
    initialRuntimeOption.defaultInterfaceMode,
  )
  const [model, setModel] = React.useState(initialRuntimeOption.defaultModel)
  const [title, setTitle] = React.useState('')
  const [thinkingLevel, setThinkingLevel] = React.useState<ThinkingLevel>('medium')
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const launcherRef = React.useRef<HTMLFormElement | null>(null)
  const titleRef = React.useRef<HTMLInputElement>(null)
  const settingsRef = React.useRef(settings)
  const runtimes = runtimeOptions(settings)
  const selectedRuntime = runtimeOption(settings, runtime)
  const models = modelOptions(settings, runtime)
  const launchProject = projects.find((item) => item.id === launchProjectId) ?? project
  const runtimeSupportsThinking = supportsThinking(runtime)
  const availableInterfaceModes = selectedRuntime.interfaceModes
  const selectedInterfaceMode = normalizeInterfaceMode(runtime, settings.runtimes[runtime], interfaceMode)
  const normalizedProjectQuery = projectQuery.trim().toLowerCase()
  const visibleTargetProjects = projects.filter((item) => {
    if (!normalizedProjectQuery) return true
    return `${item.name} ${item.cwd}`.toLowerCase().includes(normalizedProjectQuery)
  })
  const activeResumableSessions = projects.flatMap((item) =>
    item.agents.flatMap((agent) =>
      agent.isSession
        ? [{
          archived: false as const,
          id: agent.id,
          projectId: item.id,
          projectName: item.name,
          title: agent.title,
          runtime: agent.runtime,
          model: agent.model,
          status: agent.status,
          preview: agent.preview,
          updatedAt: agent.updatedAt,
        }]
        : [],
    ),
  )
  const archivedResumableSessions = archivedSessions.map((agent) => ({
    archived: true as const,
    id: agent.id,
    projectId: agent.projectId,
    projectName: agent.projectName,
    title: agent.title,
    runtime: agent.runtime,
    model: agent.model,
    status: agent.status,
    preview: agent.preview,
    updatedAt: agent.updatedAt,
  }))
  const resumableSessions = [...activeResumableSessions, ...archivedResumableSessions]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 10)

  useFocusReturn()

  React.useEffect(() => {
    if (mode === 'new') titleRef.current?.focus()
  }, [mode])

  React.useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  React.useEffect(() => {
    setLaunchProjectId(initialProjectId ?? project.id)
  }, [initialProjectId, project.id])

  React.useEffect(() => {
    const nextRuntimeOption = initialRuntime
      ? runtimeOption(settingsRef.current, initialRuntime)
      : runtimeOptions(settingsRef.current)[0]
    if (!nextRuntimeOption) return
    setRuntime(nextRuntimeOption.runtime)
    setModel(nextRuntimeOption.defaultModel)
    setInterfaceMode(nextRuntimeOption.defaultInterfaceMode)
  }, [initialProjectId, initialRuntime])

  React.useEffect(() => {
    const nextModel = normalizeRuntimeModel(settings, runtime, model)
    if (nextModel !== model) setModel(nextModel)
  }, [model, runtime, settings])

  function updateRuntime(nextRuntime: RuntimeKind) {
    setRuntime(nextRuntime)
    setModel(settings.runtimes[nextRuntime].defaultModel)
    setInterfaceMode((current) =>
      normalizeInterfaceMode(nextRuntime, settings.runtimes[nextRuntime], current))
  }

  function selectLaunchProject(projectId: string) {
    setLaunchProjectId(projectId)
    setProjectPickerOpen(false)
    setProjectQuery('')
    titleRef.current?.focus()
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await onStartSession({
        projectId: launchProject.id,
        runtime,
        interfaceMode: selectedInterfaceMode,
        model,
        title: title || undefined,
        thinkingLevel,
      })
      setTitle('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="session-dialog-scrim"
        onClick={onCancel}
        aria-label="Close session launcher"
      />
      <form
        ref={launcherRef}
        className="session-start-form session-dialog"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          trapTabFocus(event, launcherRef.current)
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-dialog-title"
        data-testid="session-launcher"
      >
        <div className="session-launcher-head">
          <span className="session-dialog-icon" aria-hidden="true">
            <Bot size={16} />
          </span>
          <div>
            <p className="settings-kicker">Session launcher</p>
            <strong id="session-dialog-title">{launchProject.name}</strong>
            <small>{mode === 'new' ? 'Pick a runtime, then launch into chat.' : 'Jump back into a local session.'}</small>
          </div>
          <button className="session-close-button" type="button" onClick={onCancel} aria-label="Close session launcher">
            ×
          </button>
        </div>

        <div className="session-launcher-tabs" role="tablist" aria-label="Session launcher mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'new'}
            data-active={mode === 'new' ? 'true' : undefined}
            onClick={() => setMode('new')}
          >
            New
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'resume'}
            data-active={mode === 'resume' ? 'true' : undefined}
            onClick={() => setMode('resume')}
          >
            Resume
          </button>
        </div>

        {mode === 'new' ? (
          <>
            <div className="session-target-row">
              <span>Target</span>
              <button
                type="button"
                className="session-target-button"
                aria-expanded={projectPickerOpen}
                onClick={() => setProjectPickerOpen((open) => !open)}
                disabled={pending}
              >
                <FolderOpen size={14} aria-hidden="true" />
                <strong>{launchProject.name}</strong>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              {projectPickerOpen ? (
                <div className="session-project-picker">
                  <label className="session-project-search">
                    <Search size={13} aria-hidden="true" />
                    <input
                      value={projectQuery}
                      onChange={(event) => setProjectQuery(event.currentTarget.value)}
                      placeholder="Search projects"
                      aria-label="Search projects"
                    />
                  </label>
                  <div className="session-project-list" role="listbox" aria-label="Project target">
                    {visibleTargetProjects.length > 0 ? visibleTargetProjects.map((item, index) => {
                      const active = item.id === launchProject.id
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className="session-project-option"
                          data-active={active ? 'true' : undefined}
                          onClick={() => selectLaunchProject(item.id)}
                          role="option"
                          aria-selected={active}
                        >
                          <span className="session-project-initial" aria-hidden="true">
                            {item.name.slice(0, 1).toLowerCase()}
                          </span>
                          <span>
                            <strong>{item.name}</strong>
                            <small>{item.cwd}</small>
                          </span>
                          <kbd>{index === 0 ? 'Enter' : index + 1}</kbd>
                        </button>
                      )
                    }) : (
                      <p className="session-project-empty">No project matches.</p>
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <label className="session-command-field">
              <Command size={16} aria-hidden="true" />
              <input
                ref={titleRef}
                value={title}
                disabled={pending}
                placeholder="Name this session (optional)"
                aria-label="Session name"
                data-testid="session-title"
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
              <span>optional</span>
            </label>

            <section className="session-picker-section" aria-label="Interface">
              <div className="session-picker-head">
                <strong>Interface</strong>
                <span>Chat tab can be GUI or agent terminal.</span>
              </div>
              <div className="session-thinking-list" data-testid="session-interface-mode">
                {availableInterfaceModes.map((item) => {
                  const active = selectedInterfaceMode === item
                  return (
                    <button
                      key={item}
                      type="button"
                      className="session-thinking-chip"
                      data-active={active ? 'true' : undefined}
                      onClick={() => setInterfaceMode(item)}
                      disabled={pending}
                      aria-pressed={active}
                    >
                      {item === 'gui' ? 'GUI' : 'Terminal'}
                    </button>
                  )
                })}
              </div>
            </section>

            <section className="session-picker-section" aria-label="Runtime">
              <div className="session-picker-head">
                <strong>Runtime</strong>
                <span>Provider is an execution mode.</span>
              </div>
              <div className="session-runtime-grid" data-testid="session-runtime">
                {runtimes.map((item) => {
                  const active = runtime === item.runtime
                  return (
                    <button
                      key={item.runtime}
                      type="button"
                      className="session-runtime-card"
                      data-active={active ? 'true' : undefined}
                      onClick={() => updateRuntime(item.runtime)}
                      disabled={pending}
                      aria-pressed={active}
                    >
                      <span>
                        <strong>{item.label}</strong>
                        <code>{item.meta}</code>
                      </span>
                      <small>{item.detail}</small>
                      <code>{item.defaultModel}</code>
                    </button>
                  )
                })}
              </div>
            </section>

            <section className="session-picker-section" aria-label="Model">
              <div className="session-picker-head">
                <strong>Model</strong>
                <span>Chips first. Search only when the set gets large.</span>
              </div>
              <div className="session-model-list" data-testid="session-model">
                {models.map((item) => {
                  const active = item.model === model
                  return (
                    <button
                      key={item.model}
                      type="button"
                      className="session-model-chip"
                      data-active={active ? 'true' : undefined}
                      onClick={() => setModel(item.model)}
                      disabled={pending}
                      aria-pressed={active}
                    >
                      <span>{item.model}</span>
                      {item.contextLabel ? <code>{item.contextLabel}</code> : null}
                    </button>
                  )
                })}
              </div>
            </section>

            <section
              className="session-picker-section"
              data-disabled={runtimeSupportsThinking ? undefined : 'true'}
              aria-label="Thinking"
            >
              <div className="session-picker-head">
                <strong>Thinking</strong>
                <span>{runtimeSupportsThinking ? 'Default is medium.' : `${runtime} does not support thinking.`}</span>
              </div>
              <div className="session-thinking-list" data-testid="session-thinking-level">
                {sessionThinkingLevels.map((item) => {
                  const active = thinkingLevel === item
                  return (
                    <button
                      key={item}
                      type="button"
                      className="session-thinking-chip"
                      data-active={active ? 'true' : undefined}
                      onClick={() => setThinkingLevel(item)}
                      disabled={pending || !runtimeSupportsThinking}
                      aria-pressed={active}
                    >
                      {item}
                    </button>
                  )
                })}
              </div>
            </section>

            <div className="session-dialog-actions">
              {error ? <span role="status">{error}</span> : null}
              <button type="submit" disabled={pending}>
                <Plus size={14} />
                Start {selectedRuntime.label} session
              </button>
            </div>
          </>
        ) : (
          <div className="session-resume-panel" role="tabpanel">
            {resumableSessions.length === 0 ? (
              <div className="session-resume-empty">
                <strong>No local sessions</strong>
                <span>Start one first, then it will appear here.</span>
              </div>
            ) : (
              <>
                <div className="session-resume-kicker">Last {resumableSessions.length} local sessions</div>
                <div className="session-resume-list">
                  {resumableSessions.map((agent) => {
                    const selected = agent.id === selectedAgentId
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        className="session-resume-row"
                        data-active={selected ? 'true' : undefined}
                        onClick={() => void onResumeSession(agent.projectId, agent.id, agent.archived)}
                      >
                        <span className={`status-dot ${agent.status}`} aria-hidden="true" />
                        <span className="session-resume-main">
                          <strong>{agent.title}</strong>
                          <span>{agent.projectName}: {agent.preview || 'Ready.'}</span>
                        </span>
                        <span className="session-resume-meta">
                          {agent.archived ? <span>archived</span> : null}
                          <span>{agent.runtime}</span>
                          <span>{agent.model}</span>
                          <span suppressHydrationWarning>{formatAgo(agent.updatedAt)}</span>
                        </span>
                        {selected ? <Check size={14} aria-hidden="true" /> : null}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </form>
    </>
  )
}
