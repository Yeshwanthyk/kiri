'use client'

import { FolderKanban, Settings } from 'lucide-react'
import * as React from 'react'
import type { ProjectRow } from '~/lib/contracts'
import type { ProjectResource, ResourceId } from './resource-tabs'

type CornerPeekProps = {
  readonly projects: readonly ProjectRow[]
  readonly hiddenProjects: readonly ProjectRow[]
  readonly selectedProjectId: string
  readonly activeResourceId: ResourceId | null
  readonly resourcesByProject: Record<string, {
    readonly resources: readonly ProjectResource[]
    readonly activeResourceId: ResourceId | null
  }>
  readonly held: boolean
  readonly onSelectProject: (projectId: string) => void
  readonly onSelectResource: (projectId: string, resourceId: ResourceId) => void
  readonly onOpenProjects: (returnFocusElement?: HTMLElement | null) => void
  readonly onOpenSettings: () => void
  readonly onExpandedChange?: (expanded: boolean) => void
}

export function CornerPeek({
  projects,
  hiddenProjects,
  selectedProjectId,
  activeResourceId,
  resourcesByProject,
  held,
  onSelectProject,
  onSelectResource,
  onOpenProjects,
  onOpenSettings,
  onExpandedChange,
}: CornerPeekProps) {
  const [open, setOpen] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)
  const anchorRef = React.useRef<HTMLButtonElement | null>(null)
  const expanded = open || held || hovered

  React.useEffect(() => {
    onExpandedChange?.(expanded)
  }, [expanded, onExpandedChange])

  return (
    <div
      className={`corner-peek-wrap ${held ? 'held' : ''} ${open ? 'open' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      <button
        ref={anchorRef}
        type="button"
        className="corner-peek-anchor"
        aria-label="Open Corner Peek"
        aria-expanded={expanded}
        data-testid="corner-peek-anchor"
        onClick={() => setOpen((current) => !current)}
      >
        {projects.length}
      </button>
      <div className="corner-peek-panel" data-testid="corner-peek-panel">
        <div className="corner-peek-head">
          <strong>projects</strong>
          <span>{held ? 'cmd held' : open ? 'pinned' : 'peek'}</span>
        </div>
        <div className="corner-peek-projects">
          {projects.map((project) => {
            const projectResources = resourcesByProject[project.id]
            const visibleResources = (projectResources?.resources ?? []).filter((resource) =>
              resource.kind === 'agent')
            const selected = project.id === selectedProjectId
            return (
              <div
                key={project.id}
                className={`corner-peek-row ${selected ? 'selected' : ''}`}
              >
                <button
                  type="button"
                  className="corner-peek-project"
                  onClick={() => {
                    onSelectProject(project.id)
                    setOpen(false)
                  }}
                  data-testid="corner-peek-project"
                >
                  <span>{project.name}</span>
                  <small>{project.agents.length}</small>
                </button>
                <div className="corner-peek-resources" aria-label={`${project.name} resources`}>
                  {visibleResources.map((resource) => (
                    <button
                      key={resource.id}
                      type="button"
                      className={resource.id === (selected ? activeResourceId : projectResources?.activeResourceId)
                        ? 'active'
                        : ''}
                      data-kind={resource.kind}
                      aria-label={`Open ${resource.kind}`}
                      onClick={() => {
                        onSelectProject(project.id)
                        onSelectResource(project.id, resource.id)
                        setOpen(false)
                      }}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        <div className="corner-peek-actions">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onOpenProjects(anchorRef.current)
            }}
            aria-label="Open projects page"
            data-testid="corner-peek-projects-action"
          >
            <FolderKanban size={13} aria-hidden="true" />
            projects
            {hiddenProjects.length > 0 ? <span>{hiddenProjects.length} hidden</span> : null}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              anchorRef.current?.focus()
              onOpenSettings()
            }}
            aria-label="Open settings"
            data-testid="corner-peek-settings-action"
          >
            <Settings size={13} aria-hidden="true" />
            settings
          </button>
        </div>
      </div>
    </div>
  )
}
