import { AlertTriangle, Check, ChevronDown } from 'lucide-react'
import * as React from 'react'
import type { AgentTask } from '~/lib/contracts'

export function TaskProgressStrip({
  tasks,
}: {
  tasks: AgentTask[]
}) {
  const taskVersion = tasks.map((task) => `${task.source}:${task.id}:${task.title}`).join('|')
  return <TaskProgressStripContent key={taskVersion} tasks={tasks} />
}

function TaskProgressStripContent({
  tasks,
}: {
  tasks: AgentTask[]
}) {
  const [expanded, setExpanded] = React.useState(false)

  if (tasks.length === 0) return null

  const { completed, failed, active } = summarizeTasks(tasks)
  const summary = `${completed}/${tasks.length} done${failed ? `, ${failed} failed` : ''}`

  return (
    <section className={`task-strip${expanded ? ' expanded' : ''}`} aria-label="Agent tasks">
      <button
        type="button"
        className="task-strip-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className={`task-status-dot ${active?.status ?? 'pending'}`} aria-hidden="true" />
        <span className="task-strip-active">{active?.title ?? 'Tasks'}</span>
        <span className="task-strip-summary">{summary}</span>
        <ChevronDown size={14} className="task-strip-chevron" aria-hidden="true" />
      </button>
      {expanded ? (
        <ol className="task-list">
          {tasks.map((task) => (
            <li key={`${task.source}:${task.id}`} className={`task-item ${task.status}`}>
              <TaskStatusIcon status={task.status} />
              <span>{task.title}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}

export function summarizeTasks(tasks: AgentTask[]) {
  return {
    completed: tasks.filter((task) => task.status === 'completed').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    active:
      tasks.find((task) => task.status === 'inProgress') ??
      tasks.find((task) => task.status === 'pending') ??
      tasks[0],
  }
}

function TaskStatusIcon({
  status,
}: {
  status: AgentTask['status']
}) {
  if (status === 'completed') return <Check size={13} className="task-item-icon" aria-hidden="true" />
  if (status === 'failed') return <AlertTriangle size={13} className="task-item-icon" aria-hidden="true" />
  return <span className={`task-item-dot ${status}`} aria-hidden="true" />
}
