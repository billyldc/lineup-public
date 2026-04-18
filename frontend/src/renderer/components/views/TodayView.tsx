import { useState, useEffect, useCallback } from 'react'
import type { TaskViewRow } from '../../../preload/index'
import { TaskRow, isDueToday } from './TaskViewShared'

interface TodayViewProps {
  refreshSignal: number
  onJumpToTask: (task: TaskViewRow) => void
}

export function TodayView({ refreshSignal, onJumpToTask }: TodayViewProps) {
  const [tasks, setTasks] = useState<TaskViewRow[]>([])

  const load = useCallback(async () => {
    setTasks(await window.lineup.getTodayTasks())
  }, [])
  useEffect(() => { load() }, [load, refreshSignal])

  async function toggleDone(task: TaskViewRow) {
    const next = task.status === 'done' ? 'todo' : 'done'
    await window.lineup.setProjectMeta(task.id, { status: next })
    load()
  }

  const overdue = tasks.filter(t => t.due_at && isDueToday(t.due_at))
  const reminder = tasks.filter(t => !(t.due_at && isDueToday(t.due_at)))

  const today = new Date()
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="px-6 py-4 border-b border-border">
        <div className="text-xl font-semibold">📅 今天</div>
        <div className="text-xs text-muted-foreground mt-1">{dateStr}</div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-6">
        {tasks.length === 0 && (
          <div className="text-center text-sm text-muted-foreground py-12">
            今天没有到期的任务 🎉
          </div>
        )}

        {overdue.length > 0 && (
          <section>
            <div className="px-3 text-xs text-muted-foreground uppercase tracking-wide mb-1">
              ⏰ 到期 ({overdue.length})
            </div>
            <div className="space-y-0.5">
              {overdue.map(t => (
                <TaskRow key={t.id} task={t} onToggleDone={toggleDone} onJump={onJumpToTask} />
              ))}
            </div>
          </section>
        )}

        {reminder.length > 0 && (
          <section>
            <div className="px-3 text-xs text-muted-foreground uppercase tracking-wide mb-1">
              🔁 周期提醒 ({reminder.length})
            </div>
            <div className="space-y-0.5">
              {reminder.map(t => (
                <TaskRow key={t.id} task={t} onToggleDone={toggleDone} onJump={onJumpToTask} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
