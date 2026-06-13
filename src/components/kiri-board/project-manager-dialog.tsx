'use client'

import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  FolderOpen,
  Plus,
  Trash2,
} from 'lucide-react'
import * as React from 'react'
import type { ProjectRow } from '~/lib/contracts'
import { ConfirmDialog } from './confirm-dialog'
import { focusableElements, trapTabFocus, useFocusReturn } from './dialog-focus'
import { errorMessage, projectNameFromPath, projectSummary } from './format'

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
  returnFocusElement,
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
  returnFocusElement?: HTMLElement | null
}) {
  const dialogRef = React.useRef<HTMLDivElement | null>(null)
  const [id, setId] = React.useState('')
  const [name, setName] = React.useState('')
  const [cwd, setCwd] = React.useState('')
  const [showHidden, setShowHidden] = React.useState(hiddenProjects.length > 0)
  const [pending, setPending] = React.useState(false)
  const [pendingRemoveProject, setPendingRemoveProject] = React.useState<ProjectRow | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const canDeleteVisibleProject = projects.length > 1
  const canDeleteHiddenProject = projects.length + hiddenProjects.length > 1
  useFocusReturn(returnFocusElement)

  React.useEffect(() => {
    if (hiddenProjects.length > 0) setShowHidden(true)
  }, [hiddenProjects.length])

  React.useEffect(() => {
    if (!dialogRef.current) return
    focusableElements(dialogRef.current)[0]?.focus()
  }, [])

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
      <div
        ref={dialogRef}
        className="project-manager-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Project manager"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
          trapTabFocus(event, dialogRef.current)
        }}
      >
        <section className="project-settings project-manager">
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
          <form className="project-add-form" onSubmit={(event) => void submit(event)}>
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
              onClick={() => void chooseDirectory()}
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
                    onClick={() => void moveVisibleProject(project.id, -1)}
                    aria-label={`Move ${project.name} up`}
                    className="project-order-button"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={pending || index === projects.length - 1}
                    onClick={() => void moveVisibleProject(project.id, 1)}
                    aria-label={`Move ${project.name} down`}
                    className="project-order-button"
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={pending || projects.length <= 1}
                    onClick={() => void hide(project.id)}
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
          {showHidden ? (
            <div className="project-list" data-testid="hidden-project-list">
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
                      onClick={() => void unhide(project.id)}
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
            </div>
          ) : null}
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
