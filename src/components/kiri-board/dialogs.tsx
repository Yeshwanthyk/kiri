'use client'

import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Command,
  Eye,
  EyeOff,
  FolderOpen,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import * as React from 'react'
import type { ArchivedSessionSummary, ProjectRow, RuntimeKind, ThinkingLevel, WorkspaceSnapshot } from '~/lib/contracts'
import { defaultThemeSelection, getKiriThemeTokens, kiriThemeNames, type KiriThemeName, type ThemeMode, type ThemeSelection } from '~/theme/kiri-themes'
import { errorMessage, formatAgo, formatTokenCount, projectNameFromPath, projectSummary } from './format'
import { formatKey, keymapGroups, keyOptions, type KeymapAction, type KeymapSettings } from './navigation'
import { chatFontSizes, defaultChatTypography, monoFonts, type ChatFontSize, type ChatTypographySettings, type MonoFont } from './storage'
import { supportsThinking } from './slash-commands'
import { runtimeCopy, sessionRuntimeOrder, sessionThinkingLevels, type CommandPaletteAction } from './board-types'

export function SettingsScreen({
  keymap,
  themeSelection,
  chatTypography,
  onKeymapChange,
  onKeymapReset,
  onThemeChange,
  onChatTypographyChange,
  onClose,
}: {
  keymap: KeymapSettings
  themeSelection: ThemeSelection
  chatTypography: ChatTypographySettings
  onKeymapChange: (action: KeymapAction, value: string) => void
  onKeymapReset: () => void
  onThemeChange: (selection: ThemeSelection) => void
  onChatTypographyChange: (settings: ChatTypographySettings) => void
  onClose: () => void
}) {
  return (
    <main className="settings-shell" data-testid="settings-page">
      <header className="settings-topbar">
        <button
          type="button"
          className="settings-back"
          onClick={onClose}
          aria-label="Back to board"
          data-testid="settings-back"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          board
        </button>
        <span className="settings-crumb">kiri / settings</span>
      </header>

      <div className="settings-rail" role="region" aria-label="Settings">
        <section className="settings-lane" data-lane="theme" aria-label="Theme">
          <ThemeSettingsPanel selection={themeSelection} onChange={onThemeChange} />
        </section>

        <section className="settings-lane" data-lane="keymap" aria-label="Keymap">
          <KeymapSettingsPanel
            keymap={keymap}
            onChange={onKeymapChange}
            onReset={onKeymapReset}
          />
        </section>

        <section className="settings-lane" data-lane="chat" aria-label="Chat reading size">
          <ChatTypographySettingsPanel
            settings={chatTypography}
            onChange={onChatTypographyChange}
          />
        </section>
      </div>
    </main>
  )
}

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
  const initialLauncherRuntime = initialRuntime ?? 'codex'
  const [runtime, setRuntime] = React.useState<RuntimeKind>(initialLauncherRuntime)
  const [model, setModel] = React.useState(
    settings.runtimes[initialLauncherRuntime].defaultModel,
  )
  const [title, setTitle] = React.useState('')
  const [thinkingLevel, setThinkingLevel] = React.useState<ThinkingLevel>('medium')
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const titleRef = React.useRef<HTMLInputElement>(null)
  const settingsRef = React.useRef(settings)
  const models = settings.runtimes[runtime].models
  const launchProject = projects.find((item) => item.id === launchProjectId) ?? project
  const runtimeSupportsThinking = supportsThinking(runtime)
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
    const nextRuntime = initialRuntime ?? 'codex'
    setRuntime(nextRuntime)
    setModel(settingsRef.current.runtimes[nextRuntime].defaultModel)
  }, [initialProjectId, initialRuntime])

  React.useEffect(() => {
    const runtimeSettings = settings.runtimes[runtime]
    if (!runtimeSettings.models.includes(model)) {
      setModel(runtimeSettings.defaultModel)
    }
  }, [model, runtime, settings])

  function updateRuntime(nextRuntime: RuntimeKind) {
    setRuntime(nextRuntime)
    setModel(settings.runtimes[nextRuntime].defaultModel)
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
        className="session-start-form session-dialog"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
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

            <section className="session-picker-section" aria-label="Runtime">
              <div className="session-picker-head">
                <strong>Runtime</strong>
                <span>Provider is an execution mode.</span>
              </div>
              <div className="session-runtime-grid" data-testid="session-runtime">
                {sessionRuntimeOrder.map((item) => {
                  const copy = runtimeCopy[item]
                  const active = runtime === item
                  return (
                    <button
                      key={item}
                      type="button"
                      className="session-runtime-card"
                      data-active={active ? 'true' : undefined}
                      onClick={() => updateRuntime(item)}
                      disabled={pending}
                      aria-pressed={active}
                    >
                      <span>
                        <strong>{copy.label}</strong>
                        <code>{copy.meta}</code>
                      </span>
                      <small>{copy.detail}</small>
                      <code>{settings.runtimes[item].defaultModel}</code>
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
                  const active = item === model
                  const contextWindow = settings.runtimes[runtime].contextWindows?.[item]
                  return (
                    <button
                      key={item}
                      type="button"
                      className="session-model-chip"
                      data-active={active ? 'true' : undefined}
                      onClick={() => setModel(item)}
                      disabled={pending}
                      aria-pressed={active}
                    >
                      <span>{item}</span>
                      {contextWindow ? <code>{formatTokenCount(contextWindow)}</code> : null}
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
                Start {runtimeCopy[runtime].label} session
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
                        onClick={() => onResumeSession(agent.projectId, agent.id, agent.archived)}
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
                          <span>{formatAgo(agent.updatedAt)}</span>
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

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string
  body: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = React.useRef<HTMLButtonElement | null>(null)

  React.useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  return (
    <>
      <button
        type="button"
        className="session-dialog-scrim"
        onClick={onCancel}
        aria-label="Cancel confirmation"
      />
      <div
        className={`session-dialog confirm-dialog${destructive ? ' confirm-dialog-destructive' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (!busy) onConfirm()
          }
        }}
        data-testid="confirm-dialog"
      >
        <div className="confirm-dialog-head">
          <span className="confirm-dialog-icon" aria-hidden="true">
            <AlertTriangle size={16} />
          </span>
          <div>
            <p className="settings-kicker">Confirm</p>
            <strong id="confirm-dialog-title">{title}</strong>
          </div>
        </div>
        <p className="confirm-dialog-body">{body}</p>
        <div className="session-dialog-actions">
          <button
            type="button"
            className="confirm-dialog-cancel"
            onClick={onCancel}
            disabled={busy}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="confirm-dialog-confirm"
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-dialog-confirm"
          >
            {busy ? 'Removing…' : confirmLabel}
          </button>
        </div>
      </div>
    </>
  )
}

export function ProjectManagerDialog({
  projects,
  hiddenProjects,
  onAdd,
  onChooseDirectory,
  onDelete,
  onHide,
  onReorderProjects,
  onUnhide,
  onClose,
}: {
  projects: ProjectRow[]
  hiddenProjects: ProjectRow[]
  onAdd: (input: { id?: string; name: string; cwd: string }) => Promise<void>
  onChooseDirectory: () => Promise<string>
  onDelete: (projectId: string) => Promise<void>
  onHide: (projectId: string) => Promise<void>
  onReorderProjects: (projectIds: string[]) => Promise<void>
  onUnhide: (projectId: string) => Promise<void>
  onClose: () => void
}) {
  const [id, setId] = React.useState('')
  const [name, setName] = React.useState('')
  const [cwd, setCwd] = React.useState('')
  const [showHidden, setShowHidden] = React.useState(hiddenProjects.length > 0)
  const [pending, setPending] = React.useState(false)
  const [pendingRemoveProject, setPendingRemoveProject] = React.useState<ProjectRow | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const canDeleteVisibleProject = projects.length > 1
  const canDeleteHiddenProject = projects.length + hiddenProjects.length > 1

  React.useEffect(() => {
    if (hiddenProjects.length > 0) setShowHidden(true)
  }, [hiddenProjects.length])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await onAdd({ id: id || undefined, name, cwd })
      setId('')
      setName('')
      setCwd('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  async function chooseDirectory() {
    setPending(true)
    setError(null)
    try {
      const nextCwd = await onChooseDirectory()
      setCwd(nextCwd)
      setName((current) => current || projectNameFromPath(nextCwd))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  async function hide(projectId: string) {
    setPending(true)
    setError(null)
    try {
      await onHide(projectId)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  async function unhide(projectId: string) {
    setPending(true)
    setError(null)
    try {
      await onUnhide(projectId)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  async function moveVisibleProject(projectId: string, direction: -1 | 1) {
    const index = projects.findIndex((project) => project.id === projectId)
    const nextIndex = index + direction
    if (index < 0 || nextIndex < 0 || nextIndex >= projects.length) return

    const nextIds = projects.map((project) => project.id)
    const [movedProjectId] = nextIds.splice(index, 1)
    nextIds.splice(nextIndex, 0, movedProjectId)

    setPending(true)
    setError(null)
    try {
      await onReorderProjects(nextIds)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  async function removeProject(projectId: string) {
    setPending(true)
    setError(null)
    try {
      await onDelete(projectId)
      setPendingRemoveProject(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
    <div className="project-manager-overlay" role="dialog" aria-modal="true">
      <section className="project-settings project-manager" aria-label="Project manager">
        <div className="project-manager-head">
          <div>
            <h2>Projects</h2>
            <p>Add, hide, and restore board rows.</p>
          </div>
          <button type="button" className="settings-close" onClick={onClose}>
            Close projects
          </button>
        </div>
        {error ? <span className="settings-error" role="status">{error}</span> : null}
        <form className="project-add-form" onSubmit={submit}>
          <label className="project-name-field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Project name"
              required
              data-testid="project-name-input"
            />
          </label>
          <label className="project-cwd-field">
            <span>Directory</span>
            <input
              value={cwd}
              onChange={(event) => setCwd(event.currentTarget.value)}
              placeholder="/absolute/path"
              required
              data-testid="project-cwd-input"
            />
          </label>
          <button
            type="button"
            className="project-folder-button"
            disabled={pending}
            onClick={chooseDirectory}
          >
            <FolderOpen size={14} />
            Choose
          </button>
          <label className="project-id-field">
            <span>Id</span>
            <input
              value={id}
              onChange={(event) => setId(event.currentTarget.value)}
              placeholder="optional"
              data-testid="project-id-input"
            />
          </label>
          <button type="submit" className="project-add-button" disabled={pending}>
            <Plus size={14} />
            Add project
          </button>
        </form>
        <div className="project-section-head">
          <span>Visible</span>
          <small>{projects.length} on board</small>
        </div>
        <div className="project-list" data-testid="project-settings-list">
          {projects.map((project, index) => (
            <div key={project.id} className="project-settings-row">
              <div>
                <strong>{project.name}</strong>
                <span>{projectSummary(project)}</span>
              </div>
              <div className="project-row-actions">
                <button
                  type="button"
                  disabled={pending || index === 0}
                  onClick={() => moveVisibleProject(project.id, -1)}
                  aria-label={`Move ${project.name} up`}
                  className="project-order-button"
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  disabled={pending || index === projects.length - 1}
                  onClick={() => moveVisibleProject(project.id, 1)}
                  aria-label={`Move ${project.name} down`}
                  className="project-order-button"
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  disabled={pending || projects.length <= 1}
                  onClick={() => hide(project.id)}
                  aria-label={`Hide ${project.name}`}
                >
                  <EyeOff size={14} />
                </button>
	                <button
	                  type="button"
	                  disabled={pending || !canDeleteVisibleProject}
	                  onClick={() => setPendingRemoveProject(project)}
	                  aria-label={`Remove ${project.name}`}
	                  className="project-remove-button"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="project-section-head">
          <span>Hidden</span>
          <small>{hiddenProjects.length} tucked away</small>
          <button
              type="button"
              className="project-hidden-toggle"
              onClick={() => setShowHidden((visible) => !visible)}
              aria-expanded={showHidden}
          >
            {showHidden ? 'Hide list' : 'Show list'}
          </button>
        </div>
        {showHidden ? <div className="project-list" data-testid="hidden-project-list">
          {hiddenProjects.length === 0 ? (
            <div className="project-settings-row project-empty-row">No hidden projects.</div>
          ) : null}
          {hiddenProjects.map((project) => (
            <div key={project.id} className="project-settings-row">
              <div>
                <strong>{project.name}</strong>
                <span>{projectSummary(project)}</span>
              </div>
              <div className="project-row-actions">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => unhide(project.id)}
                  aria-label={`Unhide ${project.name}`}
                >
                  <Eye size={14} />
                </button>
	                <button
	                  type="button"
	                  disabled={pending || !canDeleteHiddenProject}
	                  onClick={() => setPendingRemoveProject(project)}
	                  aria-label={`Remove ${project.name}`}
                  className="project-remove-button"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div> : null}
      </section>
    </div>
    {pendingRemoveProject ? (
      <ConfirmDialog
        title="Remove project?"
        body={
          <>
            <strong>{pendingRemoveProject.name}</strong> will be removed from kiri. The project directory and files stay on disk.
          </>
        }
        confirmLabel="Remove project"
        cancelLabel="Keep"
        destructive
        busy={pending}
        onConfirm={() => void removeProject(pendingRemoveProject.id)}
        onCancel={() => {
          if (pending) return
          setPendingRemoveProject(null)
        }}
      />
    ) : null}
    </>
  )
}

function ThemeSettingsPanel({
  selection,
  onChange,
}: {
  selection: ThemeSelection
  onChange: (selection: ThemeSelection) => void
}) {
  return (
    <>
      <header className="settings-lane-head">
        <div className="settings-lane-title">
          <p className="settings-kicker">Theme</p>
          <h2>Palette</h2>
          <p>Pick a theme. Mode follows your selection across the board.</p>
        </div>
        <button
          type="button"
          className="settings-reset"
          onClick={() => onChange(defaultThemeSelection)}
          data-testid="theme-reset"
        >
          reset
        </button>
      </header>

      <div className="theme-mode-toggle" role="tablist" aria-label="Theme mode">
        {(['light', 'dark'] as ThemeMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={selection.mode === mode}
            data-active={selection.mode === mode}
            data-testid={`theme-mode-${mode}`}
            onClick={() => onChange({ ...selection, mode })}
          >
            {mode}
          </button>
        ))}
      </div>

      <div className="theme-grid" role="radiogroup" aria-label="Theme name">
        {kiriThemeNames.map((name) => (
          <ThemeCard
            key={name}
            name={name}
            mode={selection.mode}
            selected={selection.name === name}
            onSelect={() => onChange({ name, mode: selection.mode })}
          />
        ))}
      </div>
    </>
  )
}

function ThemeCard({
  name,
  mode,
  selected,
  onSelect,
}: {
  name: KiriThemeName
  mode: ThemeMode
  selected: boolean
  onSelect: () => void
}) {
  const tokens = getKiriThemeTokens({ name, mode })
  const cardStyle = {
    '--tc-paper': tokens.paper,
    '--tc-panel': tokens.panel,
    '--tc-ink': tokens.ink,
    '--tc-muted': tokens.muted,
    '--tc-line': tokens.line,
    '--tc-accent': tokens.accent,
    '--tc-warn': tokens.warn,
  } as React.CSSProperties
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-selected={selected}
      data-testid={`theme-card-${name}`}
      className="theme-card"
      style={cardStyle}
      onClick={onSelect}
    >
      <div className="theme-card-preview" aria-hidden="true">
        <div className="theme-card-rail">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="theme-card-board">
          <div className="row">
            <span className="chip accent" />
            <span className="chip" />
            <span className="chip muted" />
          </div>
          <div className="row">
            <span className="chip" />
            <span className="chip muted" />
            <span className="chip warn" />
          </div>
          <div className="row">
            <span className="chip accent" />
            <span className="chip" />
            <span className="chip muted" />
          </div>
        </div>
      </div>
      <div className="theme-card-meta">
        <span className="theme-card-name">{name}</span>
        <span className="theme-card-swatches" aria-hidden="true">
          <span style={{ background: tokens.accent }} />
          <span style={{ background: tokens.accent2 }} />
          <span style={{ background: tokens.paper }} />
          <span style={{ background: tokens.ink }} />
        </span>
        <span className="theme-card-check" aria-hidden="true">
          <Check size={10} strokeWidth={3} />
        </span>
      </div>
    </button>
  )
}

function ChatTypographySettingsPanel({
  settings,
  onChange,
}: {
  settings: ChatTypographySettings
  onChange: (settings: ChatTypographySettings) => void
}) {
  const current = chatFontSizes[settings.fontSize]
  const previewStyle = {
    '--chat-preview-size': current.size,
    '--chat-preview-line': current.lineHeight,
  } as React.CSSProperties
  return (
    <>
      <header className="settings-lane-head">
        <div className="settings-lane-title">
          <p className="settings-kicker">Typography</p>
          <h2>Reading size &amp; code font</h2>
          <p>Affects chat messages, the composer, and diff rendering.</p>
        </div>
        <button
          type="button"
          className="settings-reset"
          onClick={() => onChange(defaultChatTypography)}
          data-testid="chat-reset"
        >
          reset
        </button>
      </header>

      <div className="settings-subsection">
        <p className="settings-subsection-label">Chat reading size</p>
        <div className="chat-size-options" role="radiogroup" aria-label="Chat font size">
          {(Object.keys(chatFontSizes) as ChatFontSize[]).map((size) => {
            const option = chatFontSizes[size]
            const [label, spec] = option.label.split(' · ')
            const active = settings.fontSize === size
            return (
              <button
                key={size}
                type="button"
                role="radio"
                aria-checked={active}
                data-active={active}
                data-testid={`chat-size-${size}`}
                className="chat-size-option"
                onClick={() => onChange({ ...settings, fontSize: size })}
              >
                <strong>{label}</strong>
                <small>{spec}</small>
              </button>
            )
          })}
        </div>

        <div className="chat-size-preview" style={previewStyle} aria-live="polite">
          <p>
            The model is rendering a diff while you review the previous turn.
            This is roughly how chat copy will read at the selected size.
          </p>
          <small>preview · {current.size} / {current.lineHeight}</small>
        </div>
      </div>

      <div className="settings-subsection">
        <p className="settings-subsection-label">Code &amp; diff font</p>
        <div className="mono-font-options" role="radiogroup" aria-label="Code font">
          {(Object.keys(monoFonts) as MonoFont[]).map((key) => {
            const option = monoFonts[key]
            const active = settings.monoFont === key
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={active}
                data-active={active}
                data-testid={`mono-font-${key}`}
                className="mono-font-option"
                onClick={() => onChange({ ...settings, monoFont: key })}
                style={{ '--mono-preview-stack': option.stack } as React.CSSProperties}
              >
                <span className="mono-font-option-text">
                  <strong>{option.label}</strong>
                  <small>0Oo il1 =&gt; !=</small>
                </span>
                {active ? (
                  <span className="mono-font-check" aria-hidden="true">
                    <Check size={10} strokeWidth={3} />
                  </span>
                ) : (
                  <span className="mono-font-sample" aria-hidden="true">Aa 1·0</span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

function KeymapSettingsPanel({
  keymap,
  onChange,
  onReset,
}: {
  keymap: KeymapSettings
  onChange: (action: KeymapAction, value: string) => void
  onReset: () => void
}) {
  const conflicts = React.useMemo(() => {
    const counts = new Map<string, KeymapAction[]>()
    for (const [action, value] of Object.entries(keymap) as [KeymapAction, string][]) {
      const list = counts.get(value) ?? []
      list.push(action)
      counts.set(value, list)
    }
    const map = new Map<KeymapAction, KeymapAction[]>()
    for (const list of counts.values()) {
      if (list.length < 2) continue
      for (const action of list) {
        map.set(
          action,
          list.filter((other) => other !== action),
        )
      }
    }
    return map
  }, [keymap])

  const actionLabels = React.useMemo(() => {
    const labels: Partial<Record<KeymapAction, string>> = {}
    for (const group of keymapGroups) {
      for (const row of group.rows) labels[row.action] = row.label
    }
    return labels
  }, [])

  return (
    <>
      <header className="settings-lane-head">
        <div className="settings-lane-title">
          <p className="settings-kicker">Keymap</p>
          <h2>Shortcuts</h2>
          <p>Every action takes Shift plus the chosen key.</p>
        </div>
        <button
          type="button"
          className="settings-reset"
          onClick={onReset}
          data-testid="keymap-reset"
        >
          reset
        </button>
      </header>

      {keymapGroups.map((group) => (
        <div key={group.id} className="keymap-group">
          <p className="keymap-group-label">{group.label}</p>
          {group.rows.map((row) => {
            const conflict = conflicts.get(row.action)
            const conflictLabel = conflict
              ?.map((action) => actionLabels[action] ?? action)
              .join(', ')
            return (
              <div
                key={row.action}
                className="keymap-row"
                data-conflict={conflict ? 'true' : 'false'}
              >
                <select
                  value={keymap[row.action]}
                  onChange={(event) => onChange(row.action, event.currentTarget.value)}
                  data-testid={`keymap-${row.action}`}
                  aria-label={row.label}
                >
                  {keyOptions.map((key) => (
                    <option key={key} value={key}>
                      ⇧ {formatKey(key)}
                    </option>
                  ))}
                </select>
                <div className="keymap-row-meta">
                  <strong>{row.label}</strong>
                  <small>{conflict ? `Shared with ${conflictLabel}` : row.hint}</small>
                </div>
              </div>
            )
          })}
        </div>
      ))}

      <div className="keymap-static" aria-label="Command menu shortcut">
        <span className="keymap-static-chip">⌘K</span>
        <div className="keymap-row-meta">
          <strong>Command menu</strong>
          <small>Fixed binding · ⌘K or Ctrl+K</small>
        </div>
      </div>
    </>
  )
}

export function CommandPalette({
  actions,
  onClose,
}: {
  actions: CommandPaletteAction[]
  onClose: () => void
}) {
  const [query, setQuery] = React.useState('')
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const normalizedQuery = query.trim().toLowerCase()
  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean)
  const filteredActions = actions.filter((action) => {
    const haystack = `${action.title} ${action.detail}`.toLowerCase()
    return queryTerms.every((term) => haystack.includes(term))
  })
  const visibleActions = normalizedQuery ? filteredActions : filteredActions.slice(0, 7)
  const selectedAction = visibleActions[selectedIndex]

  React.useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  React.useEffect(() => {
    if (selectedIndex >= visibleActions.length) setSelectedIndex(0)
  }, [selectedIndex, visibleActions.length])

  function moveSelection(delta: number) {
    const enabledIndexes = visibleActions.flatMap((action, index) =>
      action.disabled ? [] : [index],
    )
    if (enabledIndexes.length === 0) return

    const currentEnabledIndex = enabledIndexes.indexOf(selectedIndex)
    const nextEnabledIndex =
      currentEnabledIndex < 0
        ? 0
        : (currentEnabledIndex + delta + enabledIndexes.length) % enabledIndexes.length
    setSelectedIndex(enabledIndexes[nextEnabledIndex])
  }

  function submit(action: CommandPaletteAction | undefined) {
    const fallbackAction = visibleActions.find((item) => !item.disabled)
    const actionToRun = action && !action.disabled ? action : fallbackAction
    if (!actionToRun) return
    actionToRun.run()
  }

  return (
    <div className="command-panel" role="dialog" aria-label="Command menu">
      <div className="command-search">
        <Command size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveSelection(1)
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveSelection(-1)
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              submit(selectedAction)
            }
          }}
          aria-activedescendant={selectedAction ? `command-${selectedAction.id}` : undefined}
          placeholder="Start, end, or switch"
          aria-label="Command search"
          data-testid="command-search"
        />
        <span>⌘K</span>
      </div>
      <div className="command-list" role="listbox">
        {visibleActions.length > 0 ? (
          visibleActions.map((action, index) => {
            const Icon = action.icon
            return (
              <button
                key={action.id}
                type="button"
                id={`command-${action.id}`}
                className={`command-item ${index === selectedIndex ? 'active' : ''}`}
                disabled={action.disabled}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => submit(action)}
              >
                <Icon size={15} aria-hidden="true" />
                <span>
                  <strong>{action.title}</strong>
                  <small>{action.detail}</small>
                </span>
              </button>
            )
          })
        ) : (
          <p className="command-empty">No command matches.</p>
        )}
      </div>
    </div>
  )
}

function Keycap({ value }: { value: string }) {
  const iconSize = 13
  if (value === 'arrowup') return <ArrowUp size={iconSize} />
  if (value === 'arrowdown') return <ArrowDown size={iconSize} />
  if (value === 'arrowleft') return <ArrowLeft size={iconSize} />
  if (value === 'arrowright') return <ArrowRight size={iconSize} />
  return <kbd>{formatKey(value)}</kbd>
}
