import { FolderOpen, Settings2 } from 'lucide-react'
import type * as React from 'react'
import type { ProjectRow } from '~/lib/contracts'
import { HiddenProjectDock } from './hidden-project-dock'
import { ProjectLane } from './project-lane'

export function ProjectBoardPane({
  projects,
  hiddenProjects,
  hydrated,
  selection,
  startSessionKey,
  projectManagerOpen,
  settingsOpen,
  projectVisibilityPendingId,
  boardScrollRef,
  onToggleProjects,
  onToggleSettings,
  onHideProject,
  onSelectAgent,
  onUnhideProject,
}: {
  projects: ProjectRow[]
  hiddenProjects: ProjectRow[]
  hydrated: boolean
  selection: { projectId: string; agentId: string }
  startSessionKey: string
  projectManagerOpen: boolean
  settingsOpen: boolean
  projectVisibilityPendingId: string | null
  boardScrollRef: React.RefObject<HTMLDivElement | null>
  onToggleProjects: () => void
  onToggleSettings: () => void
  onHideProject: (projectId: string) => void
  onSelectAgent: (projectId: string, agentId: string) => void
  onUnhideProject: (projectId: string) => void
}) {
  return (
    <section
      className="board-pane"
      aria-label="Projects and agents"
      data-hydrated={hydrated ? 'true' : 'false'}
      data-testid="board-pane"
    >
      <header className="topbar">
        <div className="topbar-actions">
          <button
            type="button"
            className="topbar-trigger"
            aria-label="Projects"
            aria-expanded={projectManagerOpen}
            onClick={onToggleProjects}
          >
            <FolderOpen size={14} />
            <span>Projects</span>
          </button>
          <button
            type="button"
            className="topbar-trigger"
            aria-label="Settings"
            aria-expanded={settingsOpen}
            onClick={onToggleSettings}
          >
            <Settings2 size={14} />
            <span>Settings</span>
          </button>
        </div>
      </header>

      <div className="board-scroll" ref={boardScrollRef}>
        <div
          className="board-grid"
          data-has-selection={selection.projectId ? 'true' : 'false'}
          data-testid="board-grid"
        >
          {projects.map((project) => (
            <ProjectLane
              key={project.id}
              project={project}
              selectedAgentId={selection.agentId}
              selectedProjectId={selection.projectId}
              startSessionKey={startSessionKey}
              hideDisabled={projects.length <= 1 || projectVisibilityPendingId === project.id}
              onHide={onHideProject}
              onSelect={onSelectAgent}
            />
          ))}
        </div>
      </div>

      {hiddenProjects.length > 0 ? (
        <HiddenProjectDock
          projects={hiddenProjects}
          pendingProjectId={projectVisibilityPendingId}
          onUnhide={onUnhideProject}
        />
      ) : null}
    </section>
  )
}
