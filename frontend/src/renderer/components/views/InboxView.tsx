import { useState, useEffect, useCallback } from 'react'
import type { TaskViewRow } from '../../../preload/index'
import { TaskRow } from './TaskViewShared'

interface InboxViewProps {
  refreshSignal: number
  onJumpToTask: (task: TaskViewRow) => void
  onQuickAdd: () => void
}

export function InboxView({ refreshSignal, onJumpToTask, onQuickAdd }: InboxViewProps) {
  const [tasks, setTasks] = useState<TaskViewRow[]>([])

  const load = useCallback(async () => {
    setTasks(await window.lineup.getInboxTasks())
  }, [])
  useEffect(() => { load() }, [load, refreshSignal])

  async function toggleDone(task: TaskViewRow) {
    const next = task.status === 'done' ? 'todo' : 'done'
    await window.lineup.setProjectMeta(task.id, { status: next })
    load()
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-xl font-semibold">📋 收件箱</div>
          <div className="text-xs text-muted-foreground mt-1">
            临时任务的归宿 — 拖到左侧项目归档，或 ⌘N 添加新任务
          </div>
        </div>
        <button
          onClick={onQuickAdd}
          className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90"
        >
          + 新建 (⌘N)
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {tasks.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-12">
            收件箱是空的 —— ⌘N 快速添加一个任务
          </div>
        ) : (
          <div className="space-y-0.5">
            {tasks.map(t => (
              <TaskRow key={t.id} task={t} onToggleDone={toggleDone} onJump={onJumpToTask} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
