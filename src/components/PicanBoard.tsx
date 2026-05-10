'use client'

import { PatchDiff } from '@pierre/diffs/react'
import { useServerFn } from '@tanstack/react-start'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Columns2,
  Circle,
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
  ProjectRow,
  RuntimeKind,
  SendMessageImage,
  ThinkingLevel,
  TimelineEvent,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import { thinkingLevelSchema } from '~/lib/contracts'
import {
  applyPicanTheme,
  defaultThemeSelection,
  normalizeThemeSelection,
  picanThemeNames,
  type PicanThemeName,
  type ThemeMode,
  type ThemeSelection,
} from '~/theme/pican-themes'
import {
  addProjectMutation,
  chooseProjectDirectoryMutation,
  deleteProjectMutation,
  deleteSessionMutation,
  fetchWorkspaceSnapshot,
  forkSessionMutation,
  hideProjectMutation,
  interruptMessageMutation,
  resetSessionMutation,
  sendMessageMutation,
  setThinkingLevelMutation,
  startSessionMutation,
  steerMessageMutation,
  unhideProjectMutation,
} from '~/server/workspace'

type SidebarTab = 'chat' | 'diffs'
type DiffStyle = 'unified' | 'split'
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

type KeymapSettings = Record<KeymapAction, string>

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
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]
const keymapStorageKey = 'pican:keymap:v1'
const themeStorageKey = 'pican:theme:v1'

export function PicanBoard({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [workspace, setWorkspace] = React.useState(snapshot)
  const [selection, setSelection] = React.useState<Selection>(snapshot.selected)
  const [tab, setTab] = React.useState<SidebarTab>('chat')
  const [hydrated, setHydrated] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [projectManagerOpen, setProjectManagerOpen] = React.useState(false)
  const [sessionLauncherOpen, setSessionLauncherOpen] = React.useState(false)
  const [agentSwitcherOpen, setAgentSwitcherOpen] = React.useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false)
  const [keymap, setKeymap] = React.useState<KeymapSettings>(defaultKeymap)
  const [themeSelection, setThemeSelection] = React.useState<ThemeSelection>(defaultThemeSelection)
  const [chatFocusRequest, setChatFocusRequest] = React.useState(0)
  const [chatDrafts, setChatDrafts] = React.useState<Record<string, string>>({})
  const addProject = useServerFn(addProjectMutation)
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
  }, [])

  React.useEffect(() => {
    applyPicanTheme(document.documentElement, themeSelection)
  }, [themeSelection])

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

      if (event.key === 'Escape' && (commandPaletteOpen || agentSwitcherOpen)) {
        event.preventDefault()
        setCommandPaletteOpen(false)
        setAgentSwitcherOpen(false)
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
  }, [agentSwitcherOpen, commandPaletteOpen, keymap, workspace.projects])

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

  async function handleDeleteSession(agentId: string) {
    const agent = selectedProject?.agents.find((item) => item.id === agentId)
    if (!agent || !selectedProject) return
    if (!window.confirm(`Remove session "${agent.title}"?`)) return

    const currentProjectId = selectedProject.id
    const currentProject = selectedProject
    const currentIndex = currentProject.agents.findIndex((agent) => agent.id === agentId)
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
  }

  async function withWorkspacePolling<T>(action: () => Promise<T>, onResult: (result: T) => void) {
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      if (stopped) return
      try {
        setWorkspace(await refreshWorkspace())
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
  ) {
    await withWorkspacePolling(
      () => sendMessage({ data: { agentId, text, images } }),
      (next) => setWorkspace(next),
    )
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
        onKeymapChange={(action, value) =>
          setKeymap((current) => updateKeymap(current, action, value))
        }
        onKeymapReset={() => setKeymap(saveKeymap(defaultKeymap))}
        onThemeChange={(next) => setThemeSelection(saveThemeSelection(next))}
        onClose={() => setSettingsOpen(false)}
      />
    )
  }

  return (
    <main className="pican-shell">
      <MobileTopBar
        project={selectedProject}
        agent={selectedAgent}
        tab={tab}
        onTabChange={setTab}
        onOpenAgentSwitcher={() => setAgentSwitcherOpen(true)}
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

      <section
        className="board-pane"
        aria-label="Projects and agents"
        data-hydrated={hydrated ? 'true' : 'false'}
        data-testid="board-pane"
      >
        <header className="topbar">
          <h1 className="pican-mark">PICAN</h1>
          <div className="topbar-actions">
            <button
              type="button"
              className="settings-trigger"
              aria-expanded={projectManagerOpen}
              onClick={() => {
                setSettingsOpen(false)
                setProjectManagerOpen((open) => !open)
              }}
            >
              <FolderOpen size={14} />
              Projects
            </button>
            <button
              type="button"
              className="settings-trigger"
              aria-expanded={settingsOpen}
              onClick={() => {
                setProjectManagerOpen(false)
                setSettingsOpen((open) => !open)
              }}
            >
              <Settings2 size={14} />
              Settings
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

      <aside
        className="sidebar-pane"
        aria-label="Selected chat"
        data-testid="sidebar-pane"
      >
        {selectedAgent ? (
          <>
            <SidebarHeader
              project={selectedProject}
              agent={selectedAgent}
              onDeleteSession={handleDeleteSession}
            />
            <div className="sidebar-tabs" role="tablist">
              <button
                type="button"
                className={tab === 'chat' ? 'active' : ''}
                onClick={() => setTab('chat')}
                data-testid="tab-chat"
              >
                <MessageSquareText size={15} />
                Chat
              </button>
              <button
                type="button"
                className={tab === 'diffs' ? 'active' : ''}
                onClick={() => setTab('diffs')}
                data-testid="tab-diffs"
              >
                <GitPullRequest size={15} />
                Diffs
              </button>
            </div>

            {tab === 'chat' ? (
              <ChatPanel
                key={selectedAgent.id}
                agent={selectedAgent}
                draft={chatDrafts[selectedAgent.id] ?? ''}
                focusRequest={chatFocusRequest}
                onDraftChange={(draft) =>
                  setChatDrafts((current) => ({ ...current, [selectedAgent.id]: draft }))
                }
                onSend={handleSendMessage}
                onSteer={handleSteerMessage}
                onInterrupt={handleInterruptMessage}
                onThinkingCommand={handleThinkingCommand}
                onResetSession={handleResetSession}
                onForkSession={handleForkSession}
              />
            ) : null}
            {tab === 'diffs' ? (
              <DiffPanel
                key={selectedAgent.id}
                agent={selectedAgent}
                themeMode={themeSelection.mode}
              />
            ) : null}
          </>
        ) : (
          <EmptySessionPanel
            project={selectedProject}
            onStart={() => setSessionLauncherOpen(true)}
          />
        )}
      </aside>
    </main>
  )
}

function SettingsScreen({
  keymap,
  themeSelection,
  onKeymapChange,
  onKeymapReset,
  onThemeChange,
  onClose,
}: {
  keymap: KeymapSettings
  themeSelection: ThemeSelection
  onKeymapChange: (action: KeymapAction, value: string) => void
  onKeymapReset: () => void
  onThemeChange: (selection: ThemeSelection) => void
  onClose: () => void
}) {
  return (
    <main className="settings-shell" data-testid="settings-page">
      <header className="settings-hero">
        <h1 className="pican-mark">PICAN</h1>
        <button type="button" className="settings-close" onClick={onClose}>
          Back to board
        </button>
      </header>

      <section className="settings-intro" aria-label="Settings overview">
        <div>
          <p className="settings-kicker">Settings</p>
          <h2>Workspace controls</h2>
        </div>
        <p>Keymaps and theme stay here. Project rows are managed from the board.</p>
      </section>

      <div className="settings-layout">
        <section className="settings-section">
          <KeymapSettingsPanel
            keymap={keymap}
            onChange={onKeymapChange}
            onReset={onKeymapReset}
          />
        </section>

        <section className="settings-section">
          <ThemeSettingsPanel selection={themeSelection} onChange={onThemeChange} />
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
              disabled={pending || (runtime !== 'pi' && runtime !== 'codex')}
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

function ThemeSettingsPanel({
  selection,
  onChange,
}: {
  selection: ThemeSelection
  onChange: (selection: ThemeSelection) => void
}) {
  return (
    <section className="settings-panel" aria-label="Theme settings">
      <div>
        <p className="settings-kicker">Theme</p>
        <strong>Board palette</strong>
      </div>
      <label className="key-select">
        <span>Name</span>
        <select
          value={selection.name}
          onChange={(event) =>
            onChange({ ...selection, name: event.currentTarget.value as PicanThemeName })
          }
          data-testid="theme-name"
        >
          {picanThemeNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="key-select">
        <span>Mode</span>
        <select
          value={selection.mode}
          onChange={(event) =>
            onChange({ ...selection, mode: event.currentTarget.value as ThemeMode })
          }
          data-testid="theme-mode"
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <button
        type="button"
        className="reset-keymap"
        onClick={() => onChange(defaultThemeSelection)}
      >
        Reset
      </button>
    </section>
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
  return (
    <section className="settings-panel" aria-label="Keymap settings">
      <div>
        <p className="settings-kicker">Keymap</p>
        <strong>Board shortcuts use Shift plus key</strong>
      </div>
      <KeySelect
        label="Project up"
        action="projectPrev"
        value={keymap.projectPrev}
        onChange={onChange}
      />
      <KeySelect
        label="Project down"
        action="projectNext"
        value={keymap.projectNext}
        onChange={onChange}
      />
      <KeySelect
        label="Agent left"
        action="agentPrev"
        value={keymap.agentPrev}
        onChange={onChange}
      />
      <KeySelect
        label="Agent right"
        action="agentNext"
        value={keymap.agentNext}
        onChange={onChange}
      />
      <KeySelect
        label="Start session"
        action="startSession"
        value={keymap.startSession}
        onChange={onChange}
      />
      <KeySelect
        label="Remove session"
        action="deleteSession"
        value={keymap.deleteSession}
        onChange={onChange}
      />
      <KeySelect
        label="Focus chat"
        action="focusChat"
        value={keymap.focusChat}
        onChange={onChange}
      />
      <KeySelect
        label="Open diffs"
        action="openDiffs"
        value={keymap.openDiffs}
        onChange={onChange}
      />
      <div className="key-static" aria-label="Command menu shortcut">
        <span>Command menu</span>
        <strong>⌘K / Ctrl+K</strong>
      </div>
      <button type="button" className="reset-keymap" onClick={onReset}>
        Reset
      </button>
    </section>
  )
}

function KeySelect({
  label,
  action,
  value,
  onChange,
}: {
  label: string
  action: KeymapAction
  value: string
  onChange: (action: KeymapAction, value: string) => void
}) {
  return (
    <label className="key-select">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(action, event.currentTarget.value)}
        data-testid={`keymap-${action}`}
      >
        {keyOptions.map((key) => (
          <option key={key} value={key}>
            Shift+{formatKey(key)}
          </option>
        ))}
      </select>
    </label>
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
    if (!action || action.disabled) return
    action.run()
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
  onStartSession,
  onOpenProjects,
  onOpenSettings,
}: {
  project: ProjectRow
  agent: AgentCell | undefined
  tab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  onOpenAgentSwitcher: () => void
  onStartSession: () => void
  onOpenProjects: () => void
  onOpenSettings: () => void
}) {
  return (
    <header className="mobile-topbar" aria-label="Mobile navigation">
      <div className="mobile-topbar-main">
        <div className="mobile-brand">
          <span>PICAN</span>
          <small>{project.name}</small>
        </div>
        <button
          type="button"
          className="mobile-agent-trigger"
          onClick={onOpenAgentSwitcher}
          aria-label="Switch agent"
        >
          <span className={`status-dot ${agent?.status ?? ''}`} aria-hidden="true" />
          <span>
            <strong>{agent?.title ?? 'No session'}</strong>
            <small>{agent ? `${agent.runtime} · ${agent.model}` : 'Choose or start an agent'}</small>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        <div className="mobile-actions">
          <button type="button" onClick={onStartSession} aria-label="Start session">
            <Plus size={18} />
          </button>
          <button type="button" onClick={onOpenProjects} aria-label="Projects">
            <FolderOpen size={18} />
          </button>
          <button type="button" onClick={onOpenSettings} aria-label="Open settings">
            <Settings2 size={18} />
          </button>
        </div>
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
        <strong>{project.name}</strong>
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
              <span className={`status-dot ${agent.status}`} />
              <span>{agent.title}</span>
              <RuntimeBadge runtime={agent.runtime} />
            </div>
            <p>{agent.preview}</p>
            <div className="agent-cell-meta">
              <span>{agent.model}</span>
              <span>{agent.messageCount} msg</span>
              <span>{agent.diffCount} diff</span>
            </div>
          </button>
        ))}
      </div>
    </section>
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
}: {
  project: ProjectRow
  agent: AgentCell
  onDeleteSession: (agentId: string) => Promise<void>
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function removeSession() {
    if (!agent.isSession) return
    setPending(true)
    setError(null)
    try {
      await onDeleteSession(agent.id)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  const thinkingLevel = currentThinkingLevel(agent)

  return (
    <header className="sidebar-header">
      <div className="sidebar-title-row">
        <div className="runtime-icon">
          <Bot size={18} />
        </div>
        <div>
          <p data-testid="selected-project">{project.name}</p>
          <h2 data-testid="selected-agent">{agent.title}</h2>
        </div>
        <button
          type="button"
          className="session-remove"
          disabled={!agent.isSession || pending}
          onClick={removeSession}
          aria-label={`Remove ${agent.title}`}
          title={agent.isSession ? 'Remove session' : 'Only sessions can be removed'}
          data-testid="remove-session"
        >
          <Trash2 size={15} />
        </button>
      </div>
      {error ? <span className="sidebar-error" role="status">{error}</span> : null}
      <div className="sidebar-stats">
        <span className={`status-pill ${agent.status}`}>
          <Circle size={10} fill="currentColor" />
          {agent.status}
        </span>
        <span>{agent.runtime}</span>
        <span>{agent.slot}</span>
        <span className="thinking-level-pill" data-testid="thinking-level">
          Thinking {formatThinkingLevel(thinkingLevel ?? 'off')}
        </span>
      </div>
    </header>
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
      <span className="context-chip-ring" aria-hidden="true" />
      <strong>{usedPercent}</strong>
    </button>
  )
}

function ChatPanel({
  agent,
  draft,
  focusRequest,
  onDraftChange,
  onSend,
  onSteer,
  onInterrupt,
  onThinkingCommand,
  onResetSession,
  onForkSession,
}: {
  agent: AgentCell
  draft: string
  focusRequest: number
  onDraftChange: (draft: string) => void
  onSend: (agentId: string, text: string, images?: SendMessageImage[]) => Promise<void>
  onSteer: (agentId: string, text: string, images?: SendMessageImage[]) => Promise<void>
  onInterrupt: (agentId: string) => Promise<void>
  onThinkingCommand: (agentId: string, level?: ThinkingLevel) => Promise<void>
  onResetSession: (agentId: string) => Promise<void>
  onForkSession: (agentId: string) => Promise<void>
}) {
  const [pending, setPending] = React.useState(false)
  const [pendingPrompt, setPendingPrompt] = React.useState<string | null>(null)
  const [localRunning, setLocalRunning] = React.useState(false)
  const [images, setImages] = React.useState<SendMessageImage[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const isBackendRunning = agent.status === 'running'
  const isRunning = isBackendRunning || localRunning
  const hasDraftContent = draft.trim().length > 0 || images.length > 0
  const canInterrupt = isBackendRunning && !hasDraftContent
  const canSteer = isBackendRunning && hasDraftContent
  const canSend = !isRunning && hasDraftContent
  const canSubmit = !pending && (canSend || canSteer || canInterrupt)
  const pendingMessage = React.useMemo<BoardMessage | null>(
    () => {
      if (pendingPrompt === null) return null
      const persisted = agent.messages.some(
        (message) => message.role === 'user' && message.text === pendingPrompt,
      )
      if (persisted) return null
      return {
        id: `pending-${agent.id}`,
        role: 'user',
        text: pendingPrompt,
        timestamp: new Date().toISOString(),
      }
    },
    [agent.id, agent.messages, pendingPrompt],
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
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const latestRowId = rows.at(-1)?.id ?? ''

  React.useEffect(() => {
    if (focusRequest === 0) return
    textareaRef.current?.focus()
  }, [focusRequest])

  React.useEffect(() => {
    if (agent.status !== 'running') setLocalRunning(false)
  }, [agent.id, agent.status])

  React.useLayoutEffect(() => {
    const list = messageListRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [agent.id, agent.status, latestRowId, rows.length])

  async function addImageFiles(files: File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (!imageFiles.length) return
    try {
      const remaining = Math.max(4 - images.length, 0)
      const nextImages = await Promise.all(imageFiles.slice(0, remaining).map(readImageFile))
      if (imageFiles.length > remaining) {
        setError('Attach up to 4 images per message')
      }
      setImages((current) => [...current, ...nextImages].slice(0, 4))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    if (canInterrupt) {
      setPending(true)
      setError(null)
      try {
        await onInterrupt(agent.id)
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setPending(false)
      }
      return
    }

    const prompt = draft.trim() || 'Please inspect the attached image files.'
    let slashCommand: SlashCommand | null
    try {
      slashCommand = parseSlashCommand(prompt)
    } catch (cause) {
      setError(errorMessage(cause))
      return
    }
    if (slashCommand) {
      if (images.length > 0) {
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
        onDraftChange('')
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setPending(false)
      }
      return
    }

    const promptImages = images
    setPendingPrompt(pendingPromptText(prompt, promptImages))
    setError(null)
    onDraftChange('')
    setImages([])

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
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPendingPrompt(null)
      setPending(false)
    }
  }

  return (
    <div className="chat-panel" data-testid="chat-panel">
      <MessageTimeline rows={rows} listRef={messageListRef} />
      {error ? <span className="chat-error" role="status">{error}</span> : null}
      <form className="composer" onSubmit={submit}>
        <div className="composer-fields">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
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
        <button
          type="button"
          className="composer-attach"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach images"
          title="Attach images"
        >
          <ImagePlus size={15} />
        </button>
        <ContextUsageChip usage={agent.contextUsage} />
        <button
          type="submit"
          className={`composer-submit${canInterrupt ? ' interrupt' : ''}${canSteer ? ' steer' : ''}`}
          disabled={!canSubmit}
          aria-label={canInterrupt ? 'Stop generation' : canSteer ? 'Steer agent' : 'Send prompt'}
          title={canInterrupt ? 'Stop generation' : canSteer ? 'Steer this turn' : localRunning ? 'Starting turn' : 'Send prompt'}
        >
          {canInterrupt ? <Square size={13} fill="currentColor" /> : <Send size={15} />}
        </button>
      </form>
    </div>
  )
}

function MessageTimeline({
  rows,
  listRef,
}: {
  rows: AgentTimelineRow[]
  listRef: React.RefObject<HTMLDivElement | null>
}) {
  if (rows.length === 0) {
    return (
      <div className="message-list" ref={listRef}>
        <div className="empty-panel">No messages yet.</div>
      </div>
    )
  }

  return (
    <div className="message-list" ref={listRef}>
      {rows.map((row) => {
        if (row.kind === 'work') return <WorkTimelineRow key={row.id} row={row} />
        if (row.kind === 'working') {
          return <WorkingTimelineRow key={row.id} row={row} />
        }
        return <MessageTimelineRow key={row.id} message={row.message} />
      })}
    </div>
  )
}

function MessageTimelineRow({ message }: { message: BoardMessage }) {
  if (message.role === 'user') {
    return (
      <article className="timeline-row user-row" data-message-role={message.role}>
        <div className="user-bubble">
          <RichMessageBody text={message.text} />
          <MessageMeta message={message} align="right" />
        </div>
      </article>
    )
  }

  if (message.role === 'assistant') {
    return (
      <article className="timeline-row assistant-row" data-message-role={message.role}>
        <RichMessageBody text={message.text} />
        <div className="assistant-meta-row">
          <MessageMeta message={message} />
          <CopyTextButton text={message.text} label="Copy response" />
        </div>
      </article>
    )
  }

  return (
    <article
      className={`timeline-row note-row ${message.role}`}
      data-message-role={message.role}
    >
      <div className="note-meta">
        <span>{message.role}</span>
        <time>{formatTime(message.timestamp)}</time>
      </div>
      <RichMessageBody text={message.text} />
    </article>
  )
}

function WorkTimelineRow({
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
}

function WorkEntryRow({ entry }: { entry: TimelineWorkEntry }) {
  const [expanded, setExpanded] = React.useState(false)
  const preview = workEntryPreview(entry)
  const displayText = preview ? `${entry.label} - ${preview}` : entry.label
  const fullText = preview ?? displayText
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
            <span>
              <strong>{entry.label}</strong>
              {preview ? <> - {preview}</> : null}
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
}

function workEntryPreview(entry: TimelineWorkEntry) {
  return entry.detail?.trim() || null
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
    if (agent.runtime !== 'pi' && agent.runtime !== 'codex') {
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
  return (
    <div className="timeline-row working-row">
      <span className="working-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{row.startedAt ? `Working since ${formatTime(row.startedAt)}` : 'Working'}</span>
    </div>
  )
}

function MessageMeta({
  message,
  align = 'left',
}: {
  message: BoardMessage
  align?: 'left' | 'right'
}) {
  return (
    <div className={`message-meta ${align}`}>
      <span>{message.role}</span>
      <time>{formatTime(message.timestamp)}</time>
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
