'use client'

import * as React from 'react'
import { X } from 'lucide-react'
import type { AgentCell, KnowledgeAddInput, KnowledgeEntry, ProjectRow } from '~/lib/contracts'
import type { SidebarTab } from './board-types'
import { CornerPeek } from './corner-peek'
import { ResourceStage } from './resource-stage'
import { ResourceTabStrip } from './resource-tab-strip'
import {
  collectBrowserResources,
  type ProjectResource,
  type ResourceId,
} from './resource-tabs'
import { ScratchpadHeader, ScratchpadPanel } from './scratchpad'
import { KnowledgeHeader, KnowledgePanel } from './knowledge-panel'

type StageProps = React.ComponentProps<typeof ResourceStage>

type CornerPeekShellProps = Omit<
  StageProps,
  | 'selectedProject'
  | 'selectedAgent'
  | 'selectedBrowserResource'
  | 'browserResources'
  | 'tab'
  | 'chrome'
  | 'projects'
  | 'onStartSession'
> & {
  readonly projects: ProjectRow[]
  readonly hiddenProjects: ProjectRow[]
  readonly selectedProject: ProjectRow
  readonly selectedAgent: AgentCell | undefined
  readonly resources: readonly ProjectResource[]
  readonly activeResourceId: ResourceId | null
  readonly scratchpadOpen: boolean
  readonly knowledgeOpen: boolean
  readonly knowledgeEntries: readonly KnowledgeEntry[]
  readonly hydrated: boolean
  readonly browserAvailable: boolean
  readonly resourcesByProject: Record<string, {
    readonly resources: readonly ProjectResource[]
    readonly activeResourceId: ResourceId | null
  }>
  readonly cornerPeekHeld: boolean
  readonly projectVisibilityPendingId: string | null
  readonly onSelectProject: (projectId: string) => void
  readonly onSelectAgent: (projectId: string, agentId: string) => void
  readonly onSelectResource: (projectId: string, resourceId: ResourceId) => void
  readonly onMoveResource: (projectId: string, resourceId: ResourceId, toIndex: number) => void
  readonly onCloseAgent: (agentId: string) => void
  readonly onRenameAgent: (agentId: string, title: string) => Promise<void>
  readonly onEnsureTerminal: (projectId: string) => void
  readonly onEnsureBrowser: (projectId: string) => void
  readonly onOpenScratchpad: () => void
  readonly onCloseScratchpad: () => void
  readonly onOpenKnowledge: () => void
  readonly onCloseKnowledge: () => void
  readonly onCaptureKnowledge: (input: KnowledgeAddInput) => Promise<KnowledgeEntry>
  readonly onDeleteKnowledge: (id: string) => Promise<void>
  readonly onStartSession: () => void
  readonly onHideProject: (projectId: string) => void
  readonly onUnhideProject: (projectId: string) => void
  readonly onOpenProjects: (returnFocusElement?: HTMLElement | null) => void
  readonly onOpenSettings: () => void
  readonly onPeekExpandedChange?: (expanded: boolean) => void
}

export function CornerPeekShell({
  projects,
  hiddenProjects,
  selectedProject,
  selectedAgent,
  resources,
  activeResourceId,
  scratchpadOpen,
  knowledgeOpen,
  knowledgeEntries,
  hydrated,
  browserAvailable,
  resourcesByProject,
  cornerPeekHeld,
  projectVisibilityPendingId,
  onSelectProject,
  onSelectAgent,
  onSelectResource,
  onMoveResource,
  onCloseAgent,
  onRenameAgent,
  onEnsureTerminal,
  onEnsureBrowser,
  onOpenScratchpad,
  onCloseScratchpad,
  onOpenKnowledge,
  onCloseKnowledge,
  onCaptureKnowledge,
  onDeleteKnowledge,
  onStartSession,
  onHideProject,
  onUnhideProject,
  onOpenProjects,
  onOpenSettings,
  onPeekExpandedChange,
  ...stageProps
}: CornerPeekShellProps) {
  const activeResource = resources.find((resource) => resource.id === activeResourceId) ?? resources[0]
  const agentTitles = React.useMemo(
    () => new Map(selectedProject.agents.map((agent) => [agent.id, agent.title] as const)),
    [selectedProject.agents],
  )
  const stageAgent = resolveStageAgent(selectedProject, selectedAgent, activeResource)
  const stageBrowser = resolveStageBrowser(activeResource)
  const stageTab = resolveStageTab(activeResource)
  const browserResources = React.useMemo(
    () => collectBrowserResources(resourcesByProject),
    [resourcesByProject],
  )

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
        browserAvailable={browserAvailable}
        onAddBrowser={() => onEnsureBrowser(selectedProject.id)}
        onOpenScratchpad={onOpenScratchpad}
        onOpenKnowledge={onOpenKnowledge}
        onStartSession={onStartSession}
      />

      <CornerPeek
        projects={projects}
        hiddenProjects={hiddenProjects}
        selectedProjectId={selectedProject.id}
        activeResourceId={activeResourceId}
        resourcesByProject={resourcesByProject}
        held={cornerPeekHeld}
        pendingProjectId={projectVisibilityPendingId}
        onSelectProject={onSelectProject}
        onSelectResource={onSelectResource}
        onHide={onHideProject}
        onUnhide={onUnhideProject}
        onOpenProjects={onOpenProjects}
        onOpenSettings={onOpenSettings}
        onExpandedChange={onPeekExpandedChange}
      />

      <ResourceStage
        {...stageProps}
        chrome="stage"
        selectedProject={selectedProject}
        selectedAgent={stageAgent}
        selectedBrowserResource={stageBrowser}
        browserResources={browserResources}
        tab={stageTab}
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
      {knowledgeOpen ? (
        <>
          <button
            type="button"
            className="scratchpad-float-scrim"
            aria-label="Close knowledge"
            onClick={onCloseKnowledge}
          />
          <section
            className="scratchpad-float"
            role="dialog"
            aria-label="Knowledge"
            data-testid="knowledge-float"
            onKeyDown={(event) => {
              if (event.key === 'Escape') onCloseKnowledge()
            }}
          >
            <button
              type="button"
              className="scratchpad-float-close"
              aria-label="Close knowledge"
              data-testid="knowledge-float-close"
              onClick={onCloseKnowledge}
            >
              <X size={15} aria-hidden="true" />
            </button>
            <KnowledgeHeader entryCount={knowledgeEntries.length} />
            <KnowledgePanel
              entries={knowledgeEntries}
              projects={projects}
              selectedProjectId={selectedProject.id}
              onCapture={onCaptureKnowledge}
              onDelete={onDeleteKnowledge}
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

function resolveStageBrowser(activeResource: ProjectResource | undefined) {
  return activeResource?.kind === 'browser' ? activeResource : undefined
}

function resolveStageTab(activeResource: ProjectResource | undefined): SidebarTab {
  if (activeResource?.kind === 'terminal') return 'terminal'
  if (activeResource?.kind === 'browser') return 'browser'
  return 'chat'
}
