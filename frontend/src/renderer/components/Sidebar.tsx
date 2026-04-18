import { useState } from 'react'
import type { Project } from '../../preload/index'
import { cn } from '../lib/utils'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { InputDialog } from './InputDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { handleObjectDragOver, performDrop, setProjectDragData } from '../lib/drag'
import { PROJECT_COLORS } from './Inspector'

const priorityColors: Record<number, string> = {
  5: 'bg-red-500',
  4: 'bg-amber-500',
  3: 'bg-blue-500',
  2: 'bg-cyan-500',
  1: 'bg-slate-500',
}

export type SidebarView = 'columns' | 'today' | 'eisenhower' | 'inbox'

interface SidebarProps {
  projects: Project[]
  selectedId: number | null
  onSelect: (id: number) => void
  onRefresh: () => void
  // Called after a drag-drop has mutated objects so App can bump refreshSignal
  onObjectsChanged: () => void
  // Whether archived projects are currently being shown
  showArchived: boolean
  onToggleShowArchived: () => void
  // The currently active top-level view
  view: SidebarView
  onSelectView: (v: SidebarView) => void
  // Live counts for the top view buttons
  todayCount: number
  inboxCount: number
}

type DialogState =
  | null
  | { kind: 'new-project' }
  | { kind: 'rename-project'; project: Project }
  | { kind: 'confirm-delete'; project: Project }

export function Sidebar({
  projects, selectedId, onSelect, onRefresh, onObjectsChanged,
  showArchived, onToggleShowArchived,
  view, onSelectView, todayCount, inboxCount,
}: SidebarProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; target: Project | null } | null>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [dragOverId, setDragOverId] = useState<number | null>(null)

  function handleEmptyContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, target: null })
  }

  function handleProjectContextMenu(e: React.MouseEvent, p: Project) {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, target: p })
  }

  async function handleCreateProject(name: string) {
    await window.lineup.createProject(name, '', 3)
    setDialog(null)
    onRefresh()
  }

  async function handleDeleteProject(p: Project) {
    await window.lineup.deleteProject(p.id)
    setDialog(null)
    onRefresh()
  }

  async function handleRenameProject(p: Project, newName: string) {
    await window.lineup.renameProject(p.id, newName)
    setDialog(null)
    onRefresh()
  }

  const menuItems: MenuEntry[] = menu?.target
    ? [
        {
          label: '✏️ 重命名',
          onClick: () => setDialog({ kind: 'rename-project', project: menu.target! }),
        },
        {
          label: '🗑 删除项目',
          onClick: () => setDialog({ kind: 'confirm-delete', project: menu.target! }),
        },
      ]
    : [
        {
          label: '📁 新建项目',
          onClick: () => setDialog({ kind: 'new-project' }),
        },
      ]

  return (
    <aside
      className="w-64 min-w-48 max-w-80 border-r border-border bg-sidebar flex flex-col h-full"
      onContextMenu={handleEmptyContextMenu}
    >
      {/* Drag region / title bar */}
      <div className="h-12 flex items-center px-4 gap-2 border-b border-border app-drag-region">
        <span className="text-sm font-semibold text-sidebar-foreground pl-16">lineup</span>
        <span className="text-xs text-muted-foreground ml-auto">{projects.length} 项目</span>
      </div>

      {/* Project list */}
      <nav className="flex-1 overflow-y-auto py-2">
        {/* Top views — global, always visible above the project list */}
        <div className="pb-2 mb-2 border-b border-border">
          <ViewButton
            active={view === 'today'}
            onClick={() => onSelectView('today')}
            icon="📅"
            label="今天"
            count={todayCount}
          />
          <ViewButton
            active={view === 'eisenhower'}
            onClick={() => onSelectView('eisenhower')}
            icon="🎯"
            label="四象限"
          />
          <ViewButton
            active={view === 'inbox'}
            onClick={() => onSelectView('inbox')}
            icon="📋"
            label="收件箱"
            count={inboxCount}
          />
        </div>

        {/* Section header for projects */}
        <div className="px-4 mb-1 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">项目</span>
          <button
            onClick={() => onSelectView('columns')}
            className={cn(
              'text-[11px] px-1.5 py-0.5 rounded',
              view === 'columns' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
            title="回到项目列视图"
          >
            📁
          </button>
        </div>

        {projects.map(p => (
          <button
            key={p.id}
            draggable
            onDragStart={(e) => {
              setProjectDragData(e, {
                kind: 'project-ref',
                projectId: p.id,
                sourceParentId: 0,  // 0 = root level (no parent row)
                name: p.name,
              })
            }}
            onDragOver={(e) => { handleObjectDragOver(e); setDragOverId(p.id) }}
            onDragLeave={() => setDragOverId(prev => prev === p.id ? null : prev)}
            onDrop={async (e) => {
              e.preventDefault()
              setDragOverId(null)
              await performDrop(e, p.id, onObjectsChanged)
            }}
            onContextMenu={(e) => handleProjectContextMenu(e, p)}
            onClick={() => {
              // Clicking a project always returns to column view
              onSelectView('columns')
              onSelect(p.id)
            }}
            className={cn(
              'w-full text-left px-4 py-2 text-sm flex items-start gap-2',
              'hover:bg-accent/50 transition-colors',
              selectedId === p.id && 'bg-accent text-accent-foreground',
              dragOverId === p.id && 'bg-primary/20 ring-1 ring-primary ring-inset',
            )}
          >
            {/* Color dot(s) — own color, or inherited root ancestor colors */}
            {(() => {
              const colors: string[] = (p as any)._rootColors ?? (p.color ? [p.color] : [])
              if (colors.length > 0) {
                return (
                  <span className="flex gap-0.5 shrink-0 mt-1.5">
                    {colors.map((c, i) => (
                      <span key={i} className="w-2.5 h-2.5 rounded-full"
                        style={{ background: PROJECT_COLORS[c] || '#94a3b8' }} />
                    ))}
                  </span>
                )
              }
              return <span className={cn(
                'w-2 h-2 rounded-full mt-1.5 shrink-0',
                priorityColors[p.priority] || 'bg-slate-400'
              )} />
            })()}
            <div className="min-w-0 flex-1">
              <div className={cn(
                'font-medium truncate flex items-center gap-1',
                p.archived && 'italic text-muted-foreground',
                p.status === 'inactive' && 'text-muted-foreground opacity-60',
              )}>
                {p.pinned === 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      window.lineup.setProjectMeta(p.id, { pinned: 0 }).then(onRefresh)
                    }}
                    className="text-[10px] opacity-60 hover:opacity-100 shrink-0"
                    title="取消置顶"
                  >📌</button>
                )}
                <span className="truncate">{p.name}</span>
                {p.status === 'inactive' && <span className="text-[10px] opacity-60 shrink-0">⏸</span>}
              </div>
              {p.description && (
                <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                  {p.description}
                </div>
              )}
              {p.progress > 0 && (
                <div className="flex items-center gap-2 mt-1">
                  <div className="h-1 flex-1 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full"
                      style={{ width: `${p.progress}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground">{p.progress}%</span>
                </div>
              )}
            </div>
          </button>
        ))}
      </nav>

      {/* Bottom bar */}
      <div className="border-t border-border p-2 flex gap-1 items-center">
        <button
          onClick={onRefresh}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent transition-colors"
        >
          刷新
        </button>
        <button
          onClick={onToggleShowArchived}
          className={cn(
            'text-xs px-2 py-1 rounded hover:bg-accent transition-colors',
            showArchived ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
          title="切换显示已归档的项目"
        >
          {showArchived ? '隐藏归档' : '显示归档'}
        </button>
      </div>

      {/* Context menu */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}

      {/* Dialogs */}
      {dialog?.kind === 'new-project' && (
        <InputDialog
          title="新建根项目"
          placeholder="项目名称"
          onSubmit={handleCreateProject}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename-project' && (
        <InputDialog
          title={`重命名「${dialog.project.name}」`}
          placeholder="新名称"
          initial={dialog.project.name}
          onSubmit={(name) => handleRenameProject(dialog.project, name)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'confirm-delete' && (
        <ConfirmDialog
          title={`删除项目「${dialog.project.name}」？`}
          message="会级联删除这个项目及其所有子项目、子子项目等，以及它们的对象、待办、agents。不会删除真实的源文件。此操作不可撤销。"
          confirmLabel="删除"
          danger
          onConfirm={() => handleDeleteProject(dialog.project)}
          onCancel={() => setDialog(null)}
        />
      )}
    </aside>
  )
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  icon: string
  label: string
  count?: number
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-1.5 text-sm flex items-center gap-2',
        'hover:bg-accent/50 transition-colors',
        active && 'bg-accent text-accent-foreground'
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
      {count != null && count > 0 && (
        <span className="text-xs text-muted-foreground">{count}</span>
      )}
    </button>
  )
}
