import { useState, useEffect, useCallback } from 'react'
import type { TaskViewRow } from '../../../preload/index'
import { TaskRow } from './TaskViewShared'
import { ContextMenu, type MenuEntry } from '../ContextMenu'
import { sendToMainAgent } from '../../lib/sendToMainAgent'

interface InboxViewProps {
  refreshSignal: number
  onSelectTask: (task: TaskViewRow) => void
  onJumpToTask: (task: TaskViewRow) => void
  onQuickAdd: () => void
  selectedTaskId: number | null
}

export function InboxView({ refreshSignal, onSelectTask, onJumpToTask, onQuickAdd, selectedTaskId }: InboxViewProps) {
  const [tasks, setTasks] = useState<TaskViewRow[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number; task: TaskViewRow } | null>(null)

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

      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-2">
          {tasks.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-12">
              收件箱是空的 —— ⌘N 快速添加一个任务
            </div>
          ) : (
            <div className="space-y-0.5">
              {tasks.map(t => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onToggleDone={toggleDone}
                  onSelect={onSelectTask}
                  onJump={onJumpToTask}
                  onContextMenu={(task, e) => setMenu({ x: e.clientX, y: e.clientY, task })}
                  isSelected={selectedTaskId === t.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {menu && (() => {
        const t = menu.task
        const entries: MenuEntry[] = [
          {
            label: '💬 发送给通用 agent 处理',
            onClick: async () => {
              setMenu(null)
              const lines = [
                `任务: ${t.name}`,
                t.parent_name ? `所属项目: ${t.parent_name}` : '',
                t.due_at ? `截止: ${t.due_at.slice(0, 10)}` : '',
                t.reminder_every_days ? `每 ${t.reminder_every_days} 天提醒` : '',
                t.progress_note ? `\n备注:\n${t.progress_note}` : '',
              ].filter(Boolean)
              await sendToMainAgent(lines.join('\n'))
            },
          },
        ]
        return <ContextMenu x={menu.x} y={menu.y} items={entries} onClose={() => setMenu(null)} />
      })()}
    </div>
  )
}
