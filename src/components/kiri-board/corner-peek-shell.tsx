'use client'

import * as React from 'react'
import { X } from 'lucide-react'
import type { AgentCell, ProjectRow } from '~/lib/contracts'
import type { SidebarTab } from './board-types'
import { CornerPeek } from './corner-peek'
import { ResourceStage } from './resource-stage'
import { ResourceTabStrip } from './resource-tab-strip'
import type { ProjectResource, ResourceId } from './resource-tabs'
import { ScratchpadHeader, ScratchpadPanel } from './scratchpad'

type StageProps = React.ComponentProps<typeof ResourceStage>

type CornerPeekShellProps = Omit<
  StageProps,
  'selectedProject' | 'selectedAgent' | 'tab' | 'onTabChange' | 'chrome' | 'projects' | 'onStartSession'
> & {
  readonly projects: ProjectRow[]
  readonly hiddenProjects: ProjectRow[]
  readonly selectedProject: ProjectRow
  readonly selectedAgent: AgentCell | undefined
  readonly resources: readonly ProjectResource[]
  readonly activeResourceId: ResourceId | null
  readonly scratchpadOpen: boolean
  readonly hydrated: boolean
  readonly resourcesByProject: Record<string, {
    readonly resources: readonly ProjectResource[]
    readonly activeResourceId: ResourceId | null
  }>
  readonly cornerPeekHeld: boolean
  readonly onAgentTabChange: (tab: SidebarTab) => void
  readonly onSelectProject: (projectId: string) => void
  readonly onSelectAgent: (projectId: string, agentId: string) => void
  readonly onSelectResource: (projectId: string, resourceId: ResourceId) => void
  readonly onMoveResource: (projectId: string, resourceId: ResourceId, toIndex: number) => void
  readonly onCloseAgent: (agentId: string) => void
  readonly onRenameAgent: (agentId: string, title: string) => Promise<void>
  readonly onEnsureTerminal: (projectId: string) => void
  readonly onOpenScratchpad: () => void
  readonly onCloseScratchpad: () => void
  readonly onStartSession: () => void
  readonly onOpenProjects: (returnFocusElement?: HTMLElement | null) => void
  readonly onOpenSettings: () => void
}

export function CornerPeekShell({
  projects,
  hiddenProjects,
  selectedProject,
  selectedAgent,
  resources,
  activeResourceId,
  scratchpadOpen,
  hydrated,
  resourcesByProject,
  cornerPeekHeld,
  onAgentTabChange,
  onSelectProject,
  onSelectAgent,
  onSelectResource,
  onMoveResource,
  onCloseAgent,
  onRenameAgent,
  onEnsureTerminal,
  onOpenScratchpad,
  onCloseScratchpad,
  onStartSession,
  onOpenProjects,
  onOpenSettings,
  ...stageProps
}: CornerPeekShellProps) {
  const activeResource = resources.find((resource) => resource.id === activeResourceId) ?? resources[0]
  const agentTitles = React.useMemo(
    () => new Map(selectedProject.agents.map((agent) => [agent.id, agent.title] as const)),
    [selectedProject.agents],
  )
  const stageAgent = resolveStageAgent(selectedProject, selectedAgent, activeResource)
  const stageTab = resolveStageTab(activeResource)

  function selectResource(resourceId: ResourceId) {
    const resource = resources.find((item) => item.id === resourceId)
    if (resource?.kind === 'agent') {
      onSelectAgent(selectedProject.id, resource.agentId)
    }
    onSelectResource(selectedProject.id, resourceId)
  }

  return (
    <section
      className="corner-peek-shell"
      data-testid="board-pane"
      data-shell="corner-peek"
      data-hydrated={hydrated ? 'true' : 'false'}
      data-active-resource-kind={activeResource?.kind ?? 'empty'}
    >
      <ResourceTabStrip
        resources={resources}
        activeResourceId={activeResourceId}
        agentTitles={agentTitles}
        onSelectResource={selectResource}
        onMoveResource={(resourceId, toIndex) =>
          onMoveResource(selectedProject.id, resourceId, toIndex)}
        onCloseAgent={onCloseAgent}
        onRenameAgent={onRenameAgent}
        onAddTerminal={() => {
          if (selectedAgent) onEnsureTerminal(selectedProject.id)
        }}
        terminalDisabled={!selectedAgent}
        onOpenScratchpad={onOpenScratchpad}
        onStartSession={onStartSession}
      />

      <CornerPeek
        projects={projects}
        hiddenProjects={hiddenProjects}
        selectedProjectId={selectedProject.id}
        activeResourceId={activeResourceId}
        resourcesByProject={resourcesByProject}
        held={cornerPeekHeld}
        onSelectProject={onSelectProject}
        onSelectResource={onSelectResource}
        onOpenProjects={onOpenProjects}
        onOpenSettings={onOpenSettings}
      />

      <ResourceStage
        {...stageProps}
        chrome="stage"
        selectedProject={selectedProject}
        selectedAgent={stageAgent}
        tab={stageTab}
        onTabChange={onAgentTabChange}
        projects={projects}
        onStartSession={onStartSession}
      />

      {scratchpadOpen ? (
        <>
          <button
            type="button"
            className="scratchpad-float-scrim"
            aria-label="Close scratchpad"
            onClick={onCloseScratchpad}
          />
          <section
            className="scratchpad-float"
            role="dialog"
            aria-label="Scratchpad"
            data-testid="scratchpad-float"
            onKeyDown={(event) => {
              if (event.key === 'Escape') onCloseScratchpad()
            }}
          >
            <button
              type="button"
              className="scratchpad-float-close"
              aria-label="Close scratchpad"
              data-testid="scratchpad-float-close"
              onClick={onCloseScratchpad}
            >
              <X size={15} aria-hidden="true" />
            </button>
            <ScratchpadHeader blockCount={stageProps.scratchpadBlocks.length} />
            <ScratchpadPanel
              blocks={stageProps.scratchpadBlocks}
              projects={projects}
              settings={stageProps.settings}
              selectedProjectId={selectedProject.id}
              onCapture={stageProps.onCaptureBlock}
              onDelete={stageProps.onDeleteBlock}
              onTrigger={stageProps.onTriggerBlock}
            />
          </section>
        </>
      ) : null}
    </section>
  )
}

function resolveStageAgent(
  selectedProject: ProjectRow,
  selectedAgent: AgentCell | undefined,
  activeResource: ProjectResource | undefined,
) {
  if (activeResource?.kind === 'agent') {
    return selectedProject.agents.find((agent) => agent.id === activeResource.agentId)
  }
  if (activeResource?.kind === 'terminal') return selectedAgent ?? selectedProject.agents[0]
  return undefined
}

function resolveStageTab(activeResource: ProjectResource | undefined): SidebarTab {
  if (activeResource?.kind === 'terminal') return 'terminal'
  return 'chat'
}
