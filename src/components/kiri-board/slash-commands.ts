import type {
  AgentCell,
  ReviewTarget,
  RuntimeKind,
  ThinkingLevel,
} from '~/lib/contracts'
import { thinkingLevelSchema } from '~/lib/contracts'

const THINKING_RUNTIMES = new Set<RuntimeKind>(['pi', 'codex', 'claude'])

export type SlashCommand = {
  name: 'thinking' | 'new' | 'fork' | 'review'
  level?: ThinkingLevel
  reviewTarget?: ReviewTarget
}

export function supportsThinking(runtime: RuntimeKind) {
  return THINKING_RUNTIMES.has(runtime)
}

export function parseSlashCommand(prompt: string): SlashCommand | null {
  const [command = '', ...args] = prompt.trim().split(/\s+/)
  if (command === '/new') {
    if (args.length > 0) throw new Error('Usage: /new')
    return { name: 'new' }
  }
  if (command === '/fork') {
    if (args.length > 0) throw new Error('Usage: /fork')
    return { name: 'fork' }
  }
  if (command === '/review') {
    if (args.length === 0) {
      return { name: 'review', reviewTarget: { type: 'uncommittedChanges' } }
    }
    if (args.length === 2 && args[0] === 'base') {
      return { name: 'review', reviewTarget: { type: 'baseBranch', branch: args[1] } }
    }
    throw new Error('Usage: /review or /review base <branch>')
  }
  if (command !== '/thinking') return null
  if (args.length === 0) return { name: 'thinking' }
  if (args.length > 1) {
    throw new Error('Usage: /thinking [off|minimal|low|medium|high|xhigh]')
  }
  if (args[0] === 'cycle') return { name: 'thinking' }
  const parsed = thinkingLevelSchema.safeParse(args[0])
  if (!parsed.success) {
    throw new Error('Usage: /thinking [off|minimal|low|medium|high|xhigh]')
  }
  return { name: 'thinking', level: parsed.data }
}

export async function runSlashCommand(
  command: SlashCommand,
  agent: AgentCell,
  actions: {
    onThinkingCommand: (agentId: string, level?: ThinkingLevel) => Promise<void>
    onResetSession: (agentId: string) => Promise<void>
    onForkSession: (agentId: string) => Promise<void>
    onReviewSession: (agentId: string, target: ReviewTarget) => Promise<void>
  },
) {
  if (command.name === 'new') {
    await actions.onResetSession(agent.id)
    return
  }
  if (command.name === 'fork') {
    await actions.onForkSession(agent.id)
    return
  }
  if (command.name === 'review') {
    if (agent.runtime !== 'codex') {
      throw new Error(`${agent.runtime} sessions do not support /review yet`)
    }
    await actions.onReviewSession(agent.id, command.reviewTarget ?? { type: 'uncommittedChanges' })
    return
  }
  if (command.name === 'thinking') {
    if (!supportsThinking(agent.runtime)) {
      throw new Error(`${agent.runtime} sessions do not support /thinking yet`)
    }
    await actions.onThinkingCommand(agent.id, command.level)
  }
}
