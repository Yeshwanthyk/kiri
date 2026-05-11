import type { SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import {
  interruptCodexAgent,
  promptCodexAgent,
  resetCodexSession,
  setCodexThinkingLevel,
  steerCodexAgent,
} from './codex-runtime'
import {
  answerClaudeQuestion,
  interruptClaudeAgent,
  promptClaudeAgent,
  resetClaudeSession,
  setClaudeThinkingLevel,
  steerClaudeAgent,
} from './claude-runtime'
import {
  forkPiSession,
  interruptPiAgent,
  promptPiAgent,
  resetPiSession,
  setPiThinkingLevel,
  steerPiAgent,
} from './pi-runtime'
import { getAgentLaunchConfig } from './db'

export async function promptAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime === 'pi') return promptPiAgent(input)
  if (config.runtime === 'codex') return promptCodexAgent(input)
  if (config.runtime === 'claude') return promptClaudeAgent(input)
  throw new Error(`${config.runtime} agents can be configured, but cannot run chat today`)
}

export async function steerAgent(input: {
  agentId: string
  text: string
  images?: SendMessageImage[]
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime === 'pi') return steerPiAgent(input)
  if (config.runtime === 'codex') return steerCodexAgent(input)
  if (config.runtime === 'claude') return steerClaudeAgent(input)
  throw new Error(`${config.runtime} agents do not support steer yet`)
}

export async function interruptAgent(input: { agentId: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime === 'pi') return interruptPiAgent(input)
  if (config.runtime === 'codex') return interruptCodexAgent(input)
  if (config.runtime === 'claude') return interruptClaudeAgent(input)
  throw new Error(`${config.runtime} agents do not support interrupt yet`)
}

export async function setAgentThinkingLevel(input: {
  agentId: string
  level?: ThinkingLevel
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime === 'pi') return setPiThinkingLevel(input)
  if (config.runtime === 'codex') return setCodexThinkingLevel(input)
  if (config.runtime === 'claude') return setClaudeThinkingLevel(input)
  throw new Error(`${config.runtime} agents do not support /thinking yet`)
}

export async function resetAgentSession(input: { agentId: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime === 'pi') return resetPiSession(input)
  if (config.runtime === 'codex') return resetCodexSession(input)
  if (config.runtime === 'claude') return resetClaudeSession(input)
  throw new Error(`${config.runtime} agents do not support /new yet`)
}

export async function forkAgentSession(input: { agentId: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime === 'pi') return forkPiSession(input)
  throw new Error(`${config.runtime} agents do not support /fork yet`)
}

export async function answerAgentQuestion(input: {
  agentId: string
  requestId: string
  answers: Record<string, string | string[]>
}) {
  const config = getAgentLaunchConfig(input.agentId)
  if (config.runtime === 'claude') return answerClaudeQuestion(input)
  throw new Error(`${config.runtime} agents do not support interactive questions yet`)
}
