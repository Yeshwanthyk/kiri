'use client'

import {
  Bot,
  Check,
  Plus,
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
import { trapTabFocus, useFocusReturn } from './dialog-focus'
import { normalizeInterfaceMode, runtimeOption, runtimeOptions } from './runtime-options'

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
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const launcherRef = React.useRef<HTMLFormElement | null>(null)
  const runtimeButtonRefs = React.useRef(new Map<RuntimeKind, HTMLButtonElement>())
  const settingsRef = React.useRef(settings)
  const runtimes = runtimeOptions(settings)
  const selectedRuntime = runtimeOption(settings, runtime)
  const launchProject = projects.find((item) => item.id === launchProjectId) ?? project
  const availableInterfaceModes = selectedRuntime.interfaceModes
  const canChooseInterfaceMode = availableInterfaceModes.length > 1
  const selectedInterfaceMode = normalizeInterfaceMode(runtime, settings.runtimes[runtime], interfaceMode)
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
    if (mode === 'new') runtimeButtonRefs.current.get(runtime)?.focus()
  }, [mode, runtime])

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
    setInterfaceMode(nextRuntimeOption.defaultInterfaceMode)
  }, [initialProjectId, initialRuntime])

  function updateRuntime(nextRuntime: RuntimeKind) {
    setRuntime(nextRuntime)
    setInterfaceMode((current) =>
      normalizeInterfaceMode(nextRuntime, settings.runtimes[nextRuntime], current))
  }

  async function startSession() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await onStartSession({
        projectId: launchProject.id,
        runtime,
        interfaceMode: selectedInterfaceMode,
        thinkingLevel: 'medium',
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await startSession()
  }

  function selectRuntimeByNumber(key: string) {
    const number = Number(key)
    if (!Number.isInteger(number) || number < 1) return false
    const option = runtimes[number - 1]
    if (!option) return false
    updateRuntime(option.runtime)
    runtimeButtonRefs.current.get(option.runtime)?.focus()
    return true
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }

    if (mode === 'new' && !pending) {
      if (selectRuntimeByNumber(event.key)) {
        event.preventDefault()
        return
      }
      if (event.key === 'Enter' && isRuntimeCardTarget(event.target)) {
        event.preventDefault()
        void startSession()
        return
      }
    }

    trapTabFocus(event, launcherRef.current)
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
        onKeyDown={handleKeyDown}
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
            <small>{mode === 'new' ? 'Pick a provider. Tune the session after it starts.' : 'Jump back into a local session.'}</small>
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
            <section className="session-picker-section" aria-label="Provider">
              <div className="session-picker-head">
                <strong>Provider</strong>
                <span>{launchProject.cwd}</span>
              </div>
              <div className="session-runtime-grid" data-testid="session-runtime">
                {runtimes.map((item, index) => {
                  const active = runtime === item.runtime
                  const shortcut = String(index + 1)
                  return (
                    <button
                      key={item.runtime}
                      ref={(node) => {
                        if (node) runtimeButtonRefs.current.set(item.runtime, node)
                        else runtimeButtonRefs.current.delete(item.runtime)
                      }}
                      type="button"
                      className="session-runtime-card"
                      data-session-runtime-card="true"
                      data-active={active ? 'true' : undefined}
                      onClick={() => updateRuntime(item.runtime)}
                      disabled={pending}
                      aria-pressed={active}
                      aria-keyshortcuts={shortcut}
                    >
                      <span className="session-runtime-card-head">
                        <span className="session-runtime-name">
                          <kbd className="session-runtime-shortcut" aria-hidden="true">{shortcut}</kbd>
                          <strong>{item.label}</strong>
                        </span>
                        <code>{item.meta}</code>
                      </span>
                      <small>{item.detail}</small>
                    </button>
                  )
                })}
              </div>
            </section>

            {canChooseInterfaceMode ? (
              <section className="session-picker-section" aria-label="Interface">
                <div className="session-picker-head">
                  <strong>Interface</strong>
                  <span>{selectedRuntime.label} supports both.</span>
                </div>
                <div className="session-interface-list" data-testid="session-interface-mode">
                  {availableInterfaceModes.map((item) => {
                    const active = selectedInterfaceMode === item
                    return (
                      <button
                        key={item}
                        type="button"
                        className="session-interface-chip"
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
            ) : null}

            <div className="session-dialog-actions">
              {error ? <span role="status">{error}</span> : null}
              <button type="submit" disabled={pending}>
                <Plus size={14} />
                Start session
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

function isRuntimeCardTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && target.closest('[data-session-runtime-card="true"]') !== null
}
