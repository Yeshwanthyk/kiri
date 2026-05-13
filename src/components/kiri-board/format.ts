import type { ThinkingLevel } from '~/lib/contracts'

const messageTimeFormatter = new Intl.DateTimeFormat('en', {
  hour: 'numeric',
  minute: '2-digit',
})

export function formatKeyShort(key: string): string {
  if (!key) return ''
  if (key.startsWith('arrow')) {
    const arrow = key.slice('arrow'.length)
    return arrow.charAt(0).toUpperCase() + arrow.slice(1)
  }
  return key.toUpperCase()
}

export function formatBlockDay(iso: string) {
  const date = new Date(iso)
  const now = new Date()
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: 'long' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatBlockTime(iso: string) {
  const date = new Date(iso)
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function formatThinkingLevel(level: ThinkingLevel) {
  return level === 'minimal' ? 'low' : level
}

export function formatElapsed(totalSeconds: number) {
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

export function formatAgo(iso: string): string {
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

export function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return messageTimeFormatter.format(date)
}

export function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`
  if (value >= 1_000) return `${trimFixed(value / 1_000)}K`
  return value.toLocaleString('en')
}

function trimFixed(value: number) {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '')
}

export function projectNameFromPath(path: string) {
  return path.replace(/\/+$/g, '').split('/').filter(Boolean).at(-1) ?? ''
}

export function projectSummary(project: { name: string; agents: { length: number } }) {
  const sessions = project.agents.length
  return `${project.name} · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed'
}
