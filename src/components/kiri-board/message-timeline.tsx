'use client'

import { PatchDiff } from '@pierre/diffs/react'
import { Check, Copy, FileText, GitPullRequest, MessageSquareText, PencilLine, Search, TerminalSquare } from 'lucide-react'
import * as React from 'react'
import type { BoardMessage, DiffArtifact } from '~/lib/contracts'
import type { ThemeMode } from '~/theme/kiri-themes'
import { formatElapsed, formatTime } from './format'
import { RichMessageBody } from './rich-message-body'
import {
  classifyToolName,
  diffLineStats,
  displayPath,
  isAssistantStatusEntry,
  isCommandEntry,
  type AgentTimelineRow,
  type TimelineWorkEntry,
  workCallLabel,
} from './timeline'

export const MessageTimeline = React.memo(function MessageTimeline({
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
  const hideTimestampByRowId = React.useMemo(() => computeHiddenTimestamps(rows), [rows])

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
  const patch = entry.diff?.patch
  const stats = React.useMemo(() => (patch ? diffLineStats(patch) : null), [patch])
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
