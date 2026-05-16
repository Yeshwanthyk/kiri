import { performance } from 'node:perf_hooks'
import { preloadPatchDiff } from '@pierre/diffs/ssr'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'

import type { AgentCell, BoardMessage, DiffArtifact } from '../../src/lib/contracts'
import { ChatPanel } from '../../src/components/kiri-board/chat-panel'
import { DiffPanel } from '../../src/components/kiri-board/diff-panel'

const totalMessages = 1_500
const totalDiffs = 80
const budgets = {
  maxChatRenderMs: 1_500,
  maxDiffRenderMs: 1_500,
  maxMountedTimelineRows: 500,
  maxRenderedDiffFiles: 1,
  minRenderedSelectedDiffPaths: 1,
  minRenderedDiffBodyLines: 2,
}

const outputSchema = z.object({
  ok: z.literal(true),
  chatRenderMs: z.number(),
  diffRenderMs: z.number(),
  mountedTimelineRows: z.number(),
  renderedDiffFiles: z.number(),
  renderedSelectedDiffPaths: z.number(),
  renderedDiffBodyLines: z.number(),
  budgets: z.object({
    maxChatRenderMs: z.number(),
    maxDiffRenderMs: z.number(),
    maxMountedTimelineRows: z.number(),
    maxRenderedDiffFiles: z.number(),
    minRenderedSelectedDiffPaths: z.number(),
    minRenderedDiffBodyLines: z.number(),
  }),
})

const agent = makeAgent()
const chatStart = performance.now()
const chatHtml = renderToString(
  <ChatPanel
    agent={agent}
    cwd={process.cwd()}
    themeMode="light"
    focusRequest={0}
    onSend={() => Promise.resolve()}
    onSteer={() => Promise.resolve()}
    onInterrupt={() => Promise.resolve()}
    onThinkingCommand={() => Promise.resolve()}
    onResetSession={() => Promise.resolve()}
    onForkSession={() => Promise.resolve()}
    onReviewSession={() => Promise.resolve()}
    onAnswerQuestion={() => Promise.resolve()}
    onDetailRefresh={() => Promise.resolve()}
    hasOlderHistory
  />,
)
const chatRenderMs = performance.now() - chatStart

const diffStart = performance.now()
const selectedDiff = agent.diffs[0]
const selectedDiffPreload = await preloadPatchDiff({
  patch: selectedDiff.patch,
  options: {
    diffStyle: 'unified',
    overflow: 'wrap',
    themeType: 'light',
  },
})
const diffHtml = renderToString(
  <DiffPanel
    agent={agent}
    themeMode="light"
    preloadedDiffHtmlById={new Map([[selectedDiff.id, selectedDiffPreload.prerenderedHTML]])}
  />,
)
const diffRenderMs = performance.now() - diffStart

const output = outputSchema.parse({
  ok: true,
  chatRenderMs: round(chatRenderMs),
  diffRenderMs: round(diffRenderMs),
  mountedTimelineRows: count(chatHtml, 'class="timeline-row'),
  renderedDiffFiles: count(diffHtml, 'data-title=""'),
  renderedSelectedDiffPaths: count(diffHtml, 'src/perf-0.ts'),
  renderedDiffBodyLines:
    count(diffHtml, 'data-line-type="change-deletion"') +
    count(diffHtml, 'data-line-type="change-addition"'),
  budgets,
})

assertBudget(output.chatRenderMs <= budgets.maxChatRenderMs, 'chat render', output)
assertBudget(output.diffRenderMs <= budgets.maxDiffRenderMs, 'diff render', output)
assertBudget(output.mountedTimelineRows <= budgets.maxMountedTimelineRows, 'mounted timeline rows', output)
assertBudget(output.renderedDiffFiles <= budgets.maxRenderedDiffFiles, 'rendered diff files', output)
assertBudget(
  output.renderedSelectedDiffPaths >= budgets.minRenderedSelectedDiffPaths,
  'selected diff path render',
  output,
)
assertBudget(
  output.renderedDiffBodyLines >= budgets.minRenderedDiffBodyLines,
  'selected diff body render',
  output,
)

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)

function makeAgent(): AgentCell {
  const messages: BoardMessage[] = Array.from({ length: totalMessages }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `message ${index} ${'x'.repeat(80)}`,
    timestamp: timestampFor(index, 0),
  }))
  const diffs: DiffArtifact[] = Array.from({ length: totalDiffs }, (_, index) => ({
    id: `diff-${index}`,
    title: `src/perf-${index}.ts`,
    path: `src/perf-${index}.ts`,
    patch: makePatch(index),
    updatedAt: timestampFor(totalMessages - 1, index),
  }))
  return {
    id: 'perf-agent',
    projectId: 'perf-project',
    slot: 'session-perf',
    title: 'Perf Agent',
    runtime: 'pi',
    interfaceMode: 'gui',
    model: 'openai-codex/gpt-5.5',
    status: 'idle',
    sessionDir: process.cwd(),
    sessionFile: null,
    preview: 'message 1499',
    messageCount: messages.length,
    diffCount: diffs.length,
    contextUsage: null,
    pendingQuestion: null,
    updatedAt: timestampFor(totalMessages - 1, 0),
    isSession: true,
    messages,
    timelineEvents: [],
    timeline: messages.map((message) => ({
      type: 'message',
      id: `message:${message.id}`,
      timestamp: message.timestamp,
      message,
    })),
    timelinePage: {
      limit: 500,
      offset: 0,
      returned: 500,
      total: messages.length,
      hasMore: true,
    },
    diffs,
    tasks: [],
  }
}

function makePatch(index: number) {
  const lines = [
    `diff --git a/src/perf-${index}.ts b/src/perf-${index}.ts`,
    'index 1111111..2222222 100644',
    `--- a/src/perf-${index}.ts`,
    `+++ b/src/perf-${index}.ts`,
    '@@ -1,3 +1,3 @@',
  ]
  for (let line = 0; line < 96; line += 1) {
    lines.push(`-old ${line} ${'a'.repeat(80)}`)
    lines.push(`+new ${line} ${'b'.repeat(80)}`)
  }
  return lines.join('\n')
}

function timestampFor(index: number, offset: number) {
  return new Date(Date.UTC(2026, 4, 12, 12, 0, 0) + index * 2_000 + offset).toISOString()
}

function count(value: string, needle: string) {
  return value.split(needle).length - 1
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function assertBudget(condition: boolean, label: string, output: unknown) {
  if (!condition) {
    throw new Error(`Client render budget exceeded: ${label}\n${JSON.stringify(output, null, 2)}`)
  }
}
