'use client'

import * as React from 'react'
import type { AgentCell, ProjectRow } from '~/lib/contracts'
import { formatAgo, formatKeyShort } from './format'

type ProjectLaneProps = {
  project: ProjectRow
  selectedProjectId: string
  selectedAgentId: string
  onSelect: (projectId: string, agentId: string) => void
  onHide: (projectId: string) => void
  startSessionKey: string
  hideDisabled: boolean
}

export const ProjectLane = React.memo(function ProjectLane({
  project,
  selectedProjectId,
  selectedAgentId,
  onSelect,
  onHide,
  startSessionKey,
  hideDisabled,
}: ProjectLaneProps) {
  const isProjectSelected = project.id === selectedProjectId
  const railRef = React.useRef<HTMLDivElement | null>(null)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const isEmpty = project.agents.length === 0

  const runningCount = React.useMemo(
    () =>
      project.agents.filter(
        (agent) => agent.status === 'running' || agent.status === 'queued',
      ).length,
    [project.agents],
  )

  const selectedIndex = React.useMemo(() => {
    if (!isProjectSelected) return -1
    return project.agents.findIndex((agent) => agent.id === selectedAgentId)
  }, [isProjectSelected, project.agents, selectedAgentId])

  // Smoothly bring the selected card into view when selection changes via keyboard.
  React.useEffect(() => {
    if (!isProjectSelected) return
    const rail = railRef.current
    if (!rail) return
    const target = rail.querySelector<HTMLElement>(
      `[data-agent-id="${selectedAgentId}"]`,
    )
    if (!target) return
    const railRect = rail.getBoundingClientRect()
    const cardRect = target.getBoundingClientRect()
    const delta =
      cardRect.left -
      railRect.left -
      (railRect.width - cardRect.width) / 2
    if (Math.abs(delta) > 8) {
      rail.scrollBy({ left: delta, behavior: 'smooth' })
    }
  }, [isProjectSelected, selectedAgentId])

  // Fade the pips back out shortly after a scroll settles.
  React.useEffect(() => {
    const wrap = wrapRef.current
    const rail = railRef.current
    if (!wrap || !rail) return
    let timer: number | undefined
    const handler = () => {
      wrap.dataset.scrolling = 'true'
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        delete wrap.dataset.scrolling
      }, 600)
    }
    rail.addEventListener('scroll', handler, { passive: true })
    return () => {
      rail.removeEventListener('scroll', handler)
      window.clearTimeout(timer)
    }
  }, [])

  const showPips = project.agents.length > 1
  return (
    <section
      className={`project-lane ${isEmpty ? 'empty' : ''} ${isProjectSelected ? 'selected' : ''}`}
      aria-label={project.name}
      data-project-id={project.id}
      data-project-selected={isProjectSelected ? 'true' : undefined}
    >
      <div className="project-label">
        <strong>{project.name}</strong>
        <span>
          · {project.agents.length}{' '}
          {project.agents.length === 1 ? 'session' : 'sessions'}
        </span>
        {runningCount > 0 ? (
          <span className="lane-running">{runningCount} running</span>
        ) : null}
        <button
          type="button"
          className="project-lane-hide"
          disabled={hideDisabled}
          onClick={() => onHide(project.id)}
          aria-label={`Hide ${project.name}`}
          title={`Hide ${project.name}`}
        >
          hide
        </button>
      </div>

      {isEmpty ? (
        <div className="agent-row" data-empty="true">
          <span className="empty-session-card" data-testid="empty-project-sessions">
            no sessions <kbd>{formatKeyShort(startSessionKey)}</kbd> to launch
          </span>
        </div>
      ) : (
        <div className="lane-rail-wrap" ref={wrapRef}>
          <div className="agent-row" ref={railRef}>
            {project.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={`agent-cell ${
                  isProjectSelected && agent.id === selectedAgentId
                    ? 'selected'
                    : ''
                }`}
                onClick={() => onSelect(project.id, agent.id)}
                data-agent-id={agent.id}
                data-project-id={project.id}
                data-selected={
                  isProjectSelected && agent.id === selectedAgentId
                    ? 'true'
                    : 'false'
                }
                data-testid="agent-cell"
              >
                <div className="agent-cell-top">
                  <span className="agent-cell-title">{agent.title}</span>
                  <AgentCellState status={agent.status} updatedAt={agent.updatedAt} />
                </div>
                <p>{agent.preview}</p>
                <div className="agent-cell-meta">
                  <span>{agent.messageCount} msg</span>
                  <span className="agent-cell-runtime">{agent.runtime}</span>
                </div>
              </button>
            ))}
          </div>
          {showPips ? (
            <div
              className="lane-pips"
              role="presentation"
              data-count={project.agents.length}
            >
              {project.agents.map((agent, i) => {
                const distance = selectedIndex >= 0 ? Math.abs(i - selectedIndex) : -1
                const weight =
                  distance === 0
                    ? 'active'
                    : distance === 1
                      ? 'near'
                      : distance === 2
                        ? 'mid'
                        : 'far'
                return (
                  <span
                    key={agent.id}
                    className={`lane-pip ${isProjectSelected ? weight : 'far'}`}
                    data-side={
                      selectedIndex >= 0 && i < selectedIndex
                        ? 'before'
                        : selectedIndex >= 0 && i > selectedIndex
                          ? 'after'
                          : 'current'
                    }
                  />
                )
              })}
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}, areProjectLanePropsEqual)

function areProjectLanePropsEqual(previous: ProjectLaneProps, next: ProjectLaneProps) {
  if (
    previous.project !== next.project ||
    previous.startSessionKey !== next.startSessionKey ||
    previous.hideDisabled !== next.hideDisabled ||
    previous.onSelect !== next.onSelect ||
    previous.onHide !== next.onHide
  ) {
    return false
  }

  const wasSelected = previous.project.id === previous.selectedProjectId
  const isSelected = next.project.id === next.selectedProjectId
  if (wasSelected !== isSelected) return false
  if (!isSelected) return true
  return previous.selectedAgentId === next.selectedAgentId
}


function AgentCellState({
  status,
  updatedAt,
}: {
  status: AgentCell['status']
  updatedAt: string
}) {
  if (status === 'idle') {
    const ago = formatAgo(updatedAt)
    if (!ago) return null
    return <span className="agent-cell-state" suppressHydrationWarning>{ago}</span>
  }
  const showLabel = status === 'blocked' || status === 'failed'
  return (
    <span className="agent-cell-state" data-status={status}>
      <span className={`status-dot ${status}`} aria-hidden="true" />
      {showLabel ? <span>{status}</span> : null}
    </span>
  )
}
