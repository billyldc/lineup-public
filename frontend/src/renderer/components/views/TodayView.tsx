import { useState, useEffect, useCallback, useRef } from 'react'
import type { TaskViewRow } from '../../../preload/index'
import { TaskRow, isDueToday } from './TaskViewShared'

interface TodayViewProps {
  refreshSignal: number
  onSelectTask: (task: TaskViewRow) => void
  onJumpToTask: (task: TaskViewRow) => void
  selectedTaskId: number | null
}

export function TodayView({ refreshSignal, onSelectTask, onJumpToTask, selectedTaskId }: TodayViewProps) {
  const [tasks, setTasks] = useState<TaskViewRow[]>([])
  // When the user marks the LAST active step of a task as done, we pause
  // and ask whether the parent task is also finished or whether a new step
  // should be appended. The dialog carries enough context to act on either
  // branch without re-fetching.
  const [lastStepPrompt, setLastStepPrompt] = useState<TaskViewRow | null>(null)

  const load = useCallback(async () => {
    setTasks(await window.lineup.getTodayTasks())
  }, [])
  useEffect(() => { load() }, [load, refreshSignal])

  const toggleDone = useCallback(async (task: TaskViewRow) => {
    const goingToDone = task.status !== 'done'
    const isStep = task.task_id != null && task.task_name != null
    if (isStep && goingToDone) {
      // If completing this step would leave the parent task with zero
      // active steps, ask the user what to do — finish the task or queue
      // up a new step. Exception: if the parent task is recurring, just
      // close out the cycle silently — the next recurrence will spawn
      // fresh steps when maybeResetRecurring fires.
      const { remaining, parentRecurring } =
        await window.lineup.countActiveStepsForTask(task.task_id!)
      if (remaining <= 1) {
        if (parentRecurring) {
          await window.lineup.setProjectMeta(task.id, { status: 'done' })
          await window.lineup.setProjectMeta(task.task_id!, { status: 'done' })
          load()
          return
        }
        setLastStepPrompt(task)
        return
      }
    }
    const next = goingToDone ? 'done' : 'todo'
    await window.lineup.setProjectMeta(task.id, { status: next })
    load()
  }, [load])

  const finishStepAndTask = useCallback(async (step: TaskViewRow) => {
    await window.lineup.setProjectMeta(step.id, { status: 'done' })
    if (step.task_id != null) {
      await window.lineup.setProjectMeta(step.task_id, { status: 'done' })
    }
    setLastStepPrompt(null)
    load()
  }, [load])

  const finishStepAndAddNext = useCallback(async (step: TaskViewRow, newStepName: string) => {
    await window.lineup.setProjectMeta(step.id, { status: 'done' })
    if (step.task_id != null) {
      await window.lineup.createSubProject(newStepName, step.task_id, 3, 'step')
    }
    setLastStepPrompt(null)
    load()
  }, [load])

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
                <TaskRow
                  key={t.id}
                  task={t}
                  onToggleDone={toggleDone}
                  onSelect={onSelectTask}
                  onJump={onJumpToTask}
                  isSelected={selectedTaskId === t.id}
                />
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
                <TaskRow
                  key={t.id}
                  task={t}
                  onToggleDone={toggleDone}
                  onSelect={onSelectTask}
                  onJump={onJumpToTask}
                  isSelected={selectedTaskId === t.id}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {lastStepPrompt && (
        <LastStepPrompt
          step={lastStepPrompt}
          onCancel={() => setLastStepPrompt(null)}
          onTaskDone={() => finishStepAndTask(lastStepPrompt)}
          onAddNextStep={(name) => finishStepAndAddNext(lastStepPrompt, name)}
        />
      )}
    </div>
  )
}


function LastStepPrompt({ step, onCancel, onTaskDone, onAddNextStep }: {
  step: TaskViewRow
  onCancel: () => void
  onTaskDone: () => void
  onAddNextStep: (newStepName: string) => void
}) {
  const [newStep, setNewStep] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const taskName = step.task_name || '该任务'
  const stepName = step.name

  function submit() {
    const n = newStep.trim()
    if (n) onAddNextStep(n)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
         onClick={onCancel}>
      <div
        className="w-[480px] max-w-[90vw] bg-popover border border-border rounded-lg shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border">
          <div className="text-sm font-semibold">✓ 完成 step：{stepName}</div>
          <div className="text-xs text-muted-foreground mt-1">
            这是 <span className="text-foreground/90">{taskName}</span> 下最后一个待做 step。
          </div>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <button
              onClick={onTaskDone}
              className="w-full px-3 py-2 rounded bg-primary text-primary-foreground text-sm hover:opacity-90 text-left"
            >
              ✓ 任务也已完成 — 把 <span className="font-medium">{taskName}</span> 也标记为 done
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground text-center">— 或 —</div>
          <div>
            <label className="text-xs text-muted-foreground">还需要做下一步：</label>
            <input
              ref={inputRef}
              type="text"
              value={newStep}
              onChange={e => setNewStep(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') onCancel()
              }}
              placeholder="例：写完后 review 一遍"
              className="mt-1 w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex justify-end mt-2">
              <button
                onClick={submit}
                disabled={!newStep.trim()}
                className="px-3 py-1.5 rounded border border-primary/60 text-primary text-sm hover:bg-primary/10 disabled:opacity-40"
              >➕ 新增下一步</button>
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-end">
          <button
            onClick={onCancel}
            className="text-xs text-muted-foreground hover:text-foreground"
          >取消（不标记完成）</button>
        </div>
      </div>
    </div>
  )
}
