'use client'

import { ChevronDown } from 'lucide-react'
import * as React from 'react'
import type { AgentCell, BoardMessage, ReviewTarget, SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import type { ThemeMode } from '~/theme/kiri-themes'
import { errorMessage } from './format'
import { pendingPromptText } from './images'
import { parseSlashCommand, runSlashCommand, type SlashCommand } from './slash-commands'
import { TaskProgressStrip } from './task-progress'
import { deriveAgentTimelineRows, timelineRowsContentVersion, type AgentTimelineRow } from './timeline'
import type { RefreshAgentDetail } from './board-types'
import { ChatComposer } from './chat-composer'
import { MessageTimeline } from './message-timeline'
import { PendingQuestionPanel } from './pending-question-panel'

const maxMountedTimelineRows = 500

export function ChatPanel({
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
  hasOlderHistory = false,
  olderHistoryLoaded = false,
  olderHistoryPending = false,
  onLoadOlderHistory,
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
  hasOlderHistory?: boolean
  olderHistoryLoaded?: boolean
  olderHistoryPending?: boolean
  onLoadOlderHistory?: () => Promise<void>
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
    () => deriveAgentTimelineRows(timelineAgent, cwd, {
      maxRows: olderHistoryLoaded ? undefined : maxMountedTimelineRows,
    }),
    [cwd, olderHistoryLoaded, timelineAgent],
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

  const handleLoadOlderHistory = React.useCallback(async () => {
    if (!onLoadOlderHistory) return
    setError(null)
    try {
      await onLoadOlderHistory()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [onLoadOlderHistory])

  return (
    <div className="chat-panel" data-testid="chat-panel">
      <div className="message-list-wrap">
        <TaskProgressStrip tasks={agent.tasks} />
        <MessageTimeline
          rows={rows}
          themeMode={themeMode}
          listRef={messageListRef}
          selectedMessageId={selectedMessageId}
          hasOlderHistory={hasOlderHistory}
          olderHistoryPending={olderHistoryPending}
          onLoadOlderHistory={handleLoadOlderHistory}
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
      <div className="composer-dock">
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
    </div>
  )
}

function bottomDistance(list: HTMLElement) {
  return list.scrollHeight - list.clientHeight - list.scrollTop
}
