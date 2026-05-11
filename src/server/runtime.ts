import type { ReviewTarget, SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import { getAgentLaunchConfig } from './db'
import { runtimeAdapters } from './provider-runtime'

export async function promptAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  return runtimeAdapters[config.runtime].prompt(input)
}

export async function steerAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  const adapter = runtimeAdapters[config.runtime]
  if (adapter.steer) return adapter.steer(input)
  throw new Error(`${config.runtime} agents do not support steer yet`)
}

export async function interruptAgent(input: { agentId: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  const adapter = runtimeAdapters[config.runtime]
  if (adapter.interrupt) return adapter.interrupt(input)
  throw new Error(`${config.runtime} agents do not support interrupt yet`)
}

export async function setAgentThinkingLevel(input: {
  agentId: string
  level?: ThinkingLevel
}) {
  const config = getAgentLaunchConfig(input.agentId)
  const adapter = runtimeAdapters[config.runtime]
  if (adapter.setThinkingLevel) return adapter.setThinkingLevel(input)
  throw new Error(`${config.runtime} agents do not support /thinking yet`)
}

export async function resetAgentSession(input: { agentId: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  const adapter = runtimeAdapters[config.runtime]
  if (adapter.reset) return adapter.reset(input)
  throw new Error(`${config.runtime} agents do not support /new yet`)
}

export async function forkAgentSession(input: { agentId: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  const adapter = runtimeAdapters[config.runtime]
  if (adapter.fork) return adapter.fork(input)
  throw new Error(`${config.runtime} agents do not support /fork yet`)
}

export async function reviewAgentSession(input: {
  agentId: string
  target: ReviewTarget
}) {
  const config = getAgentLaunchConfig(input.agentId)
  const adapter = runtimeAdapters[config.runtime]
  if (adapter.review) return adapter.review(input)
  throw new Error(`${config.runtime} agents do not support /review yet`)
}

export async function answerAgentQuestion(input: {
  agentId: string
  requestId: string
  answers: Record<string, string | string[]>
}) {
  const config = getAgentLaunchConfig(input.agentId)
  const adapter = runtimeAdapters[config.runtime]
  if (adapter.answerQuestion) return adapter.answerQuestion(input)
  throw new Error(`${config.runtime} agents do not support interactive questions yet`)
}
