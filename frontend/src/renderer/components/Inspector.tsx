import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, ObjectRow } from '../../preload/index'

const typeLabels: Record<string, string> = {
  file: '文件', folder: '文件夹', url: '链接', zotero: '文献',
  trilium: '笔记', obsidian: '笔记', script: '脚本',
  mail: '邮件', contact: '联系人',
}

function weekdayCN(dateStr: string): string {
  const d = new Date(dateStr.slice(0, 10))
  if (Number.isNaN(d.getTime())) return ''
  // Chinese convention: week ends on Sunday. JS getDay() returns 0=Sun ...
  // 6=Sat, so we index directly with that — '周日' lands at index 0 which
  // is what getDay() emits for Sundays.
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(dateStr.slice(0, 10))
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const DEFAULT_INSPECTOR_WIDTH = 300
const MIN_INSPECTOR_WIDTH = 220
const MAX_INSPECTOR_WIDTH = 600
const STORAGE_WIDTH = 'lineup:inspectorWidth'
const STORAGE_VISIBLE = 'lineup:inspectorVisible'

interface InspectorProps {
  projectId: number | null
  refreshSignal: number
  onOpenMainAgent: (projectId: number) => void
  onProjectsChanged: () => void
  // When true, Inspector auto-expands. When false (e.g. user is viewing
  // a preview column), it auto-collapses. User can still manually toggle.
  autoVisible: boolean
}

export function Inspector({ projectId, refreshSignal, onOpenMainAgent, onProjectsChanged, autoVisible }: InspectorProps) {
  const [project, setProject] = useState<Project | null>(null)
  const [isRootProject, setIsRootProject] = useState(false)
  const [topObjects, setTopObjects] = useState<ObjectRow[]>([])
  const [currentSteps, setCurrentSteps] = useState<Array<{
    id: number; step_name: string; status: string; order_index: number
    task_name: string; task_id: number
  }>>([])
  const [expandedObjectIds, setExpandedObjectIds] = useState<Set<number>>(new Set())
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [editingProgress, setEditingProgress] = useState(false)
  const [progressDraft, setProgressDraft] = useState(0)
  const [progressNoteDraft, setProgressNoteDraft] = useState('')
  const [confirmArchive, setConfirmArchive] = useState(false)

  const [width, setWidth] = useState<number>(() => {
    const v = localStorage.getItem(STORAGE_WIDTH)
    const n = v ? parseInt(v, 10) : NaN
    return Number.isFinite(n) && n >= MIN_INSPECTOR_WIDTH && n <= MAX_INSPECTOR_WIDTH
      ? n : DEFAULT_INSPECTOR_WIDTH
  })
  const [manualOverride, setManualOverride] = useState<boolean | null>(null)
  // Auto-collapse when not viewing a project; auto-expand when viewing one.
  // Manual toggle (via ‹/› buttons) overrides until the autoVisible changes.
  const visible = manualOverride ?? autoVisible
  useEffect(() => { setManualOverride(null) }, [autoVisible])

  useEffect(() => { localStorage.setItem(STORAGE_WIDTH, String(width)) }, [width])

  // Reload project + top objects whenever the selected project changes or
  // the global refresh signal is bumped.
  const load = useCallback(async () => {
    if (projectId == null) {
      setProject(null)
      setTopObjects([])
      return
    }
    const [p, top, steps, parentCount] = await Promise.all([
      window.lineup.getProject(projectId),
      window.lineup.getTopObjects(projectId, 15),
      window.lineup.getCurrentSteps(projectId),
      window.lineup.getProjectParentCount(projectId),
    ])
    setProject(p ?? null)
    setTopObjects(top)
    setCurrentSteps(steps)
    setIsRootProject(parentCount === 0)
  }, [projectId])

  useEffect(() => { load() }, [load, refreshSignal])

  // Reset edit drafts when switching projects
  useEffect(() => {
    setEditingDescription(false)
    setEditingProgress(false)
    setExpandedObjectIds(new Set())
  }, [projectId])

  // Imperative ref to the date input so the "今天" button can push a
  // value into it without fighting the uncontrolled defaultValue flow.
  const dueRef = useRef<HTMLInputElement>(null)

  // ── Resize handle ───────────────────────────────────────────────
  const dragStartX = useRef<number | null>(null)
  const dragStartWidth = useRef<number>(0)
  const onResizeMove = useCallback((e: MouseEvent) => {
    if (dragStartX.current == null) return
    // Right-side panel: dragging LEFT increases width
    const delta = dragStartX.current - e.clientX
    setWidth(Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, dragStartWidth.current + delta)))
  }, [])
  const onResizeEnd = useCallback(() => {
    dragStartX.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onResizeMove)
    window.removeEventListener('mouseup', onResizeEnd)
  }, [onResizeMove])
  function onResizeStart(e: React.MouseEvent) {
    e.preventDefault()
    dragStartX.current = e.clientX
    dragStartWidth.current = width
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onResizeMove)
    window.addEventListener('mouseup', onResizeEnd)
  }

  // ── Edit handlers ────────────────────────────────────────────────
  function startEditDescription() {
    if (!project) return
    setDescriptionDraft(project.description || '')
    setEditingDescription(true)
  }
  async function saveDescription() {
    if (!project) return
    await window.lineup.setDescription(project.id, descriptionDraft)
    setEditingDescription(false)
    load()
  }

  function startEditProgress() {
    if (!project) return
    setProgressDraft(project.progress || 0)
    setProgressNoteDraft(project.progress_note || '')
    setEditingProgress(true)
  }
  async function saveProgress() {
    if (!project) return
    await window.lineup.setProgress(project.id, progressDraft, progressNoteDraft)
    setEditingProgress(false)
    load()
  }

  function toggleExpanded(id: number) {
    setExpandedObjectIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // Collapsed: show a thin vertical strip with a toggle button
  if (!visible) {
    return (
      <button
        onClick={() => setManualOverride(true)}
        className="w-6 border-l border-border bg-card/50 hover:bg-accent/50 flex items-center justify-center text-xs text-muted-foreground shrink-0"
        title="展开右侧详情面板"
      >
        ‹
      </button>
    )
  }

  return (
    <aside
      style={{ width }}
      className="border-l border-border bg-card/30 flex flex-col h-full shrink-0 relative overflow-hidden"
    >
      {/* Resize handle on the LEFT edge */}
      <div
        onMouseDown={onResizeStart}
        className="absolute top-0 left-0 w-1 h-full cursor-ew-resize hover:bg-primary/40 z-10"
        title="拖动调整宽度"
      />

      {/* Header */}
      <div className="px-4 py-2 border-b border-border bg-card/50 flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground">详情</span>
        <button
          onClick={() => setManualOverride(false)}
          className="text-xs text-muted-foreground hover:text-foreground"
          title="收起"
        >
          ›
        </button>
      </div>

      {projectId == null || !project ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-4 text-center">
          {projectId == null ? '从左侧选择一个项目' : '加载中...'}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Project title + status checkbox + main-agent launcher */}
          <div className="px-4 pt-3 pb-2 flex items-start gap-2">
            <button
              onClick={async () => {
                const nextStatus = project.status === 'done' ? 'todo' : 'done'
                await window.lineup.setProjectMeta(project.id, { status: nextStatus })
                load()
              }}
              className="shrink-0 mt-0.5 w-5 h-5 rounded border border-border flex items-center justify-center hover:bg-accent/50"
              title={project.status === 'done' ? '标记未完成' : '标记已完成'}
            >
              {project.status === 'done' && <span className="text-primary">✓</span>}
            </button>
            <div className={`text-base font-semibold break-all flex-1 ${project.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>
              {project.name}
            </div>
            <button
              onClick={() => onOpenMainAgent(project.id)}
              className="shrink-0 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:opacity-90"
              title="打开这个项目的主 agent（在虚拟项目文件夹里运行 claude）"
            >
              🤖 主 agent
            </button>
            {(project.type === 'project' || !project.type) && (
              <button
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('lineup:open-project-claude-md', {
                    detail: { projectId: project.id, projectName: project.name },
                  }))
                }}
                className="shrink-0 text-xs px-2 py-1 rounded border border-border hover:bg-accent"
                title="编辑这个项目主 agent 的 CLAUDE.md.manual（system prompt 叠层）"
              >
                📝
              </button>
            )}
          </div>

          {/* Corner actions: pin + archive (only for project type) */}
          {(project.type === 'project' || !project.type) && (
            <div className="px-4 py-1 flex items-center gap-1 justify-end">
              <button
                onClick={async () => {
                  await window.lineup.setProjectMeta(project.id, { pinned: project.pinned ? 0 : 1 })
                  onProjectsChanged()
                  load()
                }}
                className={`p-1.5 rounded hover:bg-accent/50 transition-colors ${
                  project.pinned ? 'text-primary' : 'text-muted-foreground'}`}
                title={project.pinned ? '取消置顶' : '置顶到主目录'}
              >
                📌
              </button>
              <button
                onClick={() => setConfirmArchive(true)}
                className="p-1.5 rounded hover:bg-accent/50 text-muted-foreground"
                title="归档（隐藏）"
              >
                🗑
              </button>
            </div>
          )}

          {/* Project management: pause switch + color (project-only) */}
          {(project.type === 'project' || !project.type) && (
            <section className="px-4 py-2 border-t border-border space-y-2">
              <Switch
                label="暂停"
                onLabel="⏸ 暂停" offLabel="▶ 活跃"
                active={project.status === 'inactive'}
                activeColor="bg-amber-500"
                onChange={async (paused) => {
                  await window.lineup.deactivateProject(project.id, !paused)
                  onProjectsChanged()
                  load()
                }}
              />
              {/* Only true root projects (no parents) can set their own
                  color. Sub-projects inherit from their root ancestor(s). */}
              {isRootProject && (
                <ColorPicker
                  value={project.color}
                  onChange={async (c) => {
                    await window.lineup.setProjectMeta(project.id, { color: c })
                    onProjectsChanged()
                    load()
                  }}
                />
              )}
            </section>
          )}

          {/* Archive confirmation dialog */}
          {confirmArchive && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConfirmArchive(false)}>
              <div className="bg-popover border border-border rounded-lg shadow-xl p-6 max-w-sm" onClick={e => e.stopPropagation()}>
                <div className="text-sm font-medium mb-2">归档「{project.name}」？</div>
                <div className="text-xs text-muted-foreground mb-4">
                  归档后这个项目会从侧边栏默认隐藏（点"显示归档"可以恢复）。数据不会被删除。
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setConfirmArchive(false)}
                    className="text-xs px-3 py-1.5 rounded hover:bg-accent"
                  >取消</button>
                  <button
                    onClick={async () => {
                      await window.lineup.setProjectMeta(project.id, { archived: 1 })
                      setConfirmArchive(false)
                      onProjectsChanged()
                      load()
                    }}
                    className="text-xs px-3 py-1.5 rounded bg-destructive text-destructive-foreground hover:opacity-90"
                  >确认归档</button>
                </div>
              </div>
            </div>
          )}

          {/* Planning section: switch toggles + dates + DDL countdown */}
          <section className="px-4 py-2 border-t border-border">
            <div className="text-xs text-muted-foreground mb-2">
              {project.type === 'task' ? '计划' : '默认属性（子任务继承）'}
            </div>
            <div className="space-y-2">
              <Switch
                label="重要"
                onLabel="重要" offLabel="不重要"
                active={project.important === 1}
                activeColor="bg-green-500"
                onChange={async (v) => {
                  await window.lineup.setProjectMeta(project.id, { important: v ? 1 : 0 })
                  load()
                }}
              />
              <Switch
                label="紧急"
                onLabel="紧急" offLabel="不紧急"
                active={project.urgent === 1}
                activeColor="bg-red-500"
                onChange={async (v) => {
                  await window.lineup.setProjectMeta(project.id, { urgent: v ? 1 : 0 })
                  load()
                }}
              />
            </div>
            {(project.type === 'task' || project.type === 'step') && (
              <div className="mt-3 space-y-2">
                {/* 截止 row: date input + "今天" button, then the countdown
                    on the very next line so the user can read both
                    together without the 每N天提醒 field splitting them. */}
                <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-2 items-center text-xs">
                  <label className="text-muted-foreground">截止</label>
                  <div className="flex gap-1 items-center">
                    <input
                      ref={dueRef}
                      key={`due-${project.id}`}
                      type="date"
                      defaultValue={project.due_at ? project.due_at.slice(0, 10) : ''}
                      onBlur={async e => {
                        const v = e.target.value || null
                        const current = project.due_at ? project.due_at.slice(0, 10) : null
                        if (v !== current) {
                          await window.lineup.setProjectMeta(project.id, { due_at: v })
                          load()
                        }
                      }}
                      className="bg-input border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring flex-1"
                    />
                    {project.due_at && (
                      <span className="px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground shrink-0 text-[11px]">
                        {weekdayCN(project.due_at)}
                      </span>
                    )}
                  </div>
                  {/* DDL quick-modifiers — 今天 / +N — all change due_at,
                      grouped on one line so the inputs above don't get
                      cluttered. +N extends the current due if set, else
                      counts from today. */}
                  <span />
                  <div className="flex gap-1 flex-wrap">
                    <button
                      onClick={async () => {
                        const d = new Date()
                        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                        if (dueRef.current) dueRef.current.value = today
                        await window.lineup.setProjectMeta(project.id, { due_at: today })
                        load()
                      }}
                      className="px-2 py-0.5 rounded border border-border/70 text-muted-foreground hover:bg-accent/50 text-[11px]"
                      title="设为今天"
                    >今天</button>
                    {[
                      { label: '+1 天',  days: 1 },
                      { label: '+3 天',  days: 3 },
                      { label: '+1 周',  days: 7 },
                      { label: '+2 周',  days: 14 },
                    ].map(opt => (
                      <button
                        key={opt.days}
                        onClick={async () => {
                          const base = project.due_at
                            ? project.due_at.slice(0, 10)
                            : (() => {
                                const d = new Date()
                                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                              })()
                          const next = addDaysToDateStr(base, opt.days)
                          if (dueRef.current) dueRef.current.value = next
                          await window.lineup.setProjectMeta(project.id, { due_at: next })
                          load()
                        }}
                        className="px-2 py-0.5 rounded border border-border/70 text-muted-foreground hover:bg-accent/50 text-[11px]"
                        title={project.due_at ? `从当前截止日期顺延 ${opt.days} 天` : `从今天起 ${opt.days} 天后`}
                      >{opt.label}</button>
                    ))}
                  </div>
                  {/* DDL countdown — sits right under the due date for easy
                      visual calculation, NOT after the reminder field. */}
                  {project.due_at && (() => {
                    const due = new Date(project.due_at.slice(0, 10))
                    const now = new Date()
                    now.setHours(0, 0, 0, 0)
                    const diff = Math.ceil((due.getTime() - now.getTime()) / 86_400_000)
                    const cls = diff <= 0 ? 'text-red-400' : diff <= 3 ? 'text-amber-400' : 'text-muted-foreground'
                    const text = diff < 0 ? `已过期 ${-diff} 天` : diff === 0 ? '今天到期' : `还有 ${diff} 天`
                    return (
                      <>
                        <span />
                        <div className={`text-xs ${cls}`}>⏱ {text} · {weekdayCN(project.due_at)}</div>
                      </>
                    )
                  })()}
                  <label className="text-muted-foreground">每 N 天提醒</label>
                  <input
                    key={`reminder-${project.id}`}
                    type="number"
                    min={0}
                    placeholder="不提醒"
                    defaultValue={project.reminder_every_days ?? ''}
                    onBlur={async e => {
                      const raw = e.target.value
                      const n = raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0)
                      const nextVal = n === 0 ? null : n
                      if (nextVal !== (project.reminder_every_days ?? null)) {
                        await window.lineup.setProjectMeta(project.id, { reminder_every_days: nextVal })
                        load()
                      }
                    }}
                    className="bg-input border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring w-20"
                  />
                </div>
                {/* Recurring task toggle */}
                <div className="mt-3 space-y-1">
                  <Switch
                    label="重复"
                    onLabel="🔁 重复" offLabel="一次性"
                    active={!!project.recurring_days && project.recurring_days > 0}
                    activeColor="bg-blue-500"
                    onChange={async (on) => {
                      await window.lineup.setProjectMeta(project.id, {
                        recurring_days: on ? 7 : null
                      })
                      load()
                    }}
                  />
                  {project.recurring_days && project.recurring_days > 0 && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>每</span>
                      <input
                        key={`rec-${project.id}`}
                        type="number"
                        min={1}
                        defaultValue={project.recurring_days}
                        onBlur={async e => {
                          const n = parseInt(e.target.value, 10)
                          if (Number.isFinite(n) && n > 0 && n !== project.recurring_days) {
                            await window.lineup.setProjectMeta(project.id, { recurring_days: n })
                            load()
                          }
                        }}
                        className="w-14 bg-input border border-border rounded px-1 py-0.5 text-center"
                      />
                      <span>天重复一次</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Current steps summary: the first incomplete step of each active
              task in this project. Only shown for project-type items. */}
          {(project.type === 'project' || !project.type) && currentSteps.length > 0 && (
            <section className="px-4 py-2 border-t border-border">
              <div className="text-xs text-muted-foreground mb-1">当前进展 ({currentSteps.length})</div>
              <ul className="space-y-1 -mx-1">
                {currentSteps.map(s => (
                  <li key={s.id} className="text-xs px-2 py-1 rounded hover:bg-accent/30">
                    <div className="text-muted-foreground truncate">{s.task_name}</div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-[10px] px-1 bg-primary/20 text-primary rounded">step</span>
                      <span className="break-all">{s.step_name}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Description (click to edit) */}
          <section className="px-4 py-2 border-t border-border">
            <div className="text-xs text-muted-foreground mb-1">简介</div>
            {editingDescription ? (
              <textarea
                value={descriptionDraft}
                onChange={e => setDescriptionDraft(e.target.value)}
                onBlur={saveDescription}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveDescription()
                  if (e.key === 'Escape') setEditingDescription(false)
                }}
                autoFocus
                rows={3}
                placeholder="项目简介"
                className="w-full text-sm bg-input border border-border rounded p-2 focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              />
            ) : (
              <div
                onClick={startEditDescription}
                className="text-sm break-words cursor-text hover:bg-accent/30 rounded px-2 py-1 -mx-2 min-h-[1.5em]"
                title="单击编辑"
              >
                {project.description || <span className="text-muted-foreground italic">点击添加简介</span>}
              </div>
            )}
          </section>

          {/* Progress — auto-computed, read-only. Hidden for step type.
              - task: done_steps / total_steps * 100
              - project: weighted avg of children
              Both are computed server-side in getProject/getSubProjects. */}
          {project.type !== 'step' && (
            <section className="px-4 py-2 border-t border-border">
              <div className="text-xs text-muted-foreground mb-1">
                进度 <span className="opacity-60">(自动)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 flex-1 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      project.progress >= 80 ? 'bg-green-500'
                      : project.progress >= 40 ? 'bg-amber-500'
                      : project.progress > 0 ? 'bg-blue-500'
                      : 'bg-muted'
                    }`}
                    style={{ width: `${project.progress}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{project.progress}%</span>
              </div>
            </section>
          )}

          {/* Top objects by weighted recency score */}
          <section className="px-4 py-2 border-t border-border">
            <div className="text-xs text-muted-foreground mb-1">最常用 ({topObjects.length})</div>
            {topObjects.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">暂无</div>
            ) : (
              <ul className="space-y-0.5 -mx-2">
                {topObjects.map(o => {
                  const expanded = expandedObjectIds.has(o.id)
                  return (
                    <li key={o.id}>
                      <div
                        onClick={() => toggleExpanded(o.id)}
                        onDoubleClick={() => window.lineup.openObject(o.id)}
                        className="cursor-pointer hover:bg-accent/40 rounded px-2 py-1 flex items-start gap-2"
                        title="单击展开路径，双击打开"
                      >
                        <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground shrink-0 mt-0.5">
                          {typeLabels[o.type] || o.type}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm break-all">{o.name}</div>
                          {expanded && (
                            <div className="text-xs text-muted-foreground break-all mt-0.5">{o.target}</div>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </aside>
  )
}

/**
 * iOS-style switch toggle: a sliding pill that shows on/off label text.
 */
function Switch({
  label,
  onLabel,
  offLabel,
  active,
  activeColor,
  onChange,
}: {
  label: string
  onLabel: string
  offLabel: string
  active: boolean
  activeColor: string
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        onClick={() => onChange(!active)}
        className={`relative w-16 h-6 rounded-full transition-colors ${active ? activeColor : 'bg-muted'}`}
      >
        {/* Sliding dot */}
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all
          ${active ? 'left-[calc(100%-1.375rem)]' : 'left-0.5'}`}
        />
        {/* Label inside the track */}
        <span className={`absolute inset-0 flex items-center text-[10px] font-medium transition-opacity
          ${active ? 'justify-start pl-1.5 text-white' : 'justify-end pr-1.5 text-muted-foreground'}`}>
          {active ? onLabel : offLabel}
        </span>
      </button>
    </div>
  )
}

/**
 * Preset-color picker. 8 choices + clear (null). The chosen color shows
 * up in the sidebar as the project row's dot (replacing the
 * priority-based fallback color).
 */
export const PROJECT_COLORS: Record<string, string> = {
  red:    '#ef4444',
  amber:  '#f59e0b',
  yellow: '#eab308',
  green:  '#22c55e',
  teal:   '#14b8a6',
  blue:   '#3b82f6',
  purple: '#a855f7',
  pink:   '#ec4899',
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string | null
  onChange: (color: string | null) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(PROJECT_COLORS).map(([name, hex]) => {
        const active = value === name
        return (
          <button
            key={name}
            onClick={() => onChange(active ? null : name)}
            className={`w-5 h-5 rounded-full transition-all ${active ? 'ring-2 ring-foreground ring-offset-1 ring-offset-card' : 'hover:scale-110'}`}
            style={{ background: hex }}
            title={name + (active ? ' (已选,点击清除)' : '')}
          />
        )
      })}
    </div>
  )
}
