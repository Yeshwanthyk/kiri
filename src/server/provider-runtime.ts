import type { ReviewTarget, SendMessageImage, ThinkingLevel } from '~/lib/contracts'
import {
  interruptCodexAgent,
  promptCodexAgent,
  resetCodexSession,
  reviewCodexSession,
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
import type { RuntimeKind } from '~/lib/contracts'

export type ProviderRuntimeAdapter = {
  prompt: (input: {
    agentId: string
    text: string
    images?: SendMessageImage[]
  }) => Promise<unknown>
  steer?: (input: {
    agentId: string
    text: string
    images?: SendMessageImage[]
  }) => Promise<unknown>
  interrupt?: (input: { agentId: string }) => Promise<unknown>
  setThinkingLevel?: (input: {
    agentId: string
    level?: ThinkingLevel
  }) => Promise<unknown>
  reset?: (input: { agentId: string }) => Promise<unknown>
  fork?: (input: { agentId: string }) => Promise<string>
  review?: (input: {
    agentId: string
    target: ReviewTarget
  }) => Promise<unknown>
  answerQuestion?: (input: {
    agentId: string
    requestId: string
    answers: Record<string, string | string[]>
  }) => Promise<unknown>
}

export const runtimeAdapters: Record<RuntimeKind, ProviderRuntimeAdapter> = {
  pi: {
    prompt: promptPiAgent,
    steer: steerPiAgent,
    interrupt: interruptPiAgent,
    setThinkingLevel: setPiThinkingLevel,
    reset: resetPiSession,
    fork: forkPiSession,
  },
  codex: {
    prompt: promptCodexAgent,
    steer: steerCodexAgent,
    interrupt: interruptCodexAgent,
    setThinkingLevel: setCodexThinkingLevel,
    reset: resetCodexSession,
    review: reviewCodexSession,
  },
  claude: {
    prompt: promptClaudeAgent,
    steer: steerClaudeAgent,
    interrupt: interruptClaudeAgent,
    setThinkingLevel: setClaudeThinkingLevel,
    reset: resetClaudeSession,
    answerQuestion: answerClaudeQuestion,
  },
  opencode: {
    prompt: async () => {
      throw new Error('opencode agents can be configured, but cannot run chat today')
    },
  },
}
