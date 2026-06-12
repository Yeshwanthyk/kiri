'use client'

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { GitPullRequest, MessageSquareText, NotebookPen, Plus, TerminalSquare } from 'lucide-react'
import * as React from 'react'
import type {
  AgentCell,
  ProjectRow,
  ReviewTarget,
  RuntimeKind,
  ScratchpadBlock,
  SendMessageImage,
  SessionInterfaceMode,
  ThinkingLevel,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import { thinkingLevelSchema } from '~/lib/contracts'
import { agentDetailQueryOptions, fetchAgentDetail } from '~/server/workspace'
import type { ThemeMode } from '~/theme/kiri-themes'
import { errorMessage, formatKeyShort, formatThinkingLevel } from './format'
import { ScratchpadHeader, ScratchpadPanel } from './scratchpad'
import { ChatPanel } from './chat-panel'
import { TerminalPanel } from './terminal-panel'
import { TerminalWorkspace } from './terminal-workspace'
import { mergeAgentDetail, prependAgentDetailPages } from './agent-detail'
import type { RefreshAgentDetail, SidebarTab } from './board-types'
import type { KeymapSettings } from './navigation'
import type { ChatTypographySettings } from './storage'

const DiffPanel = React.lazy(() =>
  import('./diff-panel').then((module) => ({ default: module.DiffPanel })))

type OlderDetailPage = {
  readonly agentId: string
  readonly revision: string
  readonly offset: number
  readonly page: AgentCell
}

export function SelectedAgentPane({
  selectedProject,
  selectedAgent,
  tab,
  onTabChange,
  chatFocusRequest,
  terminalFocusRequest,
  themeMode,
  keymap,
  chatTypography,
  startSessionKey,
  onStartSession,
  onDeleteSession,
  onRenameSession,
  onSend,
  onRefreshTerminalDiffs,
  onSteer,
  onInterrupt,
  onThinkingCommand,
  onResetSession,
  onForkSession,
  onReviewSession,
  onAnswerQuestion,
  scratchpadBlocks,
  projects,
  settings,
  onCaptureBlock,
  onDeleteBlock,
  onTriggerBlock,
}: {
  selectedProject: ProjectRow
  selectedAgent: AgentCell | undefined
  tab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  chatFocusRequest: number
  terminalFocusRequest: number
  themeMode: ThemeMode
  keymap: KeymapSettings
  chatTypography: ChatTypographySettings
  startSessionKey: string
  onStartSession: () => void
  onDeleteSession: (agentId: string) => void
  onRenameSession: (agentId: string, title: string) => Promise<void>
  onSend: (
    agentId: string,
    text: string,
    images?: SendMessageImage[],
    onDetailRefresh?: RefreshAgentDetail,
  ) => Promise<void>
  onRefreshTerminalDiffs: (
    agentId: string,
    onDetailRefresh?: RefreshAgentDetail,
  ) => Promise<void>
  onSteer: (agentId: string, text: string, images?: SendMessageImage[]) => Promise<void>
  onInterrupt: (agentId: string) => Promise<void>
  onThinkingCommand: (agentId: string, level?: ThinkingLevel) => Promise<void>
  onResetSession: (agentId: string) => Promise<void>
  onForkSession: (agentId: string) => Promise<void>
  onReviewSession: (agentId: string, target: ReviewTarget) => Promise<void>
  onAnswerQuestion: (
    agentId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ) => Promise<void>
  scratchpadBlocks: ScratchpadBlock[]
  projects: ProjectRow[]
  settings: WorkspaceSnapshot['settings']
  onCaptureBlock: (body: string, projectId: string | null) => Promise<void>
  onDeleteBlock: (id: string) => Promise<void>
  onTriggerBlock: (
    block: ScratchpadBlock,
    overrides?: {
      projectId?: string
      runtime?: RuntimeKind
      interfaceMode?: SessionInterfaceMode
      model?: string
      thinkingLevel?: ThinkingLevel
      title?: string
    },
  ) => Promise<void>
}) {
  const revision = selectedAgent
    ? `${selectedAgent.updatedAt}:${selectedAgent.messageCount}:${selectedAgent.diffCount}:${selectedAgent.status}`
    : ''
  const detailQuery = useQuery({
    ...agentDetailQueryOptions(selectedAgent?.id ?? '', 500, revision),
    placeholderData: keepPreviousData,
  })
  const [olderDetailPages, setOlderDetailPages] = React.useState<OlderDetailPage[]>([])
  const [olderHistoryPending, setOlderHistoryPending] = React.useState(false)
  const detailBasisRef = React.useRef<{ agentId: string; revision: string } | null>(null)
  React.useEffect(() => {
    setOlderDetailPages([])
  }, [selectedAgent?.id, revision])
  React.useEffect(() => {
    detailBasisRef.current = selectedAgent ? { agentId: selectedAgent.id, revision } : null
  }, [selectedAgent, revision])
  const detailAgent = detailQuery.isPlaceholderData ? undefined : detailQuery.data
  const latestAgent = mergeAgentDetail(selectedAgent, detailAgent)
  const olderPagesForAgent = React.useMemo(
    () =>
      olderDetailPages
        .filter((item) =>
          item.agentId === selectedAgent?.id && item.revision === revision,
        )
        .map((item) => item.page),
    [olderDetailPages, revision, selectedAgent?.id],
  )
  const agent = prependAgentDetailPages(latestAgent, olderPagesForAgent)
  const chatUsesTerminal = agent?.interfaceMode === 'terminal'
  const visibleTerminalMode = agent && tab === 'terminal'
    ? 'shell'
    : agent && tab === 'chat' && chatUsesTerminal
      ? 'runtime'
      : null
  const [mountedTerminalModes, setMountedTerminalModes] = React.useState<{
    readonly runtime: boolean
    readonly shell: boolean
  }>({ runtime: false, shell: false })
  React.useEffect(() => {
    setMountedTerminalModes({
      runtime: selectedAgent?.interfaceMode === 'terminal' && tab === 'chat',
      shell: Boolean(selectedAgent) && tab === 'terminal',
    })
  }, [selectedProject.id, selectedAgent?.id, selectedAgent?.interfaceMode])
  React.useEffect(() => {
    if (!visibleTerminalMode) return
    setMountedTerminalModes((current) => current[visibleTerminalMode]
      ? current
      : { ...current, [visibleTerminalMode]: true })
  }, [visibleTerminalMode])
  const refreshDetail = React.useCallback(async () => {
    if (!selectedAgent) return
    await detailQuery.refetch()
  }, [detailQuery, selectedAgent])
  const loadOlderHistory = React.useCallback(async () => {
    if (!agent || olderHistoryPending) return
    const requestBasis = detailBasisRef.current
    if (!requestBasis) return
    const requestOffset = agent.timeline.length
    setOlderHistoryPending(true)
    try {
      const page = await fetchAgentDetail({
        data: {
          agentId: agent.id,
          limit: 500,
          offset: requestOffset,
        },
      })
      const currentBasis = detailBasisRef.current
      if (
        !currentBasis ||
        currentBasis.agentId !== requestBasis.agentId ||
        currentBasis.revision !== requestBasis.revision
      ) {
        return
      }
      setOlderDetailPages((current) => {
        const offset = page.timelinePage?.offset ?? requestOffset
        if (current.some((item) =>
          item.agentId === requestBasis.agentId &&
          item.revision === requestBasis.revision &&
          item.offset === offset,
        )) {
          return current
        }
        return [
          ...current,
          {
            agentId: requestBasis.agentId,
            revision: requestBasis.revision,
            offset,
            page,
          },
        ]
      })
    } finally {
      setOlderHistoryPending(false)
    }
  }, [agent, olderHistoryPending])
  const previousDiffRefreshRef = React.useRef<{
    tab: SidebarTab | null
    agentId: string | null
  }>({ tab: null, agentId: null })

  React.useEffect(() => {
    const previous = previousDiffRefreshRef.current
    const agentId = agent?.id ?? null
    previousDiffRefreshRef.current = { tab, agentId }
    const shouldRefresh = tab === 'diffs'
      && agent?.interfaceMode === 'terminal'
      && (previous.tab !== 'diffs' || previous.agentId !== agent.id)
    if (!shouldRefresh) return
    void onRefreshTerminalDiffs(agent.id, refreshDetail).catch((error) => {
      console.error('Failed to refresh terminal diffs', error)
    })
  }, [agent, onRefreshTerminalDiffs, refreshDetail, tab])

  const tabBar = (
    <div className="sidebar-tabs" role="tablist" aria-label="Selected agent view">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'chat'}
        className={tab === 'chat' ? 'active' : ''}
        onClick={() => onTabChange('chat')}
        disabled={!agent}
        data-testid="tab-chat"
      >
        <MessageSquareText size={15} />
        Chat
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'diffs'}
        className={tab === 'diffs' ? 'active' : ''}
        onClick={() => onTabChange('diffs')}
        disabled={!agent}
        data-testid="tab-diffs"
      >
        <GitPullRequest size={15} />
        Diffs
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'terminal'}
        className={tab === 'terminal' ? 'active' : ''}
        onClick={() => onTabChange('terminal')}
        disabled={!agent}
        data-testid="tab-terminal"
      >
        <TerminalSquare size={15} />
        Terminal
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'scratchpad'}
        className={tab === 'scratchpad' ? 'active' : ''}
        onClick={() => onTabChange('scratchpad')}
        data-testid="tab-scratchpad"
      >
        <NotebookPen size={15} />
        Scratchpad
        {scratchpadBlocks.length > 0 ? (
          <span className="sidebar-tab-count">{scratchpadBlocks.length}</span>
        ) : null}
      </button>
    </div>
  )

  return (
    <aside
      className="sidebar-pane"
      aria-label="Selected chat"
      data-testid="sidebar-pane"
    >
      {agent ? (
        <SidebarHeader
          project={selectedProject}
          agent={agent}
          onDeleteSession={onDeleteSession}
          onRenameSession={onRenameSession}
        />
      ) : tab === 'scratchpad' ? (
        <ScratchpadHeader blockCount={scratchpadBlocks.length} />
      ) : null}

      {tabBar}

      {tab === 'scratchpad' ? (
        <ScratchpadPanel
          blocks={scratchpadBlocks}
          projects={projects}
          settings={settings}
          selectedProjectId={selectedProject.id}
          onCapture={onCaptureBlock}
          onDelete={onDeleteBlock}
          onTrigger={onTriggerBlock}
        />
      ) : agent && tab === 'chat' && !chatUsesTerminal ? (
        <ChatPanel
          key={agent.id}
          agent={agent}
          cwd={selectedProject.cwd}
          themeMode={themeMode}
          focusRequest={chatFocusRequest}
          onSend={(agentId, text, images) =>
            onSend(agentId, text, images, refreshDetail)
          }
          onSteer={onSteer}
          onInterrupt={onInterrupt}
          onThinkingCommand={onThinkingCommand}
          onResetSession={onResetSession}
          onForkSession={onForkSession}
          onReviewSession={onReviewSession}
          onAnswerQuestion={onAnswerQuestion}
          onDetailRefresh={refreshDetail}
          hasOlderHistory={agent.timelinePage?.hasMore ?? false}
          olderHistoryLoaded={olderPagesForAgent.length > 0}
          olderHistoryPending={olderHistoryPending}
          onLoadOlderHistory={loadOlderHistory}
        />
      ) : agent && tab === 'diffs' ? (
        <React.Suspense fallback={<div className="empty-panel">Loading diff view...</div>}>
          <DiffPanel
            key={agent.id}
            agent={agent}
            themeMode={themeMode}
          />
        </React.Suspense>
      ) : agent && (tab === 'terminal' || (tab === 'chat' && chatUsesTerminal)) ? null : !agent ? (
        <EmptySessionPanel
          project={selectedProject}
          startSessionKey={startSessionKey}
          onStart={onStartSession}
        />
      ) : null}

      {agent && mountedTerminalModes.runtime ? (
        <TerminalPanel
          key={`terminal-${agent.id}-runtime`}
          agent={agent}
          focusRequest={terminalFocusRequest}
          toggleFocusKey={keymap.toggleTerminalFocus}
          typography={chatTypography}
          mode="runtime"
          project={selectedProject}
          themeMode={themeMode}
          visible={visibleTerminalMode === 'runtime'}
        />
      ) : null}
      {agent && mountedTerminalModes.shell ? (
        <TerminalWorkspace
          key={`terminal-workspace-${selectedProject.id}`}
          agent={agent}
          focusRequest={terminalFocusRequest}
          toggleFocusKey={keymap.toggleTerminalFocus}
          typography={chatTypography}
          project={selectedProject}
          themeMode={themeMode}
          visible={visibleTerminalMode === 'shell'}
        />
      ) : null}
    </aside>
  )
}

function EmptySessionPanel({
  project,
  startSessionKey,
  onStart,
}: {
  project: ProjectRow
  startSessionKey: string
  onStart: () => void
}) {
  return (
    <div className="empty-sidebar-session" data-testid="empty-session-panel">
      <p className="empty-session-kicker" data-testid="selected-project">{project.name}</p>
      <h2 data-testid="selected-agent">No session</h2>
      <p className="empty-session-hint">
        Press <kbd>{formatKeyShort(startSessionKey)}</kbd> to start
      </p>
      <button type="button" className="empty-session-action" onClick={onStart}>
        <Plus size={13} aria-hidden="true" />
        Start session
      </button>
    </div>
  )
}

function SidebarHeader({
  project,
  agent,
  onDeleteSession,
  onRenameSession,
}: {
  project: ProjectRow
  agent: AgentCell
  onDeleteSession: (agentId: string) => void
  onRenameSession: (agentId: string, title: string) => Promise<void>
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState(false)
  const [draftTitle, setDraftTitle] = React.useState(agent.title)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    setDraftTitle(agent.title)
  }, [agent.id, agent.title])

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  async function commitTitle() {
    const next = draftTitle.trim()
    if (!next || next === agent.title) {
      setEditing(false)
      setDraftTitle(agent.title)
      return
    }
    setPending(true)
    setError(null)
    try {
      await onRenameSession(agent.id, next)
      setEditing(false)
    } catch (cause) {
      setError(errorMessage(cause))
      setDraftTitle(agent.title)
    } finally {
      setPending(false)
    }
  }

  function removeSession() {
    if (!agent.isSession) return
    onDeleteSession(agent.id)
  }

  function beginEdit() {
    if (!agent.isSession) return
    setDraftTitle(agent.title)
    setEditing(true)
  }

  const thinkingLevel = currentThinkingLevel(agent)
  const thinking = formatThinkingLevel(thinkingLevel ?? 'off')
  const canEdit = agent.isSession
  const canRemove = agent.isSession && !pending

  return (
    <header className="chat-header">
      <div className="chat-header-row">
        <span
          className={`chat-status-dot ${agent.status}`}
          title={agent.status}
          aria-label={`Status: ${agent.status}`}
        />
        <span className="chat-meta" data-meta="project" data-testid="selected-project" title={project.name}>
          {project.name}
        </span>
        <span className="chat-meta chat-meta-divider" data-divider="slot" aria-hidden="true">·</span>
        <span className="chat-meta" data-meta="slot" title={agent.slot}>{agent.slot}</span>
        <span className="chat-meta chat-meta-divider" data-divider="model" aria-hidden="true">·</span>
        <span className="chat-meta" data-meta="model" title={`${agent.model} · thinking ${thinking}`}>
          {agent.model}
          <span className="chat-meta-thinking">:{thinking}</span>
        </span>

        <span className="chat-header-spacer" />

        {editing ? (
          <input
            ref={inputRef}
            className="chat-title-input"
            value={draftTitle}
            disabled={pending}
            data-testid="chat-title-input"
            onChange={(event) => setDraftTitle(event.currentTarget.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void commitTitle()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(false)
                setDraftTitle(agent.title)
              }
            }}
            aria-label="Rename session"
          />
        ) : (
          <button
            type="button"
            className="chat-title"
            onClick={beginEdit}
            disabled={!canEdit}
            data-testid="selected-agent"
            title={canEdit ? 'Click to rename' : agent.title}
          >
            {agent.title}
          </button>
        )}

        <button
          type="button"
          className="chat-icon-button"
          onClick={beginEdit}
          disabled={!canEdit || editing}
          aria-label="Rename session"
          title="Rename session"
          data-testid="rename-session"
        >
          <EditIcon />
        </button>
        <button
          type="button"
          className="chat-icon-button chat-icon-danger"
          onClick={removeSession}
          disabled={!canRemove}
          aria-label={`Remove ${agent.title}`}
          title={agent.isSession ? 'Remove session' : 'Only sessions can be removed'}
          data-testid="remove-session"
        >
          <RemoveIcon />
        </button>
      </div>
      {error ? <span className="chat-header-error" role="status">{error}</span> : null}
      <span className="chat-thinking-track" data-testid="thinking-level" aria-hidden="true">Thinking {thinking}</span>
    </header>
  )
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.3 2.1l2.6 2.6" />
      <path d="M10.6 0.8l1.6 1.6a1 1 0 0 1 0 1.4l-7.2 7.2-3 0.6 0.6-3 7.2-7.2a1 1 0 0 1 1.4 0z" />
    </svg>
  )
}

function RemoveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l8 8" />
      <path d="M11 3l-8 8" />
    </svg>
  )
}

function currentThinkingLevel(agent: AgentCell) {
  for (let index = agent.timelineEvents.length - 1; index >= 0; index -= 1) {
    const event = agent.timelineEvents[index]
    if (event?.kind !== 'thinking_level') continue
    const parsed = thinkingLevelSchema.safeParse(event.detail)
    if (parsed.success) return parsed.data
  }
  return null
}
