import type { ProjectRow } from '~/lib/contracts'

export function HiddenProjectDock({
  projects,
  pendingProjectId,
  onUnhide,
}: {
  projects: ProjectRow[]
  pendingProjectId: string | null
  onUnhide: (projectId: string) => void
}) {
  return (
    <section className="hidden-project-dock" aria-label="Hidden projects" data-testid="hidden-project-shelf">
      <div className="hidden-project-dock-head">
        <span>Hidden</span>
        <small>{projects.length}</small>
      </div>
      <div className="hidden-project-chips">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className="hidden-project-chip"
            disabled={pendingProjectId === project.id}
            onClick={() => onUnhide(project.id)}
            aria-label={`Restore ${project.name}`}
            title={`Restore ${project.name}`}
          >
            <span>{project.name}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
