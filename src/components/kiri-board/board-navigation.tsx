'use client'

import { ChevronDown, FolderOpen, MessageSquareText, NotebookPen, Plus, Settings2, TerminalSquare } from 'lucide-react'
import type { AgentCell, ProjectRow } from '~/lib/contracts'
import type { SidebarTab } from './board-types'
import { RuntimeBadge } from './runtime-badge'

export function MobileTopBar({
  project,
  agent,
  tab,
  onTabChange,
  onOpenAgentSwitcher,
  onSelectAgent,
  onStartSession,
  onOpenProjects,
  onOpenSettings,
}: {
  project: ProjectRow
  agent: AgentCell | undefined
  tab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  onOpenAgentSwitcher: () => void
  onSelectAgent: (agentId: string) => void
  onStartSession: () => void
  onOpenProjects: () => void
  onOpenSettings: () => void
}) {
  return (
    <header className="mobile-topbar" aria-label="Mobile navigation">
      <div className="mobile-project-line">
        <button
          type="button"
          className="mobile-project-trigger"
          onClick={onOpenAgentSwitcher}
          aria-label="Open all sessions"
        >
          <span className="mobile-project-pill">
            <FolderOpen size={15} aria-hidden="true" />
            <strong>{project.name}</strong>
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </button>
        <div className="mobile-actions">
          <button type="button" onClick={onOpenProjects} aria-label="Projects">
            <FolderOpen size={18} />
          </button>
          <button type="button" onClick={onOpenSettings} aria-label="Open settings">
            <Settings2 size={18} />
          </button>
        </div>
      </div>
      <div className="mobile-agent-strip" aria-label="Agents in this project">
        {project.agents.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === agent?.id ? 'active' : ''}
            onClick={() => onSelectAgent(item.id)}
            aria-current={item.id === agent?.id ? 'true' : undefined}
          >
            <span className={`status-dot ${item.status}`} aria-hidden="true" />
            {item.title}
          </button>
        ))}
        <button type="button" className="new" onClick={onStartSession}>
          <Plus size={13} /> New
        </button>
      </div>
      <div className="mobile-view-tabs" role="tablist" aria-label="Selected agent view">
        <button
          type="button"
          className={tab === 'chat' ? 'active' : ''}
          onClick={() => onTabChange('chat')}
          role="tab"
          aria-selected={tab === 'chat'}
        >
          <MessageSquareText size={15} />
          Chat
        </button>
        <button
          type="button"
          className={tab === 'terminal' ? 'active' : ''}
          onClick={() => onTabChange('terminal')}
          role="tab"
          aria-selected={tab === 'terminal'}
        >
          <TerminalSquare size={15} />
          Terminal
        </button>
        <button
          type="button"
          className={tab === 'scratchpad' ? 'active' : ''}
          onClick={() => onTabChange('scratchpad')}
          role="tab"
          aria-selected={tab === 'scratchpad'}
        >
          <NotebookPen size={15} />
          Scratch
        </button>
      </div>
    </header>
  )
}
export function AgentSwitcherSheet({
  projects,
  selectedProjectId,
  selectedAgentId,
  onSelectAgent,
  onStartSession,
  onClose,
}: {
  projects: ProjectRow[]
  selectedProjectId: string
  selectedAgentId: string
  onSelectAgent: (projectId: string, agentId: string) => void
  onStartSession: (projectId: string) => void
  onClose: () => void
}) {
  return (
    <>
      <button
        type="button"
        className="agent-switcher-scrim"
        onClick={onClose}
        aria-label="Close agent switcher"
      />
      <section
        className="agent-switcher-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-switcher-title"
      >
        <div className="agent-switcher-head">
          <div>
            <p className="settings-kicker">Switch agent</p>
            <h2 id="agent-switcher-title">Sessions</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close agent switcher">
            ×
          </button>
        </div>
        <div className="agent-switcher-list">
          {projects.map((project) => (
            <section key={project.id} className="agent-switcher-project">
              <div className="agent-switcher-project-head">
                <strong>{project.name}</strong>
                <button type="button" onClick={() => onStartSession(project.id)}>
                  <Plus size={14} />
                  New
                </button>
              </div>
              {project.agents.length === 0 ? (
                <button
                  type="button"
                  className="agent-switcher-empty"
                  onClick={() => onStartSession(project.id)}
                >
                  No sessions yet. Start one.
                </button>
              ) : null}
              {project.agents.map((agent) => {
                const selected =
                  project.id === selectedProjectId && agent.id === selectedAgentId
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`agent-switcher-row ${selected ? 'selected' : ''}`}
                    onClick={() => onSelectAgent(project.id, agent.id)}
                    aria-current={selected ? 'true' : undefined}
                  >
                    <span className={`status-dot ${agent.status}`} aria-hidden="true" />
                    <span>
                      <strong>{agent.title}</strong>
                      <small>{agent.preview}</small>
                    </span>
                    <span className="agent-switcher-meta">
                      <RuntimeBadge runtime={agent.runtime} />
                      <small>{agent.messageCount} msg</small>
                    </span>
                  </button>
                )
              })}
            </section>
          ))}
        </div>
      </section>
    </>
  )
}
