'use client'

import { PatchDiff } from '@pierre/diffs/react'
import { useServerFn } from '@tanstack/react-start'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Columns2,
  Circle,
  Copy,
  GitPullRequest,
  Maximize2,
  MessageSquareText,
  Minimize2,
  PanelRight,
  Plus,
  Rows3,
  Send,
  Settings2,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import * as React from 'react'
import type {
  AgentCell,
  BoardMessage,
  DiffArtifact,
  ProjectRow,
  RuntimeKind,
  TimelineEvent,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import {
  addProjectMutation,
  deleteProjectMutation,
  deleteSessionMutation,
  fetchWorkspaceSnapshot,
  sendMessageMutation,
  startSessionMutation,
} from '~/server/workspace'

type SidebarTab = 'chat' | 'diffs' | 'artifacts'
type DiffStyle = 'unified' | 'split'
type AgentTimelineRow =
  | {
      kind: 'message'
      id: string
      message: BoardMessage
    }
  | {
      kind: 'work'
      id: string
      startedAt: string
      entries: TimelineWorkEntry[]
    }
  | {
      kind: 'working'
      id: string
      startedAt: string | null
    }

type TimelineWorkEntry = {
  id: string
  kind: string
  tone: TimelineEvent['tone']
  label: string
  detail: string | null
  timestamp: string
}

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
  const [chatFocusRequest, setChatFocusRequest] = React.useState(0)
  const [chatDrafts, setChatDrafts] = React.useState<Record<string, string>>({})
  const addProject = useServerFn(addProjectMutation)
  const deleteProject = useServerFn(deleteProjectMutation)
  const deleteSession = useServerFn(deleteSessionMutation)
  const refreshWorkspace = useServerFn(fetchWorkspaceSnapshot)
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
      if (key === 'c') {
        event.preventDefault()
        setSettingsOpen(false)
        setSessionLauncherOpen(false)
        setTab('chat')
        setChatFocusRequest((request) => request + 1)
        return
      }

      if (key === 'd') {
        event.preventDefault()
        setTab('diffs')
        return
      }

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
        setChatFocusRequest(0)
        setSelection((current) =>
          moveProject(workspace.projects, current, action === 'projectNext' ? 1 : -1),
        )
        return
      }

      setChatFocusRequest(0)
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
    setChatFocusRequest(0)
    if (fallbackAgent) {
      setSelection({ projectId: project.id, agentId: fallbackAgent.id })
    } else {
      setSelection({ projectId: project.id, agentId: '' })
    }
  }

  async function handleSendMessage(agentId: string, text: string) {
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      if (stopped) return
      try {
        setWorkspace(await refreshWorkspace())
      } finally {
        if (!stopped) {
          timer = window.setTimeout(poll, 750)
        }
      }
    }
    timer = window.setTimeout(poll, 250)
    try {
      const next = await sendMessage({ data: { agentId, text } })
      setWorkspace(next)
    } finally {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
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
      setChatFocusRequest(0)
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
            <span>
              <Keycap value="c" />
              chat
            </span>
            <span>
              <Keycap value="d" />
              diffs
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
              onSelect={(agentId) => {
                setChatFocusRequest(0)
                setSelection({ projectId: project.id, agentId })
              }}
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
              <ChatPanel
                key={selectedAgent.id}
                agent={selectedAgent}
                draft={chatDrafts[selectedAgent.id] ?? ''}
                focusRequest={chatFocusRequest}
                onDraftChange={(draft) =>
                  setChatDrafts((current) => ({ ...current, [selectedAgent.id]: draft }))
                }
                onSend={handleSendMessage}
              />
            ) : null}
            {tab === 'diffs' ? <DiffPanel key={selectedAgent.id} agent={selectedAgent} /> : null}
            {tab === 'artifacts' ? (
              <ArtifactsPanel key={selectedAgent.id} agent={selectedAgent} />
            ) : null}
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

function ContextUsageChip({
  usage,
}: {
  usage: AgentCell['contextUsage']
}) {
  if (!usage) return null

  const usedPercent = Math.round(usage.usedPercent)
  const remainingPercent = Math.max(100 - usedPercent, 0)
  const normalizedPercent = Math.max(0, Math.min(100, usage.usedPercent))

  return (
    <button
      type="button"
      className="context-chip"
      aria-label={`${formatTokenCount(usage.usedTokens)} of ${formatTokenCount(usage.windowTokens)} context tokens used`}
      title={`${usedPercent}% used (${remainingPercent}% left), ${usage.usedTokens.toLocaleString('en')} / ${usage.windowTokens.toLocaleString('en')} tokens used`}
      style={{ '--context-used': `${normalizedPercent}%` } as React.CSSProperties}
    >
      <span className="context-chip-ring" aria-hidden="true" />
      <strong>{usedPercent}</strong>
    </button>
  )
}

function ChatPanel({
  agent,
  draft,
  focusRequest,
  onDraftChange,
  onSend,
}: {
  agent: AgentCell
  draft: string
  focusRequest: number
  onDraftChange: (draft: string) => void
  onSend: (agentId: string, text: string) => Promise<void>
}) {
  const [pending, setPending] = React.useState(false)
  const [pendingPrompt, setPendingPrompt] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const canSend = draft.trim().length > 0 && !pending
  const pendingMessage = React.useMemo<BoardMessage | null>(
    () => {
      if (pendingPrompt === null) return null
      const persisted = agent.messages.some(
        (message) => message.role === 'user' && message.text === pendingPrompt,
      )
      if (persisted) return null
      return {
        id: `pending-${agent.id}`,
        role: 'user',
        text: pendingPrompt,
        timestamp: new Date().toISOString(),
      }
    },
    [agent.id, agent.messages, pendingPrompt],
  )
  const visibleMessages = React.useMemo(
    () => (pendingMessage ? [...agent.messages, pendingMessage] : agent.messages),
    [agent.messages, pendingMessage],
  )
  const timelineAgent = React.useMemo(
    () => ({
      ...agent,
      messages: visibleMessages,
      timeline: pendingMessage === null
        ? agent.timeline
        : [
            ...agent.timeline,
            {
              type: 'message' as const,
              id: `message:${pendingMessage.id}`,
              timestamp: pendingMessage.timestamp,
              message: pendingMessage,
            },
          ],
    }),
    [agent, pendingMessage, visibleMessages],
  )
  const rows = React.useMemo(
    () => deriveAgentTimelineRows(timelineAgent),
    [timelineAgent],
  )
  const messageListRef = React.useRef<HTMLDivElement | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const latestRowId = rows.at(-1)?.id ?? ''

  React.useEffect(() => {
    if (focusRequest === 0) return
    textareaRef.current?.focus()
  }, [focusRequest])

  React.useLayoutEffect(() => {
    const list = messageListRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [agent.id, agent.status, latestRowId, rows.length])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSend) return
    const prompt = draft.trim()
    setPending(true)
    setPendingPrompt(prompt)
    setError(null)
    onDraftChange('')
    try {
      await onSend(agent.id, prompt)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPendingPrompt(null)
      setPending(false)
    }
  }

  return (
    <div className="chat-panel" data-testid="chat-panel">
      <MessageTimeline rows={rows} listRef={messageListRef} />
      {error ? <span className="chat-error" role="status">{error}</span> : null}
      <form className="composer" onSubmit={submit}>
        <TerminalSquare size={16} />
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => onDraftChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.blur()
              return
            }
            if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey) return
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }}
          aria-label="Prompt"
          placeholder="Type to this agent"
          rows={3}
          data-testid="chat-input"
        />
        <ContextUsageChip usage={agent.contextUsage} />
        <button
          type="submit"
          className="composer-submit"
          disabled={!canSend}
          aria-label="Send prompt"
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  )
}

function MessageTimeline({
  rows,
  listRef,
}: {
  rows: AgentTimelineRow[]
  listRef: React.RefObject<HTMLDivElement | null>
}) {
  if (rows.length === 0) {
    return (
      <div className="message-list" ref={listRef}>
        <div className="empty-panel">No messages yet.</div>
      </div>
    )
  }

  return (
    <div className="message-list" ref={listRef}>
      {rows.map((row) => {
        if (row.kind === 'work') return <WorkTimelineRow key={row.id} row={row} />
        if (row.kind === 'working') {
          return <WorkingTimelineRow key={row.id} row={row} />
        }
        return <MessageTimelineRow key={row.id} message={row.message} />
      })}
    </div>
  )
}

function MessageTimelineRow({ message }: { message: BoardMessage }) {
  if (message.role === 'user') {
    return (
      <article className="timeline-row user-row" data-message-role={message.role}>
        <div className="user-bubble">
          <RichMessageBody text={message.text} />
          <MessageMeta message={message} align="right" />
        </div>
      </article>
    )
  }

  if (message.role === 'assistant') {
    return (
      <article className="timeline-row assistant-row" data-message-role={message.role}>
        <RichMessageBody text={message.text} />
        <div className="assistant-meta-row">
          <MessageMeta message={message} />
          <CopyTextButton text={message.text} label="Copy response" />
        </div>
      </article>
    )
  }

  return (
    <article
      className={`timeline-row note-row ${message.role}`}
      data-message-role={message.role}
    >
      <div className="note-meta">
        <span>{message.role}</span>
        <time>{formatTime(message.timestamp)}</time>
      </div>
      <RichMessageBody text={message.text} />
    </article>
  )
}

function WorkTimelineRow({
  row,
}: {
  row: Extract<AgentTimelineRow, { kind: 'work' }>
}) {
  const [expanded, setExpanded] = React.useState(false)
  const visibleEntries = expanded ? row.entries : row.entries.slice(0, 6)
  const hiddenCount = row.entries.length - visibleEntries.length

  return (
    <section className="timeline-row work-row" aria-label="Runtime activity">
      <div className="work-row-header">
        <span>Tool calls ({row.entries.length})</span>
        {hiddenCount > 0 ? (
          <button type="button" onClick={() => setExpanded((value) => !value)}>
            <ChevronDown size={13} className={expanded ? 'expanded' : ''} />
            {expanded ? 'Show less' : `Show ${hiddenCount} more`}
          </button>
        ) : null}
      </div>
      <div className="work-entry-list">
        {visibleEntries.map((entry) => (
          <WorkEntryRow key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  )
}

function WorkEntryRow({ entry }: { entry: TimelineWorkEntry }) {
  const [expanded, setExpanded] = React.useState(false)
  const preview = workEntryPreview(entry)
  const displayText = preview ? `${entry.label} - ${preview}` : entry.label
  const fullText = preview ?? displayText
  const canExpand = displayText.length > 72 || fullText.includes('\n')

  return (
    <div className={`work-entry ${entry.tone} ${expanded ? 'expanded' : ''}`}>
      <TerminalSquare size={13} className={`work-entry-icon ${entry.tone}`} />
      <div className="work-entry-content">
        <div className="work-entry-title">
          <button
            type="button"
            onClick={() => {
              if (canExpand) setExpanded((value) => !value)
            }}
            className={`work-entry-toggle ${canExpand ? 'expandable' : ''}`}
            aria-expanded={expanded}
            disabled={!canExpand}
            title={displayText}
          >
            <span>
              <strong>{entry.label}</strong>
              {preview ? <> - {preview}</> : null}
            </span>
          </button>
          <time>{formatTime(entry.timestamp)}</time>
        </div>
        {expanded && canExpand ? (
          <pre className="work-entry-detail"><code>{fullText}</code></pre>
        ) : null}
      </div>
    </div>
  )
}

function workEntryPreview(entry: TimelineWorkEntry) {
  return entry.detail?.trim() || null
}

function WorkingTimelineRow({
  row,
}: {
  row: Extract<AgentTimelineRow, { kind: 'working' }>
}) {
  return (
    <div className="timeline-row working-row">
      <span className="working-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{row.startedAt ? `Working since ${formatTime(row.startedAt)}` : 'Working'}</span>
    </div>
  )
}

function MessageMeta({
  message,
  align = 'left',
}: {
  message: BoardMessage
  align?: 'left' | 'right'
}) {
  return (
    <div className={`message-meta ${align}`}>
      <span>{message.role}</span>
      <time>{formatTime(message.timestamp)}</time>
    </div>
  )
}

const markdownComponents = {
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
} satisfies Components

function RichMessageBody({
  text,
  compact = false,
}: {
  text: string
  compact?: boolean
}) {
  return (
    <div className={compact ? 'rich-message-body compact' : 'rich-message-body'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = React.useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button type="button" className="copy-message" onClick={copy} aria-label={label}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function deriveAgentTimelineRows(agent: AgentCell): AgentTimelineRow[] {
  const rows: AgentTimelineRow[] = []
  let workEntries: TimelineWorkEntry[] = []
  const timeline = agent.timeline.length
    ? agent.timeline
    : agent.messages.map((message) => ({
        type: 'message' as const,
        id: `message:${message.id}`,
        timestamp: message.timestamp,
        message,
      }))

  function flushWork() {
    if (workEntries.length === 0) return
    rows.push({
      kind: 'work',
      id: `work:${workEntries[0]?.id}:${workEntries[workEntries.length - 1]?.id}`,
      startedAt: workEntries[0]?.timestamp ?? new Date(0).toISOString(),
      entries: workEntries,
    })
    workEntries = []
  }

  for (const item of timeline) {
    if (item.type === 'event') {
      const entry = eventToWorkEntry(item.event)
      if (entry) workEntries.push(entry)
      continue
    }

    if (item.message.role === 'tool') {
      workEntries.push(toolMessageToWorkEntry(item.message))
      continue
    }

    flushWork()
    rows.push({
      kind: 'message',
      id: `message:${item.message.id}`,
      message: item.message,
    })
  }

  flushWork()

  if (agent.status === 'running') {
    const lastRow = rows[rows.length - 1]
    rows.push({
      kind: 'working',
      id: 'working-indicator',
      startedAt: lastRow?.kind === 'message' ? lastRow.message.timestamp : null,
    })
  }

  return rows
}

function eventToWorkEntry(event: TimelineEvent): TimelineWorkEntry | null {
  if (!shouldShowRuntimeEvent(event)) return null

  return {
    id: event.id,
    kind: event.kind,
    tone: event.tone,
    label: runtimeEventLabel(event),
    detail: event.detail,
    timestamp: event.timestamp,
  }
}

function shouldShowRuntimeEvent(event: TimelineEvent) {
  if (event.kind !== 'tool_execution_start') return false
  return event.label.toLowerCase() !== 'taskupdate'
}

function runtimeEventLabel(event: TimelineEvent) {
  const label = event.label.trim()
  if (label.toLowerCase() === 'bash') return 'Ran command'
  if (!label || label === 'tool execution start') return 'Tool'
  return label
}

function toolMessageToWorkEntry(message: BoardMessage): TimelineWorkEntry {
  const [firstLine, ...rest] = message.text.split('\n')
  return {
    id: message.id,
    kind: 'tool.message',
    tone: 'tool',
    label: firstLine?.trim() || 'Tool output',
    detail: rest.join('\n').trim() || message.text,
    timestamp: message.timestamp,
  }
}

function DiffPanel({ agent }: { agent: AgentCell }) {
  const [selectedDiffId, setSelectedDiffId] = React.useState<string | null>(null)
  const [diffStyle, setDiffStyle] = React.useState<DiffStyle>('unified')
  const [fullscreen, setFullscreen] = React.useState(false)
  const fileButtonRefs = React.useRef<Array<HTMLButtonElement | null>>([])
  const diff =
    agent.diffs.find((item) => item.id === selectedDiffId) ?? agent.diffs[0]
  const selectedIndex = diff
    ? Math.max(0, agent.diffs.findIndex((item) => item.id === diff.id))
    : -1
  const duplicateFileNames = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of agent.diffs) {
      const name = diffFileName(item)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return new Set(
      [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    )
  }, [agent.diffs])

  React.useEffect(() => {
    setSelectedDiffId(null)
    setFullscreen(false)
  }, [agent.id, agent.diffs.length])

  React.useEffect(() => {
    if (!fullscreen) return

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        setFullscreen(false)
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        selectRelative(-1, false)
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        selectRelative(1, false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreen, selectedIndex, agent.diffs])

  React.useEffect(() => {
    fileButtonRefs.current[selectedIndex]?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [selectedIndex])

  function selectIndex(index: number, focus = false) {
    if (!agent.diffs.length) return
    const nextIndex = Math.max(0, Math.min(index, agent.diffs.length - 1))
    setSelectedDiffId(agent.diffs[nextIndex]?.id ?? null)
    if (focus) {
      window.requestAnimationFrame(() => fileButtonRefs.current[nextIndex]?.focus())
    }
  }

  function selectRelative(delta: -1 | 1, focus = false) {
    if (!agent.diffs.length || selectedIndex === -1) return
    const nextIndex = (selectedIndex + delta + agent.diffs.length) % agent.diffs.length
    selectIndex(nextIndex, focus)
  }

  function onFileListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      selectRelative(-1, true)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      selectRelative(1, true)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      selectIndex(0, true)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      selectIndex(agent.diffs.length - 1, true)
    }
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
      <div
        className="diff-file-list"
        role="tablist"
        aria-label="Changed files"
        onKeyDown={onFileListKeyDown}
      >
        {agent.diffs.map((item, index) => {
          const fileName = diffFileName(item)
          const folder = duplicateFileNames.has(fileName)
            ? diffFileFolder(item.path)
            : null
          return (
            <button
              key={item.id}
              ref={(element) => {
                fileButtonRefs.current[index] = element
              }}
              type="button"
              role="tab"
              className={item.id === diff.id ? 'active' : ''}
              onClick={() => setSelectedDiffId(item.id)}
              aria-selected={item.id === diff.id}
              tabIndex={item.id === diff.id ? 0 : -1}
              title={item.path}
            >
              <span className="diff-file-name">{fileName}</span>
              {folder ? <span className="diff-file-folder">{folder}</span> : null}
            </button>
          )
        })}
      </div>
      <div className="pierre-host">
        <PatchDiff
          key={`${diff.id}:${diffStyle}`}
          patch={diff.patch}
          disableWorkerPool
          options={{
            diffStyle,
            overflow: 'wrap',
            themeType: 'light',
          }}
        />
      </div>
    </div>
  )
}

function diffFileName(file: Pick<DiffArtifact, 'path' | 'title'>) {
  const normalized = file.path.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? file.title
}

function diffFileFolder(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= 1) return null
  return parts.slice(0, -1).join('/')
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

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`
  if (value >= 1_000) return `${trimFixed(value / 1_000)}K`
  return value.toLocaleString('en')
}

function trimFixed(value: number) {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '')
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
