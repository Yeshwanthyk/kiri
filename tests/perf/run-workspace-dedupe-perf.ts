import { performance } from 'node:perf_hooks'
import type { AgentCell, ProjectRow, WorkspaceSnapshot } from '../../src/lib/contracts'
import { createWorkspaceDedupe } from '../../src/components/kiri-board/workspace-fingerprint'

const idlePolls = 200
const projectCount = 12
const agentsPerProject = 8

function buildSnapshot(tick: number, churning: boolean): WorkspaceSnapshot {
  const projects: ProjectRow[] = []
  for (let p = 0; p < projectCount; p += 1) {
    const agents: AgentCell[] = []
    for (let a = 0; a < agentsPerProject; a += 1) {
      const updatedAt = churning && a === 0 && p === 0
        ? new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
        : '2026-01-01T00:00:00.000Z'
      agents.push({
        id: `p${p}-a${a}`,
        projectId: `p${p}`,
        slot: `session-${a}`,
        title: `Agent ${p}/${a}`,
        runtime: 'pi',
        interfaceMode: 'gui',
        model: 'pi-model',
        status: 'idle',
        sessionDir: `/tmp/p${p}`,
        sessionFile: null,
        preview: 'No messages yet',
        messageCount: 12,
        contextUsage: null,
        pendingQuestion: null,
        updatedAt,
        isSession: true,
        messages: [],
        timelineEvents: [],
        timeline: [],
        tasks: [],
      })
    }
    projects.push({
      id: `p${p}`,
      name: `Project ${p}`,
      cwd: `/tmp/p${p}`,
      position: p,
      hiddenAt: null,
      agents,
    })
  }
  return {
    settings: {
      runtimes: {
        pi: { models: ['pi-model'], defaultModel: 'pi-model' },
        codex: { models: ['codex-model'], defaultModel: 'codex-model' },
        claude: { models: ['claude-model'], defaultModel: 'claude-model' },
        opencode: { models: ['opencode-model'], defaultModel: 'opencode-model' },
      },
    },
    preferences: {
      theme: { mode: 'dark', name: 'kiri' },
      keymap: {
        projectPrev: 'k', projectNext: 'j', agentPrev: 'h', agentNext: 'l',
        focusChat: 'i', openTerminal: 't', openBrowser: 'b', openScratchpad: 's',
        startSession: 'n', deleteSession: 'backspace', toggleTerminalFocus: 'f',
      },
      chatTypography: { fontSize: 'comfortable', monoFont: 'fira' },
      agentByProject: {},
    },
    projects,
    hiddenProjects: [],
    archivedSessions: [],
    scratchpadBlocks: [],
    selected: { projectId: 'p0', agentId: 'p0-a0' },
  }
}

const initialIdle = buildSnapshot(0, false)

// Baseline: simulate naive applyWorkspace (always setWorkspace on every poll).
let baselineApplyCount = 0
const baselineStart = performance.now()
for (let i = 0; i < idlePolls; i += 1) {
  const next = buildSnapshot(i, false)
  baselineApplyCount += 1
  void next
}
const baselineMs = performance.now() - baselineStart

// With dedupe: idle polls collapse to zero setState calls.
const dedupe = createWorkspaceDedupe(initialIdle)
let dedupeApplyCount = 0
const dedupeStart = performance.now()
for (let i = 0; i < idlePolls; i += 1) {
  const next = buildSnapshot(i, false)
  dedupe.apply(next, () => { dedupeApplyCount += 1 })
}
const dedupeMs = performance.now() - dedupeStart

// Churn case: every poll produces a real change, dedupe must still forward all.
const churningInitial = buildSnapshot(0, true)
const churningDedupe = createWorkspaceDedupe(churningInitial)
let churningApplyCount = 0
const churningStart = performance.now()
for (let i = 1; i <= idlePolls; i += 1) {
  const next = buildSnapshot(i, true)
  churningDedupe.apply(next, () => { churningApplyCount += 1 })
}
const churningMs = performance.now() - churningStart

const snapshotBytes = Buffer.byteLength(JSON.stringify(initialIdle))

process.stdout.write(`${JSON.stringify({
  ok: true,
  idlePolls,
  snapshotBytes,
  baselineApplyCount,
  baselineMs: round(baselineMs),
  dedupeApplyCount,
  dedupeMs: round(dedupeMs),
  churningApplyCount,
  churningMs: round(churningMs),
}, null, 2)}\n`)

function round(value: number) {
  return Math.round(value * 100) / 100
}
