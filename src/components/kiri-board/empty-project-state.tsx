import { FolderOpen, Plus, Settings2 } from 'lucide-react'
import { CommandPalette } from './command-palette'
import type { CommandPaletteAction } from './board-types'
import { ProjectManagerDialog } from './project-manager-dialog'
import type { ProjectRow } from '~/lib/contracts'

export function EmptyProjectState({
  commandPaletteOpen,
  commandActions,
  projectManagerOpen,
  projects,
  hiddenProjects,
  hydrated,
  onAddProject,
  onChooseDirectory,
  onCloseCommandPalette,
  onCloseProjectManager,
  onDeleteProject,
  onHideProject,
  onOpenProjectManager,
  onOpenSettings,
  onReorderProjects,
  onUnhideProject,
}: {
  commandPaletteOpen: boolean
  commandActions: CommandPaletteAction[]
  projectManagerOpen: boolean
  projects: ProjectRow[]
  hiddenProjects: ProjectRow[]
  hydrated: boolean
  onAddProject: (input: { id?: string; name: string; cwd: string }) => Promise<void>
  onChooseDirectory: () => Promise<string>
  onCloseCommandPalette: () => void
  onCloseProjectManager: () => void
  onDeleteProject: (projectId: string) => Promise<void>
  onHideProject: (projectId: string) => Promise<void>
  onOpenProjectManager: () => void
  onOpenSettings: () => void
  onReorderProjects: (projectIds: string[]) => Promise<void>
  onUnhideProject: (projectId: string) => Promise<void>
}) {
  return (
    <main
      className="empty-project-shell"
      data-hydrated={hydrated ? 'true' : 'false'}
      data-testid="empty-project-state"
    >
      {commandPaletteOpen ? (
        <CommandPalette
          actions={commandActions}
          onClose={onCloseCommandPalette}
        />
      ) : null}

      {projectManagerOpen ? (
        <ProjectManagerDialog
          projects={projects}
          hiddenProjects={hiddenProjects}
          onAdd={onAddProject}
          onChooseDirectory={onChooseDirectory}
          onDelete={onDeleteProject}
          onHide={onHideProject}
          onReorderProjects={onReorderProjects}
          onUnhide={onUnhideProject}
          onClose={onCloseProjectManager}
        />
      ) : null}

      <section className="empty-project-state" aria-label="No projects configured">
        <div className="empty-project-mark" aria-hidden="true">
          <FolderOpen size={22} />
        </div>
        <div>
          <p className="empty-project-kicker">kiri</p>
          <h1>No projects yet</h1>
          <p>Add a local repo to start sessions on this machine.</p>
        </div>
        <div className="empty-project-actions">
          <button
            type="button"
            className="project-add-button"
            onClick={onOpenProjectManager}
            data-testid="empty-add-project"
          >
            <Plus size={14} />
            Add project
          </button>
          <button
            type="button"
            className="empty-project-secondary"
            onClick={onOpenSettings}
          >
            <Settings2 size={14} />
            Settings
          </button>
        </div>
      </section>
    </main>
  )
}
