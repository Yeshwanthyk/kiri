import { PiRpcProcessAdapter } from './pi-rpc'
import {
  getAgentLaunchConfig,
  recordPiMessages,
  setAgentStatus,
} from './db'
import { getRuntimeSettings } from './settings'

const adapters = new Map<string, PiRpcProcessAdapter>()
const adapterKeys = new Map<string, string>()
const queues = new Map<string, Promise<void>>()

export async function promptPiAgent(input: { agentId: string; text: string }) {
  const config = getAgentLaunchConfig(input.agentId)
  const previous = queues.get(config.id) ?? Promise.resolve()
  const next = previous.then(() => promptPiAgentNow(config, input.text))
  queues.set(
    config.id,
    next.catch(() => {
      // Keep the queue alive after a failed turn.
    }),
  )
  await next
}

async function promptPiAgentNow(
  config: ReturnType<typeof getAgentLaunchConfig>,
  text: string,
) {
  let adapter = adapters.get(config.id)
  if (config.runtime !== 'pi') {
    throw new Error(`${config.runtime} agents can be configured, but only Pi can run chat today`)
  }

  const settings = getRuntimeSettings(config.runtime)
  const adapterKey = JSON.stringify({
    cwd: config.cwd,
    sessionDir: config.sessionDir,
    model: config.model,
    models: settings.models,
  })
  if (adapter && adapterKeys.get(config.id) !== adapterKey) {
    adapter.stop()
    adapters.delete(config.id)
    adapterKeys.delete(config.id)
    adapter = undefined
  }

  if (!adapter) {
    adapter = new PiRpcProcessAdapter({
      cwd: config.cwd,
      sessionDir: config.sessionDir,
      model: config.model,
      models: settings.models,
    })
    adapters.set(config.id, adapter)
    adapterKeys.set(config.id, adapterKey)
  }

  setAgentStatus(config.id, 'running')
  try {
    adapter.start()
    const before = await adapter.getState()
    const messages = await adapter.promptAndWait(text)
    const after = await adapter.getState()
    recordPiMessages({
      agentId: config.id,
      promptText: text,
      messages,
      sessionFile: after.sessionFile ?? before.sessionFile,
    })
  } finally {
    setAgentStatus(config.id, 'idle')
  }
}
