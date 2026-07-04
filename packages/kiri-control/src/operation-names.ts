export const kiriReadOperations = [
  'operations.list',
  'context.show',
  'model.list',
  'project.list',
  'session.list',
  'agent.detail',
  'agent.events.list',
  'task.list',
  'knowledge.list',
  'knowledge.search',
  'scratchpad.list',
  'terminal.read',
  'terminal.list',
  'terminal.wait-for',
  'workflow.list',
  'workflow.show',
  'workflow.validate',
] as const

export const kiriWriteOperations = [
  'project.add',
  'project.hide',
  'project.unhide',
  'project.delete',
  'session.create',
  'session.spawn',
  'session.rename',
  'session.archive',
  'session.restore',
  'session.delete',
  'agent.prompt',
  'agent.interrupt',
  'agent.status.set',
  'agent.tasks.replace',
  'terminal.input',
  'terminal.keys',
  'terminal.spawn',
  'terminal.kill',
  'knowledge.add',
  'knowledge.update',
  'knowledge.delete',
  'knowledge.markSeen',
  'scratchpad.add',
  'scratchpad.delete',
  'scratchpad.trigger',
  'workflow.create',
  'workflow.dispatch',
  'workflow.await',
  'workflow.retrigger',
  'workflow.track',
  'workflow.untrack',
  'workflow.archive',
  'workflow.restore',
] as const

export type KiriReadOperation = typeof kiriReadOperations[number]
export type KiriWriteOperation = typeof kiriWriteOperations[number]
export type KiriOperation = KiriReadOperation | KiriWriteOperation

export function isKiriOperation(value: unknown): value is KiriOperation {
  return typeof value === 'string' && (
    (kiriReadOperations as readonly string[]).includes(value)
    || (kiriWriteOperations as readonly string[]).includes(value)
  )
}

export function isKiriWriteOperation(value: unknown): value is KiriWriteOperation {
  return typeof value === 'string' && (kiriWriteOperations as readonly string[]).includes(value)
}
