import type {
  AgentCell,
  BoardMessage,
  TimelineEvent,
} from '~/lib/contracts'

export type TimelinePatch = {
  id: string
  title: string
  path: string
  patch: string
  updatedAt: string
}

export type AgentTimelineRow =
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

export type TimelineWorkEntry = {
  id: string
  kind: string
  tone: TimelineEvent['tone']
  label: string
  detail: string | null
  path?: string
  diff?: TimelinePatch
  count?: number
  timestamp: string
}

type TimelineRowsOptions = {
  readonly maxRows?: number
}

export function timelineRowsContentVersion(rows: AgentTimelineRow[]) {
  return rows.map((row) => {
    if (row.kind === 'message') return `${row.id}:${row.message.text.length}`
    if (row.kind === 'work') {
      const last = row.entries.at(-1)
      return `${row.id}:${row.entries.length}:${last?.id ?? ''}:${last?.detail?.length ?? 0}`
    }
    return row.id
  }).join('|')
}

export function deriveAgentTimelineRows(
  agent: AgentCell,
  cwd: string,
  options: TimelineRowsOptions = {},
): AgentTimelineRow[] {
  const rows: AgentTimelineRow[] = []
  let workEntries: TimelineWorkEntry[] = []
  const maxRows = options.maxRows
  const timeline = agent.timeline.length
    ? agent.timeline
    : agent.messages.map((message) => ({
        type: 'message' as const,
        id: `message:${message.id}`,
        timestamp: message.timestamp,
        message,
      }))

  function pushRow(row: AgentTimelineRow) {
    rows.push(row)
    if (maxRows === undefined) return
    while (rows.length > maxRows) rows.shift()
  }

  function flushWork() {
    if (workEntries.length === 0) return
    pushRow({
      kind: 'work',
      id: `work:${workEntries[0]?.id}`,
      startedAt: workEntries[0]?.timestamp ?? new Date(0).toISOString(),
      entries: workEntries,
    })
    workEntries = []
  }

  const compactAssistantMessageIds = compactedAssistantMessageIds(timeline)

  for (const item of timeline) {
    if (item.type === 'event') {
      const entry = eventToWorkEntry(item.event, cwd)
      if (entry) {
        const entries = inlinePatchDiffEntries(entry, cwd)
        workEntries.push(...entries)
      }
      continue
    }

    if (item.message.role === 'assistant' && compactAssistantMessageIds.has(item.message.id)) {
      workEntries.push(assistantMessageToWorkEntry(item.message))
      continue
    }

    if (item.message.role === 'tool') {
      const entry = toolMessageToWorkEntry(item.message, cwd)
      if (entry) {
        const entries = inlinePatchDiffEntries(entry, cwd)
        workEntries.push(...entries)
      }
      continue
    }

    flushWork()
    pushRow({
      kind: 'message',
      id: `message:${item.message.id}`,
      message: item.message,
    })
  }

  flushWork()

  if (agent.status === 'running') {
    const lastRow = rows[rows.length - 1]
    pushRow({
      kind: 'working',
      id: 'working-indicator',
      startedAt: lastRow?.kind === 'message' ? lastRow.message.timestamp : null,
    })
  }

  return rows
}

export function compactWorkEntries(entries: TimelineWorkEntry[]) {
  const compacted: TimelineWorkEntry[] = []
  for (const entry of entries) {
    if (isEmptyWorkEntry(entry)) continue
    const previous = compacted[compacted.length - 1]
    if (previous && workEntryKey(previous) === workEntryKey(entry)) {
      compacted[compacted.length - 1] = {
        ...previous,
        count: (previous.count ?? 1) + 1,
        timestamp: entry.timestamp,
      }
      continue
    }
    compacted.push(entry)
  }
  return compacted
}

export function summarizeWorkEntries(entries: TimelineWorkEntry[]) {
  const edited = countEntries(entries.filter((entry) => entry.diff))
  const updates = countEntries(entries.filter((entry) => isAssistantStatusEntry(entry)))
  const commands = countEntries(entries.filter((entry) => isCommandEntry(entry)))
  const explored = countEntries(entries) - edited - updates - commands
  const parts = [
    edited ? `edited ${edited} ${edited === 1 ? 'file' : 'files'}` : null,
    updates ? `${updates} ${updates === 1 ? 'update' : 'updates'}` : null,
    explored ? `explored ${explored}` : null,
    commands ? `ran ${commands} ${commands === 1 ? 'command' : 'commands'}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : `${entries.length} activities`
}

export function isAssistantStatusEntry(entry: TimelineWorkEntry) {
  return entry.kind === 'assistant.status'
}

export function isCommandEntry(entry: TimelineWorkEntry) {
  const label = entry.label.toLowerCase()
  return label.includes('command') || label === 'bash' || entry.kind === 'tool.message'
}

export function workCallLabel(entry: TimelineWorkEntry) {
  const detail = entry.detail?.trim() ?? ''
  const colonIndex = detail.indexOf(': ')
  if (colonIndex > 0 && colonIndex <= 32) {
    return normalizeWorkCallLabel(detail.slice(0, colonIndex))
  }
  const label = normalizeWorkCallLabel(entry.label)
  if (label.includes('command') || label === 'bash') return 'bash'
  return label || 'tool'
}

function normalizeWorkCallLabel(value: string) {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'commandexecution' || normalized === 'command run' || normalized === 'ran command') {
    return 'bash'
  }
  if (normalized === 'multi_edit') return 'multiedit'
  return normalized
}

export function diffLineStats(patch: string) {
  let added = 0
  let deleted = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    if (line.startsWith('-')) deleted += 1
  }
  return { added, deleted }
}

export function classifyToolName(name: string): 'path' | 'command' | 'pattern' | 'unknown' {
  const normalized = name.toLowerCase()
  if (['read', 'edit', 'write', 'multiedit', 'notebookedit'].includes(normalized)) return 'path'
  if (normalized === 'bash' || normalized.includes('shell') || normalized.includes('command')) {
    return 'command'
  }
  if (normalized === 'grep' || normalized === 'glob') return 'pattern'
  return 'unknown'
}

export function displayPath(path: string) {
  const normalized = normalizeDiffPath(path)
  const srcIndex = normalized.lastIndexOf('/src/')
  if (srcIndex >= 0) return normalized.slice(srcIndex + 1)
  const testsIndex = normalized.lastIndexOf('/tests/')
  if (testsIndex >= 0) return normalized.slice(testsIndex + 1)
  const parts = normalized.split('/').filter(Boolean)
  if (normalized.startsWith('/') && parts.length > 3) return parts.slice(-3).join('/')
  return normalized
}

export function normalizeDiffPath(path: string) {
  return path.replace(/\\/g, '/')
}

export function normalizeTimelinePath(path: string, cwd: string | undefined) {
  const normalized = normalizeDiffPath(path.replace(/^["']|["']$/g, '').trim())
  const normalizedCwd = cwd ? normalizeDiffPath(cwd).replace(/\/+$/g, '') : ''
  if (normalizedCwd && normalized === normalizedCwd) return ''
  if (normalizedCwd && normalized.startsWith(`${normalizedCwd}/`)) {
    return normalized.slice(normalizedCwd.length + 1)
  }
  return normalized
}

function eventToWorkEntry(
  event: TimelineEvent,
  cwd?: string,
): TimelineWorkEntry | null {
  if (!shouldShowRuntimeEvent(event)) return null
  const path = event.path ? normalizeTimelinePath(event.path, cwd) : undefined
  if (isEmptyCommandEvent(event)) return null
  if (isNoisyFileOperationEvent(event, path)) return null

  return {
    id: event.id,
    kind: event.kind,
    tone: event.tone,
    label: runtimeEventLabel(event),
    detail: event.detail,
    ...(path ? { path } : {}),
    timestamp: event.timestamp,
  }
}

function shouldShowRuntimeEvent(event: TimelineEvent) {
  if (event.kind === 'codex_context_compacted') return true
  if (event.kind === 'fileOperationStarted' || event.kind === 'fileOperationCompleted') return true
  if (event.kind.startsWith('claude_tool_')) return true
  if (event.kind.startsWith('claude_question_')) return true
  if (event.kind !== 'tool_execution_start') return false
  return event.label.toLowerCase() !== 'taskupdate'
}

function runtimeEventLabel(event: TimelineEvent) {
  if (event.kind === 'fileOperationCompleted') return 'Changed file'
  if (event.kind === 'fileOperationStarted') return 'Editing'
  const label = event.label.trim()
  if (label.toLowerCase() === 'bash') return 'Ran command'
  if (!label || label === 'tool execution start') return 'Tool'
  return label
}

function toolMessageToWorkEntry(
  message: BoardMessage,
  cwd: string,
): TimelineWorkEntry | null {
  const [firstLine, ...rest] = message.text.split('\n')
  const parsed = parseToolInvocation(firstLine?.trim() ?? '')
  const label = parsed?.label ?? firstLine?.trim() ?? 'Tool output'
  const detail = rest.join('\n').trim() || message.text
  const path = parsed?.path ? normalizeTimelinePath(parsed.path, cwd) : undefined
  if (isNoisyToolMessage(label, detail)) return null
  return {
    id: message.id,
    kind: 'tool.message',
    tone: 'tool',
    label,
    detail,
    ...(path ? { path } : {}),
    timestamp: message.timestamp,
  }
}

function inlinePatchDiffEntries(entry: TimelineWorkEntry, cwd?: string): TimelineWorkEntry[] {
  if (entry.diff) return [entry]
  const patch = entry.detail?.trim()
  if (!patch?.includes('diff --git ')) return [entry]

  const patches = splitPatchByFile(patch)
  if (patches.length === 0) return [entry]

  const diffEntries = patches.map((item, index) => {
    const path = normalizeTimelinePath(item.path, cwd)
    return {
      ...entry,
      id: `${entry.id}:patch:${index}`,
      kind: `${entry.kind}.diff`,
      label: 'Diff',
      detail: item.patch,
      path,
      diff: {
        id: `${entry.id}:patch:${index}`,
        title: entry.label,
        path,
        patch: item.patch,
        updatedAt: entry.timestamp,
      },
    } satisfies TimelineWorkEntry
  })

  return [{
    ...entry,
    detail: entry.detail?.split('\n')[0] ?? entry.detail,
  }, ...diffEntries]
}

function splitPatchByFile(patch: string) {
  const patches: Array<{ path: string; patch: string }> = []
  let currentPath: string | null = null
  let currentLines: string[] = []

  function flush() {
    if (!currentPath || currentLines.length === 0) return
    patches.push({ path: currentPath, patch: currentLines.join('\n') })
  }

  for (const line of patch.trim().split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (match?.[2]) {
      flush()
      currentPath = match[2]
      currentLines = [line]
      continue
    }
    if (currentPath) currentLines.push(line)
  }
  flush()
  return patches
}

function assistantMessageToWorkEntry(message: BoardMessage): TimelineWorkEntry {
  return {
    id: message.id,
    kind: 'assistant.status',
    tone: 'info',
    label: 'Update',
    detail: message.text,
    timestamp: message.timestamp,
  }
}

function compactedAssistantMessageIds(
  timeline: AgentCell['timeline'],
): Set<string> {
  const ids = new Set<string>()
  let turnAssistantIds: string[] = []

  function flushTurn() {
    if (turnAssistantIds.length > 1) {
      for (const id of turnAssistantIds.slice(0, -1)) ids.add(id)
    }
    turnAssistantIds = []
  }

  for (const item of timeline) {
    if (item.type !== 'message') continue
    if (item.message.role === 'user') {
      flushTurn()
      continue
    }
    if (item.message.role === 'assistant') turnAssistantIds.push(item.message.id)
  }
  flushTurn()

  return ids
}

function countEntries(entries: TimelineWorkEntry[]) {
  return entries.reduce((count, entry) => count + (entry.count ?? 1), 0)
}

function parseToolInvocation(line: string) {
  const colonIndex = line.indexOf(': ')
  if (colonIndex <= 0 || colonIndex > 32) return null
  const label = line.slice(0, colonIndex).trim()
  const value = line.slice(colonIndex + 2).trim()
  if (!value || classifyToolName(label) !== 'path') return null
  return { label, path: value }
}

function isNoisyToolMessage(label: string, detail: string) {
  const normalizedLabel = normalizeWorkCallLabel(label)
  const normalizedDetail = detail.trim().toLowerCase()
  if (normalizedDetail.includes('diff --git ')) return false
  if (!normalizedDetail || normalizedDetail === '{}' || normalizedDetail === '[]') return true
  if (normalizedDetail.includes('has been updated successfully') &&
    normalizedDetail.includes('no need to read it back')) {
    return true
  }
  return normalizedLabel === 'edit' || normalizedLabel === 'write' || normalizedLabel === 'multiedit'
}

function workEntryKey(entry: TimelineWorkEntry) {
  return [
    entry.label,
    entry.detail?.trim() ?? '',
    entry.path ?? '',
    entry.diff?.id ?? '',
  ].join('\0')
}

function isEmptyWorkEntry(entry: TimelineWorkEntry) {
  const detail = entry.detail?.trim()
  if (!detail || detail === '{}' || detail === '[]') return !entry.path && !entry.diff
  return false
}

function isEmptyCommandEvent(event: TimelineEvent) {
  const detail = event.detail?.trim()
  return runtimeEventLabel(event).toLowerCase().includes('command') &&
    (!detail || detail === '{}' || detail === '[]')
}

function isNoisyFileOperationEvent(
  event: TimelineEvent,
  path: string | undefined,
) {
  if (event.kind !== 'fileOperationStarted' && event.kind !== 'fileOperationCompleted') return false
  if (!path) return true
  return false
}
