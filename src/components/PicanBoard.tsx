import { PatchDiff } from '@pierre/diffs/react'
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
  TerminalSquare,
} from 'lucide-react'
import * as React from 'react'
import type { AgentCell, ProjectRow, WorkspaceSnapshot } from '~/lib/contracts'

type SidebarTab = 'chat' | 'diffs' | 'artifacts'

type Selection = {
  projectId: string
  agentId: string
}

export function PicanBoard({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [selection, setSelection] = React.useState<Selection>(snapshot.selected)
  const [tab, setTab] = React.useState<SidebarTab>('chat')

  const selectedProject =
    snapshot.projects.find((project) => project.id === selection.projectId) ??
    snapshot.projects[0]
  const selectedAgent =
    selectedProject?.agents.find((agent) => agent.id === selection.agentId) ??
    selectedProject?.agents[0]

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.shiftKey || isEditableTarget(event.target)) return

      const key = event.key.toLowerCase()
      if (!['arrowup', 'arrowdown', 'h', 'j', 'k', 'l'].includes(key)) return
      event.preventDefault()

      if (key === 'arrowup' || key === 'arrowdown') {
        setSelection((current) =>
          moveProject(snapshot.projects, current, key === 'arrowdown' ? 1 : -1),
        )
        return
      }

      setSelection((current) => {
        const project =
          snapshot.projects.find((row) => row.id === current.projectId) ??
          snapshot.projects[0]
        if (!project) return current
        return moveAgent(project, current, key)
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [snapshot.projects])

  if (!selectedProject || !selectedAgent) {
    return <div className="empty-shell">No projects configured.</div>
  }

  return (
    <main className="pican-shell">
      <section className="board-pane" aria-label="Projects and agents">
        <header className="topbar">
          <div>
            <p className="eyebrow">pican</p>
            <h1>Kanban Orchestrator</h1>
          </div>
          <div className="keymap" aria-label="Keyboard shortcuts">
            <span>
              <ArrowUp size={13} />
              <ArrowDown size={13} />
              projects
            </span>
            <span>
              <ArrowLeft size={13} />
              <ArrowRight size={13} />
              agents
            </span>
            <span>Shift+H/J/K/L</span>
          </div>
        </header>

        <div className="board-grid">
          {snapshot.projects.map((project) => (
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

      <aside className="sidebar-pane" aria-label="Selected chat">
        <SidebarHeader project={selectedProject} agent={selectedAgent} />
        <div className="sidebar-tabs" role="tablist">
          <button
            type="button"
            className={tab === 'chat' ? 'active' : ''}
            onClick={() => setTab('chat')}
          >
            <MessageSquareText size={15} />
            Chat
          </button>
          <button
            type="button"
            className={tab === 'diffs' ? 'active' : ''}
            onClick={() => setTab('diffs')}
          >
            <GitPullRequest size={15} />
            Diffs
          </button>
          <button
            type="button"
            className={tab === 'artifacts' ? 'active' : ''}
            onClick={() => setTab('artifacts')}
          >
            <PanelRight size={15} />
            Artifacts
          </button>
        </div>

        {tab === 'chat' ? <ChatPanel agent={selectedAgent} /> : null}
        {tab === 'diffs' ? <DiffPanel agent={selectedAgent} /> : null}
        {tab === 'artifacts' ? <ArtifactsPanel agent={selectedAgent} /> : null}
      </aside>
    </main>
  )
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

function SidebarHeader({
  project,
  agent,
}: {
  project: ProjectRow
  agent: AgentCell
}) {
  return (
    <header className="sidebar-header">
      <div className="sidebar-title-row">
        <div className="runtime-icon">
          <Bot size={18} />
        </div>
        <div>
          <p>{project.name}</p>
          <h2>{agent.title}</h2>
        </div>
      </div>
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

function ChatPanel({ agent }: { agent: AgentCell }) {
  return (
    <div className="chat-panel">
      <div className="message-list">
        {agent.messages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            <div>
              <span>{message.role}</span>
              <time>{formatTime(message.timestamp)}</time>
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      <div className="composer">
        <TerminalSquare size={16} />
        <input value="" readOnly aria-label="Prompt" placeholder="Pi prompt wiring next" />
      </div>
    </div>
  )
}

function DiffPanel({ agent }: { agent: AgentCell }) {
  const diff = agent.diffs[0]

  if (!diff) {
    return (
      <div className="empty-panel">
        <GitPullRequest size={18} />
        No diffs for this agent yet.
      </div>
    )
  }

  return (
    <div className="diff-panel">
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
    <div className="empty-panel">
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
  if (!project) return current
  const agent =
    project.agents.find((item) => item.id === current.agentId) ??
    project.agents[0]
  return {
    projectId: project.id,
    agentId: agent?.id ?? current.agentId,
  }
}

function moveAgent(project: ProjectRow, current: Selection, key: string): Selection {
  const columns = Math.max(1, Math.min(3, project.agents.length))
  const index = project.agents.findIndex((agent) => agent.id === current.agentId)
  const deltaByKey: Record<string, number> = {
    h: -1,
    l: 1,
    k: -columns,
    j: columns,
  }
  const nextIndex = clamp(index + deltaByKey[key], 0, project.agents.length - 1)
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
