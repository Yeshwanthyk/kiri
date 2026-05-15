'use client'

import { PatchDiff } from '@pierre/diffs/react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, ChevronDown, Copy, FileText, GitPullRequest, ImagePlus, MessageSquareText, PencilLine, Search, Send, Square, TerminalSquare } from 'lucide-react'
import * as React from 'react'
import { highlightCode, highlightCodeSync } from '../../lib/code-highlighter'
import type { AgentCell, BoardMessage, DiffArtifact, PendingQuestion, ReviewTarget, SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import type { ThemeMode } from '~/theme/kiri-themes'
import { errorMessage, formatElapsed, formatTime, formatTokenCount } from './format'
import { imageKey, pendingPromptText, readImageFile } from './images'
import { readStoredChatDraft, updateChatDraft } from './storage'
import { parseSlashCommand, runSlashCommand, type SlashCommand } from './slash-commands'
import { TaskProgressStrip } from './task-progress'
import { classifyToolName, deriveAgentTimelineRows, diffLineStats, displayPath, isAssistantStatusEntry, isCommandEntry, timelineRowsContentVersion, type AgentTimelineRow, type TimelineWorkEntry, workCallLabel } from './timeline'
import type { RefreshAgentDetail } from './board-types'

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
  const allRows = React.useMemo(
    () => deriveAgentTimelineRows(timelineAgent, cwd),
    [cwd, timelineAgent],
  )
  const rows = React.useMemo(
    () =>
      !olderHistoryLoaded && allRows.length > maxMountedTimelineRows
        ? allRows.slice(-maxMountedTimelineRows)
        : allRows,
    [allRows, olderHistoryLoaded],
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
          hasOlderHistory={hasOlderHistory}
          olderHistoryPending={olderHistoryPending}
          onLoadOlderHistory={async () => {
            if (!onLoadOlderHistory) return
            setError(null)
            try {
              await onLoadOlderHistory()
            } catch (cause) {
              setError(errorMessage(cause))
            }
          }}
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
    <form className="composer" onSubmit={(event) => void submit(event)}>
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
  hasOlderHistory,
  olderHistoryPending,
  onLoadOlderHistory,
}: {
  rows: AgentTimelineRow[]
  themeMode: ThemeMode
  listRef: React.RefObject<HTMLDivElement | null>
  selectedMessageId: string | null
  hasOlderHistory: boolean
  olderHistoryPending: boolean
  onLoadOlderHistory: () => Promise<void>
}) {
  if (rows.length === 0) {
    return (
      <div className="message-list" ref={listRef}>
        {hasOlderHistory ? (
          <LoadOlderHistoryButton
            pending={olderHistoryPending}
            onLoad={onLoadOlderHistory}
          />
        ) : null}
        <div className="empty-panel">No messages yet.</div>
      </div>
    )
  }

  const hideTimestampByRowId = computeHiddenTimestamps(rows)

  return (
    <div className="message-list" ref={listRef}>
      {hasOlderHistory ? (
        <LoadOlderHistoryButton
          pending={olderHistoryPending}
          onLoad={onLoadOlderHistory}
        />
      ) : null}
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

function LoadOlderHistoryButton({
  pending,
  onLoad,
}: {
  pending: boolean
  onLoad: () => Promise<void>
}) {
  return (
    <button
      type="button"
      className="load-older-history"
      disabled={pending}
      onClick={() => void onLoad()}
    >
      {pending ? 'Loading history...' : 'Load older history'}
    </button>
  )
}

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
    <form
      className="pending-question-panel"
      onSubmit={(event) => void submit(event)}
      data-testid="pending-question"
    >
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
    <button type="button" className="copy-message" onClick={() => void copy()} aria-label={label}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function bottomDistance(list: HTMLElement) {
  return list.scrollHeight - list.clientHeight - list.scrollTop
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
