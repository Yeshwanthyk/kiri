'use client'

import { PatchDiff } from '@pierre/diffs/react'
import type { GitStatus } from '@pierre/trees'
import {
  FileTree as PierreFileTree,
  useFileTree,
} from '@pierre/trees/react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightCode, highlightCodeSync } from '../lib/code-highlighter'
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
  NotebookPen,
  Plus,
  PencilLine,
  FileText,
  Rows3,
  Search,
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
  ArchivedSessionSummary,
  BoardMessage,
  DiffArtifact,
  PendingQuestion,
  ProjectRow,
  ReviewTarget,
  RuntimeKind,
  ScratchpadBlock,
  SendMessageImage,
  ThinkingLevel,
  WorkspaceSnapshot,
} from '~/lib/contracts'
import { getAetherHostBridge, pickProjectDirectory } from '~/lib/host-capabilities'
import { thinkingLevelSchema } from '~/lib/contracts'
import {
  applyAetherTheme,
  defaultThemeSelection,
  getAetherThemeTokens,
  aetherThemeNames,
  type AetherThemeName,
  type ThemeMode,
  type ThemeSelection,
} from '~/theme/aether-themes'
import {
  addProjectMutation,
  addScratchpadBlockMutation,
  answerQuestionMutation,
  chooseProjectDirectoryMutation,
  deleteProjectMutation,
  deleteScratchpadBlockMutation,
  deleteSessionMutation,
  agentDetailQueryOptions,
  fetchWorkspaceSnapshot,
  forkSessionMutation,
  hideProjectMutation,
  interruptMessageMutation,
  renameSessionMutation,
  resetSessionMutation,
  restoreSessionMutation,
  reviewSessionMutation,
  sendMessageMutation,
  setThinkingLevelMutation,
  startSessionMutation,
  steerMessageMutation,
  terminalConfigQuery,
  triggerScratchpadBlockMutation,
  unhideProjectMutation,
} from '~/server/workspace'
import {
  classifyToolName,
  deriveAgentTimelineRows,
  diffLineStats,
  displayPath,
  isAssistantStatusEntry,
  isCommandEntry,
  normalizeDiffPath,
  timelineRowsContentVersion,
  type AgentTimelineRow,
  type TimelineWorkEntry,
  workCallLabel,
} from './aether-board/timeline'
import {
  errorMessage,
  formatAgo,
  formatElapsed,
  formatKeyShort,
  formatThinkingLevel,
  formatTime,
  formatTokenCount,
  projectNameFromPath,
  projectSummary,
} from './aether-board/format'
import { imageKey, pendingPromptText, readImageFile } from './aether-board/images'
import { ScratchpadHeader, ScratchpadPanel } from './aether-board/scratchpad'
import { TaskProgressStrip } from './aether-board/task-progress'
import {
  actionForKey,
  defaultKeymap,
  formatKey,
  keymapGroups,
  keyOptions,
  moveAgent,
  moveProject,
  updateKeymap,
  type KeymapAction,
  type KeymapSettings,
  type Selection,
} from './aether-board/navigation'
import {
  applyChatTypography,
  chatFontSizes,
  defaultChatTypography,
  monoFonts,
  readStoredChatDraft,
  readStoredChatTypography,
  readStoredKeymap,
  readStoredThemeSelection,
  saveChatTypography,
  saveKeymap,
  saveThemeSelection,
  updateChatDraft,
  type ChatFontSize,
  type ChatTypographySettings,
  type MonoFont,
} from './aether-board/storage'
import {
  parseSlashCommand,
  runSlashCommand,
  supportsThinking,
  type SlashCommand,
} from './aether-board/slash-commands'

type SidebarTab = 'chat' | 'diffs' | 'terminal' | 'scratchpad'
type DiffStyle = 'unified' | 'split'

type RefreshAgentDetail = () => Promise<void>

export function mergeAgentDetail(
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
    tasks: detail.tasks,
    contextUsage: detail.contextUsage,
    pendingQuestion: detail.pendingQuestion,
  }
}

type GhosttyTerminalInstance = InstanceType<(typeof import('ghostty-web'))['Terminal']>
type GhosttyFitAddonInstance = InstanceType<(typeof import('ghostty-web'))['FitAddon']>
type TerminalDisposable = { dispose: () => void }

type CommandPaletteAction = {
  id: string
  title: string
  detail: string
  icon: LucideIcon
  disabled: boolean
  run: () => void
}

const sessionThinkingLevels = ['off', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly ThinkingLevel[]

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
  const [pendingProjectDelete, setPendingProjectDelete] = React.useState<ProjectRow | null>(null)
  const [projectDeleteInFlight, setProjectDeleteInFlight] = React.useState(false)
  const [keymap, setKeymap] = React.useState<KeymapSettings>(defaultKeymap)
  const [themeSelection, setThemeSelection] = React.useState<ThemeSelection>(defaultThemeSelection)
  const [chatTypography, setChatTypography] = React.useState<ChatTypographySettings>(defaultChatTypography)
  const [chatFocusRequest, setChatFocusRequest] = React.useState(0)
  const addProject = useServerFn(addProjectMutation)
  const addScratchpadBlock = useServerFn(addScratchpadBlockMutation)
  const answerQuestion = useServerFn(answerQuestionMutation)
  const chooseProjectDirectory = useServerFn(chooseProjectDirectoryMutation)
  const deleteProject = useServerFn(deleteProjectMutation)
  const deleteScratchpadBlock = useServerFn(deleteScratchpadBlockMutation)
  const deleteSession = useServerFn(deleteSessionMutation)
  const forkSession = useServerFn(forkSessionMutation)
  const hideProject = useServerFn(hideProjectMutation)
  const refreshWorkspace = useServerFn(fetchWorkspaceSnapshot)
  const resetSession = useServerFn(resetSessionMutation)
  const restoreSession = useServerFn(restoreSessionMutation)
  const reviewSession = useServerFn(reviewSessionMutation)
  const sendMessage = useServerFn(sendMessageMutation)
  const setThinkingLevel = useServerFn(setThinkingLevelMutation)
  const steerMessage = useServerFn(steerMessageMutation)
  const interruptMessage = useServerFn(interruptMessageMutation)
  const renameSession = useServerFn(renameSessionMutation)
  const startSession = useServerFn(startSessionMutation)
  const triggerScratchpadBlock = useServerFn(triggerScratchpadBlockMutation)
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

      if (action === 'openScratchpad') {
        setTab('scratchpad')
        return
      }

      if (action === 'startSession') {
        if (!selectedProject) {
          setSettingsOpen(false)
          setAgentSwitcherOpen(false)
          setCommandPaletteOpen(false)
          setProjectManagerOpen(true)
          return
        }
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
  }, [
    agentSwitcherOpen,
    commandPaletteOpen,
    projectManagerOpen,
    keymap,
    selectedProject,
    selection.agentId,
    selection.projectId,
    workspace.projects,
  ])

  async function handleAddProject(input: { id?: string; name: string; cwd: string }) {
    const next = await addProject({ data: input })
    setWorkspace(next)
    const project = next.projects.find((item) => item.cwd === input.cwd) ?? next.projects.at(-1)
    if (project) setSelection({ projectId: project.id, agentId: project.agents[0]?.id ?? '' })
  }

  async function handleDeleteProject(projectId: string) {
    const next = await deleteProject({ data: { id: projectId } })
    setWorkspace(next)
    if (selection.projectId === projectId) setSelection(next.selected)
  }

  async function confirmDeleteProject(projectId: string) {
    setProjectDeleteInFlight(true)
    try {
      await handleDeleteProject(projectId)
      setPendingProjectDelete(null)
    } finally {
      setProjectDeleteInFlight(false)
    }
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
    return pickProjectDirectory(() => chooseProjectDirectory())
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

  async function handleReviewSession(agentId: string, target: ReviewTarget) {
    const next = await reviewSession({ data: { agentId, target } })
    setWorkspace(next)
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

  async function handleCaptureBlock(body: string, projectId: string | null) {
    const next = await addScratchpadBlock({ data: { body, projectId } })
    setWorkspace(next)
  }

  async function handleDeleteBlock(id: string) {
    const next = await deleteScratchpadBlock({ data: { id } })
    setWorkspace(next)
  }

  async function handleTriggerBlock(
    block: ScratchpadBlock,
    overrides?: { projectId?: string; runtime?: RuntimeKind; model?: string; thinkingLevel?: ThinkingLevel; title?: string },
  ) {
    const projectId = overrides?.projectId ?? block.projectId ?? selectedProject?.id
    if (!projectId) throw new Error('Pick a project before triggering a block')
    const result = await triggerScratchpadBlock({
      data: {
        id: block.id,
        projectId,
        runtime: overrides?.runtime,
        model: overrides?.model,
        title: overrides?.title,
        thinkingLevel: overrides?.thinkingLevel ?? 'medium',
      },
    })
    setWorkspace(result.snapshot)
    setSelection({ projectId, agentId: result.agentId })
    setChatFocusRequest(0)
    setTab('chat')
  }

  async function handleResumeSession(projectId: string, agentId: string, archived: boolean) {
    if (!archived) {
      selectAgent(projectId, agentId)
      setSessionLauncherOpen(false)
      return
    }
    const next = await restoreSession({ data: { agentId } })
    setWorkspace(next)
    setChatFocusRequest(0)
    setSelection({ projectId, agentId })
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
        disabled: !selectedProject,
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
        id: 'scratchpad',
        title: 'Open scratchpad',
        detail:
          workspace.scratchpadBlocks.length > 0
            ? `${workspace.scratchpadBlocks.length} block${workspace.scratchpadBlocks.length === 1 ? '' : 's'}`
            : 'No blocks yet',
        icon: NotebookPen,
        disabled: false,
        run: () => {
          setCommandPaletteOpen(false)
          setTab('scratchpad')
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
        disabled: !selectedProject || workspace.projects.length <= 1,
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
        disabled: !selectedProject || workspace.projects.length <= 1,
        run: () => {
          setCommandPaletteOpen(false)
          setPendingProjectDelete(project)
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
    [selectedAgent, selectedProject, workspace.hiddenProjects, workspace.projects, workspace.scratchpadBlocks],
  )

  React.useEffect(() => {
    const unsubscribe = getAetherHostBridge()?.onMenuAction?.((actionId) => {
      const action = commandActions.find((item) => item.id === actionId)
      if (!action || action.disabled) return
      action.run()
    })
    return unsubscribe
  }, [commandActions])

  if (settingsOpen) {
    return (
      <SettingsScreen
        keymap={keymap}
        themeSelection={themeSelection}
        chatTypography={chatTypography}
        onKeymapChange={(action, value) =>
          setKeymap((current) => saveKeymap(updateKeymap(current, action, value)))
        }
        onKeymapReset={() => setKeymap(saveKeymap(defaultKeymap))}
        onThemeChange={(next) => setThemeSelection(saveThemeSelection(next))}
        onChatTypographyChange={(next) => setChatTypography(saveChatTypography(next))}
        onClose={() => setSettingsOpen(false)}
      />
    )
  }

  if (!selectedProject) {
    return (
      <main
        className="empty-project-shell"
        data-hydrated={hydrated ? 'true' : 'false'}
        data-testid="empty-project-state"
      >
        {commandPaletteOpen ? (
          <CommandPalette
            actions={commandActions}
            onClose={() => setCommandPaletteOpen(false)}
          />
        ) : null}

        {projectManagerOpen ? (
          <ProjectManagerDialog
            projects={workspace.projects}
            hiddenProjects={workspace.hiddenProjects}
            onAdd={handleAddProject}
            onChooseDirectory={handleChooseProjectDirectory}
            onDelete={handleDeleteProject}
            onHide={handleHideProject}
            onUnhide={handleUnhideProject}
            onClose={() => setProjectManagerOpen(false)}
          />
        ) : null}

        <section className="empty-project-state" aria-label="No projects configured">
          <div className="empty-project-mark" aria-hidden="true">
            <FolderOpen size={22} />
          </div>
          <div>
            <p className="empty-project-kicker">Aether</p>
            <h1>No projects yet</h1>
            <p>Add a local repo to start sessions on this machine.</p>
          </div>
          <div className="empty-project-actions">
            <button
              type="button"
              className="project-add-button"
              onClick={() => setProjectManagerOpen(true)}
              data-testid="empty-add-project"
            >
              <Plus size={14} />
              Add project
            </button>
            <button
              type="button"
              className="empty-project-secondary"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={14} />
              Settings
            </button>
          </div>
        </section>
      </main>
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
          projects={workspace.projects}
          archivedSessions={workspace.archivedSessions}
          selectedAgentId={selection.agentId}
          settings={workspace.settings}
          onStartSession={handleStartSession}
          onResumeSession={handleResumeSession}
          onCancel={() => setSessionLauncherOpen(false)}
        />
      ) : null}

      {projectManagerOpen ? (
        <ProjectManagerDialog
          projects={workspace.projects}
          hiddenProjects={workspace.hiddenProjects}
          onAdd={handleAddProject}
          onChooseDirectory={handleChooseProjectDirectory}
          onDelete={handleDeleteProject}
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
              <strong>{pendingDelete.title}</strong> will be hidden from the board. You can restore it from Resume.
            </>
          }
          confirmLabel="Remove session"
          cancelLabel="Keep"
          busy={deleteInFlight}
          onConfirm={() => void confirmDeleteSession()}
          onCancel={() => {
            if (deleteInFlight) return
            setPendingDelete(null)
          }}
        />
      ) : null}

      {pendingProjectDelete ? (
        <ConfirmDialog
          title="Remove project?"
          body={
            <>
              <strong>{pendingProjectDelete.name}</strong> will be removed from Aether. The project directory and files stay on disk.
            </>
          }
          confirmLabel="Remove project"
          cancelLabel="Keep"
          destructive
          busy={projectDeleteInFlight}
          onConfirm={() => void confirmDeleteProject(pendingProjectDelete.id)}
          onCancel={() => {
            if (projectDeleteInFlight) return
            setPendingProjectDelete(null)
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
              startSessionKey={keymap.startSession}
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
        onReviewSession={handleReviewSession}
        onAnswerQuestion={handleAnswerQuestion}
        scratchpadBlocks={workspace.scratchpadBlocks}
        projects={workspace.projects}
        onCaptureBlock={handleCaptureBlock}
        onDeleteBlock={handleDeleteBlock}
        onTriggerBlock={handleTriggerBlock}
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
  projects,
  archivedSessions,
  selectedAgentId,
  settings,
  onStartSession,
  onResumeSession,
  onCancel,
}: {
  project: ProjectRow
  projects: ProjectRow[]
  archivedSessions: ArchivedSessionSummary[]
  selectedAgentId: string
  settings: WorkspaceSnapshot['settings']
  onStartSession: (input: {
    projectId: string
    runtime: RuntimeKind
    model?: string
    title?: string
    thinkingLevel: ThinkingLevel
  }) => Promise<void>
  onResumeSession: (projectId: string, agentId: string, archived: boolean) => void | Promise<void>
  onCancel: () => void
}) {
  const [mode, setMode] = React.useState<'new' | 'resume'>('new')
  const [runtime, setRuntime] = React.useState<RuntimeKind>('pi')
  const [model, setModel] = React.useState(settings.runtimes.pi.defaultModel)
  const [title, setTitle] = React.useState('')
  const [thinkingLevel, setThinkingLevel] = React.useState<ThinkingLevel>('medium')
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const titleRef = React.useRef<HTMLInputElement>(null)
  const runtimes = Object.keys(settings.runtimes) as RuntimeKind[]
  const models = settings.runtimes[runtime].models
  const activeResumableSessions = projects.flatMap((item) =>
    item.agents.flatMap((agent) =>
      agent.isSession
        ? [{
          archived: false as const,
          id: agent.id,
          projectId: item.id,
          projectName: item.name,
          title: agent.title,
          runtime: agent.runtime,
          model: agent.model,
          status: agent.status,
          preview: agent.preview,
          updatedAt: agent.updatedAt,
        }]
        : [],
    ),
  )
  const archivedResumableSessions = archivedSessions.map((agent) => ({
    archived: true as const,
    id: agent.id,
    projectId: agent.projectId,
    projectName: agent.projectName,
    title: agent.title,
    runtime: agent.runtime,
    model: agent.model,
    status: agent.status,
    preview: agent.preview,
    updatedAt: agent.updatedAt,
  }))
  const resumableSessions = [...activeResumableSessions, ...archivedResumableSessions]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 10)

  React.useEffect(() => {
    if (mode === 'new') titleRef.current?.focus()
  }, [mode])

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
      <button
        type="button"
        className="session-dialog-scrim"
        onClick={onCancel}
        aria-label="Close session launcher"
      />
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
            <p className="settings-kicker">Session launcher</p>
            <strong id="session-dialog-title">{project.name}</strong>
            <small>{mode === 'new' ? 'Pick a runtime, then launch into chat.' : 'Jump back into a local session.'}</small>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close session launcher">
            ×
          </button>
        </div>

        <div className="session-launcher-tabs" role="tablist" aria-label="Session launcher mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'new'}
            data-active={mode === 'new' ? 'true' : undefined}
            onClick={() => setMode('new')}
          >
            New
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'resume'}
            data-active={mode === 'resume' ? 'true' : undefined}
            onClick={() => setMode('resume')}
          >
            Resume
          </button>
        </div>

        {mode === 'new' ? (
          <>
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
              <label className="session-runtime-field">
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
              <label className="session-thinking-field">
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
              <label className="session-model-field">
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
            </div>

            <div className="session-dialog-actions">
              {error ? <span role="status">{error}</span> : null}
              <button type="submit" disabled={pending}>
                <Plus size={14} />
                Start session
              </button>
            </div>
          </>
        ) : (
          <div className="session-resume-panel" role="tabpanel">
            {resumableSessions.length === 0 ? (
              <div className="session-resume-empty">
                <strong>No local sessions</strong>
                <span>Start one first, then it will appear here.</span>
              </div>
            ) : (
              <>
                <div className="session-resume-kicker">Last {resumableSessions.length} local sessions</div>
                <div className="session-resume-list">
                  {resumableSessions.map((agent) => {
                    const selected = agent.id === selectedAgentId
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        className="session-resume-row"
                        data-active={selected ? 'true' : undefined}
                        onClick={() => onResumeSession(agent.projectId, agent.id, agent.archived)}
                      >
                        <span className={`status-dot ${agent.status}`} aria-hidden="true" />
                        <span className="session-resume-main">
                          <strong>{agent.title}</strong>
                          <span>{agent.projectName}: {agent.preview || 'Ready.'}</span>
                        </span>
                        <span className="session-resume-meta">
                          {agent.archived ? <span>archived</span> : null}
                          <span>{agent.runtime}</span>
                          <span>{agent.model}</span>
                          <span>{formatAgo(agent.updatedAt)}</span>
                        </span>
                        {selected ? <Check size={14} aria-hidden="true" /> : null}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )}
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
      <button
        type="button"
        className="session-dialog-scrim"
        onClick={onCancel}
        aria-label="Cancel confirmation"
      />
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
  onDelete,
  onHide,
  onUnhide,
  onClose,
}: {
  projects: ProjectRow[]
  hiddenProjects: ProjectRow[]
  onAdd: (input: { id?: string; name: string; cwd: string }) => Promise<void>
  onChooseDirectory: () => Promise<string>
  onDelete: (projectId: string) => Promise<void>
  onHide: (projectId: string) => Promise<void>
  onUnhide: (projectId: string) => Promise<void>
  onClose: () => void
}) {
  const [id, setId] = React.useState('')
  const [name, setName] = React.useState('')
  const [cwd, setCwd] = React.useState('')
  const [showHidden, setShowHidden] = React.useState(hiddenProjects.length > 0)
  const [pending, setPending] = React.useState(false)
  const [pendingRemoveProject, setPendingRemoveProject] = React.useState<ProjectRow | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const canDeleteVisibleProject = projects.length > 1
  const canDeleteHiddenProject = projects.length + hiddenProjects.length > 1

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
    <div className="project-manager-overlay" role="dialog" aria-modal="true">
      <section className="project-settings project-manager" aria-label="Project manager">
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
              <div className="project-row-actions">
                <button
                  type="button"
                  disabled={pending || projects.length <= 1}
                  onClick={() => hide(project.id)}
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
              <div className="project-row-actions">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => unhide(project.id)}
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
        </div> : null}
      </section>
    </div>
    {pendingRemoveProject ? (
      <ConfirmDialog
        title="Remove project?"
        body={
          <>
            <strong>{pendingRemoveProject.name}</strong> will be removed from Aether. The project directory and files stay on disk.
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
          <p className="settings-kicker">Typography</p>
          <h2>Reading size &amp; code font</h2>
          <p>Affects chat messages, the composer, and diff rendering.</p>
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

      <div className="settings-subsection">
        <p className="settings-subsection-label">Chat reading size</p>
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
                onClick={() => onChange({ ...settings, fontSize: size })}
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
      </div>

      <div className="settings-subsection">
        <p className="settings-subsection-label">Code &amp; diff font</p>
        <div className="mono-font-options" role="radiogroup" aria-label="Code font">
          {(Object.keys(monoFonts) as MonoFont[]).map((key) => {
            const option = monoFonts[key]
            const active = settings.monoFont === key
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={active}
                data-active={active}
                data-testid={`mono-font-${key}`}
                className="mono-font-option"
                onClick={() => onChange({ ...settings, monoFont: key })}
                style={{ '--mono-preview-stack': option.stack } as React.CSSProperties}
              >
                <span className="mono-font-option-text">
                  <strong>{option.label}</strong>
                  <small>0Oo il1 =&gt; !=</small>
                </span>
                {active ? (
                  <span className="mono-font-check" aria-hidden="true">
                    <Check size={10} strokeWidth={3} />
                  </span>
                ) : (
                  <span className="mono-font-sample" aria-hidden="true">Aa 1·0</span>
                )}
              </button>
            )
          })}
        </div>
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
    const enabledIndexes = visibleActions.flatMap((action, index) =>
      action.disabled ? [] : [index],
    )
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
        <button
          type="button"
          className="mobile-project-trigger"
          onClick={onOpenAgentSwitcher}
          aria-label="Open all sessions"
        >
          <span>Aether</span>
          <strong>{project.name}</strong>
          <ChevronDown size={13} aria-hidden="true" />
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
        <button
          type="button"
          className={tab === 'scratchpad' ? 'active' : ''}
          onClick={() => onTabChange('scratchpad')}
          role="tab"
          aria-selected={tab === 'scratchpad'}
        >
          <NotebookPen size={15} />
          Scratch
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
      <button
        type="button"
        className="agent-switcher-scrim"
        onClick={onClose}
        aria-label="Close agent switcher"
      />
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
  startSessionKey,
}: {
  project: ProjectRow
  selectedProjectId: string
  selectedAgentId: string
  onSelect: (agentId: string) => void
  startSessionKey: string
}) {
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
  const remainingAhead =
    isProjectSelected && selectedIndex >= 0
      ? project.agents.length - 1 - selectedIndex
      : 0
  const chipVisible = isProjectSelected && remainingAhead > 1

  return (
    <section
      className={`project-lane ${isEmpty ? 'empty' : ''} ${isProjectSelected ? 'selected' : ''}`}
      aria-label={project.name}
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
      </div>

      {isEmpty ? (
        <div className="agent-row" data-empty="true">
          <span className="empty-session-card" data-testid="empty-project-sessions">
            no sessions <kbd>{formatKeyShort(startSessionKey)}</kbd> to launch
          </span>
        </div>
      ) : (
        <div className="lane-rail-wrap" ref={wrapRef}>
          <span
            className={`lane-rail-chip ${chipVisible ? 'visible' : ''}`}
            aria-hidden="true"
          >
            {remainingAhead} more <span className="arrow">→</span>
          </span>
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
                onClick={() => onSelect(agent.id)}
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
                  {agent.diffCount > 0 ? (
                    <span className="diff-token">+{agent.diffCount}</span>
                  ) : null}
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
              {project.agents.map((agent, i) => (
                <span
                  key={agent.id}
                  className={`lane-pip ${
                    isProjectSelected && i === selectedIndex ? 'active' : ''
                  }`}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}
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
  onReviewSession,
  onAnswerQuestion,
  scratchpadBlocks,
  projects,
  onCaptureBlock,
  onDeleteBlock,
  onTriggerBlock,
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
  onReviewSession: (agentId: string, target: ReviewTarget) => Promise<void>
  onAnswerQuestion: (
    agentId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ) => Promise<void>
  scratchpadBlocks: ScratchpadBlock[]
  projects: ProjectRow[]
  onCaptureBlock: (body: string, projectId: string | null) => Promise<void>
  onDeleteBlock: (id: string) => Promise<void>
  onTriggerBlock: (block: ScratchpadBlock) => Promise<void>
}) {
  const revision = selectedAgent
    ? `${selectedAgent.updatedAt}:${selectedAgent.messageCount}:${selectedAgent.diffCount}:${selectedAgent.status}`
    : ''
  const detailQuery = useQuery({
    ...agentDetailQueryOptions(selectedAgent?.id ?? '', 500, revision),
    placeholderData: keepPreviousData,
  })
  const agent = mergeAgentDetail(selectedAgent, detailQuery.data)
  const refreshDetail = React.useCallback(async () => {
    if (!selectedAgent) return
    await detailQuery.refetch()
  }, [detailQuery, selectedAgent])

  const tabBar = (
    <div className="sidebar-tabs" role="tablist">
      <button
        type="button"
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
          selectedProjectId={selectedProject.id}
          onCapture={onCaptureBlock}
          onDelete={onDeleteBlock}
          onTrigger={onTriggerBlock}
        />
      ) : agent && tab === 'chat' ? (
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
        />
      ) : agent && tab === 'diffs' ? (
        <DiffPanel
          key={agent.id}
          agent={agent}
          themeMode={themeMode}
        />
      ) : agent && tab === 'terminal' ? (
        <TerminalPanel
          key={agent.id}
          agent={agent}
          project={selectedProject}
          themeMode={themeMode}
        />
      ) : !agent ? (
        <EmptySessionPanel
          project={selectedProject}
          onStart={onStartSession}
        />
      ) : null}
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
      <div className="empty-session-surface">
        <div className="empty-session-head">
          <div className="runtime-icon">
            <Bot size={18} />
          </div>
          <p data-testid="selected-project">{project.name}</p>
        </div>
        <h2 data-testid="selected-agent">No session</h2>
        <div className="empty-session-command">
          <span>agent slot ready</span>
          <button type="button" onClick={onStart}>
            <Plus size={14} />
            Start session
          </button>
        </div>
      </div>
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
  cwd,
  themeMode,
  focusRequest,
  onSend,
  onSteer,
  onInterrupt,
  onThinkingCommand,
  onResetSession,
  onForkSession,
  onReviewSession,
  onAnswerQuestion,
  onDetailRefresh,
}: {
  agent: AgentCell
  cwd: string
  themeMode: ThemeMode
  focusRequest: number
  onSend: (agentId: string, text: string, images?: SendMessageImage[]) => Promise<void>
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
    () => deriveAgentTimelineRows(timelineAgent, cwd),
    [cwd, timelineAgent],
  )
  const messageListRef = React.useRef<HTMLDivElement | null>(null)
  const timelineContentVersion = React.useMemo(() => timelineRowsContentVersion(rows), [rows])
  const [hasNewContent, setHasNewContent] = React.useState(false)
  const [selectedMessageId, setSelectedMessageId] = React.useState<string | null>(null)
  const [composerEmpty, setComposerEmpty] = React.useState(true)
  const didInitialScrollRef = React.useRef(false)
  const wasAtBottomRef = React.useRef(true)

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

    if (!didInitialScrollRef.current) {
      if (rows.length === 0) return
      list.scrollTop = list.scrollHeight
      didInitialScrollRef.current = true
      wasAtBottomRef.current = true
      setHasNewContent(false)
      return
    }

    if (selectedMessageId !== null) {
      const distance = bottomDistance(list)
      wasAtBottomRef.current = distance <= 24
      if (!wasAtBottomRef.current) setHasNewContent(true)
      return
    }

    if (wasAtBottomRef.current) {
      list.scrollTop = list.scrollHeight
      wasAtBottomRef.current = true
      setHasNewContent(false)
      return
    }

    const distance = bottomDistance(list)
    wasAtBottomRef.current = distance <= 24
    setHasNewContent(distance > 24)
  }, [rows.length, selectedMessageId, timelineContentVersion])

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
      const distance = bottomDistance(list)
      wasAtBottomRef.current = distance <= 24
      if (wasAtBottomRef.current) setHasNewContent(false)
    }
    onScroll()
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
          onReviewSession,
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
        <TaskProgressStrip tasks={agent.tasks} />
        <MessageTimeline
          rows={rows}
          themeMode={themeMode}
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
              <span key={imageKey(image)} className="composer-attachment">
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
  themeMode,
  listRef,
  selectedMessageId,
}: {
  rows: AgentTimelineRow[]
  themeMode: ThemeMode
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
        if (row.kind === 'work') {
          return (
            <WorkTimelineRow
              key={row.id}
              row={row}
              themeMode={themeMode}
            />
          )
        }
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
  themeMode,
}: {
  row: Extract<AgentTimelineRow, { kind: 'work' }>
  themeMode: ThemeMode
}) {
  const [hidden, setHidden] = React.useState(true)
  const entries = row.entries
  const counts = React.useMemo(() => activityCounts(entries), [entries])
  const tickEntries = entries.slice(0, 24)

  const summary = [
    counts.updates ? `${counts.updates} updates` : null,
    counts.edits ? `${counts.edits} edits` : null,
    counts.commands ? `${counts.commands} commands` : null,
    counts.other ? `${counts.other} other` : null,
  ].filter(Boolean).join(', ')

  return (
    <section className="timeline-row work-row" aria-label="Runtime activity">
      <div className="work-row-header">
        <div className="work-row-heading">
          <span className="work-row-ticks" aria-hidden="true">
            {tickEntries.map((entry) => (
              <span key={entry.id} className={`work-row-tick tone-${workEntryTickTone(entry)}`} />
            ))}
          </span>
          <span className="work-row-summary">Activity log</span>
          <span className="work-row-badge">{entries.length}</span>
          {summary ? <span className="work-row-breakdown">{summary}</span> : null}
        </div>
        <button
          type="button"
          className="work-row-hide"
          onClick={() => setHidden((value) => !value)}
          aria-expanded={!hidden}
        >
          {hidden ? 'Show' : 'Hide'}
        </button>
      </div>
      {!hidden && entries.length > 0 ? (
        <div className="work-entry-list">
          {entries.map((entry) => (
            <WorkEntryRow
              key={entry.id}
              entry={entry}
              themeMode={themeMode}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
})

const WorkEntryRow = React.memo(function WorkEntryRow({
  entry,
  themeMode,
}: {
  entry: TimelineWorkEntry
  themeMode: ThemeMode
}) {
  const preview = formatWorkPreview(entry)
  const previewText = preview?.text ?? null
  const stats = entry.diff ? diffLineStats(entry.diff.patch) : null
  const displayText = previewText ? `${entry.label} - ${previewText}` : entry.label
  const fullText = entry.detail?.trim() || displayText
  const visibleText = truncateWorkEntryDetail(fullText)
  const icon = workEntryIcon(entry)
  const command = isCommandEntry(entry)
  const status = isAssistantStatusEntry(entry)

  return (
    <div className={`work-entry ${entry.tone} ${entry.diff ? 'has-diff' : ''} ${command ? 'is-command' : ''} ${status ? 'is-status' : ''} ${icon ? '' : 'no-icon'}`}>
      {icon}
      <div className="work-entry-content">
        <div className="work-entry-heading">
          <span className="work-entry-label">
            {command ? <span className="work-call-pill">{workCallLabel(entry)}</span> : <strong>{entry.label}</strong>}
            {previewText && entry.path && preview ? <span className="work-entry-path">{preview.node}</span> : null}
          </span>
          <span className="work-entry-meta">
            {stats ? (
              <span className="work-diff-stats">
                <span className="add">+{stats.added}</span>
                <span className="del">-{stats.deleted}</span>
              </span>
            ) : null}
            <time>{formatTime(entry.timestamp)}</time>
          </span>
        </div>
        {visibleText ? (
          <pre className="work-entry-detail"><code>{visibleText}</code></pre>
        ) : null}
        {entry.diff ? (
          <InlineDiffPreview
            diff={entry.diff}
            themeMode={themeMode}
          />
        ) : null}
      </div>
    </div>
  )
})

const WORK_ENTRY_DETAIL_MAX_CHARS = 12_000
const WORK_ENTRY_DETAIL_MAX_LINES = 240

function truncateWorkEntryDetail(text: string) {
  if (text.length <= WORK_ENTRY_DETAIL_MAX_CHARS && countLines(text) <= WORK_ENTRY_DETAIL_MAX_LINES) {
    return text
  }

  const lines = text.split('\n')
  const lineLimited = lines.length > WORK_ENTRY_DETAIL_MAX_LINES
    ? lines.slice(0, WORK_ENTRY_DETAIL_MAX_LINES).join('\n')
    : text
  const charLimited = lineLimited.length > WORK_ENTRY_DETAIL_MAX_CHARS
    ? lineLimited.slice(0, WORK_ENTRY_DETAIL_MAX_CHARS).trimEnd()
    : lineLimited

  return `${charLimited}\n[truncated]`
}

function countLines(text: string) {
  let lines = 1
  for (const char of text) {
    if (char === '\n') lines += 1
  }
  return lines
}

function InlineDiffPreview({
  diff,
  themeMode,
}: {
  diff: DiffArtifact
  themeMode: ThemeMode
}) {
  const stats = React.useMemo(() => diffLineStats(diff.patch), [diff.patch])
  return (
    <div className="inline-diff-card expanded">
      <div className="inline-diff-summary">
        <GitPullRequest size={13} />
        <span className="inline-diff-path">{diff.path}</span>
        <span className="inline-diff-counts">
          <span className="add">+{stats.added}</span>
          <span className="del">-{stats.deleted}</span>
        </span>
      </div>
      <div className="inline-pierre-host">
        <PatchDiff
          key={`${diff.id}:inline:${themeMode}`}
          patch={diff.patch}
          disableWorkerPool
          options={{
            diffStyle: 'unified',
            overflow: 'wrap',
            themeType: themeMode,
          }}
        />
      </div>
    </div>
  )
}

function activityCounts(entries: TimelineWorkEntry[]) {
  let updates = 0
  let edits = 0
  let commands = 0
  let other = 0
  for (const entry of entries) {
    if (entry.diff) {
      edits += 1
    } else if (isAssistantStatusEntry(entry)) {
      updates += 1
    } else if (isCommandEntry(entry)) {
      commands += 1
    } else {
      other += 1
    }
  }
  return { updates, edits, commands, other }
}

function workEntryTickTone(entry: TimelineWorkEntry) {
  if (entry.diff) return 'edit'
  if (isCommandEntry(entry)) return 'bash'
  if (isAssistantStatusEntry(entry)) return 'status'
  return 'read'
}

function workEntryIcon(entry: TimelineWorkEntry) {
  const call = workCallLabel(entry)
  if (isAssistantStatusEntry(entry)) {
    return <MessageSquareText size={13} className="work-entry-icon status" />
  }
  if (entry.diff) {
    return <PencilLine size={13} className="work-entry-icon diff" />
  }
  if (call === 'grep' || call === 'glob' || call === 'search') {
    return <Search size={13} className="work-entry-icon search" />
  }
  if (call === 'read') {
    return <FileText size={13} className="work-entry-icon file" />
  }
  if (call === 'edit' || call === 'write' || call === 'multiedit') {
    return <PencilLine size={13} className="work-entry-icon diff" />
  }
  if (isCommandEntry(entry)) return null
  return <TerminalSquare size={13} className={`work-entry-icon ${entry.tone}`} />
}

type WorkPreview = { node: React.ReactNode; text: string }

function formatWorkPreview(entry: TimelineWorkEntry): WorkPreview | null {
  if (entry.path) return renderPathPreview(entry.path)
  const detail = entry.detail?.trim()
  if (!detail || detail === '{}' || detail === '[]') return null

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

function renderPathPreview(rawPath: string): WorkPreview {
  const path = displayPath(rawPath.replace(/^["']|["']$/g, '').trim())
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

function extractCodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  if (React.isValidElement(node)) {
    return extractCodeText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

const HighlightedPre = React.memo(function HighlightedPre({
  code,
  lang,
  fallback,
}: {
  code: string
  lang: string | undefined
  fallback: React.ReactNode
}) {
  const [html, setHtml] = React.useState<string | null>(() => highlightCodeSync(code, lang))

  React.useEffect(() => {
    if (html !== null) return
    let cancelled = false
    const run = () => {
      void highlightCode(code, lang).then((next) => {
        if (!cancelled && next) setHtml(next)
      })
    }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number
      cancelIdleCallback?: (id: number) => void
    }
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(run)
      return () => {
        cancelled = true
        w.cancelIdleCallback?.(id)
      }
    }
    const timer = window.setTimeout(run, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [code, lang, html])

  if (html) {
    return <div className="shiki-block" dangerouslySetInnerHTML={{ __html: html }} />
  }
  return <pre>{fallback}</pre>
})

const markdownComponents = {
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
  pre({ children }) {
    const child = React.Children.toArray(children).find(React.isValidElement)
    if (!child) return <pre>{children}</pre>
    const childProps = child.props as { className?: string; children?: React.ReactNode }
    const match = /language-([\w-]+)/.exec(childProps.className ?? '')
    const lang = match ? match[1] : undefined
    const raw = extractCodeText(childProps.children)
    const code = raw.endsWith('\n') ? raw.slice(0, -1) : raw
    return <HighlightedPre code={code} lang={lang} fallback={children} />
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

function bottomDistance(list: HTMLElement) {
  return list.scrollHeight - list.clientHeight - list.scrollTop
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
    const terminalDisposables: TerminalDisposable[] = []

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
        socket.onopen = () => {
          if (!term || !socket) return
          setStatus('Connected')
          socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          const banner = `Aether terminal · ${project.cwd}\r\n\r\n`
          term.write(banner)
          appendTerminalTranscript(setTranscript, banner)
        }
        socket.onmessage = (event) => {
          if (typeof event.data === 'string') {
            term?.write(event.data)
            appendTerminalTranscript(setTranscript, event.data)
          }
        }
        socket.onclose = () => {
          if (!disposed) {
            setStatus('Closed')
            appendTerminalTranscript(setTranscript, '\r\n[Aether terminal socket closed]\r\n')
          }
        }
        socket.onerror = () => {
          if (!disposed) setStatus('Connection failed')
        }
        terminalDisposables.push(
          term.onData((data) => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'input', data }))
            }
          }),
          term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'resize', cols, rows }))
            }
          }),
        )
      } catch (error) {
        if (disposed) return
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }

    void connect()

    return () => {
      disposed = true
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onclose = null
        socket.onerror = null
      }
      socket?.close()
      for (const disposable of terminalDisposables) {
        disposable.dispose()
      }
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
  config: { host: string; port: number; path: string; token?: string },
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
  if (config.token) url.searchParams.set('token', config.token)
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
  const diffBodyRef = React.useRef<HTMLDivElement | null>(null)
  const diff =
    agent.diffs.find((item) => item.id === selectedDiffId) ?? agent.diffs[0]
  const selectedIndex = diff
    ? Math.max(0, agent.diffs.findIndex((item) => item.id === diff.id))
    : -1
  const diffByPath = React.useMemo(
    () => new Map(agent.diffs.map((item) => [normalizeDiffPath(item.path), item])),
    [agent.diffs],
  )

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
        selectRelative(-1)
        return
      }
      if (key === 'l') {
        event.preventDefault()
        selectRelative(1)
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

  function selectIndex(index: number) {
    if (!agent.diffs.length) return
    const nextIndex = Math.max(0, Math.min(index, agent.diffs.length - 1))
    setSelectedDiffId(agent.diffs[nextIndex]?.id ?? null)
  }

  function selectRelative(delta: -1 | 1) {
    if (!agent.diffs.length || selectedIndex === -1) return
    const nextIndex = (selectedIndex + delta + agent.diffs.length) % agent.diffs.length
    selectIndex(nextIndex)
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
      <div className="diff-body">
        <DiffFileTree
          diffs={agent.diffs}
          selectedPath={normalizeDiffPath(diff.path)}
          onSelectPath={(path) => {
            const next = diffByPath.get(path)
            if (next) setSelectedDiffId(next.id)
          }}
        />
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
    </div>
  )
}

function DiffFileTree({
  diffs,
  selectedPath,
  onSelectPath,
}: {
  diffs: DiffArtifact[]
  selectedPath: string
  onSelectPath: (path: string) => void
}) {
  const paths = React.useMemo(
    () => diffs.map((diff) => normalizeDiffPath(diff.path)),
    [diffs],
  )
  const statusByPath = React.useMemo(
    () => new Map(
      diffs.map((diff) => [
        normalizeDiffPath(diff.path),
        diffGitStatus(diff.patch),
      ]),
    ),
    [diffs],
  )
  const pathSignature = paths.join('\0')
  const selectablePathsRef = React.useRef(new Set(paths))
  const onSelectPathRef = React.useRef(onSelectPath)
  const selectedPathRef = React.useRef(selectedPath)
  selectablePathsRef.current = new Set(paths)
  onSelectPathRef.current = onSelectPath
  selectedPathRef.current = selectedPath
  const { model } = useFileTree({
    density: 'compact',
    flattenEmptyDirectories: false,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    onSelectionChange: (selectedPaths) => {
      const nextPath = selectedPaths[0]
      if (
        nextPath &&
        nextPath !== selectedPathRef.current &&
        selectablePathsRef.current.has(nextPath)
      ) {
        onSelectPathRef.current(nextPath)
      }
    },
    paths,
    renderRowDecoration: ({ item }) => {
      if (item.kind !== 'file') return null
      const status = statusByPath.get(item.path)
      if (!status) return null
      return {
        text: diffGitStatusLabel(status),
        title: `Changed file: ${diffGitStatusTitle(status)}`,
      }
    },
    search: diffs.length > 8,
    unsafeCSS: diffTreeUnsafeCSS,
  })

  React.useEffect(() => {
    model.resetPaths(paths)
  }, [model, pathSignature, paths])

  React.useEffect(() => {
    if (!selectedPath) return
    const selectedPaths = model.getSelectedPaths()
    if (selectedPaths.length === 1 && selectedPaths[0] === selectedPath) return
    for (const path of selectedPaths) {
      model.getItem(path)?.deselect()
    }
    const item = model.getItem(selectedPath)
    if (item) {
      item.select()
      item.focus()
      return
    }
    model.focusNearestPath(selectedPath)
  }, [model, selectedPath])

  return (
    <aside className="diff-tree-pane" aria-label="Changed files">
      <PierreFileTree
        model={model}
        header={<span className="diff-tree-header">Changed files</span>}
        style={diffTreeStyle}
      />
    </aside>
  )
}

const diffTreeStyle: React.CSSProperties = {
  height: '100%',
  minHeight: 0,
  width: '100%',
  '--trees-bg-override': 'var(--panel-2)',
  '--trees-bg-muted-override': 'color-mix(in oklab, var(--paper) 7%, var(--panel-2))',
  '--trees-border-color-override': 'transparent',
  '--trees-border-radius-override': '6px',
  '--trees-fg-override': 'var(--ink)',
  '--trees-muted-fg-override': 'var(--muted)',
  '--trees-font-family-override': 'var(--font-mono)',
  '--trees-font-size-override': '12px',
  '--trees-item-padding-x-override': '6px',
  '--trees-padding-inline-override': '10px',
  '--trees-level-gap-override': '7px',
  '--trees-icon-width-override': '14px',
  '--trees-git-lane-width-override': '0px',
  '--trees-selected-bg-override': 'var(--accent-soft)',
  '--trees-selected-fg-override': 'var(--accent)',
} as React.CSSProperties

const diffTreeUnsafeCSS = `
  [data-type='item'] {
    letter-spacing: 0;
  }

  [data-item-section='content'] {
    flex: 1 1 auto;
  }

  [data-item-section='decoration'] {
    flex: 0 0 18px;
    color: var(--trees-status-modified);
    font-weight: var(--trees-font-weight-semibold);
  }

  [data-item-section='spacing-item'] {
    opacity: 0.45;
  }

  :host(:hover) [data-item-section='spacing-item'] {
    opacity: 0.7;
  }
`

function diffGitStatus(patch: string): GitStatus {
  if (/^(?:new file mode|--- \/dev\/null$)/m.test(patch)) return 'added'
  if (/^(?:deleted file mode|\+\+\+ \/dev\/null$)/m.test(patch)) return 'deleted'
  if (/^rename (?:from|to) /m.test(patch)) return 'renamed'
  return 'modified'
}

function diffGitStatusLabel(status: GitStatus) {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'ignored':
      return ''
    case 'modified':
      return 'M'
  }
}

function diffGitStatusTitle(status: GitStatus) {
  switch (status) {
    case 'added':
      return 'added'
    case 'deleted':
      return 'deleted'
    case 'ignored':
      return 'ignored'
    case 'renamed':
      return 'renamed'
    case 'untracked':
      return 'untracked'
    case 'modified':
      return 'modified'
  }
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

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || target.isContentEditable
}
