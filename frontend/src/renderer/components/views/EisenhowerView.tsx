import { useState, useEffect, useCallback } from 'react'
import type { TaskViewRow } from '../../../preload/index'
import { TaskRow, effectiveUrgent } from './TaskViewShared'

interface EisenhowerViewProps {
  refreshSignal: number
  onJumpToTask: (task: TaskViewRow) => void
}

export function EisenhowerView({ refreshSignal, onJumpToTask }: EisenhowerViewProps) {
  const [tasks, setTasks] = useState<TaskViewRow[]>([])

  const load = useCallback(async () => {
    setTasks(await window.lineup.getEisenhowerTasks())
  }, [])
  useEffect(() => { load() }, [load, refreshSignal])

  async function toggleDone(task: TaskViewRow) {
    const next = task.status === 'done' ? 'todo' : 'done'
    await window.lineup.setProjectMeta(task.id, { status: next })
    load()
  }

  const q1 = tasks.filter(t => t.important === 1 && effectiveUrgent(t))
  const q2 = tasks.filter(t => t.important === 1 && !effectiveUrgent(t))
  const q3 = tasks.filter(t => t.important !== 1 && effectiveUrgent(t))
  const q4 = tasks.filter(t => t.important !== 1 && !effectiveUrgent(t))

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="px-6 py-4 border-b border-border">
        <div className="text-xl font-semibold">🎯 四象限</div>
        <div className="text-xs text-muted-foreground mt-1">
          🔥 紧急 = 手动 pin 或截止 ≤ 3 天
        </div>
      </div>

      <div className="flex-1 overflow-hidden grid grid-cols-2 grid-rows-2 gap-px bg-border">
        <Quadrant
          title="🔥 紧急 + 重要"
          tint="bg-red-500/5"
          tasks={q1}
          onToggleDone={toggleDone}
          onJump={onJumpToTask}
        />
        <Quadrant
          title="🌱 重要 · 不紧急"
          tint="bg-green-500/5"
          tasks={q2}
          onToggleDone={toggleDone}
          onJump={onJumpToTask}
        />
        <Quadrant
          title="⚡ 紧急 · 不重要"
          tint="bg-amber-500/5"
          tasks={q3}
          onToggleDone={toggleDone}
          onJump={onJumpToTask}
        />
        <Quadrant
          title="😴 都不"
          tint="bg-slate-500/5"
          tasks={q4}
          onToggleDone={toggleDone}
          onJump={onJumpToTask}
        />
      </div>
    </div>
  )
}

function Quadrant({
  title, tint, tasks, onToggleDone, onJump,
}: {
  title: string
  tint: string
  tasks: TaskViewRow[]
  onToggleDone: (task: TaskViewRow) => void
  onJump: (task: TaskViewRow) => void
}) {
  return (
    <div className={`${tint} overflow-hidden flex flex-col`}>
      <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border shrink-0 bg-card/30">
        {title} ({tasks.length})
      </div>
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {tasks.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-4 italic">—</div>
        ) : (
          tasks.map(t => (
            <TaskRow key={t.id} task={t} onToggleDone={onToggleDone} onJump={onJump} />
          ))
        )}
      </div>
    </div>
  )
}
