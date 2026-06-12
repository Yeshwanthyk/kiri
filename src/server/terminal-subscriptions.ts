import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import {
  runWaitTargets,
  waitTargetSchema,
  type TerminalRegistryApi,
  type WaitTargetsResult,
} from './terminal-control'

// Wake-mode delivery for workflow.await: the caller registers a condition and
// ends its turn; when the condition fires (or times out), the result is
// composed into a compact message and typed into the receiving agent's
// terminal as a fresh user turn. Zero tokens are spent while waiting.

export const subscribeSchema = z.object({
  targets: z.array(waitTargetSchema).min(1).max(32),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  quorum: z.enum(['any', 'all']).default('any'),
  deliver: z.object({
    agentId: z.string().trim().min(1),
    note: z.string().max(2_000).optional(),
    title: z.string().max(200).optional(),
  }),
})
export type SubscribeInput = z.infer<typeof subscribeSchema>

type SubscriptionStatus = 'pending' | 'delivered' | 'failed'

type SubscriptionRecord = SubscribeInput & {
  readonly id: string
  readonly createdAt: string
  status: SubscriptionStatus
  outcome: string | null
}

export type TerminalSubscriptionsApi = {
  readonly subscribe: (input: SubscribeInput) => { id: string }
  readonly list: () => Array<{
    id: string
    status: SubscriptionStatus
    deliverAgentId: string
    targets: number
    outcome: string | null
  }>
  /** Resolves when no pending subscription is in flight (test support). */
  readonly settled: () => Promise<void>
}

export type TerminalSubscriptionsDependencies = {
  readonly registry: TerminalRegistryApi
  // Brings the receiving agent's runtime session up (with conversation
  // resume) when it is not currently attached to a live terminal.
  readonly spawnForDelivery?: (agentId: string) => Promise<unknown>
  // Persisting pending subscriptions lets the daemon re-arm them on restart.
  readonly journalPath?: string
  // Text and Enter are written separately: some TUIs (Claude Code) treat
  // text+CR in one chunk as a paste and leave it unsubmitted.
  readonly submitDelayMs?: number
  // Briefly batch ready wakes for the same receiver into one submitted turn.
  readonly batchDelayMs?: number
  readonly timers?: {
    readonly setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  }
}

const journalSchema = z.array(z.object({
  id: z.string(),
  createdAt: z.string(),
  status: z.enum(['pending', 'delivered', 'failed']),
  outcome: z.string().nullable(),
  targets: z.array(waitTargetSchema),
  timeoutMs: z.number().int().positive(),
  quorum: z.enum(['any', 'all']),
  deliver: z.object({
    agentId: z.string(),
    note: z.string().optional(),
    title: z.string().optional(),
  }),
}))

export function makeTerminalSubscriptions(
  dependencies: TerminalSubscriptionsDependencies,
): TerminalSubscriptionsApi {
  const submitDelayMs = dependencies.submitDelayMs ?? 150
  const batchDelayMs = dependencies.batchDelayMs ?? 25
  const maxSettledRecords = 100
  const timers = dependencies.timers ?? { setTimeout }
  const records = new Map<string, SubscriptionRecord>()
  const inFlight = new Set<Promise<void>>()
  const pendingDeliveries = new Map<string, PendingDelivery>()
  let counter = 0

  for (const restored of loadJournal(dependencies.journalPath)) {
    records.set(restored.id, restored)
    if (restored.status === 'pending') watch(restored)
  }

  return {
    subscribe: (input) => {
      counter += 1
      const record: SubscriptionRecord = {
        ...input,
        id: `sub-${Date.now().toString(36)}-${counter}`,
        createdAt: new Date().toISOString(),
        status: 'pending',
        outcome: null,
      }
      records.set(record.id, record)
      persist()
      watch(record)
      return { id: record.id }
    },
    list: () => Array.from(records.values()).map((record) => ({
      id: record.id,
      status: record.status,
      deliverAgentId: record.deliver.agentId,
      targets: record.targets.length,
      outcome: record.outcome,
    })),
    settled: async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled(Array.from(inFlight))
      }
    },
  }

  function watch(record: SubscriptionRecord) {
    const run = (async () => {
      const result = await runWaitTargets(dependencies.registry, record.targets, {
        timeoutMs: record.timeoutMs,
        quorum: record.quorum,
      })
      await deliver(record, result)
    })().catch((error) => {
      record.status = 'failed'
      record.outcome = error instanceof Error ? error.message : String(error)
      pruneSettled()
      persist()
    }).finally(() => {
      inFlight.delete(run)
    })
    inFlight.add(run)
  }

  async function deliver(record: SubscriptionRecord, result: WaitTargetsResult) {
    const text = composeWake(record, result)
    const key = `${record.deliver.agentId}:runtime`
    await enqueueDelivery(key, { record, result, text })
  }

  async function enqueueDelivery(
    key: string,
    item: PendingDeliveryItem,
  ) {
    const existing = pendingDeliveries.get(key)
    if (existing) {
      if (existing.flushing) {
        await existing.promise
        return enqueueDelivery(key, item)
      }
      existing.items.push(item)
      return existing.promise
    }

    let resolveDelivery!: () => void
    const pending: PendingDelivery = {
      key,
      items: [item],
      flushing: false,
      promise: new Promise((resolve) => {
        resolveDelivery = resolve
      }),
    }
    pendingDeliveries.set(key, pending)
    timers.setTimeout(() => {
      pending.flushing = true
      void flushDelivery(pending).catch((error) => {
        failPending(pending, error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (pendingDeliveries.get(key) === pending) pendingDeliveries.delete(key)
        resolveDelivery()
      })
    }, batchDelayMs)
    return pending.promise
  }

  async function flushDelivery(pending: PendingDelivery) {
    let target = dependencies.registry.sessions.get(pending.key)
    if ((!target || target.exited) && dependencies.spawnForDelivery) {
      try {
        await dependencies.spawnForDelivery(pending.items[0]?.record.deliver.agentId ?? '')
      } catch (error) {
        failPending(pending, `spawn for delivery failed: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      target = dependencies.registry.sessions.get(pending.key)
    }

    if (!target || target.exited) {
      failPending(pending, `no live session ${pending.key} to deliver to`)
      return
    }

    target.proc.write(pending.items.map((item) => item.text).join('\n\n'))
    await submitDelivery(target)
    for (const item of pending.items) {
      item.record.status = 'delivered'
      item.record.outcome = item.result.matched ? 'condition met' : 'timed out'
    }
    pruneSettled()
    persist()
  }

  function submitDelivery(target: NonNullable<ReturnType<TerminalRegistryApi['sessions']['get']>>) {
    return new Promise<void>((resolve, reject) => {
      timers.setTimeout(() => {
        try {
          if (target.exited) throw new Error(`session ${target.key} exited before submit`)
          target.proc.write('\r')
          resolve()
        } catch (error) {
          reject(error)
        }
      }, submitDelayMs)
    })
  }

  function failPending(pending: PendingDelivery, outcome: string) {
    for (const item of pending.items) {
      item.record.status = 'failed'
      item.record.outcome = outcome
    }
    pruneSettled()
    persist()
  }

  function composeWake(record: SubscriptionRecord, result: WaitTargetsResult) {
    const lines: string[] = []
    const heading = record.deliver.title ?? 'await'
    if (result.matched || result.matches.length > 0) {
      const summary = result.matches
        .map((match) => `${match.label ?? match.key}: ${match.idle
          ? 'went idle'
          : `matched ${JSON.stringify(match.match ?? '')}`}`)
        .join('; ')
      lines.push(`[kiri wake ${record.id}] ${heading}: ${summary}`)
      for (const match of result.matches) {
        if (match.tail.length > 0) {
          lines.push(`tail ${match.label ?? match.key}: ${match.tail.join(' | ')}`)
        }
      }
    } else {
      lines.push(`[kiri wake ${record.id}] ${heading}: timed out after ${record.timeoutMs}ms with no match`)
    }
    if (result.missing.length > 0) {
      lines.push(`missing sessions: ${result.missing.join(', ')}`)
    }
    if (record.deliver.note) {
      lines.push(`note: ${record.deliver.note}`)
    }
    return lines.join('\n')
  }

  function persist() {
    if (!dependencies.journalPath) return
    const serialized = JSON.stringify(Array.from(records.values()), null, 2)
    const tmp = `${dependencies.journalPath}.tmp`
    writeFileSync(tmp, serialized, { mode: 0o600 })
    renameSync(tmp, dependencies.journalPath)
  }

  function pruneSettled() {
    const settled = Array.from(records.values())
      .filter((record) => record.status !== 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    while (settled.length > maxSettledRecords) {
      const oldest = settled.shift()
      if (oldest) records.delete(oldest.id)
    }
  }
}

type PendingDeliveryItem = {
  readonly record: SubscriptionRecord
  readonly result: WaitTargetsResult
  readonly text: string
}

type PendingDelivery = {
  readonly key: string
  readonly items: PendingDeliveryItem[]
  readonly promise: Promise<void>
  flushing: boolean
}

export async function handleSubscriptionControlRoute(
  route: string,
  body: unknown,
  subscriptions: TerminalSubscriptionsApi,
): Promise<{ status: number; body: unknown } | null> {
  if (route === 'POST /api/sessions/subscribe') {
    const input = subscribeSchema.parse(body)
    return { status: 200, body: { ok: true, ...subscriptions.subscribe(input) } }
  }
  if (route === 'GET /api/subscriptions') {
    return { status: 200, body: { subscriptions: subscriptions.list() } }
  }
  return null
}

function loadJournal(journalPath: string | undefined): SubscriptionRecord[] {
  if (!journalPath || !existsSync(journalPath)) return []
  try {
    const parsed = journalSchema.safeParse(JSON.parse(readFileSync(journalPath, 'utf8')))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}
