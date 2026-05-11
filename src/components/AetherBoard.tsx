'use client'

import { PatchDiff } from '@pierre/diffs/react'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Columns2,
  Command,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  GitPullRequest,
  ImagePlus,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Plus,
  Rows3,
  Send,
  Settings2,
  Square,
  Shuffle,
  TerminalSquare,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import * as React from 'react'
import type {
  AgentCell,
  BoardMessage,
  DiffArtifact,
  PendingQuestion,
  ProjectRow,
  RuntimeKind,
  SendMessageImage,
  ThinkingLevel,
  TimelineEvent,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import { thinkingLevelSchema } from '~/lib/contracts'
import {
  applyAetherTheme,
  defaultThemeSelection,
  getAetherThemeTokens,
  normalizeThemeSelection,
  aetherThemeNames,
  type AetherThemeName,
  type ThemeMode,
  type ThemeSelection,
} from '~/theme/aether-themes'
import {
  addProjectMutation,
  answerQuestionMutation,
  chooseProjectDirectoryMutation,
  deleteProjectMutation,
  deleteSessionMutation,
  agentDetailQueryOptions,
  fetchWorkspaceSnapshot,
  forkSessionMutation,
  hideProjectMutation,
  interruptMessageMutation,
  renameSessionMutation,
  resetSessionMutation,
  sendMessageMutation,
  setThinkingLevelMutation,
  startSessionMutation,
  steerMessageMutation,
  terminalConfigQuery,
  unhideProjectMutation,
} from '~/server/workspace'

type SidebarTab = 'chat' | 'diffs' | 'terminal'
type DiffStyle = 'unified' | 'split'
const THINKING_RUNTIMES = new Set<RuntimeKind>(['pi', 'codex', 'claude'])

function supportsThinking(runtime: RuntimeKind) {
  return THINKING_RUNTIMES.has(runtime)
}

type AgentTimelineRow =
  | {
      kind: 'message'
      id: string
      message: BoardMessage
    }
  | {
      kind: 'work'
      id: string
      startedAt: string
      entries: TimelineWorkEntry[]
    }
  | {
      kind: 'working'
      id: string
      startedAt: string | null
    }

type TimelineWorkEntry = {
  id: string
  kind: string
  tone: TimelineEvent['tone']
  label: string
  detail: string | null
  timestamp: string
}

type KeymapAction =
  | 'projectPrev'
  | 'projectNext'
  | 'agentPrev'
  | 'agentNext'
  | 'startSession'
  | 'deleteSession'
  | 'focusChat'
  | 'openDiffs'
  | 'openTerminal'

type KeymapSettings = Record<KeymapAction, string>

type ChatFontSize = 'compact' | 'comfortable' | 'large' | 'xlarge'

type ChatTypographySettings = {
  fontSize: ChatFontSize
}

type RefreshAgentDetail = () => Promise<void>

function mergeAgentDetail(
  summary: AgentCell | undefined,
  detail: AgentCell | undefined,
) {
  if (!summary) return undefined
  if (!detail || detail.id !== summary.id) return summary
  return {
    ...summary,
    messages: detail.messages,
    timelineEvents: detail.timelineEvents,
    timeline: detail.timeline,
    diffs: detail.diffs,
    contextUsage: detail.contextUsage,
    pendingQuestion: detail.pendingQuestion,
  }
}

type GhosttyTerminalInstance = InstanceType<(typeof import('ghostty-web'))['Terminal']>
type GhosttyFitAddonInstance = InstanceType<(typeof import('ghostty-web'))['FitAddon']>

type Selection = {
  projectId: string
  agentId: string
}

type CommandPaletteAction = {
  id: string
  title: string
  detail: string
  icon: LucideIcon
  disabled: boolean
  run: () => void
}

const sessionThinkingLevels = ['off', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly ThinkingLevel[]

const defaultKeymap: KeymapSettings = {
  projectPrev: 'k',
  projectNext: 'j',
  agentPrev: 'h',
  agentNext: 'l',
  startSession: 'n',
  deleteSession: 'x',
  focusChat: 'c',
  openDiffs: 'd',
  openTerminal: 't',
}

const keyOptions = [
  'h',
  'j',
  'k',
  'l',
  'n',
  'x',
  'c',
  'd',
  't',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]
const chatFontSizes: Record<ChatFontSize, { label: string; size: string; lineHeight: string }> = {
  compact: { label: 'Compact · 13px', size: '13px', lineHeight: '1.5' },
  comfortable: { label: 'Comfortable · 14px', size: '14px', lineHeight: '1.58' },
  large: { label: 'Large · 16px', size: '16px', lineHeight: '1.62' },
  xlarge: { label: 'Extra large · 18px', size: '18px', lineHeight: '1.66' },
}

const defaultChatTypography: ChatTypographySettings = { fontSize: 'comfortable' }
const keymapStorageKey = 'aether:keymap:v1'
const themeStorageKey = 'aether:theme:v1'
const chatTypographyStorageKey = 'aether:chat-typography:v1'
const chatDraftStorageKey = 'aether:chat-drafts:v1'

export function AetherBoard({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [workspace, setWorkspace] = React.useState(snapshot)
  const [selection, setSelection] = React.useState<Selection>(snapshot.selected)
  const [tab, setTab] = React.useState<SidebarTab>('chat')
  const [hydrated, setHydrated] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [projectManagerOpen, setProjectManagerOpen] = React.useState(false)
  const [sessionLauncherOpen, setSessionLauncherOpen] = React.useState(false)
  const [agentSwitcherOpen, setAgentSwitcherOpen] = React.useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false)
  const [pendingDelete, setPendingDelete] = React.useState<{ agentId: string; title: string } | null>(null)
  const [deleteInFlight, setDeleteInFlight] = React.useState(false)
  const [keymap, setKeymap] = React.useState<KeymapSettings>(defaultKeymap)
  const [themeSelection, setThemeSelection] = React.useState<ThemeSelection>(defaultThemeSelection)
  const [chatTypography, setChatTypography] = React.useState<ChatTypographySettings>(defaultChatTypography)
  const [chatFocusRequest, setChatFocusRequest] = React.useState(0)
  const addProject = useServerFn(addProjectMutation)
  const answerQuestion = useServerFn(answerQuestionMutation)
  const chooseProjectDirectory = useServerFn(chooseProjectDirectoryMutation)
  const deleteProject = useServerFn(deleteProjectMutation)
  const deleteSession = useServerFn(deleteSessionMutation)
  const forkSession = useServerFn(forkSessionMutation)
  const hideProject = useServerFn(hideProjectMutation)
  const refreshWorkspace = useServerFn(fetchWorkspaceSnapshot)
  const resetSession = useServerFn(resetSessionMutation)
  const sendMessage = useServerFn(sendMessageMutation)
  const setThinkingLevel = useServerFn(setThinkingLevelMutation)
  const steerMessage = useServerFn(steerMessageMutation)
  const interruptMessage = useServerFn(interruptMessageMutation)
  const renameSession = useServerFn(renameSessionMutation)
  const startSession = useServerFn(startSessionMutation)
  const unhideProject = useServerFn(unhideProjectMutation)

  const selectedProject =
    workspace.projects.find((project) => project.id === selection.projectId) ??
    workspace.projects[0]
  const selectedAgent =
    selectedProject?.agents.find((agent) => agent.id === selection.agentId) ??
    selectedProject?.agents[0]

  React.useEffect(() => {
    setWorkspace(snapshot)
  }, [snapshot])

  React.useEffect(() => {
    if (!selectedProject) return
    const agentId = selectedAgent?.id ?? ''
    if (selectedProject.id !== selection.projectId || agentId !== selection.agentId) {
      setSelection({ projectId: selectedProject.id, agentId })
    }
  }, [selectedAgent, selectedProject, selection.agentId, selection.projectId])

  React.useEffect(() => {
    setHydrated(true)
    setKeymap(readStoredKeymap())
    setThemeSelection(readStoredThemeSelection())
    setChatTypography(readStoredChatTypography())
  }, [])

  React.useEffect(() => {
    applyAetherTheme(document.documentElement, themeSelection)
  }, [themeSelection])

  React.useEffect(() => {
    applyChatTypography(document.documentElement, chatTypography)
  }, [chatTypography])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === 'k') {
        event.preventDefault()
        setSettingsOpen(false)
        setSessionLauncherOpen(false)
        setAgentSwitcherOpen(false)
        setCommandPaletteOpen((open) => !open)
        return
      }

      if (
        event.key === 'Escape' &&
        (commandPaletteOpen || agentSwitcherOpen || projectManagerOpen)
      ) {
        event.preventDefault()
        setCommandPaletteOpen(false)
        setAgentSwitcherOpen(false)
        setProjectManagerOpen(false)
        return
      }

      if (commandPaletteOpen || agentSwitcherOpen || !event.shiftKey || isEditableTarget(event.target)) return

      const action = actionForKey(keymap, key)
      if (!action) return
      event.preventDefault()

      if (action === 'focusChat') {
        setSettingsOpen(false)
        setSessionLauncherOpen(false)
        setAgentSwitcherOpen(false)
        setCommandPaletteOpen(false)
        setTab('chat')
        setChatFocusRequest((request) => request + 1)
        return
      }

      if (action === 'openDiffs') {
        setTab('diffs')
        return
      }

      if (action === 'openTerminal') {
        setTab('terminal')
        return
      }

      if (action === 'startSession') {
        setSettingsOpen(false)
        setAgentSwitcherOpen(false)
        setCommandPaletteOpen(false)
        setSessionLauncherOpen(true)
        return
      }

      if (action === 'deleteSession') {
        const project =
          workspace.projects.find((row) => row.id === selection.projectId) ??
          workspace.projects[0]
        const agent = project?.agents.find((row) => row.id === selection.agentId)
        if (agent?.isSession) {
          void handleDeleteSession(agent.id)
        }
        return
      }

      if (action === 'projectPrev' || action === 'projectNext') {
        setChatFocusRequest(0)
        setSelection((current) =>
          moveProject(workspace.projects, current, action === 'projectNext' ? 1 : -1),
        )
        return
      }

      setChatFocusRequest(0)
      setSelection((current) => {
        const project =
          workspace.projects.find((row) => row.id === current.projectId) ??
          workspace.projects[0]
        if (!project) return current
        return moveAgent(project, current, action === 'agentNext' ? 1 : -1)
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [agentSwitcherOpen, commandPaletteOpen, projectManagerOpen, keymap, workspace.projects])

  async function handleAddProject(input: { id?: string; name: string; cwd: string }) {
    const next = await addProject({ data: input })
    setWorkspace(next)
    const project = next.projects.find((item) => item.cwd === input.cwd) ?? next.projects.at(-1)
    if (project) setSelection({ projectId: project.id, agentId: project.agents[0]?.id ?? '' })
  }

  async function handleDeleteProject(projectId: string) {
    const next = await deleteProject({ data: { id: projectId } })
    setWorkspace(next)
  }

  async function handleHideProject(projectId: string) {
    const next = await hideProject({ data: { id: projectId } })
    setWorkspace(next)
    if (selection.projectId === projectId) setSelection(next.selected)
  }

  async function handleUnhideProject(projectId: string) {
    const next = await unhideProject({ data: { id: projectId } })
    setWorkspace(next)
    const project = next.projects.find((item) => item.id === projectId)
    if (project) setSelection({ projectId: project.id, agentId: project.agents[0]?.id ?? '' })
  }

  async function handleChooseProjectDirectory() {
    return chooseProjectDirectory()
  }

  async function handleRenameSession(agentId: string, title: string) {
    const next = await renameSession({ data: { agentId, title } })
    setWorkspace(next)
  }

  function handleDeleteSession(agentId: string) {
    const agent = selectedProject?.agents.find((item) => item.id === agentId)
    if (!agent || !selectedProject) return
    setPendingDelete({ agentId, title: agent.title })
  }

  async function confirmDeleteSession() {
    if (!pendingDelete || !selectedProject) return
    const { agentId } = pendingDelete
    const currentProjectId = selectedProject.id
    const currentProject = selectedProject
    const currentIndex = currentProject.agents.findIndex((agent) => agent.id === agentId)
    setDeleteInFlight(true)
    try {
      const next = await deleteSession({ data: { agentId } })
      setWorkspace(next)
      const project =
        next.projects.find((item) => item.id === currentProjectId) ?? next.projects[0]
      if (!project) return
      const fallbackAgent =
        project.agents[Math.max(0, Math.min(currentIndex - 1, project.agents.length - 1))]
      setChatFocusRequest(0)
      if (fallbackAgent) {
        setSelection({ projectId: project.id, agentId: fallbackAgent.id })
      } else {
        setSelection({ projectId: project.id, agentId: '' })
      }
    } finally {
      setDeleteInFlight(false)
      setPendingDelete(null)
    }
  }

  async function withWorkspacePolling<T>(
    action: () => Promise<T>,
    onResult: (result: T) => void,
    onPoll?: RefreshAgentDetail,
  ) {
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      if (stopped) return
      try {
        const next = await refreshWorkspace()
        if (stopped) return
        setWorkspace(next)
        await onPoll?.()
      } finally {
        if (!stopped) {
          timer = window.setTimeout(poll, 750)
        }
      }
    }
    timer = window.setTimeout(poll, 250)
    try {
      const result = await action()
      onResult(result)
    } finally {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }

  async function handleSendMessage(
    agentId: string,
    text: string,
    images: SendMessageImage[] = [],
    onDetailRefresh?: RefreshAgentDetail,
  ) {
    await withWorkspacePolling(
      () => sendMessage({ data: { agentId, text, images } }),
      (next) => setWorkspace(next),
      onDetailRefresh,
    )
    await onDetailRefresh?.()
  }

  async function handleSteerMessage(
    agentId: string,
    text: string,
    images: SendMessageImage[] = [],
  ) {
    const next = await steerMessage({ data: { agentId, text, images } })
    setWorkspace(next)
  }

  async function handleInterruptMessage(agentId: string) {
    const next = await interruptMessage({ data: { agentId } })
    setWorkspace(next)
  }

  async function handleThinkingCommand(agentId: string, level?: ThinkingLevel) {
    const next = await setThinkingLevel({ data: { agentId, level } })
    setWorkspace(next)
  }

  async function handleResetSession(agentId: string) {
    const next = await resetSession({ data: { agentId } })
    setWorkspace(next)
  }

  async function handleForkSession(agentId: string) {
    const result = await forkSession({ data: { agentId } })
    setWorkspace(result.snapshot)
    const project = result.snapshot.projects.find((item) =>
      item.agents.some((agent) => agent.id === result.agentId),
    )
    if (project) {
      setSelection({ projectId: project.id, agentId: result.agentId })
      setChatFocusRequest(0)
    }
  }

  async function handleAnswerQuestion(
    agentId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ) {
    const next = await answerQuestion({ data: { agentId, requestId, answers } })
    setWorkspace(next)
  }

  async function handleStartSession(input: {
    projectId: string
    runtime: RuntimeKind
    model?: string
    title?: string
    thinkingLevel: ThinkingLevel
  }) {
    const next = await startSession({ data: input })
    setWorkspace(next)
    const project = next.projects.find((item) => item.id === input.projectId)
    const agent =
      (input.title
        ? project?.agents.find((item) => item.title === input.title)
        : undefined) ?? project?.agents[project.agents.length - 1]
    if (project && agent) {
      setChatFocusRequest(0)
      setSelection({ projectId: project.id, agentId: agent.id })
    }
    setAgentSwitcherOpen(false)
    setSessionLauncherOpen(false)
  }

  function selectAgent(projectId: string, agentId: string) {
    setChatFocusRequest(0)
    setSelection({ projectId, agentId })
    setAgentSwitcherOpen(false)
  }

  function openSessionLauncher(projectId = selectedProject?.id) {
    const project = workspace.projects.find((item) => item.id === projectId)
    if (project) {
      setSelection({ projectId: project.id, agentId: project.agents[0]?.id ?? '' })
    }
    setSettingsOpen(false)
    setCommandPaletteOpen(false)
    setAgentSwitcherOpen(false)
    setSessionLauncherOpen(true)
  }

  const commandActions = React.useMemo(
    () => [
      {
        id: 'start-session',
        title: 'Start session',
        detail: selectedProject?.name ?? 'Current project',
        icon: Plus,
        disabled: false,
        run: () => openSessionLauncher(),
      },
      {
        id: 'end-session',
        title: 'End selected session',
        detail: selectedAgent?.isSession ? selectedAgent.title : 'No selected session',
        icon: Trash2,
        disabled: !selectedAgent?.isSession,
        run: () => {
          if (!selectedAgent?.isSession) return
          setCommandPaletteOpen(false)
          void handleDeleteSession(selectedAgent.id)
        },
      },
      {
        id: 'settings',
        title: 'Open settings',
        detail: 'Keymaps and theme',
        icon: Settings2,
        disabled: false,
        run: () => {
          setSessionLauncherOpen(false)
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
          setProjectManagerOpen(false)
          setSettingsOpen(true)
        },
      },
      {
        id: 'terminal',
        title: 'Open terminal',
        detail: selectedProject?.cwd ?? 'Selected project cwd',
        icon: TerminalSquare,
        disabled: !selectedAgent,
        run: () => {
          setCommandPaletteOpen(false)
          setTab('terminal')
        },
      },
      {
        id: 'add-project',
        title: 'Add project',
        detail: 'Choose or paste a directory',
        icon: FolderOpen,
        disabled: false,
        run: () => {
          setSessionLauncherOpen(false)
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
          setSettingsOpen(false)
          setProjectManagerOpen(true)
        },
      },
      {
        id: 'hide-project',
        title: `Hide ${selectedProject?.name ?? 'current project'}`,
        detail: 'Keep sessions, remove from board',
        icon: EyeOff,
        disabled: workspace.projects.length <= 1,
        run: () => {
          if (!selectedProject) return
          setCommandPaletteOpen(false)
          void handleHideProject(selectedProject.id)
        },
      },
      ...workspace.hiddenProjects.map((project) => ({
        id: `unhide-project-${project.id}`,
        title: `Unhide ${project.name}`,
        detail: 'Hidden project',
        icon: Eye,
        disabled: false,
        run: () => {
          setCommandPaletteOpen(false)
          void handleUnhideProject(project.id)
        },
      })),
      ...workspace.projects.map((project) => ({

        id: `delete-project-${project.id}`,
        title: `Remove ${project.name}`,
        detail: 'Project',
        icon: Trash2,
        disabled: workspace.projects.length <= 1,
        run: () => {
          setCommandPaletteOpen(false)
          void handleDeleteProject(project.id)
        },
      })),
      ...workspace.projects.flatMap((project) => [
        {
          id: `switch-project-${project.id}`,
          title: `Switch to ${project.name}`,
          detail: 'Project',
          icon: Shuffle,
          disabled: false,
          run: () => {
            const agentId = project.agents[0]?.id ?? ''
            setChatFocusRequest(0)
            setSelection({ projectId: project.id, agentId })
            setAgentSwitcherOpen(false)
            setCommandPaletteOpen(false)
          },
        },
        ...project.agents.map((agent) => ({
          id: `switch-agent-${agent.id}`,
          title: `Switch to ${agent.title}`,
          detail: project.name,
          icon: Bot,
          disabled: false,
          run: () => {
            setChatFocusRequest(0)
            setSelection({ projectId: project.id, agentId: agent.id })
            setAgentSwitcherOpen(false)
            setCommandPaletteOpen(false)
          },
        })),
      ]),
    ],
    [selectedAgent, selectedProject, workspace.hiddenProjects, workspace.projects],
  )

  if (!selectedProject) {
    return <div className="empty-shell">No projects configured.</div>
  }

  if (settingsOpen) {
    return (
      <SettingsScreen
        keymap={keymap}
        themeSelection={themeSelection}
        chatTypography={chatTypography}
        onKeymapChange={(action, value) =>
          setKeymap((current) => updateKeymap(current, action, value))
        }
        onKeymapReset={() => setKeymap(saveKeymap(defaultKeymap))}
        onThemeChange={(next) => setThemeSelection(saveThemeSelection(next))}
        onChatTypographyChange={(next) => setChatTypography(saveChatTypography(next))}
        onClose={() => setSettingsOpen(false)}
      />
    )
  }

  return (
    <main className="aether-shell">
      <MobileTopBar
        project={selectedProject}
        agent={selectedAgent}
        tab={tab}
        onTabChange={setTab}
        onOpenAgentSwitcher={() => setAgentSwitcherOpen(true)}
        onSelectAgent={(agentId) => {
          setSelection({ projectId: selectedProject.id, agentId })
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
        }}
        onStartSession={() => openSessionLauncher()}
        onOpenProjects={() => {
          setSessionLauncherOpen(false)
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
          setSettingsOpen(false)
          setProjectManagerOpen(true)
        }}
        onOpenSettings={() => {
          setSessionLauncherOpen(false)
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
          setProjectManagerOpen(false)
          setSettingsOpen(true)
        }}
      />

      {commandPaletteOpen ? (
        <CommandPalette
          actions={commandActions}
          onClose={() => setCommandPaletteOpen(false)}
        />
      ) : null}

      {agentSwitcherOpen ? (
        <AgentSwitcherSheet
          projects={workspace.projects}
          selectedProjectId={selection.projectId}
          selectedAgentId={selection.agentId}
          onSelectAgent={selectAgent}
          onStartSession={openSessionLauncher}
          onClose={() => setAgentSwitcherOpen(false)}
        />
      ) : null}

      {sessionLauncherOpen ? (
        <InlineSessionLauncher
          project={selectedProject}
          settings={workspace.settings}
          onStartSession={handleStartSession}
          onCancel={() => setSessionLauncherOpen(false)}
        />
      ) : null}

      {projectManagerOpen ? (
        <ProjectManagerDialog
          projects={workspace.projects}
          hiddenProjects={workspace.hiddenProjects}
          onAdd={handleAddProject}
          onChooseDirectory={handleChooseProjectDirectory}
          onHide={handleHideProject}
          onUnhide={handleUnhideProject}
          onClose={() => setProjectManagerOpen(false)}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="Remove session?"
          body={
            <>
              <strong>{pendingDelete.title}</strong> and its history will be permanently deleted. This can&rsquo;t be undone.
            </>
          }
          confirmLabel="Remove session"
          cancelLabel="Keep"
          destructive
          busy={deleteInFlight}
          onConfirm={() => void confirmDeleteSession()}
          onCancel={() => {
            if (deleteInFlight) return
            setPendingDelete(null)
          }}
        />
      ) : null}

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
              onClick={() => {
                setSettingsOpen(false)
                setProjectManagerOpen((open) => !open)
              }}
            >
              <FolderOpen size={14} />
              <span>Projects</span>
            </button>
            <button
              type="button"
              className="topbar-trigger"
              aria-label="Settings"
              aria-expanded={settingsOpen}
              onClick={() => {
                setProjectManagerOpen(false)
                setSettingsOpen((open) => !open)
              }}
            >
              <Settings2 size={14} />
              <span>Settings</span>
            </button>
          </div>
        </header>

        <div className="board-grid">
          {workspace.projects.map((project) => (
            <ProjectLane
              key={project.id}
              project={project}
              selectedAgentId={selection.agentId}
              selectedProjectId={selection.projectId}
              onSelect={(agentId) => {
                setChatFocusRequest(0)
                setSelection({ projectId: project.id, agentId })
              }}
            />
          ))}
        </div>
      </section>

      <SelectedAgentPane
        selectedProject={selectedProject}
        selectedAgent={selectedAgent}
        tab={tab}
        onTabChange={setTab}
        chatFocusRequest={chatFocusRequest}
        themeMode={themeSelection.mode}
        onStartSession={() => setSessionLauncherOpen(true)}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        onSend={handleSendMessage}
        onSteer={handleSteerMessage}
        onInterrupt={handleInterruptMessage}
        onThinkingCommand={handleThinkingCommand}
        onResetSession={handleResetSession}
        onForkSession={handleForkSession}
        onAnswerQuestion={handleAnswerQuestion}
      />
    </main>
  )
}

function SettingsScreen({
  keymap,
  themeSelection,
  chatTypography,
  onKeymapChange,
  onKeymapReset,
  onThemeChange,
  onChatTypographyChange,
  onClose,
}: {
  keymap: KeymapSettings
  themeSelection: ThemeSelection
  chatTypography: ChatTypographySettings
  onKeymapChange: (action: KeymapAction, value: string) => void
  onKeymapReset: () => void
  onThemeChange: (selection: ThemeSelection) => void
  onChatTypographyChange: (settings: ChatTypographySettings) => void
  onClose: () => void
}) {
  return (
    <main className="settings-shell" data-testid="settings-page">
      <header className="settings-topbar">
        <button
          type="button"
          className="settings-back"
          onClick={onClose}
          aria-label="Back to board"
          data-testid="settings-back"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          board
        </button>
        <span className="settings-crumb">aether / settings</span>
      </header>

      <div className="settings-rail" role="region" aria-label="Settings">
        <section className="settings-lane" data-lane="theme" aria-label="Theme">
          <ThemeSettingsPanel selection={themeSelection} onChange={onThemeChange} />
        </section>

        <section className="settings-lane" data-lane="keymap" aria-label="Keymap">
          <KeymapSettingsPanel
            keymap={keymap}
            onChange={onKeymapChange}
            onReset={onKeymapReset}
          />
        </section>

        <section className="settings-lane" data-lane="chat" aria-label="Chat reading size">
          <ChatTypographySettingsPanel
            settings={chatTypography}
            onChange={onChatTypographyChange}
          />
        </section>
      </div>
    </main>
  )
}

function InlineSessionLauncher({
  project,
  settings,
  onStartSession,
  onCancel,
}: {
  project: ProjectRow
  settings: WorkspaceSnapshot['settings']
  onStartSession: (input: {
    projectId: string
    runtime: RuntimeKind
    model?: string
    title?: string
    thinkingLevel: ThinkingLevel
  }) => Promise<void>
  onCancel: () => void
}) {
  const [runtime, setRuntime] = React.useState<RuntimeKind>('pi')
  const [model, setModel] = React.useState(settings.runtimes.pi.defaultModel)
  const [title, setTitle] = React.useState('')
  const [thinkingLevel, setThinkingLevel] = React.useState<ThinkingLevel>('medium')
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const titleRef = React.useRef<HTMLInputElement>(null)
  const runtimes = Object.keys(settings.runtimes) as RuntimeKind[]
  const models = settings.runtimes[runtime].models

  React.useEffect(() => {
    titleRef.current?.focus()
  }, [])

  function updateRuntime(nextRuntime: RuntimeKind) {
    setRuntime(nextRuntime)
    setModel(settings.runtimes[nextRuntime].defaultModel)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await onStartSession({
        projectId: project.id,
        runtime,
        model,
        title: title || undefined,
        thinkingLevel,
      })
      setTitle('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <div className="session-dialog-scrim" onClick={onCancel} />
      <form
        className="session-start-form session-dialog"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-dialog-title"
        data-testid="session-launcher"
      >
        <div className="session-launcher-head">
          <span className="session-dialog-icon" aria-hidden="true">
            <Bot size={16} />
          </span>
          <div>
            <p className="settings-kicker">New session</p>
            <strong id="session-dialog-title">{project.name}</strong>
            <small>Pick a runtime, then launch into chat.</small>
          </div>
          <button type="button" onClick={onCancel} aria-label="Cancel new session">
            ×
          </button>
        </div>

        <label className="session-command-field">
          <Command size={16} aria-hidden="true" />
          <input
            ref={titleRef}
            value={title}
            disabled={pending}
            placeholder="Name this session (optional)"
            aria-label="Session name"
            data-testid="session-title"
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          <span>optional</span>
        </label>

        <div className="session-dialog-grid">
          <label>
            <span>Runtime</span>
            <select
              value={runtime}
              disabled={pending}
              data-testid="session-runtime"
              onChange={(event) => updateRuntime(event.currentTarget.value as RuntimeKind)}
            >
              {runtimes.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Model</span>
            <select
              value={model}
              disabled={pending}
              data-testid="session-model"
              onChange={(event) => setModel(event.currentTarget.value)}
            >
              {models.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Thinking</span>
            <select
              value={thinkingLevel}
              disabled={pending || !supportsThinking(runtime)}
              data-testid="session-thinking-level"
              onChange={(event) => setThinkingLevel(event.currentTarget.value as ThinkingLevel)}
            >
              {sessionThinkingLevels.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="session-dialog-actions">
          {error ? <span role="status">{error}</span> : null}
          <button type="submit" disabled={pending}>
            <Plus size={14} />
            Start session
          </button>
        </div>
      </form>
    </>
  )
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string
  body: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = React.useRef<HTMLButtonElement | null>(null)

  React.useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  return (
    <>
      <div className="session-dialog-scrim" onClick={onCancel} />
      <div
        className={`session-dialog confirm-dialog${destructive ? ' confirm-dialog-destructive' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (!busy) onConfirm()
          }
        }}
        data-testid="confirm-dialog"
      >
        <div className="confirm-dialog-head">
          <span className="confirm-dialog-icon" aria-hidden="true">
            <AlertTriangle size={16} />
          </span>
          <div>
            <p className="settings-kicker">Confirm</p>
            <strong id="confirm-dialog-title">{title}</strong>
          </div>
        </div>
        <p className="confirm-dialog-body">{body}</p>
        <div className="session-dialog-actions">
          <button
            type="button"
            className="confirm-dialog-cancel"
            onClick={onCancel}
            disabled={busy}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="confirm-dialog-confirm"
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-dialog-confirm"
          >
            {busy ? 'Removing…' : confirmLabel}
          </button>
        </div>
      </div>
    </>
  )
}

function ProjectManagerDialog({
  projects,
  hiddenProjects,
  onAdd,
  onChooseDirectory,
  onHide,
  onUnhide,
  onClose,
}: {
  projects: ProjectRow[]
  hiddenProjects: ProjectRow[]
  onAdd: (input: { id?: string; name: string; cwd: string }) => Promise<void>
  onChooseDirectory: () => Promise<string>
  onHide: (projectId: string) => Promise<void>
  onUnhide: (projectId: string) => Promise<void>
  onClose: () => void
}) {
  const [id, setId] = React.useState('')
  const [name, setName] = React.useState('')
  const [cwd, setCwd] = React.useState('')
  const [showHidden, setShowHidden] = React.useState(hiddenProjects.length > 0)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (hiddenProjects.length > 0) setShowHidden(true)
  }, [hiddenProjects.length])

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

  return (
    <div className="project-manager-overlay" role="dialog" aria-modal="true">
      <section className="project-settings project-manager" aria-label="Project manager">
        <div className="project-manager-head">
          <div>
            <h2>Projects</h2>
            <p>Add, hide, and restore board rows.</p>
          </div>
          <button type="button" className="settings-close" onClick={onClose}>
            Done
          </button>
        </div>
        {error ? <span className="settings-error" role="status">{error}</span> : null}
        <form className="project-add-form" onSubmit={submit}>
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
            onClick={chooseDirectory}
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
          {projects.map((project) => (
            <div key={project.id} className="project-settings-row">
              <div>
                <strong>{project.name}</strong>
                <span>{projectSummary(project)}</span>
              </div>
              <button
                type="button"
                disabled={pending || projects.length <= 1}
                onClick={() => hide(project.id)}
                aria-label={`Hide ${project.name}`}
              >
                <EyeOff size={14} />
              </button>
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
        {showHidden ? <div className="project-list" data-testid="hidden-project-list">
          {hiddenProjects.length === 0 ? (
            <div className="project-settings-row project-empty-row">No hidden projects.</div>
          ) : null}
          {hiddenProjects.map((project) => (
            <div key={project.id} className="project-settings-row">
              <div>
                <strong>{project.name}</strong>
                <span>{projectSummary(project)}</span>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => unhide(project.id)}
                aria-label={`Unhide ${project.name}`}
              >
                <Eye size={14} />
              </button>
            </div>
          ))}
        </div> : null}
      </section>
    </div>
  )
}

const keymapGroups: { id: string; label: string; rows: { action: KeymapAction; label: string; hint: string }[] }[] = [
  {
    id: 'board',
    label: 'Board navigation',
    rows: [
      { action: 'projectPrev', label: 'Project up', hint: 'Previous project row' },
      { action: 'projectNext', label: 'Project down', hint: 'Next project row' },
      { action: 'agentPrev', label: 'Agent left', hint: 'Previous session in row' },
      { action: 'agentNext', label: 'Agent right', hint: 'Next session in row' },
    ],
  },
  {
    id: 'session',
    label: 'Session',
    rows: [
      { action: 'startSession', label: 'Start session', hint: 'Open new-session dialog' },
      { action: 'deleteSession', label: 'Remove session', hint: 'Delete the selected session' },
    ],
  },
  {
    id: 'focus',
    label: 'Focus',
    rows: [
      { action: 'focusChat', label: 'Focus chat', hint: 'Jump cursor to composer' },
      { action: 'openDiffs', label: 'Open diffs', hint: 'Switch sidebar to diffs' },
      { action: 'openTerminal', label: 'Open terminal', hint: 'Switch sidebar to terminal' },
    ],
  },
]

function ThemeSettingsPanel({
  selection,
  onChange,
}: {
  selection: ThemeSelection
  onChange: (selection: ThemeSelection) => void
}) {
  return (
    <>
      <header className="settings-lane-head">
        <div className="settings-lane-title">
          <p className="settings-kicker">Theme</p>
          <h2>Palette</h2>
          <p>Pick a theme. Mode follows your selection across the board.</p>
        </div>
        <button
          type="button"
          className="settings-reset"
          onClick={() => onChange(defaultThemeSelection)}
          data-testid="theme-reset"
        >
          reset
        </button>
      </header>

      <div className="theme-mode-toggle" role="tablist" aria-label="Theme mode">
        {(['light', 'dark'] as ThemeMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={selection.mode === mode}
            data-active={selection.mode === mode}
            data-testid={`theme-mode-${mode}`}
            onClick={() => onChange({ ...selection, mode })}
          >
            {mode}
          </button>
        ))}
      </div>

      <div className="theme-grid" role="radiogroup" aria-label="Theme name">
        {aetherThemeNames.map((name) => (
          <ThemeCard
            key={name}
            name={name}
            mode={selection.mode}
            selected={selection.name === name}
            onSelect={() => onChange({ name, mode: selection.mode })}
          />
        ))}
      </div>
    </>
  )
}

function ThemeCard({
  name,
  mode,
  selected,
  onSelect,
}: {
  name: AetherThemeName
  mode: ThemeMode
  selected: boolean
  onSelect: () => void
}) {
  const tokens = getAetherThemeTokens({ name, mode })
  const cardStyle = {
    '--tc-paper': tokens.paper,
    '--tc-panel': tokens.panel,
    '--tc-ink': tokens.ink,
    '--tc-muted': tokens.muted,
    '--tc-line': tokens.line,
    '--tc-accent': tokens.accent,
    '--tc-warn': tokens.warn,
  } as React.CSSProperties
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-selected={selected}
      data-testid={`theme-card-${name}`}
      className="theme-card"
      style={cardStyle}
      onClick={onSelect}
    >
      <div className="theme-card-preview" aria-hidden="true">
        <div className="theme-card-rail">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="theme-card-board">
          <div className="row">
            <span className="chip accent" />
            <span className="chip" />
            <span className="chip muted" />
          </div>
          <div className="row">
            <span className="chip" />
            <span className="chip muted" />
            <span className="chip warn" />
          </div>
          <div className="row">
            <span className="chip accent" />
            <span className="chip" />
            <span className="chip muted" />
          </div>
        </div>
      </div>
      <div className="theme-card-meta">
        <span className="theme-card-name">{name}</span>
        <span className="theme-card-swatches" aria-hidden="true">
          <span style={{ background: tokens.accent }} />
          <span style={{ background: tokens.accent2 }} />
          <span style={{ background: tokens.paper }} />
          <span style={{ background: tokens.ink }} />
        </span>
        <span className="theme-card-check" aria-hidden="true">
          <Check size={10} strokeWidth={3} />
        </span>
      </div>
    </button>
  )
}

function ChatTypographySettingsPanel({
  settings,
  onChange,
}: {
  settings: ChatTypographySettings
  onChange: (settings: ChatTypographySettings) => void
}) {
  const current = chatFontSizes[settings.fontSize]
  const previewStyle = {
    '--chat-preview-size': current.size,
    '--chat-preview-line': current.lineHeight,
  } as React.CSSProperties
  return (
    <>
      <header className="settings-lane-head">
        <div className="settings-lane-title">
          <p className="settings-kicker">Chat</p>
          <h2>Reading size</h2>
          <p>Affects chat messages and the composer only.</p>
        </div>
        <button
          type="button"
          className="settings-reset"
          onClick={() => onChange(defaultChatTypography)}
          data-testid="chat-reset"
        >
          reset
        </button>
      </header>

      <div className="chat-size-options" role="radiogroup" aria-label="Chat font size">
        {(Object.keys(chatFontSizes) as ChatFontSize[]).map((size) => {
          const option = chatFontSizes[size]
          const [label, spec] = option.label.split(' · ')
          const active = settings.fontSize === size
          return (
            <button
              key={size}
              type="button"
              role="radio"
              aria-checked={active}
              data-active={active}
              data-testid={`chat-size-${size}`}
              className="chat-size-option"
              onClick={() => onChange({ fontSize: size })}
            >
              <strong>{label}</strong>
              <small>{spec}</small>
            </button>
          )
        })}
      </div>

      <div className="chat-size-preview" style={previewStyle} aria-live="polite">
        <p>
          The model is rendering a diff while you review the previous turn.
          This is roughly how chat copy will read at the selected size.
        </p>
        <small>preview · {current.size} / {current.lineHeight}</small>
      </div>
    </>
  )
}

function KeymapSettingsPanel({
  keymap,
  onChange,
  onReset,
}: {
  keymap: KeymapSettings
  onChange: (action: KeymapAction, value: string) => void
  onReset: () => void
}) {
  const conflicts = React.useMemo(() => {
    const counts = new Map<string, KeymapAction[]>()
    for (const [action, value] of Object.entries(keymap) as [KeymapAction, string][]) {
      const list = counts.get(value) ?? []
      list.push(action)
      counts.set(value, list)
    }
    const map = new Map<KeymapAction, KeymapAction[]>()
    for (const list of counts.values()) {
      if (list.length < 2) continue
      for (const action of list) {
        map.set(
          action,
          list.filter((other) => other !== action),
        )
      }
    }
    return map
  }, [keymap])

  const actionLabels = React.useMemo(() => {
    const labels: Partial<Record<KeymapAction, string>> = {}
    for (const group of keymapGroups) {
      for (const row of group.rows) labels[row.action] = row.label
    }
    return labels
  }, [])

  return (
    <>
      <header className="settings-lane-head">
        <div className="settings-lane-title">
          <p className="settings-kicker">Keymap</p>
          <h2>Shortcuts</h2>
          <p>Every action takes Shift plus the chosen key.</p>
        </div>
        <button
          type="button"
          className="settings-reset"
          onClick={onReset}
          data-testid="keymap-reset"
        >
          reset
        </button>
      </header>

      {keymapGroups.map((group) => (
        <div key={group.id} className="keymap-group">
          <p className="keymap-group-label">{group.label}</p>
          {group.rows.map((row) => {
            const conflict = conflicts.get(row.action)
            const conflictLabel = conflict
              ?.map((action) => actionLabels[action] ?? action)
              .join(', ')
            return (
              <div
                key={row.action}
                className="keymap-row"
                data-conflict={conflict ? 'true' : 'false'}
              >
                <select
                  value={keymap[row.action]}
                  onChange={(event) => onChange(row.action, event.currentTarget.value)}
                  data-testid={`keymap-${row.action}`}
                  aria-label={row.label}
                >
                  {keyOptions.map((key) => (
                    <option key={key} value={key}>
                      ⇧ {formatKey(key)}
                    </option>
                  ))}
                </select>
                <div className="keymap-row-meta">
                  <strong>{row.label}</strong>
                  <small>{conflict ? `Shared with ${conflictLabel}` : row.hint}</small>
                </div>
              </div>
            )
          })}
        </div>
      ))}

      <div className="keymap-static" aria-label="Command menu shortcut">
        <span className="keymap-static-chip">⌘K</span>
        <div className="keymap-row-meta">
          <strong>Command menu</strong>
          <small>Fixed binding · ⌘K or Ctrl+K</small>
        </div>
      </div>
    </>
  )
}

function CommandPalette({
  actions,
  onClose,
}: {
  actions: CommandPaletteAction[]
  onClose: () => void
}) {
  const [query, setQuery] = React.useState('')
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const normalizedQuery = query.trim().toLowerCase()
  const filteredActions = actions.filter((action) => {
    const haystack = `${action.title} ${action.detail}`.toLowerCase()
    return haystack.includes(normalizedQuery)
  })
  const visibleActions = normalizedQuery ? filteredActions : filteredActions.slice(0, 7)
  const selectedAction = visibleActions[selectedIndex]

  React.useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  React.useEffect(() => {
    if (selectedIndex >= visibleActions.length) setSelectedIndex(0)
  }, [selectedIndex, visibleActions.length])

  function moveSelection(delta: number) {
    const enabledIndexes = visibleActions
      .map((action, index) => (action.disabled ? -1 : index))
      .filter((index) => index >= 0)
    if (enabledIndexes.length === 0) return

    const currentEnabledIndex = enabledIndexes.indexOf(selectedIndex)
    const nextEnabledIndex =
      currentEnabledIndex < 0
        ? 0
        : (currentEnabledIndex + delta + enabledIndexes.length) % enabledIndexes.length
    setSelectedIndex(enabledIndexes[nextEnabledIndex])
  }

  function submit(action: CommandPaletteAction | undefined) {
    const fallbackAction = visibleActions.find((item) => !item.disabled)
    const actionToRun = action && !action.disabled ? action : fallbackAction
    if (!actionToRun) return
    actionToRun.run()
  }

  return (
    <div className="command-panel" role="dialog" aria-label="Command menu">
      <div className="command-search">
        <Command size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveSelection(1)
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveSelection(-1)
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              submit(selectedAction)
            }
          }}
          aria-activedescendant={selectedAction ? `command-${selectedAction.id}` : undefined}
          placeholder="Start, end, or switch"
          aria-label="Command search"
          data-testid="command-search"
        />
        <span>⌘K</span>
      </div>
      <div className="command-list" role="listbox">
        {visibleActions.length > 0 ? (
          visibleActions.map((action, index) => {
            const Icon = action.icon
            return (
              <button
                key={action.id}
                type="button"
                id={`command-${action.id}`}
                className={`command-item ${index === selectedIndex ? 'active' : ''}`}
                disabled={action.disabled}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => submit(action)}
              >
                <Icon size={15} aria-hidden="true" />
                <span>
                  <strong>{action.title}</strong>
                  <small>{action.detail}</small>
                </span>
              </button>
            )
          })
        ) : (
          <p className="command-empty">No command matches.</p>
        )}
      </div>
    </div>
  )
}

function Keycap({ value }: { value: string }) {
  const iconSize = 13
  if (value === 'arrowup') return <ArrowUp size={iconSize} />
  if (value === 'arrowdown') return <ArrowDown size={iconSize} />
  if (value === 'arrowleft') return <ArrowLeft size={iconSize} />
  if (value === 'arrowright') return <ArrowRight size={iconSize} />
  return <kbd>{formatKey(value)}</kbd>
}

function MobileTopBar({
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
        <span>{project.name}</span>
        <button type="button" onClick={onOpenAgentSwitcher}>All sessions</button>
      </div>
      <div className="mobile-topbar-main">
        <button
          type="button"
          className="mobile-agent-trigger"
          onClick={onOpenAgentSwitcher}
          aria-label="Switch agent"
        >
          <span className={`status-dot ${agent?.status ?? ''}`} aria-hidden="true" />
          <span>
            <strong>{agent?.title ?? 'No session'}</strong>
            <small>{agent ? `${agent.runtime} · ${agent.status}` : 'Choose or start an agent'}</small>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
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
          className={tab === 'diffs' ? 'active' : ''}
          onClick={() => onTabChange('diffs')}
          role="tab"
          aria-selected={tab === 'diffs'}
        >
          <GitPullRequest size={15} />
          Diffs
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
      </div>
    </header>
  )
}

function AgentSwitcherSheet({
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
      <div className="agent-switcher-scrim" onClick={onClose} />
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
                      <small>{agent.diffCount} diff</small>
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

function ProjectLane({
  project,
  selectedProjectId,
  selectedAgentId,
  onSelect,
}: {
  project: ProjectRow
  selectedProjectId: string
  selectedAgentId: string
  onSelect: (agentId: string) => void
}) {
  const isProjectSelected = project.id === selectedProjectId

  return (
    <section
      className={`project-lane ${isProjectSelected ? 'selected' : ''}`}
      aria-label={project.name}
    >
      <div className="project-label">
        <span>{projectSummary(project)}</span>
      </div>
      <div className="agent-row">
        {project.agents.length === 0 ? (
          <div className="empty-session-card" data-testid="empty-project-sessions">
            No sessions
          </div>
        ) : null}
        {project.agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={`agent-cell ${
              isProjectSelected && agent.id === selectedAgentId
                ? 'selected'
                : ''
            }`}
            onClick={() => onSelect(agent.id)}
            data-agent-id={agent.id}
            data-project-id={project.id}
            data-selected={
              isProjectSelected && agent.id === selectedAgentId ? 'true' : 'false'
            }
            data-testid="agent-cell"
          >
            <div className="agent-cell-top">
              <span className="agent-cell-title">{agent.title}</span>
              <AgentCellState status={agent.status} updatedAt={agent.updatedAt} />
            </div>
            <p>{agent.preview}</p>
            <div className="agent-cell-meta">
              {agent.diffCount > 0 ? (
                <span className="diff-token">+{agent.diffCount}</span>
              ) : null}
              <span>{agent.messageCount} msg</span>
              <span className="agent-cell-runtime">{agent.runtime}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

function SelectedAgentPane({
  selectedProject,
  selectedAgent,
  tab,
  onTabChange,
  chatFocusRequest,
  themeMode,
  onStartSession,
  onDeleteSession,
  onRenameSession,
  onSend,
  onSteer,
  onInterrupt,
  onThinkingCommand,
  onResetSession,
  onForkSession,
  onAnswerQuestion,
}: {
  selectedProject: ProjectRow
  selectedAgent: AgentCell | undefined
  tab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  chatFocusRequest: number
  themeMode: ThemeMode
  onStartSession: () => void
  onDeleteSession: (agentId: string) => void
  onRenameSession: (agentId: string, title: string) => Promise<void>
  onSend: (
    agentId: string,
    text: string,
    images?: SendMessageImage[],
    onDetailRefresh?: RefreshAgentDetail,
  ) => Promise<void>
  onSteer: (agentId: string, text: string, images?: SendMessageImage[]) => Promise<void>
  onInterrupt: (agentId: string) => Promise<void>
  onThinkingCommand: (agentId: string, level?: ThinkingLevel) => Promise<void>
  onResetSession: (agentId: string) => Promise<void>
  onForkSession: (agentId: string) => Promise<void>
  onAnswerQuestion: (
    agentId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ) => Promise<void>
}) {
  const revision = selectedAgent
    ? `${selectedAgent.updatedAt}:${selectedAgent.messageCount}:${selectedAgent.diffCount}:${selectedAgent.status}`
    : ''
  const detailQuery = useQuery(
    agentDetailQueryOptions(selectedAgent?.id ?? '', 100, revision),
  )
  const agent = mergeAgentDetail(selectedAgent, detailQuery.data)
  const refreshDetail = React.useCallback(async () => {
    if (!selectedAgent) return
    await detailQuery.refetch()
  }, [detailQuery, selectedAgent])

  return (
    <aside
      className="sidebar-pane"
      aria-label="Selected chat"
      data-testid="sidebar-pane"
    >
      {agent ? (
        <>
          <SidebarHeader
            project={selectedProject}
            agent={agent}
            onDeleteSession={onDeleteSession}
            onRenameSession={onRenameSession}
          />
          <div className="sidebar-tabs" role="tablist">
            <button
              type="button"
              className={tab === 'chat' ? 'active' : ''}
              onClick={() => onTabChange('chat')}
              data-testid="tab-chat"
            >
              <MessageSquareText size={15} />
              Chat
            </button>
            <button
              type="button"
              className={tab === 'diffs' ? 'active' : ''}
              onClick={() => onTabChange('diffs')}
              data-testid="tab-diffs"
            >
              <GitPullRequest size={15} />
              Diffs
            </button>
            <button
              type="button"
              className={tab === 'terminal' ? 'active' : ''}
              onClick={() => onTabChange('terminal')}
              data-testid="tab-terminal"
            >
              <TerminalSquare size={15} />
              Terminal
            </button>
          </div>

          {tab === 'chat' ? (
            <ChatPanel
              key={agent.id}
              agent={agent}
              focusRequest={chatFocusRequest}
              onSend={(agentId, text, images) =>
                onSend(agentId, text, images, refreshDetail)
              }
              onSteer={onSteer}
              onInterrupt={onInterrupt}
              onThinkingCommand={onThinkingCommand}
              onResetSession={onResetSession}
              onForkSession={onForkSession}
              onAnswerQuestion={onAnswerQuestion}
              onDetailRefresh={refreshDetail}
            />
          ) : null}
          {tab === 'diffs' ? (
            <DiffPanel
              key={agent.id}
              agent={agent}
              themeMode={themeMode}
            />
          ) : null}
          {tab === 'terminal' ? (
            <TerminalPanel
              key={agent.id}
              agent={agent}
              project={selectedProject}
              themeMode={themeMode}
            />
          ) : null}
        </>
      ) : (
        <EmptySessionPanel
          project={selectedProject}
          onStart={onStartSession}
        />
      )}
    </aside>
  )
}

function EmptySessionPanel({
  project,
  onStart,
}: {
  project: ProjectRow
  onStart: () => void
}) {
  return (
    <div className="empty-sidebar-session" data-testid="empty-session-panel">
      <div className="runtime-icon">
        <Bot size={18} />
      </div>
      <p data-testid="selected-project">{project.name}</p>
      <h2 data-testid="selected-agent">No session</h2>
      <button type="button" onClick={onStart}>
        <Plus size={14} />
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

function formatThinkingLevel(level: ThinkingLevel) {
  return level === 'minimal' ? 'low' : level
}

function ContextUsageChip({
  usage,
}: {
  usage: AgentCell['contextUsage']
}) {
  if (!usage) return null

  const usedPercent = Math.round(usage.usedPercent)
  const remainingPercent = Math.max(100 - usedPercent, 0)
  const normalizedPercent = Math.max(0, Math.min(100, usage.usedPercent))

  return (
    <button
      type="button"
      className="context-chip"
      aria-label={`${formatTokenCount(usage.usedTokens)} of ${formatTokenCount(usage.windowTokens)} context tokens used`}
      title={`${usedPercent}% used (${remainingPercent}% left), ${usage.usedTokens.toLocaleString('en')} / ${usage.windowTokens.toLocaleString('en')} tokens used`}
      style={{ '--context-used': `${normalizedPercent}%` } as React.CSSProperties}
    >
      <span className="context-chip-battery" aria-hidden="true">
        <span />
      </span>
      <strong>{usedPercent}</strong>
    </button>
  )
}

function ChatPanel({
  agent,
  focusRequest,
  onSend,
  onSteer,
  onInterrupt,
  onThinkingCommand,
  onResetSession,
  onForkSession,
  onAnswerQuestion,
  onDetailRefresh,
}: {
  agent: AgentCell
  focusRequest: number
  onSend: (agentId: string, text: string, images?: SendMessageImage[]) => Promise<void>
  onSteer: (agentId: string, text: string, images?: SendMessageImage[]) => Promise<void>
  onInterrupt: (agentId: string) => Promise<void>
  onThinkingCommand: (agentId: string, level?: ThinkingLevel) => Promise<void>
  onResetSession: (agentId: string) => Promise<void>
  onForkSession: (agentId: string) => Promise<void>
  onAnswerQuestion: (
    agentId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ) => Promise<void>
  onDetailRefresh: RefreshAgentDetail
}) {
  const [pending, setPending] = React.useState(false)
  const [pendingPrompt, setPendingPrompt] = React.useState<
    { text: string; baselineUserCount: number } | null
  >(null)
  const [localRunning, setLocalRunning] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const isBackendRunning = agent.status === 'running'
  const isRunning = isBackendRunning || localRunning
  const userMessageCount = React.useMemo(
    () => agent.messages.reduce((count, message) => (message.role === 'user' ? count + 1 : count), 0),
    [agent.messages],
  )
  const pendingMessage = React.useMemo<BoardMessage | null>(
    () => {
      if (pendingPrompt === null) return null
      if (userMessageCount > pendingPrompt.baselineUserCount) return null
      return {
        id: `pending-${agent.id}`,
        role: 'user',
        text: pendingPrompt.text,
        timestamp: new Date().toISOString(),
      }
    },
    [agent.id, pendingPrompt, userMessageCount],
  )
  const visibleMessages = React.useMemo(
    () => (pendingMessage ? [...agent.messages, pendingMessage] : agent.messages),
    [agent.messages, pendingMessage],
  )
  const timelineAgent = React.useMemo(
    () => ({
      ...agent,
      messages: visibleMessages,
      timeline: pendingMessage === null
        ? agent.timeline
        : [
            ...agent.timeline,
            {
              type: 'message' as const,
              id: `message:${pendingMessage.id}`,
              timestamp: pendingMessage.timestamp,
              message: pendingMessage,
            },
          ],
    }),
    [agent, pendingMessage, visibleMessages],
  )
  const rows = React.useMemo(
    () => deriveAgentTimelineRows(timelineAgent),
    [timelineAgent],
  )
  const messageListRef = React.useRef<HTMLDivElement | null>(null)
  const latestRowId = rows.at(-1)?.id ?? ''
  const [hasNewContent, setHasNewContent] = React.useState(false)
  const [selectedMessageId, setSelectedMessageId] = React.useState<string | null>(null)
  const [composerEmpty, setComposerEmpty] = React.useState(true)

  const messageRows = React.useMemo(
    () =>
      rows.filter(
        (row): row is Extract<AgentTimelineRow, { kind: 'message' }> => row.kind === 'message',
      ),
    [rows],
  )
  const selectedIndex = React.useMemo(() => {
    if (selectedMessageId === null) return -1
    return messageRows.findIndex((row) => row.message.id === selectedMessageId)
  }, [messageRows, selectedMessageId])

  React.useEffect(() => {
    setSelectedMessageId(null)
  }, [agent.id])

  React.useEffect(() => {
    if (selectedMessageId !== null && selectedIndex === -1) setSelectedMessageId(null)
  }, [selectedIndex, selectedMessageId])

  React.useEffect(() => {
    if (agent.status !== 'running') setLocalRunning(false)
  }, [agent.id, agent.status])

  React.useLayoutEffect(() => {
    const list = messageListRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
    setHasNewContent(false)
  }, [agent.id])

  React.useLayoutEffect(() => {
    if (selectedMessageId !== null) return
    const list = messageListRef.current
    if (!list) return
    const distance = list.scrollHeight - list.clientHeight - list.scrollTop
    if (distance <= 24) {
      list.scrollTop = list.scrollHeight
      setHasNewContent(false)
    } else {
      setHasNewContent(true)
    }
  }, [agent.status, latestRowId, rows.length, selectedMessageId])

  React.useEffect(() => {
    function isComposerTextarea(target: EventTarget | null): boolean {
      return (
        target instanceof HTMLTextAreaElement &&
        target.dataset.testid === 'chat-input'
      )
    }

    function scrollSelectedIntoView(messageId: string) {
      requestAnimationFrame(() => {
        const list = messageListRef.current
        if (!list) return
        const el = list.querySelector<HTMLElement>(
          `[data-selected-id="${CSS.escape(messageId)}"]`,
        )
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      })
    }

    function selectIndex(nextIndex: number) {
      const clamped = Math.max(0, Math.min(messageRows.length - 1, nextIndex))
      const next = messageRows[clamped]
      if (!next) return
      setSelectedMessageId(next.message.id)
      scrollSelectedIntoView(next.message.id)
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (selectedMessageId === null) {
        if (
          event.key === 'ArrowUp' &&
          !event.shiftKey &&
          composerEmpty &&
          isComposerTextarea(event.target) &&
          messageRows.length > 0
        ) {
          event.preventDefault()
          selectIndex(messageRows.length - 1)
        }
        return
      }

      if (event.shiftKey) return

      const key = event.key
      if (key === 'ArrowUp' || key === '[') {
        event.preventDefault()
        if (selectedIndex > 0) selectIndex(selectedIndex - 1)
        return
      }
      if (key === 'ArrowDown' || key === ']') {
        event.preventDefault()
        if (selectedIndex >= messageRows.length - 1) {
          setSelectedMessageId(null)
        } else {
          selectIndex(selectedIndex + 1)
        }
        return
      }
      if (key === 'j') {
        event.preventDefault()
        const list = messageListRef.current
        if (list) list.scrollBy({ top: list.clientHeight * 0.5, behavior: 'smooth' })
        return
      }
      if (key === 'k') {
        event.preventDefault()
        const list = messageListRef.current
        if (list) list.scrollBy({ top: -list.clientHeight * 0.5, behavior: 'smooth' })
        return
      }
      setSelectedMessageId(null)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [composerEmpty, messageRows, selectedIndex, selectedMessageId])

  React.useEffect(() => {
    const list = messageListRef.current
    if (!list) return
    const onScroll = () => {
      const distance = list.scrollHeight - list.clientHeight - list.scrollTop
      if (distance <= 24) setHasNewContent(false)
    }
    list.addEventListener('scroll', onScroll, { passive: true })
    return () => list.removeEventListener('scroll', onScroll)
  }, [agent.id])

  function scrollToBottom() {
    const list = messageListRef.current
    if (!list) return
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
    setHasNewContent(false)
  }

  async function interrupt() {
    setPending(true)
    setError(null)
    try {
      await onInterrupt(agent.id)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  async function submitPrompt(
    prompt: string,
    promptImages: SendMessageImage[],
    clearComposer: () => void,
  ) {
    let slashCommand: SlashCommand | null
    try {
      slashCommand = parseSlashCommand(prompt)
    } catch (cause) {
      setError(errorMessage(cause))
      return
    }
    if (slashCommand) {
      if (promptImages.length > 0) {
        setError('Slash commands cannot include image attachments')
        return
      }
      setPending(true)
      setError(null)
      try {
        await runSlashCommand(slashCommand, agent, {
          onThinkingCommand,
          onResetSession,
          onForkSession,
        })
        await onDetailRefresh()
        clearComposer()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setPending(false)
      }
      return
    }

    setPendingPrompt({
      text: pendingPromptText(prompt, promptImages),
      baselineUserCount: userMessageCount,
    })
    setError(null)
    clearComposer()

    if (!isBackendRunning) {
      setLocalRunning(true)
      void onSend(agent.id, prompt, promptImages)
        .catch((cause) => setError(errorMessage(cause)))
        .finally(() => {
          setPendingPrompt(null)
          setLocalRunning(false)
        })
      return
    }

    setPending(true)
    try {
      await onSteer(agent.id, prompt, promptImages)
      await onDetailRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPendingPrompt(null)
      setPending(false)
    }
  }

  return (
    <div className="chat-panel" data-testid="chat-panel">
      <div className="message-list-wrap">
        <MessageTimeline
          rows={rows}
          listRef={messageListRef}
          selectedMessageId={selectedMessageId}
        />
        {hasNewContent ? (
          <button
            type="button"
            className="jump-to-bottom"
            onClick={scrollToBottom}
            aria-label="Jump to latest messages"
          >
            <ChevronDown size={14} />
            New messages
          </button>
        ) : null}
      </div>
      {error ? <span className="chat-error" role="status">{error}</span> : null}
      {agent.pendingQuestion ? (
        <PendingQuestionPanel
          pendingQuestion={agent.pendingQuestion}
          onAnswer={async (answers) => {
            setError(null)
            try {
              await onAnswerQuestion(agent.id, agent.pendingQuestion!.requestId, answers)
            } catch (cause) {
              setError(errorMessage(cause))
            }
          }}
        />
      ) : null}
      <ChatComposer
        agentId={agent.id}
        contextUsage={agent.contextUsage}
        focusRequest={focusRequest}
        isBackendRunning={isBackendRunning}
        isRunning={isRunning}
        pending={pending}
        onError={setError}
        onInterrupt={interrupt}
        onSubmitPrompt={submitPrompt}
        onEmptyChange={setComposerEmpty}
      />
    </div>
  )
}

function ChatComposer({
  agentId,
  contextUsage,
  focusRequest,
  isBackendRunning,
  isRunning,
  pending,
  onError,
  onInterrupt,
  onSubmitPrompt,
  onEmptyChange,
}: {
  agentId: string
  contextUsage: AgentCell['contextUsage']
  focusRequest: number
  isBackendRunning: boolean
  isRunning: boolean
  pending: boolean
  onError: React.Dispatch<React.SetStateAction<string | null>>
  onInterrupt: () => Promise<void>
  onSubmitPrompt: (
    prompt: string,
    images: SendMessageImage[],
    clearComposer: () => void,
  ) => Promise<void>
  onEmptyChange?: (empty: boolean) => void
}) {
  const [draft, setDraft] = React.useState(() => readStoredChatDraft(agentId))
  const [images, setImages] = React.useState<SendMessageImage[]>([])
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const hasDraftContent = draft.trim().length > 0 || images.length > 0

  React.useEffect(() => {
    onEmptyChange?.(!hasDraftContent)
  }, [hasDraftContent, onEmptyChange])
  const canInterrupt = isBackendRunning && !hasDraftContent
  const canSteer = isBackendRunning && hasDraftContent
  const canSend = !isRunning && hasDraftContent
  const canSubmit = !pending && (canSend || canSteer || canInterrupt)

  React.useEffect(() => {
    setDraft(readStoredChatDraft(agentId))
    setImages([])
  }, [agentId])

  React.useEffect(() => {
    if (focusRequest === 0) return
    textareaRef.current?.focus()
  }, [focusRequest])

  function setStoredDraft(value: string) {
    updateChatDraft(agentId, value, setDraft)
  }

  function clearComposer() {
    updateChatDraft(agentId, '', setDraft)
    setImages([])
  }

  async function addImageFiles(files: File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (!imageFiles.length) return
    try {
      const remaining = Math.max(4 - images.length, 0)
      const nextImages = await Promise.all(imageFiles.slice(0, remaining).map(readImageFile))
      if (imageFiles.length > remaining) {
        onError('Attach up to 4 images per message')
      }
      setImages((current) => [...current, ...nextImages].slice(0, 4))
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    if (canInterrupt) {
      await onInterrupt()
      return
    }
    const prompt = draft.trim() || 'Please inspect the attached image files.'
    await onSubmitPrompt(prompt, images, clearComposer)
  }

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-fields">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setStoredDraft(event.currentTarget.value)}
          onPaste={(event) => {
            void addImageFiles(Array.from(event.clipboardData.files))
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.blur()
              return
            }
            if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey) return
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }}
          aria-label="Prompt"
          placeholder="Type to this agent"
          rows={3}
          data-testid="chat-input"
        />
        {images.length ? (
          <div className="composer-attachments" aria-label="Attached images">
            {images.map((image, index) => (
              <span key={`${image.name}-${index}`} className="composer-attachment">
                {image.name}
                <button
                  type="button"
                  onClick={() =>
                    setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                  aria-label={`Remove ${image.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(event) => {
          void addImageFiles(Array.from(event.currentTarget.files ?? []))
          event.currentTarget.value = ''
        }}
      />
      <span className="composer-hint">Enter to send · Shift Enter for newline</span>
      <button
        type="button"
        className="composer-attach"
        onClick={() => fileInputRef.current?.click()}
        aria-label="Attach images"
        title="Attach images"
      >
        <ImagePlus size={15} />
      </button>
      <ContextUsageChip usage={contextUsage} />
      <button
        type="submit"
        className={`composer-submit${canInterrupt ? ' interrupt' : ''}${canSteer ? ' steer' : ''}`}
        disabled={!canSubmit}
        aria-label={canInterrupt ? 'Stop generation' : canSteer ? 'Steer agent' : 'Send prompt'}
        title={canInterrupt ? 'Stop generation' : canSteer ? 'Steer this turn' : isRunning ? 'Starting turn' : 'Send prompt'}
      >
        {canInterrupt ? <Square size={13} fill="currentColor" /> : <Send size={15} />}
      </button>
    </form>
  )
}

const MessageTimeline = React.memo(function MessageTimeline({
  rows,
  listRef,
  selectedMessageId,
}: {
  rows: AgentTimelineRow[]
  listRef: React.RefObject<HTMLDivElement | null>
  selectedMessageId: string | null
}) {
  if (rows.length === 0) {
    return (
      <div className="message-list" ref={listRef}>
        <div className="empty-panel">No messages yet.</div>
      </div>
    )
  }

  const hideTimestampByRowId = computeHiddenTimestamps(rows)

  return (
    <div className="message-list" ref={listRef}>
      {rows.map((row) => {
        if (row.kind === 'work') return <WorkTimelineRow key={row.id} row={row} />
        if (row.kind === 'working') {
          return <WorkingTimelineRow key={row.id} row={row} />
        }
        return (
          <MessageTimelineRow
            key={row.id}
            message={row.message}
            hideTimestamp={hideTimestampByRowId.has(row.id)}
            selected={selectedMessageId === row.message.id}
          />
        )
      })}
    </div>
  )
})

function computeHiddenTimestamps(rows: AgentTimelineRow[]): Set<string> {
  const hidden = new Set<string>()
  let prevRole: string | null = null
  let prevTimeMs: number | null = null
  for (const row of rows) {
    if (row.kind !== 'message') continue
    const ts = new Date(row.message.timestamp).getTime()
    const valid = !Number.isNaN(ts)
    const sameRole = prevRole === row.message.role
    const within = prevTimeMs !== null && valid && ts - prevTimeMs <= 60_000
    if (sameRole && within) hidden.add(row.id)
    prevRole = row.message.role
    if (valid) prevTimeMs = ts
  }
  return hidden
}

function PendingQuestionPanel({
  pendingQuestion,
  onAnswer,
}: {
  pendingQuestion: PendingQuestion
  onAnswer: (answers: Record<string, string | string[]>) => Promise<void>
}) {
  const [answers, setAnswers] = React.useState<Record<string, string | string[]>>(() =>
    Object.fromEntries(
      pendingQuestion.questions.map((question) => [
        question.id,
        question.multiSelect ? [] : question.options[0]?.label ?? '',
      ]),
    ),
  )
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    setAnswers(Object.fromEntries(
      pendingQuestion.questions.map((question) => [
        question.id,
        question.multiSelect ? [] : question.options[0]?.label ?? '',
      ]),
    ))
  }, [pendingQuestion.requestId, pendingQuestion.questions])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    try {
      await onAnswer(answers)
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="pending-question-panel" onSubmit={submit} data-testid="pending-question">
      <div className="pending-question-head">
        <strong>Claude needs input</strong>
      </div>
      {pendingQuestion.questions.map((question) => {
        const labelId = `pending-question-${question.id}-label`
        const hasOptions = question.options.length > 0
        return (
          <div key={question.id} className="pending-question-field">
            <span id={labelId}>{question.question}</span>
            {hasOptions && !question.multiSelect ? (
              <div
                className="pending-question-options"
                role="radiogroup"
                aria-labelledby={labelId}
              >
                {question.options.map((option) => {
                  const selected = answers[question.id] === option.label
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`pending-question-chip${selected ? ' selected' : ''}`}
                      onClick={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: option.label,
                        }))
                      }
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            ) : hasOptions ? (
              <div
                className="pending-question-options"
                role="group"
                aria-labelledby={labelId}
              >
                {question.options.map((option) => {
                  const currentAnswer = answers[question.id]
                  const selected = Array.isArray(currentAnswer)
                    ? currentAnswer.includes(option.label)
                    : false
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role="checkbox"
                      aria-checked={selected}
                      className={`pending-question-chip${selected ? ' selected' : ''}`}
                      onClick={() =>
                        setAnswers((current) => {
                          const existing = Array.isArray(current[question.id])
                            ? (current[question.id] as string[])
                            : []
                          const next = existing.includes(option.label)
                            ? existing.filter((item) => item !== option.label)
                            : [...existing, option.label]
                          return { ...current, [question.id]: next }
                        })
                      }
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            ) : (
              <input
                aria-labelledby={labelId}
                value={String(answers[question.id] ?? '')}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: value,
                  }))
                }}
              />
            )}
          </div>
        )
      })}
      <button type="submit" disabled={pending}>
        <Check size={14} />
        Answer
      </button>
    </form>
  )
}

const MessageTimelineRow = React.memo(function MessageTimelineRow({
  message,
  hideTimestamp = false,
  selected = false,
}: {
  message: BoardMessage
  hideTimestamp?: boolean
  selected?: boolean
}) {
  const fullTime = formatTime(message.timestamp)
  const selectedClass = selected ? ' is-selected' : ''
  const selectedDataId = selected ? message.id : undefined
  const ariaCurrent = selected ? ('true' as const) : undefined

  if (message.role === 'user') {
    return (
      <article
        className={`timeline-row user-row${selectedClass}`}
        data-message-role={message.role}
        data-selected-id={selectedDataId}
        aria-current={ariaCurrent}
        title={hideTimestamp ? fullTime : undefined}
      >
        <div className="user-bubble">
          <RichMessageBody text={message.text} />
          <MessageMeta message={message} align="right" hideTime={hideTimestamp} />
        </div>
      </article>
    )
  }

  if (message.role === 'assistant') {
    return (
      <article
        className={`timeline-row assistant-row${selectedClass}`}
        data-message-role={message.role}
        data-selected-id={selectedDataId}
        aria-current={ariaCurrent}
        title={hideTimestamp ? fullTime : undefined}
      >
        <RichMessageBody text={message.text} />
        <div className="assistant-meta-row">
          <MessageMeta message={message} hideTime={hideTimestamp} />
          <CopyTextButton text={message.text} label="Copy response" />
        </div>
      </article>
    )
  }

  return (
    <article
      className={`timeline-row note-row ${message.role}${selectedClass}`}
      data-message-role={message.role}
      data-selected-id={selectedDataId}
      aria-current={ariaCurrent}
      title={hideTimestamp ? fullTime : undefined}
    >
      <div className="note-meta">
        <span>{message.role}</span>
        {hideTimestamp ? null : <time>{fullTime}</time>}
      </div>
      <RichMessageBody text={message.text} />
    </article>
  )
})

const WorkTimelineRow = React.memo(function WorkTimelineRow({
  row,
}: {
  row: Extract<AgentTimelineRow, { kind: 'work' }>
}) {
  const [expanded, setExpanded] = React.useState(false)
  const visibleEntries = expanded ? row.entries : row.entries.slice(0, 6)
  const hiddenCount = row.entries.length - visibleEntries.length
  const title = row.entries.some((entry) => entry.kind !== 'tool_execution_start')
    ? 'Activity'
    : 'Tool calls'

  return (
    <section className="timeline-row work-row" aria-label="Runtime activity">
      <div className="work-row-header">
        <span>{title} ({row.entries.length})</span>
        {hiddenCount > 0 ? (
          <button type="button" onClick={() => setExpanded((value) => !value)}>
            <ChevronDown size={13} className={expanded ? 'expanded' : ''} />
            {expanded ? 'Show less' : `Show ${hiddenCount} more`}
          </button>
        ) : null}
      </div>
      <div className="work-entry-list">
        {visibleEntries.map((entry) => (
          <WorkEntryRow key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  )
})

const WorkEntryRow = React.memo(function WorkEntryRow({ entry }: { entry: TimelineWorkEntry }) {
  const [expanded, setExpanded] = React.useState(false)
  const preview = formatWorkPreview(entry)
  const previewText = preview?.text ?? null
  const displayText = previewText ? `${entry.label} - ${previewText}` : entry.label
  const fullText = entry.detail?.trim() || displayText
  const canExpand = displayText.length > 72 || fullText.includes('\n')

  return (
    <div className={`work-entry ${entry.tone} ${expanded ? 'expanded' : ''}`}>
      <TerminalSquare size={13} className={`work-entry-icon ${entry.tone}`} />
      <div className="work-entry-content">
        <div className="work-entry-title">
          <button
            type="button"
            onClick={() => {
              if (canExpand) setExpanded((value) => !value)
            }}
            className={`work-entry-toggle ${canExpand ? 'expandable' : ''}`}
            aria-expanded={expanded}
            disabled={!canExpand}
            title={displayText}
          >
            <span suppressHydrationWarning>
              <strong>{entry.label}</strong>
              {preview ? <> - {preview.node}</> : null}
            </span>
          </button>
          <time>{formatTime(entry.timestamp)}</time>
        </div>
        {expanded && canExpand ? (
          <pre className="work-entry-detail"><code>{fullText}</code></pre>
        ) : null}
      </div>
    </div>
  )
})

type WorkPreview = { node: React.ReactNode; text: string }

function formatWorkPreview(entry: TimelineWorkEntry): WorkPreview | null {
  const detail = entry.detail?.trim()
  if (!detail) return null

  const colonIndex = detail.indexOf(': ')
  if (colonIndex > 0 && colonIndex <= 32) {
    const toolName = detail.slice(0, colonIndex)
    const args = detail.slice(colonIndex + 2).trim()
    if (args) {
      const kind = classifyToolName(toolName)
      if (kind === 'path') return renderPathPreview(args)
      if (kind === 'command') return { node: <span className="work-arg-mono">{args}</span>, text: args }
      if (kind === 'pattern') {
        return { node: <span className="work-arg-mono">"{args}"</span>, text: `"${args}"` }
      }
    }
  }

  return { node: detail, text: detail }
}

function classifyToolName(name: string): 'path' | 'command' | 'pattern' | 'unknown' {
  const normalized = name.toLowerCase()
  if (['read', 'edit', 'write', 'multiedit', 'notebookedit'].includes(normalized)) return 'path'
  if (normalized === 'bash' || normalized.includes('shell') || normalized.includes('command')) {
    return 'command'
  }
  if (normalized === 'grep' || normalized === 'glob') return 'pattern'
  return 'unknown'
}

function renderPathPreview(rawPath: string): WorkPreview {
  const path = rawPath.replace(/^["']|["']$/g, '').trim()
  const slash = path.lastIndexOf('/')
  if (slash <= 0 || slash >= path.length - 1) {
    return { node: <span className="work-arg-path">{path}</span>, text: path }
  }
  const dir = path.slice(0, slash + 1)
  const base = path.slice(slash + 1)
  return {
    node: (
      <span className="work-arg-path">
        <span className="work-arg-dir">{dir}</span>
        <span className="work-arg-base">{base}</span>
      </span>
    ),
    text: path,
  }
}

type SlashCommand = {
  name: 'thinking' | 'new' | 'fork'
  level?: ThinkingLevel
}

function parseSlashCommand(prompt: string): SlashCommand | null {
  const [command = '', ...args] = prompt.trim().split(/\s+/)
  if (command === '/new') {
    if (args.length > 0) throw new Error('Usage: /new')
    return { name: 'new' }
  }
  if (command === '/fork') {
    if (args.length > 0) throw new Error('Usage: /fork')
    return { name: 'fork' }
  }
  if (command !== '/thinking') return null
  if (args.length === 0) return { name: 'thinking' }
  if (args.length > 1) {
    throw new Error('Usage: /thinking [off|minimal|low|medium|high|xhigh]')
  }
  if (args[0] === 'cycle') return { name: 'thinking' }
  const parsed = thinkingLevelSchema.safeParse(args[0])
  if (!parsed.success) {
    throw new Error('Usage: /thinking [off|minimal|low|medium|high|xhigh]')
  }
  return { name: 'thinking', level: parsed.data }
}

async function runSlashCommand(
  command: SlashCommand,
  agent: AgentCell,
  actions: {
    onThinkingCommand: (agentId: string, level?: ThinkingLevel) => Promise<void>
    onResetSession: (agentId: string) => Promise<void>
    onForkSession: (agentId: string) => Promise<void>
  },
) {
  if (command.name === 'new') {
    await actions.onResetSession(agent.id)
    return
  }
  if (command.name === 'fork') {
    await actions.onForkSession(agent.id)
    return
  }
  if (command.name === 'thinking') {
    if (!supportsThinking(agent.runtime)) {
      throw new Error(`${agent.runtime} sessions do not support /thinking yet`)
    }
    await actions.onThinkingCommand(agent.id, command.level)
  }
}

function WorkingTimelineRow({
  row,
}: {
  row: Extract<AgentTimelineRow, { kind: 'working' }>
}) {
  const elapsed = useElapsedSeconds(row.startedAt)
  return (
    <div className="timeline-row working-row">
      <span className="working-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        {elapsed === null ? 'Working' : `Working · ${formatElapsed(elapsed)}`}
      </span>
    </div>
  )
}

function useElapsedSeconds(startedAt: string | null | undefined) {
  const startMs = React.useMemo(() => {
    if (!startedAt) return null
    const ms = new Date(startedAt).getTime()
    return Number.isNaN(ms) ? null : ms
  }, [startedAt])

  const [seconds, setSeconds] = React.useState<number | null>(() =>
    startMs === null ? null : Math.max(0, Math.floor((Date.now() - startMs) / 1000)),
  )

  React.useEffect(() => {
    if (startMs === null) {
      setSeconds(null)
      return
    }
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - startMs) / 1000)))
    tick()
    let timer: number | undefined
    const start = () => {
      if (timer !== undefined) return
      timer = window.setInterval(tick, 1000)
    }
    const stop = () => {
      if (timer === undefined) return
      window.clearInterval(timer)
      timer = undefined
    }
    if (document.visibilityState === 'visible') start()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        tick()
        start()
      } else {
        stop()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [startMs])

  return seconds
}

function formatElapsed(totalSeconds: number) {
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const ss = seconds.toString().padStart(2, '0')
  if (hours > 0) {
    const mm = minutes.toString().padStart(2, '0')
    return `${hours}:${mm}:${ss}`
  }
  return `${minutes}:${ss}`
}

function MessageMeta({
  message,
  align = 'left',
  hideTime = false,
}: {
  message: BoardMessage
  align?: 'left' | 'right'
  hideTime?: boolean
}) {
  return (
    <div className={`message-meta ${align}`}>
      <span>{message.role}</span>
      {hideTime ? null : <time>{formatTime(message.timestamp)}</time>}
    </div>
  )
}

const markdownComponents = {
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
} satisfies Components

function RichMessageBody({
  text,
  compact = false,
}: {
  text: string
  compact?: boolean
}) {
  return (
    <div className={compact ? 'rich-message-body compact' : 'rich-message-body'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = React.useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button type="button" className="copy-message" onClick={copy} aria-label={label}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function deriveAgentTimelineRows(agent: AgentCell): AgentTimelineRow[] {
  const rows: AgentTimelineRow[] = []
  let workEntries: TimelineWorkEntry[] = []
  const timeline = agent.timeline.length
    ? agent.timeline
    : agent.messages.map((message) => ({
        type: 'message' as const,
        id: `message:${message.id}`,
        timestamp: message.timestamp,
        message,
      }))

  function flushWork() {
    if (workEntries.length === 0) return
    rows.push({
      kind: 'work',
      id: `work:${workEntries[0]?.id}:${workEntries[workEntries.length - 1]?.id}`,
      startedAt: workEntries[0]?.timestamp ?? new Date(0).toISOString(),
      entries: workEntries,
    })
    workEntries = []
  }

  for (const item of timeline) {
    if (item.type === 'event') {
      const entry = eventToWorkEntry(item.event)
      if (entry) workEntries.push(entry)
      continue
    }

    if (item.message.role === 'tool') {
      workEntries.push(toolMessageToWorkEntry(item.message))
      continue
    }

    flushWork()
    rows.push({
      kind: 'message',
      id: `message:${item.message.id}`,
      message: item.message,
    })
  }

  flushWork()

  if (agent.status === 'running') {
    const lastRow = rows[rows.length - 1]
    rows.push({
      kind: 'working',
      id: 'working-indicator',
      startedAt: lastRow?.kind === 'message' ? lastRow.message.timestamp : null,
    })
  }

  return rows
}

function eventToWorkEntry(event: TimelineEvent): TimelineWorkEntry | null {
  if (!shouldShowRuntimeEvent(event)) return null

  return {
    id: event.id,
    kind: event.kind,
    tone: event.tone,
    label: runtimeEventLabel(event),
    detail: event.detail,
    timestamp: event.timestamp,
  }
}

function shouldShowRuntimeEvent(event: TimelineEvent) {
  if (event.kind === 'codex_context_compacted') return true
  if (event.kind.startsWith('claude_tool_')) return true
  if (event.kind.startsWith('claude_question_')) return true
  if (event.kind !== 'tool_execution_start') return false
  return event.label.toLowerCase() !== 'taskupdate'
}

function runtimeEventLabel(event: TimelineEvent) {
  const label = event.label.trim()
  if (label.toLowerCase() === 'bash') return 'Ran command'
  if (!label || label === 'tool execution start') return 'Tool'
  return label
}

function toolMessageToWorkEntry(message: BoardMessage): TimelineWorkEntry {
  const [firstLine, ...rest] = message.text.split('\n')
  return {
    id: message.id,
    kind: 'tool.message',
    tone: 'tool',
    label: firstLine?.trim() || 'Tool output',
    detail: rest.join('\n').trim() || message.text,
    timestamp: message.timestamp,
  }
}

function TerminalPanel({
  agent,
  project,
  themeMode,
}: {
  agent: AgentCell
  project: ProjectRow
  themeMode: ThemeMode
}) {
  const getTerminalConfig = useServerFn(terminalConfigQuery)
  const getTerminalConfigRef = React.useRef(getTerminalConfig)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = React.useState('Connecting')
  const [transcript, setTranscript] = React.useState('')

  React.useEffect(() => {
    getTerminalConfigRef.current = getTerminalConfig
  }, [getTerminalConfig])

  React.useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let term: GhosttyTerminalInstance | null = null
    let fitAddon: GhosttyFitAddonInstance | null = null

    async function connect() {
      const host = hostRef.current
      if (!host) return
      host.textContent = ''
      setTranscript('')
      setStatus('Loading')

      try {
        const [{ init, Terminal, FitAddon }, terminalConfig] = await Promise.all([
          import('ghostty-web'),
          getTerminalConfigRef.current({ data: { agentId: agent.id } }),
        ])
        if (disposed) return

        await init()
        if (disposed) return

        term = new Terminal({
          fontSize: 13,
          fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          cursorBlink: true,
          theme: terminalTheme(themeMode),
        })
        fitAddon = new FitAddon()
        term.loadAddon(fitAddon)
        term.open(host)
        fitAddon.fit()
        fitAddon.observeResize?.()

        const url = terminalWebSocketUrl(terminalConfig, agent.id, term.cols, term.rows)
        socket = new WebSocket(url)
        socket.addEventListener('open', () => {
          if (!term || !socket) return
          setStatus('Connected')
          socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          const banner = `Aether terminal · ${project.cwd}\r\n\r\n`
          term.write(banner)
          appendTerminalTranscript(setTranscript, banner)
        })
        socket.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            term?.write(event.data)
            appendTerminalTranscript(setTranscript, event.data)
          }
        })
        socket.addEventListener('close', () => {
          if (!disposed) {
            setStatus('Closed')
            appendTerminalTranscript(setTranscript, '\r\n[Aether terminal socket closed]\r\n')
          }
        })
        socket.addEventListener('error', () => {
          if (!disposed) setStatus('Connection failed')
        })
        term.onData((data) => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'input', data }))
          }
        })
        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'resize', cols, rows }))
          }
        })
      } catch (error) {
        if (disposed) return
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }

    void connect()

    return () => {
      disposed = true
      socket?.close()
      fitAddon?.dispose()
      term?.dispose()
    }
  }, [agent.id, project.cwd, themeMode])

  return (
    <section className="terminal-panel" data-testid="terminal-panel">
      <div className="terminal-header">
        <div>
          <strong>{project.name}</strong>
          <span>{project.cwd}</span>
        </div>
        <span className="terminal-status">{status}</span>
      </div>
      <div ref={hostRef} className="terminal-host" />
      <pre className="terminal-transcript" data-testid="terminal-transcript" aria-live="polite">
        {transcript}
      </pre>
    </section>
  )
}

function appendTerminalTranscript(
  setTranscript: React.Dispatch<React.SetStateAction<string>>,
  data: string,
) {
  setTranscript((current) => `${current}${data}`.slice(-8_000))
}

function terminalWebSocketUrl(
  config: { host: string; port: number; path: string },
  agentId: string,
  cols: number,
  rows: number,
) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const pageHost = window.location.hostname
  const isLocalPage = pageHost === 'localhost' || pageHost === '127.0.0.1' || pageHost === '::1'
  const host =
    !isLocalPage && (config.host === '127.0.0.1' || config.host === '0.0.0.0')
      ? pageHost
      : config.host
  const url = new URL(`${protocol}//${host}:${config.port}${config.path}`)
  url.searchParams.set('agentId', agentId)
  url.searchParams.set('cols', String(cols))
  url.searchParams.set('rows', String(rows))
  return url.toString()
}

function terminalTheme(themeMode: ThemeMode) {
  if (themeMode === 'dark') {
    return {
      background: '#101216',
      foreground: '#e6e8ef',
      cursor: '#f5c15c',
      selectionBackground: '#334155',
    }
  }
  return {
    background: '#fbfaf7',
    foreground: '#1f2937',
    cursor: '#9a5b00',
    selectionBackground: '#d7e3ee',
  }
}

function DiffPanel({ agent, themeMode }: { agent: AgentCell; themeMode: ThemeMode }) {
  const [selectedDiffId, setSelectedDiffId] = React.useState<string | null>(null)
  const [diffStyle, setDiffStyle] = React.useState<DiffStyle>('unified')
  const [fullscreen, setFullscreen] = React.useState(false)
  const fileButtonRefs = React.useRef<Array<HTMLButtonElement | null>>([])
  const diffBodyRef = React.useRef<HTMLDivElement | null>(null)
  const diff =
    agent.diffs.find((item) => item.id === selectedDiffId) ?? agent.diffs[0]
  const selectedIndex = diff
    ? Math.max(0, agent.diffs.findIndex((item) => item.id === diff.id))
    : -1
  const duplicateFileNames = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of agent.diffs) {
      const name = diffFileName(item)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return new Set(
      [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    )
  }, [agent.diffs])

  React.useEffect(() => {
    setSelectedDiffId(null)
    setFullscreen(false)
  }, [agent.id, agent.diffs.length])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'escape' && fullscreen) {
        event.preventDefault()
        setFullscreen(false)
        return
      }
      if (key === 'f') {
        event.preventDefault()
        setFullscreen((value) => !value)
        return
      }
      if (key === 'h') {
        event.preventDefault()
        selectRelative(-1, false)
        return
      }
      if (key === 'l') {
        event.preventDefault()
        selectRelative(1, false)
        return
      }
      if (key === 'j') {
        event.preventDefault()
        scrollDiff(320)
        return
      }
      if (key === 'k') {
        event.preventDefault()
        scrollDiff(-320)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreen, selectedIndex, agent.diffs])

  React.useEffect(() => {
    fileButtonRefs.current[selectedIndex]?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [selectedIndex])

  function selectIndex(index: number, focus = false) {
    if (!agent.diffs.length) return
    const nextIndex = Math.max(0, Math.min(index, agent.diffs.length - 1))
    setSelectedDiffId(agent.diffs[nextIndex]?.id ?? null)
    if (focus) {
      window.requestAnimationFrame(() => fileButtonRefs.current[nextIndex]?.focus())
    }
  }

  function selectRelative(delta: -1 | 1, focus = false) {
    if (!agent.diffs.length || selectedIndex === -1) return
    const nextIndex = (selectedIndex + delta + agent.diffs.length) % agent.diffs.length
    selectIndex(nextIndex, focus)
  }

  function onFileListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const key = event.key.toLowerCase()
    if (key === 'h') {
      event.preventDefault()
      selectRelative(-1, true)
      return
    }
    if (key === 'l') {
      event.preventDefault()
      selectRelative(1, true)
      return
    }
    if (key === 'j') {
      event.preventDefault()
      scrollDiff(320)
      return
    }
    if (key === 'k') {
      event.preventDefault()
      scrollDiff(-320)
    }
  }

  function scrollDiff(delta: number) {
    diffBodyRef.current?.scrollBy({ top: delta, behavior: 'smooth' })
  }

  if (!diff) {
    return (
      <div className="empty-panel" data-testid="diff-panel">
        <GitPullRequest size={18} />
        <span>No diffs for this agent yet.</span>
      </div>
    )
  }

  return (
    <div
      className={`diff-panel${fullscreen ? ' fullscreen' : ''}`}
      data-testid="diff-panel"
    >
      <div className="diff-header">
        <div>
          <strong>{agent.diffs.length} file{agent.diffs.length === 1 ? '' : 's'}</strong>
          <span>{diff.path}</span>
        </div>
        <div className="diff-toolbar" aria-label="Diff controls">
          <button
            type="button"
            onClick={() => selectRelative(-1)}
            aria-label="Previous changed file"
            title="Previous file"
          >
            <ArrowLeft size={14} />
          </button>
          <span className="diff-index">{selectedIndex + 1}/{agent.diffs.length}</span>
          <button
            type="button"
            onClick={() => selectRelative(1)}
            aria-label="Next changed file"
            title="Next file"
          >
            <ArrowRight size={14} />
          </button>
          <div className="diff-view-toggle" role="group" aria-label="Diff layout">
            <button
              type="button"
              className={diffStyle === 'unified' ? 'active' : ''}
              onClick={() => setDiffStyle('unified')}
              aria-label="Unified diff"
              title="Unified"
            >
              <Rows3 size={14} />
            </button>
            <button
              type="button"
              className={diffStyle === 'split' ? 'active' : ''}
              onClick={() => setDiffStyle('split')}
              aria-label="Split diff"
              title="Split"
            >
              <Columns2 size={14} />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setFullscreen((value) => !value)}
            aria-label={fullscreen ? 'Exit fullscreen diffs' : 'Fullscreen diffs'}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
      <div
        className="diff-file-list"
        role="tablist"
        aria-label="Changed files"
        onKeyDown={onFileListKeyDown}
      >
        {agent.diffs.map((item, index) => {
          const fileName = diffFileName(item)
          const folder = duplicateFileNames.has(fileName)
            ? diffFileFolder(item.path)
            : null
          return (
            <button
              key={item.id}
              ref={(element) => {
                fileButtonRefs.current[index] = element
              }}
              type="button"
              role="tab"
              className={item.id === diff.id ? 'active' : ''}
              onClick={() => setSelectedDiffId(item.id)}
              aria-selected={item.id === diff.id}
              tabIndex={item.id === diff.id ? 0 : -1}
              title={item.path}
            >
              <span className="diff-file-name">{fileName}</span>
              {folder ? <span className="diff-file-folder">{folder}</span> : null}
            </button>
          )
        })}
      </div>
      <div className="pierre-host" ref={diffBodyRef}>
        <PatchDiff
          key={`${diff.id}:${diffStyle}:${themeMode}`}
          patch={diff.patch}
          disableWorkerPool
          options={{
            diffStyle,
            overflow: 'wrap',
            themeType: themeMode,
          }}
        />
      </div>
    </div>
  )
}

function diffFileName(file: Pick<DiffArtifact, 'path' | 'title'>) {
  const normalized = file.path.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? file.title
}

function diffFileFolder(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= 1) return null
  return parts.slice(0, -1).join('/')
}

function RuntimeBadge({ runtime }: { runtime: string }) {
  return <span className="runtime-badge">{runtime}</span>
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
    return <span className="agent-cell-state">{ago}</span>
  }
  const showLabel = status === 'blocked' || status === 'failed'
  return (
    <span className="agent-cell-state" data-status={status}>
      <span className={`status-dot ${status}`} aria-hidden="true" />
      {showLabel ? <span>{status}</span> : null}
    </span>
  )
}

function formatAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Math.max(0, Date.now() - then)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

function moveProject(
  projects: ProjectRow[],
  current: Selection,
  delta: 1 | -1,
): Selection {
  const index = projects.findIndex((project) => project.id === current.projectId)
  const nextIndex = clamp(index + delta, 0, projects.length - 1)
  const project = projects[nextIndex]
  const currentProject = projects[index]
  if (!project) return current
  const agent =
    project.agents.find((item) => item.id === current.agentId) ??
    project.agents[
      clamp(
        currentProject?.agents.findIndex((item) => item.id === current.agentId) ??
          0,
        0,
        project.agents.length - 1,
      )
    ]
  return {
    projectId: project.id,
    agentId: agent?.id ?? current.agentId,
  }
}

function moveAgent(project: ProjectRow, current: Selection, delta: 1 | -1): Selection {
  const index = project.agents.findIndex((agent) => agent.id === current.agentId)
  const nextIndex = clamp(index + delta, 0, project.agents.length - 1)
  return {
    projectId: project.id,
    agentId: project.agents[nextIndex]?.id ?? current.agentId,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || target.isContentEditable
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`
  if (value >= 1_000) return `${trimFixed(value / 1_000)}K`
  return value.toLocaleString('en')
}

function trimFixed(value: number) {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '')
}

function actionForKey(keymap: KeymapSettings, key: string): KeymapAction | undefined {
  return (Object.entries(keymap) as Array<[KeymapAction, string]>).find(
    ([, binding]) => binding === key,
  )?.[0]
}

function updateKeymap(
  current: KeymapSettings,
  action: KeymapAction,
  value: string,
): KeymapSettings {
  const keymap = { ...current }
  const displacedAction = (
    Object.entries(keymap) as Array<[KeymapAction, string]>
  ).find(
    ([otherAction, binding]) => otherAction !== action && binding === value,
  )?.[0]

  if (displacedAction) {
    keymap[displacedAction] = current[action]
  }
  keymap[action] = value
  return saveKeymap(keymap)
}

function readStoredKeymap(): KeymapSettings {
  try {
    const stored = window.localStorage.getItem(keymapStorageKey)
    if (!stored) return defaultKeymap
    const parsed = JSON.parse(stored) as Partial<KeymapSettings>
    const next = { ...defaultKeymap, ...parsed }
    const values = Object.values(next)
    if (
      values.length !== new Set(values).size ||
      values.some((value) => !keyOptions.includes(value))
    ) {
      return defaultKeymap
    }
    return next
  } catch {
    return defaultKeymap
  }
}

function saveKeymap(keymap: KeymapSettings): KeymapSettings {
  window.localStorage.setItem(keymapStorageKey, JSON.stringify(keymap))
  return keymap
}

function readStoredThemeSelection(): ThemeSelection {
  try {
    const stored = window.localStorage.getItem(themeStorageKey)
    if (!stored) return defaultThemeSelection
    return normalizeThemeSelection(JSON.parse(stored))
  } catch {
    return defaultThemeSelection
  }
}

function saveThemeSelection(selection: ThemeSelection): ThemeSelection {
  window.localStorage.setItem(themeStorageKey, JSON.stringify(selection))
  return selection
}

function readStoredChatTypography(): ChatTypographySettings {
  try {
    const stored = window.localStorage.getItem(chatTypographyStorageKey)
    if (!stored) return defaultChatTypography
    const record = JSON.parse(stored) as Record<string, unknown>
    return normalizeChatTypography(record)
  } catch {
    return defaultChatTypography
  }
}

function saveChatTypography(settings: ChatTypographySettings): ChatTypographySettings {
  window.localStorage.setItem(chatTypographyStorageKey, JSON.stringify(settings))
  return settings
}

function readStoredChatDraft(agentId: string) {
  return readStoredChatDrafts()[agentId] ?? ''
}

function updateChatDraft(
  agentId: string,
  value: string,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
) {
  setDraft(value)
  const drafts = readStoredChatDrafts()
  if (value) {
    drafts[agentId] = value
  } else {
    delete drafts[agentId]
  }
  window.sessionStorage.setItem(chatDraftStorageKey, JSON.stringify(drafts))
}

function readStoredChatDrafts(): Record<string, string> {
  try {
    const stored = window.sessionStorage.getItem(chatDraftStorageKey)
    if (!stored) return {}
    const parsed = JSON.parse(stored) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => (
        typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )),
    )
  } catch {
    return {}
  }
}

function normalizeChatTypography(value: Record<string, unknown>): ChatTypographySettings {
  const fontSize = typeof value.fontSize === 'string' && value.fontSize in chatFontSizes
    ? value.fontSize as ChatFontSize
    : defaultChatTypography.fontSize
  return { fontSize }
}

function applyChatTypography(element: HTMLElement, settings: ChatTypographySettings): void {
  const tokens = chatFontSizes[settings.fontSize]
  element.style.setProperty('--chat-font-size', tokens.size)
  element.style.setProperty('--chat-line-height', tokens.lineHeight)
}

function formatKey(key: string) {
  if (key.startsWith('arrow')) return key.replace('arrow', 'Arrow ')
  return key.toUpperCase()
}

function pendingPromptText(text: string, images: SendMessageImage[]) {
  if (!images.length) return text
  return `${text}\n\nAttached images:\n${images.map((image) => `- ${image.name}`).join('\n')}`
}

function projectNameFromPath(path: string) {
  return path.replace(/\/+$/g, '').split('/').filter(Boolean).at(-1) ?? ''
}

function projectSummary(project: ProjectRow) {
  const sessions = project.agents.length
  return `${project.id} · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`
}

async function readImageFile(file: File): Promise<SendMessageImage> {
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
    throw new Error(`Unsupported image type: ${file.type || file.name}`)
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error(`Image "${file.name}" is larger than 5MB`)
  }
  const dataUrl = await readFileAsDataUrl(file)
  const [, data] = dataUrl.split(',', 2)
  if (!data) throw new Error(`Could not read image "${file.name}"`)
  return {
    name: file.name || 'image',
    mimeType: file.type,
    data,
  }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error(`Could not read image "${file.name}"`))
    })
    reader.addEventListener('error', () => reject(reader.error ?? new Error('File read failed')))
    reader.readAsDataURL(file)
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed'
}
