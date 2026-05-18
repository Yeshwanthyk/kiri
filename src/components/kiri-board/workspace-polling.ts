const workspacePollingTimings = {
  initialDelayMs: 250,
  intervalMs: 750,
  maxDurationMs: 120_000,
} as const

type WorkspacePollingTimers = {
  readonly setTimeout: (callback: () => void, delayMs: number) => number
  readonly clearTimeout: (timer: number) => void
  readonly now: () => number
}

type WorkspacePollingInput<T, Snapshot> = {
  readonly action: () => Promise<T>
  readonly refreshWorkspace: () => Promise<Snapshot>
  readonly onResult: (result: T) => void
  readonly onWorkspace: (snapshot: Snapshot) => void
  readonly onPoll?: () => Promise<void>
  readonly timers?: WorkspacePollingTimers
  readonly timings?: typeof workspacePollingTimings
}

export async function pollWorkspaceDuringAction<T, Snapshot>({
  action,
  refreshWorkspace,
  onResult,
  onWorkspace,
  onPoll,
  timers = browserTimers(),
  timings = workspacePollingTimings,
}: WorkspacePollingInput<T, Snapshot>) {
  let stopped = false
  let timer: number | undefined
  const startedAt = timers.now()
  const poll = async () => {
    if (stopped) return
    if (timers.now() - startedAt >= timings.maxDurationMs) {
      stopped = true
      return
    }
    try {
      const next = await refreshWorkspace()
      if (stopped) return
      onWorkspace(next)
      await onPoll?.()
    } finally {
      if (!stopped) {
        timer = timers.setTimeout(() => {
          void poll()
        }, timings.intervalMs)
      }
    }
  }
  timer = timers.setTimeout(() => {
    void poll()
  }, timings.initialDelayMs)
  try {
    const result = await action()
    onResult(result)
  } finally {
    stopped = true
    if (timer !== undefined) timers.clearTimeout(timer)
  }
}

type BackgroundWorkspacePollingInput<Snapshot> = {
  readonly refreshWorkspace: () => Promise<Snapshot>
  readonly onWorkspace: (snapshot: Snapshot) => void
  readonly onError?: (error: unknown) => void
  readonly isVisible?: () => boolean
  readonly isIdle?: () => boolean
  readonly idleToken?: () => unknown
  readonly timers?: Pick<WorkspacePollingTimers, 'setTimeout' | 'clearTimeout'>
  readonly intervalMs?: number
}

export function pollWorkspaceInBackground<Snapshot>({
  refreshWorkspace,
  onWorkspace,
  onError = (error) => console.error('Failed to refresh workspace snapshot', error),
  isVisible = () => document.visibilityState === 'visible',
  isIdle = () => true,
  idleToken = () => undefined,
  timers = browserTimers(),
  intervalMs = 2_000,
}: BackgroundWorkspacePollingInput<Snapshot>) {
  let stopped = false
  let timer: number | undefined

  const schedule = () => {
    if (stopped) return
    timer = timers.setTimeout(() => {
      void tick()
    }, intervalMs)
  }

  const tick = async () => {
    if (stopped) return
    if (!isVisible() || !isIdle()) {
      schedule()
      return
    }

    const startedIdleToken = idleToken()
    try {
      const next = await refreshWorkspace()
      if (!stopped && isIdle() && idleToken() === startedIdleToken) onWorkspace(next)
    } catch (error) {
      if (!stopped) onError(error)
    } finally {
      schedule()
    }
  }

  schedule()

  return () => {
    stopped = true
    if (timer !== undefined) timers.clearTimeout(timer)
  }
}

function browserTimers(): WorkspacePollingTimers {
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timer) => window.clearTimeout(timer),
    now: () => Date.now(),
  }
}
