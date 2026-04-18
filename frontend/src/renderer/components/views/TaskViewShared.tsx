import type { TaskViewRow } from '../../../preload/index'
import { PROJECT_COLORS } from '../Inspector'

/** A single task row used across Today / Eisenhower / Inbox views. */
export function TaskRow({
  task,
  onToggleDone,
  onJump,
}: {
  task: TaskViewRow
  onToggleDone: (task: TaskViewRow) => void
  onJump: (task: TaskViewRow) => void
}) {
  const isDone = task.status === 'done'
  const color = task.parent_color && PROJECT_COLORS[task.parent_color]
    ? PROJECT_COLORS[task.parent_color]
    : null

  return (
    <div
      className={`group flex items-start gap-2 px-3 py-2 rounded hover:bg-accent/40 cursor-pointer ${isDone ? 'opacity-60' : ''}`}
      onClick={() => onJump(task)}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onToggleDone(task) }}
        className="shrink-0 mt-0.5 w-4 h-4 rounded border border-border flex items-center justify-center hover:bg-accent"
        title={isDone ? '标记未完成' : '标记已完成'}
      >
        {isDone && <span className="text-xs text-primary">✓</span>}
      </button>

      <div className="min-w-0 flex-1">
        <div className={`text-sm break-all ${isDone ? 'line-through' : ''}`}>
          {task.name}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
          {task.parent_name ? (
            <span className="flex items-center gap-1 truncate">
              {color && <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />}
              <span className="truncate">{task.parent_name}</span>
            </span>
          ) : (
            <span className="italic opacity-60">inbox</span>
          )}
          {task.due_at && (
            <span className={isDueToday(task.due_at) ? 'text-red-400' : ''}>
              ⏰ {task.due_at.slice(0, 10)}
            </span>
          )}
          {task.reminder_every_days && (
            <span>🔁 {task.reminder_every_days}d</span>
          )}
          {task.important === 1 && <span>🌱</span>}
          {(task.urgent === 1 || isAutoUrgent(task.due_at)) && <span>🔥</span>}
        </div>
      </div>
    </div>
  )
}

export function isDueToday(dateStr: string | null): boolean {
  if (!dateStr) return false
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return dateStr.slice(0, 10) <= today
}

/** A task is auto-urgent if its due date is within 3 days. Matches the
 *  rule the user requested in P2 discussion. */
export function isAutoUrgent(dateStr: string | null): boolean {
  if (!dateStr) return false
  const due = new Date(dateStr.slice(0, 10))
  const now = new Date()
  const diffDays = (due.getTime() - now.getTime()) / 86_400_000
  return diffDays <= 3
}

/** Combined effective urgency — manual pin OR due within 3 days. */
export function effectiveUrgent(task: TaskViewRow): boolean {
  return task.urgent === 1 || isAutoUrgent(task.due_at)
}
