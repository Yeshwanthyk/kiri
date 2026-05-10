'use client'

import { PatchDiff } from '@pierre/diffs/react'
import { useServerFn } from '@tanstack/react-start'
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Circle,
  GitPullRequest,
  MessageSquareText,
  PanelRight,
  Plus,
  Send,
  Settings2,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import * as React from 'react'
import type {
  AgentCell,
  ProjectRow,
  RuntimeKind,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import {
  addProjectMutation,
  deleteProjectMutation,
  deleteSessionMutation,
  sendMessageMutation,
  startSessionMutation,
} from '~/server/workspace'

type SidebarTab = 'chat' | 'diffs' | 'artifacts'
type KeymapAction =
  | 'projectPrev'
  | 'projectNext'
  | 'agentPrev'
  | 'agentNext'
  | 'startSession'
  | 'deleteSession'

type KeymapSettings = Record<KeymapAction, string>

type Selection = {
  projectId: string
  agentId: string
}

const defaultKeymap: KeymapSettings = {
  projectPrev: 'k',
  projectNext: 'j',
  agentPrev: 'h',
  agentNext: 'l',
  startSession: 'n',
  deleteSession: 'x',
}

const keyOptions = [
  'h',
  'j',
  'k',
  'l',
  'n',
  'x',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]
const keymapStorageKey = 'pican:keymap:v1'

export function PicanBoard({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [workspace, setWorkspace] = React.useState(snapshot)
  const [selection, setSelection] = React.useState<Selection>(snapshot.selected)
  const [tab, setTab] = React.useState<SidebarTab>('chat')
  const [hydrated, setHydrated] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [sessionLauncherOpen, setSessionLauncherOpen] = React.useState(false)
  const [keymap, setKeymap] = React.useState<KeymapSettings>(defaultKeymap)
  const addProject = useServerFn(addProjectMutation)
  const deleteProject = useServerFn(deleteProjectMutation)
  const deleteSession = useServerFn(deleteSessionMutation)
  const sendMessage = useServerFn(sendMessageMutation)
  const startSession = useServerFn(startSessionMutation)

  const selectedProject =
    workspace.projects.find((project) => project.id === selection.projectId) ??
    workspace.projects[0]
  const selectedAgent =
    selectedProject?.agents.find((agent) => agent.id === selection.agentId) ??
    selectedProject?.agents[0]

  React.useEffect(() => {
    setWorkspace(snapshot)
  }, [snapshot])

  React.useEffect(() => {
    if (!selectedProject) return
    const agentId = selectedAgent?.id ?? ''
    if (selectedProject.id !== selection.projectId || agentId !== selection.agentId) {
      setSelection({ projectId: selectedProject.id, agentId })
    }
  }, [selectedAgent, selectedProject, selection.agentId, selection.projectId])

  React.useEffect(() => {
    setHydrated(true)
    setKeymap(readStoredKeymap())
  }, [])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.shiftKey || isEditableTarget(event.target)) return

      const key = event.key.toLowerCase()
      const action = actionForKey(keymap, key)
      if (!action) return
      event.preventDefault()

      if (action === 'startSession') {
        setSettingsOpen(false)
        setSessionLauncherOpen(true)
        return
      }

      if (action === 'deleteSession') {
        const project =
          workspace.projects.find((row) => row.id === selection.projectId) ??
          workspace.projects[0]
        const agent = project?.agents.find((row) => row.id === selection.agentId)
        if (agent?.isSession) {
          void handleDeleteSession(agent.id)
        }
        return
      }

      if (action === 'projectPrev' || action === 'projectNext') {
        setSelection((current) =>
          moveProject(workspace.projects, current, action === 'projectNext' ? 1 : -1),
        )
        return
      }

      setSelection((current) => {
        const project =
          workspace.projects.find((row) => row.id === current.projectId) ??
          workspace.projects[0]
        if (!project) return current
        return moveAgent(project, current, action === 'agentNext' ? 1 : -1)
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keymap, workspace.projects])

  async function handleAddProject(input: { id?: string; name: string; cwd: string }) {
    const next = await addProject({ data: input })
    setWorkspace(next)
  }

  async function handleDeleteProject(projectId: string) {
    const next = await deleteProject({ data: { id: projectId } })
    setWorkspace(next)
  }

  async function handleDeleteSession(agentId: string) {
    const agent = selectedProject.agents.find((item) => item.id === agentId)
    if (!agent) return
    if (!window.confirm(`Remove session "${agent.title}"?`)) return

    const currentProjectId = selectedProject.id
    const currentProject = selectedProject
    const currentIndex = currentProject.agents.findIndex((agent) => agent.id === agentId)
    const next = await deleteSession({ data: { agentId } })
    setWorkspace(next)
    const project =
      next.projects.find((item) => item.id === currentProjectId) ?? next.projects[0]
    if (!project) return
    const fallbackAgent =
      project.agents[Math.max(0, Math.min(currentIndex - 1, project.agents.length - 1))]
    if (fallbackAgent) {
      setSelection({ projectId: project.id, agentId: fallbackAgent.id })
    } else {
      setSelection({ projectId: project.id, agentId: '' })
    }
  }

  async function handleSendMessage(agentId: string, text: string) {
    const next = await sendMessage({ data: { agentId, text } })
    setWorkspace(next)
  }

  async function handleStartSession(input: {
    projectId: string
    runtime: RuntimeKind
    model?: string
    title?: string
  }) {
    const next = await startSession({ data: input })
    setWorkspace(next)
    const project = next.projects.find((item) => item.id === input.projectId)
    const agent =
      (input.title
        ? project?.agents.find((item) => item.title === input.title)
        : undefined) ?? project?.agents[project.agents.length - 1]
    if (project && agent) {
      setSelection({ projectId: project.id, agentId: agent.id })
    }
    setSessionLauncherOpen(false)
  }

  if (!selectedProject) {
    return <div className="empty-shell">No projects configured.</div>
  }

  if (settingsOpen) {
    return (
      <SettingsScreen
        workspace={workspace}
        keymap={keymap}
        onKeymapChange={(action, value) =>
          setKeymap((current) => updateKeymap(current, action, value))
        }
        onKeymapReset={() => setKeymap(saveKeymap(defaultKeymap))}
        onAddProject={handleAddProject}
        onDeleteProject={handleDeleteProject}
        onClose={() => setSettingsOpen(false)}
      />
    )
  }

  return (
    <main className="pican-shell">
      <section
        className="board-pane"
        aria-label="Projects and agents"
        data-hydrated={hydrated ? 'true' : 'false'}
        data-testid="board-pane"
      >
        <header className="topbar">
          <div>
            <p className="eyebrow">pican</p>
            <h1>Kanban Orchestrator</h1>
          </div>
          <div className="keymap" aria-label="Keyboard shortcuts">
            <span>
              <Keycap value={keymap.projectPrev} />
              <Keycap value={keymap.projectNext} />
              projects
            </span>
            <span>
              <Keycap value={keymap.agentPrev} />
              <Keycap value={keymap.agentNext} />
              agents
            </span>
            <span>
              <Keycap value={keymap.startSession} />
              new session
            </span>
            <span>
              <Keycap value={keymap.deleteSession} />
              remove session
            </span>
            <button
              type="button"
              className="settings-trigger"
              aria-expanded={sessionLauncherOpen}
              onClick={() => setSessionLauncherOpen((open) => !open)}
              data-testid="start-session-trigger"
            >
              <Plus size={14} />
              Start
            </button>
            <button
              type="button"
              className="settings-trigger"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings2 size={14} />
              Settings
            </button>
          </div>
        </header>

        {sessionLauncherOpen ? (
          <InlineSessionLauncher
            project={selectedProject}
            settings={workspace.settings}
            onStartSession={handleStartSession}
            onCancel={() => setSessionLauncherOpen(false)}
          />
        ) : null}

        <div className="board-grid">
          {workspace.projects.map((project) => (
            <ProjectLane
              key={project.id}
              project={project}
              selectedAgentId={selection.agentId}
              selectedProjectId={selection.projectId}
              onSelect={(agentId) =>
                setSelection({ projectId: project.id, agentId })
              }
            />
          ))}
        </div>
      </section>

      <aside
        className="sidebar-pane"
        aria-label="Selected chat"
        data-testid="sidebar-pane"
      >
        {selectedAgent ? (
          <>
            <SidebarHeader
              project={selectedProject}
              agent={selectedAgent}
              onDeleteSession={handleDeleteSession}
            />
            <div className="sidebar-tabs" role="tablist">
              <button
                type="button"
                className={tab === 'chat' ? 'active' : ''}
                onClick={() => setTab('chat')}
                data-testid="tab-chat"
              >
                <MessageSquareText size={15} />
                Chat
              </button>
              <button
                type="button"
                className={tab === 'diffs' ? 'active' : ''}
                onClick={() => setTab('diffs')}
                data-testid="tab-diffs"
              >
                <GitPullRequest size={15} />
                Diffs
              </button>
              <button
                type="button"
                className={tab === 'artifacts' ? 'active' : ''}
                onClick={() => setTab('artifacts')}
                data-testid="tab-artifacts"
              >
                <PanelRight size={15} />
                Artifacts
              </button>
            </div>

            {tab === 'chat' ? (
              <ChatPanel agent={selectedAgent} onSend={handleSendMessage} />
            ) : null}
            {tab === 'diffs' ? <DiffPanel agent={selectedAgent} /> : null}
            {tab === 'artifacts' ? <ArtifactsPanel agent={selectedAgent} /> : null}
          </>
        ) : (
          <EmptySessionPanel
            project={selectedProject}
            onStart={() => setSessionLauncherOpen(true)}
          />
        )}
      </aside>
    </main>
  )
}

function SettingsScreen({
  workspace,
  keymap,
  onKeymapChange,
  onKeymapReset,
  onAddProject,
  onDeleteProject,
  onClose,
}: {
  workspace: WorkspaceSnapshot
  keymap: KeymapSettings
  onKeymapChange: (action: KeymapAction, value: string) => void
  onKeymapReset: () => void
  onAddProject: (input: { id?: string; name: string; cwd: string }) => Promise<void>
  onDeleteProject: (projectId: string) => Promise<void>
  onClose: () => void
}) {
  return (
    <main className="settings-shell" data-testid="settings-page">
      <header className="settings-hero">
        <div>
          <p className="eyebrow">settings</p>
          <h1>Workspace Settings</h1>
        </div>
        <button type="button" className="settings-close" onClick={onClose}>
          Back to board
        </button>
      </header>

      <div className="settings-layout">
        <section className="settings-section">
          <KeymapSettingsPanel
            keymap={keymap}
            onChange={onKeymapChange}
            onReset={onKeymapReset}
          />
        </section>

        <section className="settings-section">
          <ProjectSettingsPanel
            projects={workspace.projects}
            onAdd={onAddProject}
            onDelete={onDeleteProject}
          />
        </section>
      </div>
    </main>
  )
}

function InlineSessionLauncher({
  project,
  settings,
  onStartSession,
  onCancel,
}: {
  project: ProjectRow
  settings: WorkspaceSnapshot['settings']
  onStartSession: (input: {
    projectId: string
    runtime: RuntimeKind
    model?: string
    title?: string
  }) => Promise<void>
  onCancel: () => void
}) {
  const [runtime, setRuntime] = React.useState<RuntimeKind>('pi')
  const [model, setModel] = React.useState(settings.runtimes.pi.defaultModel)
  const [title, setTitle] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const runtimes = Object.keys(settings.runtimes) as RuntimeKind[]
  const models = settings.runtimes[runtime].models

  function updateRuntime(nextRuntime: RuntimeKind) {
    setRuntime(nextRuntime)
    setModel(settings.runtimes[nextRuntime].defaultModel)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await onStartSession({
        projectId: project.id,
        runtime,
        model,
        title: title || undefined,
      })
      setTitle('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="session-start-form inline-session-launcher"
      onSubmit={submit}
      data-testid="session-launcher"
    >
      <div className="session-launcher-head">
        <div>
          <p className="settings-kicker">New session</p>
          <strong>{project.name}</strong>
        </div>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <label>
        <span>Runtime</span>
        <select
          value={runtime}
          disabled={pending}
          data-testid="session-runtime"
          onChange={(event) => updateRuntime(event.currentTarget.value as RuntimeKind)}
        >
          {runtimes.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Model</span>
        <select
          value={model}
          disabled={pending}
          data-testid="session-model"
          onChange={(event) => setModel(event.currentTarget.value)}
        >
          {models.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Name</span>
        <input
          value={title}
          disabled={pending}
          placeholder="Base session"
          data-testid="session-title"
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={pending}>
        <Plus size={14} />
        Start session
      </button>
      {error ? <span role="status">{error}</span> : null}
    </form>
  )
}

function ProjectSettingsPanel({
  projects,
  onAdd,
  onDelete,
}: {
  projects: ProjectRow[]
  onAdd: (input: { id?: string; name: string; cwd: string }) => Promise<void>
  onDelete: (projectId: string) => Promise<void>
}) {
  const [id, setId] = React.useState('')
  const [name, setName] = React.useState('')
  const [cwd, setCwd] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

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

  async function removeProject(projectId: string) {
    setPending(true)
    setError(null)
    try {
      await onDelete(projectId)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="project-settings" aria-label="Project settings">
      <div className="project-settings-head">
        <div>
          <p className="settings-kicker">Projects</p>
          <strong>Add or remove rows</strong>
        </div>
        {error ? <span role="status">{error}</span> : null}
      </div>
      <form className="project-add-form" onSubmit={submit}>
        <label>
          <span>Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="Project name"
            required
            data-testid="project-name-input"
          />
        </label>
        <label>
          <span>Cwd</span>
          <input
            value={cwd}
            onChange={(event) => setCwd(event.currentTarget.value)}
            placeholder="/absolute/path"
            required
            data-testid="project-cwd-input"
          />
        </label>
        <label>
          <span>Id</span>
          <input
            value={id}
            onChange={(event) => setId(event.currentTarget.value)}
            placeholder="optional"
            data-testid="project-id-input"
          />
        </label>
        <button type="submit" disabled={pending}>
          <Plus size={14} />
          Add
        </button>
      </form>
      <div className="project-list" data-testid="project-settings-list">
        {projects.map((project) => (
          <div key={project.id} className="project-settings-row">
            <div>
              <strong>{project.name}</strong>
              <span>{project.id}</span>
            </div>
            <button
              type="button"
              disabled={pending || projects.length <= 1}
              onClick={() => removeProject(project.id)}
              aria-label={`Delete ${project.name}`}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </section>
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
  return (
    <section className="settings-panel" aria-label="Keymap settings">
      <div>
        <p className="settings-kicker">Keymap</p>
        <strong>Shift plus key</strong>
      </div>
      <KeySelect
        label="Project up"
        action="projectPrev"
        value={keymap.projectPrev}
        onChange={onChange}
      />
      <KeySelect
        label="Project down"
        action="projectNext"
        value={keymap.projectNext}
        onChange={onChange}
      />
      <KeySelect
        label="Agent left"
        action="agentPrev"
        value={keymap.agentPrev}
        onChange={onChange}
      />
      <KeySelect
        label="Agent right"
        action="agentNext"
        value={keymap.agentNext}
        onChange={onChange}
      />
      <KeySelect
        label="Start session"
        action="startSession"
        value={keymap.startSession}
        onChange={onChange}
      />
      <KeySelect
        label="Remove session"
        action="deleteSession"
        value={keymap.deleteSession}
        onChange={onChange}
      />
      <button type="button" className="reset-keymap" onClick={onReset}>
        Reset
      </button>
    </section>
  )
}

function KeySelect({
  label,
  action,
  value,
  onChange,
}: {
  label: string
  action: KeymapAction
  value: string
  onChange: (action: KeymapAction, value: string) => void
}) {
  return (
    <label className="key-select">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(action, event.currentTarget.value)}
        data-testid={`keymap-${action}`}
      >
        {keyOptions.map((key) => (
          <option key={key} value={key}>
            Shift+{formatKey(key)}
          </option>
        ))}
      </select>
    </label>
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

function ProjectLane({
  project,
  selectedProjectId,
  selectedAgentId,
  onSelect,
}: {
  project: ProjectRow
  selectedProjectId: string
  selectedAgentId: string
  onSelect: (agentId: string) => void
}) {
  const isProjectSelected = project.id === selectedProjectId

  return (
    <section
      className={`project-lane ${isProjectSelected ? 'selected' : ''}`}
      aria-label={project.name}
    >
      <div className="project-label">
        <strong>{project.name}</strong>
        <span>{project.cwd}</span>
      </div>
      <div className="agent-row">
        {project.agents.length === 0 ? (
          <div className="empty-session-card" data-testid="empty-project-sessions">
            No sessions
          </div>
        ) : null}
        {project.agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={`agent-cell ${
              isProjectSelected && agent.id === selectedAgentId
                ? 'selected'
                : ''
            }`}
            onClick={() => onSelect(agent.id)}
            data-agent-id={agent.id}
            data-project-id={project.id}
            data-selected={
              isProjectSelected && agent.id === selectedAgentId ? 'true' : 'false'
            }
            data-testid="agent-cell"
          >
            <div className="agent-cell-top">
              <span className={`status-dot ${agent.status}`} />
              <span>{agent.title}</span>
              <RuntimeBadge runtime={agent.runtime} />
            </div>
            <p>{agent.preview}</p>
            <div className="agent-cell-meta">
              <span>{agent.model}</span>
              <span>{agent.messageCount} msg</span>
              <span>{agent.diffCount} diff</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

function EmptySessionPanel({
  project,
  onStart,
}: {
  project: ProjectRow
  onStart: () => void
}) {
  return (
    <div className="empty-sidebar-session" data-testid="empty-session-panel">
      <div className="runtime-icon">
        <Bot size={18} />
      </div>
      <p data-testid="selected-project">{project.name}</p>
      <h2 data-testid="selected-agent">No session</h2>
      <button type="button" onClick={onStart}>
        <Plus size={14} />
        Start session
      </button>
    </div>
  )
}

function SidebarHeader({
  project,
  agent,
  onDeleteSession,
}: {
  project: ProjectRow
  agent: AgentCell
  onDeleteSession: (agentId: string) => Promise<void>
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function removeSession() {
    if (!agent.isSession) return
    setPending(true)
    setError(null)
    try {
      await onDeleteSession(agent.id)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <header className="sidebar-header">
      <div className="sidebar-title-row">
        <div className="runtime-icon">
          <Bot size={18} />
        </div>
        <div>
          <p data-testid="selected-project">{project.name}</p>
          <h2 data-testid="selected-agent">{agent.title}</h2>
        </div>
        <button
          type="button"
          className="session-remove"
          disabled={!agent.isSession || pending}
          onClick={removeSession}
          aria-label={`Remove ${agent.title}`}
          title={agent.isSession ? 'Remove session' : 'Only sessions can be removed'}
          data-testid="remove-session"
        >
          <Trash2 size={15} />
        </button>
      </div>
      {error ? <span className="sidebar-error" role="status">{error}</span> : null}
      <div className="sidebar-stats">
        <span className={`status-pill ${agent.status}`}>
          <Circle size={10} fill="currentColor" />
          {agent.status}
        </span>
        <span>{agent.runtime}</span>
        <span>{agent.slot}</span>
      </div>
    </header>
  )
}

function ChatPanel({
  agent,
  onSend,
}: {
  agent: AgentCell
  onSend: (agentId: string, text: string) => Promise<void>
}) {
  const [draft, setDraft] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const [pendingPrompt, setPendingPrompt] = React.useState<string | null>(null)
  const canSend = draft.trim().length > 0 && !pending
  const visibleMessages =
    pendingPrompt === null
      ? agent.messages
      : [
          ...agent.messages,
          {
            id: `pending-${agent.id}`,
            role: 'user' as const,
            text: pendingPrompt,
            timestamp: new Date().toISOString(),
          },
        ]

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSend) return
    const prompt = draft.trim()
    setPending(true)
    setPendingPrompt(prompt)
    setDraft('')
    try {
      await onSend(agent.id, prompt)
    } finally {
      setPendingPrompt(null)
      setPending(false)
    }
  }

  return (
    <div className="chat-panel" data-testid="chat-panel">
      <div className="message-list">
        {visibleMessages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            <div>
              <span>{message.role}</span>
              <time>{formatTime(message.timestamp)}</time>
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      <form className="composer" onSubmit={submit}>
        <TerminalSquare size={16} />
        <input
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          aria-label="Prompt"
          placeholder="Type to this agent"
          data-testid="chat-input"
        />
        <button type="submit" disabled={!canSend} aria-label="Send prompt">
          <Send size={15} />
        </button>
      </form>
    </div>
  )
}

function DiffPanel({ agent }: { agent: AgentCell }) {
  const diff = agent.diffs[0]

  if (!diff) {
    return (
      <div className="empty-panel" data-testid="diff-panel">
        <GitPullRequest size={18} />
        <span>No diffs for this agent yet.</span>
      </div>
    )
  }

  return (
    <div className="diff-panel" data-testid="diff-panel">
      <div className="diff-header">
        <strong>{diff.title}</strong>
        <span>{diff.path}</span>
      </div>
      <div className="pierre-host">
        <PatchDiff
          patch={diff.patch}
          disableWorkerPool
          options={{
            diffStyle: 'unified',
            overflow: 'wrap',
            themeType: 'light',
          }}
        />
      </div>
    </div>
  )
}

function ArtifactsPanel({ agent }: { agent: AgentCell }) {
  return (
    <div className="empty-panel" data-testid="artifacts-panel">
      <Activity size={18} />
      {agent.sessionFile
        ? `Session file: ${agent.sessionFile}`
        : `Reserved session dir: ${agent.sessionDir}`}
    </div>
  )
}

function RuntimeBadge({ runtime }: { runtime: string }) {
  return <span className="runtime-badge">{runtime}</span>
}

function moveProject(
  projects: ProjectRow[],
  current: Selection,
  delta: 1 | -1,
): Selection {
  const index = projects.findIndex((project) => project.id === current.projectId)
  const nextIndex = clamp(index + delta, 0, projects.length - 1)
  const project = projects[nextIndex]
  const currentProject = projects[index]
  if (!project) return current
  const agent =
    project.agents.find((item) => item.id === current.agentId) ??
    project.agents[
      clamp(
        currentProject?.agents.findIndex((item) => item.id === current.agentId) ??
          0,
        0,
        project.agents.length - 1,
      )
    ]
  return {
    projectId: project.id,
    agentId: agent?.id ?? current.agentId,
  }
}

function moveAgent(project: ProjectRow, current: Selection, delta: 1 | -1): Selection {
  const index = project.agents.findIndex((agent) => agent.id === current.agentId)
  const nextIndex = clamp(index + delta, 0, project.agents.length - 1)
  return {
    projectId: project.id,
    agentId: project.agents[nextIndex]?.id ?? current.agentId,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || target.isContentEditable
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function actionForKey(keymap: KeymapSettings, key: string): KeymapAction | undefined {
  return (Object.entries(keymap) as Array<[KeymapAction, string]>).find(
    ([, binding]) => binding === key,
  )?.[0]
}

function updateKeymap(
  current: KeymapSettings,
  action: KeymapAction,
  value: string,
): KeymapSettings {
  const keymap = { ...current }
  const displacedAction = (
    Object.entries(keymap) as Array<[KeymapAction, string]>
  ).find(
    ([otherAction, binding]) => otherAction !== action && binding === value,
  )?.[0]

  if (displacedAction) {
    keymap[displacedAction] = current[action]
  }
  keymap[action] = value
  return saveKeymap(keymap)
}

function readStoredKeymap(): KeymapSettings {
  try {
    const stored = window.localStorage.getItem(keymapStorageKey)
    if (!stored) return defaultKeymap
    const parsed = JSON.parse(stored) as Partial<KeymapSettings>
    const next = { ...defaultKeymap, ...parsed }
    const values = Object.values(next)
    if (
      values.length !== new Set(values).size ||
      values.some((value) => !keyOptions.includes(value))
    ) {
      return defaultKeymap
    }
    return next
  } catch {
    return defaultKeymap
  }
}

function saveKeymap(keymap: KeymapSettings): KeymapSettings {
  window.localStorage.setItem(keymapStorageKey, JSON.stringify(keymap))
  return keymap
}

function formatKey(key: string) {
  if (key.startsWith('arrow')) return key.replace('arrow', 'Arrow ')
  return key.toUpperCase()
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed'
}
