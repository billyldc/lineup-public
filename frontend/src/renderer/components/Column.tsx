import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, ObjectRow, Todo, RegisteredType, BrowseItem, Agent } from '../../preload/index'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { InputDialog } from './InputDialog'
import { BrowseDialog } from './BrowseDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { filesystemPathForObject } from '../lib/utils'
import { PROJECT_COLORS } from './Inspector'
import { setObjectDragData, setProjectDragData, handleObjectDragOver, performDrop } from '../lib/drag'

const typeLabels: Record<string, string> = {
  file: '文件', folder: '文件夹', url: '链接', zotero: '文献',
  trilium: '笔记', obsidian: '笔记', script: '脚本',
}

interface ColumnProps {
  projectId: number
  selectedChildId: number | null
  selectedObjectBrowseId?: string | null
  onSelectChild: (id: number) => void
  onEnterObject?: (obj: ObjectRow) => void
  onOpenAgent?: (agent: Agent) => void
  onColumnsChanged: () => void
  isLast: boolean
  // Bumped by App whenever something project-wide changes (e.g. a drag-drop
  // moved an object into another project). Triggers a re-load of this
  // column's data so cross-column drops show up.
  refreshSignal?: number
}

type DialogState =
  | null
  | { kind: 'new-project' }
  | { kind: 'new-task' }
  | { kind: 'new-step' }
  | { kind: 'text-object-name'; type: RegisteredType }
  | { kind: 'text-object-target'; type: RegisteredType; name: string }
  | { kind: 'fs-object-name'; type: RegisteredType; target: string }
  | { kind: 'browse'; type: RegisteredType; source: 'obsidian' | 'trilium' | 'zotero' }
  | { kind: 'confirm-delete-project'; project: Project; parentCount: number }
  | { kind: 'confirm-delete-object'; object: ObjectRow }
  | { kind: 'rename-project'; project: Project }
  | { kind: 'rename-object'; object: ObjectRow }
  | { kind: 'relink-object'; object: ObjectRow }

const DEFAULT_COL_WIDTH = 288  // matches old w-72
const MIN_COL_WIDTH = 200
const MAX_COL_WIDTH = 700

function loadColWidth(projectId: number): number {
  const v = localStorage.getItem(`lineup:colWidth:${projectId}`)
  const n = v ? parseInt(v, 10) : NaN
  return Number.isFinite(n) && n >= MIN_COL_WIDTH && n <= MAX_COL_WIDTH ? n : DEFAULT_COL_WIDTH
}

export function Column({
  projectId,
  selectedChildId,
  selectedObjectBrowseId = null,
  onSelectChild,
  onEnterObject,
  onOpenAgent,
  onColumnsChanged,
  isLast,
  refreshSignal = 0,
}: ColumnProps) {
  const [selectedObjectId, setSelectedObjectId] = useState<number | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [subProjects, setSubProjects] = useState<Project[]>([])
  const [objects, setObjects] = useState<ObjectRow[]>([])
  const [todos, setTodos] = useState<Todo[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [registeredTypes, setRegisteredTypes] = useState<RegisteredType[]>([])
  const [dragOverTarget, setDragOverTarget] = useState<'self' | number | null>(null)
  const [width, setWidth] = useState<number>(() => loadColWidth(projectId))
  const dragStartX = useRef<number | null>(null)
  const dragStartWidth = useRef<number>(0)

  // Reload width when switching to a different project (each project has its own)
  useEffect(() => { setWidth(loadColWidth(projectId)) }, [projectId])

  useEffect(() => {
    localStorage.setItem(`lineup:colWidth:${projectId}`, String(width))
  }, [projectId, width])

  // Drag-to-resize the column's right edge
  const onResizeMove = useCallback((e: MouseEvent) => {
    if (dragStartX.current == null) return
    const delta = e.clientX - dragStartX.current
    const next = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, dragStartWidth.current + delta))
    setWidth(next)
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

  const load = useCallback(async () => {
    const [p, subs, objs, tds, ags] = await Promise.all([
      window.lineup.getProject(projectId),
      window.lineup.getSubProjects(projectId),
      window.lineup.getObjects(projectId),
      window.lineup.getTodos(projectId),
      window.lineup.listAgentsForProject(projectId),
    ])
    setProject(p ?? null)
    setSubProjects(subs)
    setObjects(objs)
    setTodos(tds)
    setAgents(ags)
  }, [projectId])

  useEffect(() => { load() }, [load, refreshSignal])

  // Shared refresh: reload this column AND tell App to refresh projects
  // list + other visible columns.
  const refreshAfterDrop = useCallback(() => {
    load()
    onColumnsChanged()
  }, [load, onColumnsChanged])

  // Compute the set of "blocked" step ids for sequential gating. A step
  // is blocked iff it has at least one step sibling earlier in the
  // ordering whose status != 'done'. Projects and tasks are never
  // blocked — sequential only applies to steps. getSubProjects already
  // returns rows ordered by (order_index, open_count, name) so we can
  // just scan.
  const blockedStepIds = (() => {
    const blocked = new Set<number>()
    let seenIncompleteStep = false
    for (const sp of subProjects) {
      if (sp.type !== 'step') continue
      if (seenIncompleteStep) {
        blocked.add(sp.id)
      } else if (sp.status !== 'done') {
        seenIncompleteStep = true
      }
    }
    return blocked
  })()

  // Toggle a task or step's done state. Uses setProjectMeta so we touch
  // only the status column — doesn't interfere with progress bars.
  async function toggleDone(sp: Project) {
    const next = sp.status === 'done' ? 'todo' : 'done'
    await window.lineup.setProjectMeta(sp.id, { status: next })
    load()
  }

  useEffect(() => {
    window.lineup.getRegisteredTypes().then(setRegisteredTypes)
  }, [])

  // What kind of row the current context menu is anchored to.
  // null = empty column area (show "insert" menu).
  // {project} = right-clicked a sub-project row.
  // {object} = right-clicked an object row.
  const [menuTarget, setMenuTarget] = useState<
    | null
    | { kind: 'project'; project: Project }
    | { kind: 'object'; object: ObjectRow }
  >(null)

  function handleColumnContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    setMenuTarget(null)
    setMenu({ x: e.clientX, y: e.clientY })
  }

  function handleProjectRowContextMenu(e: React.MouseEvent, sp: Project) {
    e.preventDefault()
    e.stopPropagation()
    setMenuTarget({ kind: 'project', project: sp })
    setMenu({ x: e.clientX, y: e.clientY })
  }

  function handleObjectRowContextMenu(e: React.MouseEvent, o: ObjectRow) {
    e.preventDefault()
    e.stopPropagation()
    setMenuTarget({ kind: 'object', object: o })
    setMenu({ x: e.clientX, y: e.clientY })
  }

  async function handleCreateProject(name: string) {
    await window.lineup.createSubProject(name, projectId, 3, 'project')
    setDialog(null)
    await load()
    onColumnsChanged()
  }

  async function handleCreateTask(name: string) {
    await window.lineup.createSubProject(name, projectId, 3, 'task')
    setDialog(null)
    await load()
    onColumnsChanged()
  }

  async function handleCreateStep(name: string) {
    await window.lineup.createSubProject(name, projectId, 3, 'step')
    setDialog(null)
    await load()
    onColumnsChanged()
  }

  async function handleCreateObject(name: string, target: string, type: string) {
    await window.lineup.linkObject(projectId, name, target, type)
    setDialog(null)
    await load()
    onColumnsChanged()
  }

  // Decide how to insert based on the type
  async function handleInsertType(t: RegisteredType) {
    if (t.name === 'file' || t.name === 'folder') {
      // Native Finder picker
      const target = await window.lineup.browseFile(t.name as 'file' | 'folder')
      if (!target) return
      setDialog({ kind: 'fs-object-name', type: t, target })
    } else if (t.name === 'obsidian') {
      setDialog({ kind: 'browse', type: t, source: 'obsidian' })
    } else if (t.name === 'trilium') {
      setDialog({ kind: 'browse', type: t, source: 'trilium' })
    } else if (t.name === 'zotero') {
      setDialog({ kind: 'browse', type: t, source: 'zotero' })
    } else {
      // url / script — text input
      setDialog({ kind: 'text-object-name', type: t })
    }
  }

  async function handleDeleteProject(p: Project, parentCount: number) {
    if (parentCount > 1) {
      // Multi-ref: just remove the link from THIS parent, keep the project
      await window.lineup.unlinkFromParent(p.id, projectId)
    } else {
      // Last (or only) copy: cascade delete
      await window.lineup.deleteProject(p.id)
    }
    setDialog(null)
    await load()
    onColumnsChanged()
  }

  async function handleDeleteObject(o: ObjectRow) {
    await window.lineup.removeObject(o.id)
    setDialog(null)
    await load()
  }

  async function handleRenameProject(p: Project, newName: string) {
    await window.lineup.renameProject(p.id, newName)
    setDialog(null)
    await load()
    onColumnsChanged()
  }

  async function handleRenameObject(o: ObjectRow, newName: string) {
    await window.lineup.renameObject(o.id, newName)
    setDialog(null)
    await load()
  }

  // Menu for empty-space right click: insertion options.
  //
  // Rules:
  // - If the parent column is a project → offer 插入任务 + 插入子项目 + 插入对象
  // - If it's a task → don't offer 插入任务 (tasks only contain agent-created steps)
  //   but still allow linking objects (files the task needs)
  // - If it's a step → nothing to insert manually (steps are atomic)
  const parentIsProject = !project?.type || project.type === 'project'
  const parentIsTask = project?.type === 'task'
  const parentIsStep = project?.type === 'step'

  const insertMenuItems: MenuEntry[] = parentIsStep
    ? []  // steps are atomic
    : [
        ...(parentIsProject ? [
          {
            label: '☐ 插入任务',
            onClick: () => setDialog({ kind: 'new-task' }),
          },
          {
            label: '📁 插入子项目',
            onClick: () => setDialog({ kind: 'new-project' }),
          },
          { separator: true },
        ] : []),
        ...(parentIsTask ? [
          {
            label: '☑ 插入 step',
            onClick: () => setDialog({ kind: 'new-step' }),
          },
          { separator: true },
        ] : []),
        ...registeredTypes.map(t => ({
          label: `📄 插入${t.label}`,
          onClick: () => handleInsertType(t),
        })),
      ]

  // Menu for right click on a specific row
  const rowMenuItems: MenuEntry[] = (() => {
    if (!menuTarget) return []
    if (menuTarget.kind === 'project') {
      return [
        {
          label: '✏️ 重命名',
          onClick: () => setDialog({ kind: 'rename-project', project: menuTarget.project }),
        },
        {
          label: '🗑 删除',
          onClick: async () => {
            const cnt = await window.lineup.getProjectParentCount(menuTarget.project.id)
            setDialog({ kind: 'confirm-delete-project', project: menuTarget.project, parentCount: cnt })
          },
        },
      ]
    }
    // Object row menu: rename + reveal in Finder + copy path + (for folders) open in vscode + delete
    const items: MenuEntry[] = [
      {
        label: '✏️ 重命名',
        onClick: () => setDialog({ kind: 'rename-object', object: menuTarget.object }),
      },
      { separator: true },
    ]
    const fsPath = filesystemPathForObject(menuTarget.object)
    const isFolder = menuTarget.object.type === 'folder'
    if (fsPath) {
      items.push(
        {
          label: '📂 在 Finder 中显示',
          onClick: () => window.lineup.revealInFinder(fsPath),
        },
        {
          label: '📋 复制路径',
          onClick: () => window.lineup.copyToClipboard(fsPath),
        },
      )
      if (isFolder) {
        items.push({
          label: '⌨ 在 VSCode 中打开',
          onClick: () => window.lineup.openInVscode(fsPath),
        })
        items.push({
          label: '🤖 在此文件夹新建 Claude agent',
          onClick: async () => {
            const agents = await window.lineup.listAgentsForFolder(fsPath)
            if (agents.length > 0) {
              // Already has agent — just open it
              onOpenAgent?.(agents[0])
              return
            }
            // No agent yet — open a new chat tab with claude in this folder
            const tabId = `folder:${fsPath}`
            // Emit the same handler path as handleOpenAgent for a fresh folder agent
            onOpenAgent?.({
              name: menuTarget.object.name,
              session_id: '',  // fresh session
              is_db: false,
              folder_path: fsPath,
            })
          },
        })
      }
      items.push({ separator: true })
    }
    // Relink: change the target path without deleting + re-adding
    items.push({
      label: '🔗 重新链接目标',
      onClick: () => setDialog({ kind: 'relink-object', object: menuTarget.object }),
    })
    items.push({ separator: true })
    items.push({
      label: '🗑 删除对象',
      onClick: () => setDialog({ kind: 'confirm-delete-object', object: menuTarget.object }),
    })
    return items
  })()

  const menuItems: MenuEntry[] = menuTarget ? rowMenuItems : insertMenuItems

  if (!project) {
    return (
      <div
        style={{ width }}
        className="border-r border-border p-4 text-muted-foreground shrink-0"
      >
        加载中...
      </div>
    )
  }

  return (
    <>
      <div
        style={{ width }}
        className="border-r border-border flex flex-col h-full shrink-0 overflow-hidden relative"
        onContextMenu={handleColumnContextMenu}
      >
        {/* Resize handle on the right edge */}
        <div
          onMouseDown={onResizeStart}
          className="absolute top-0 right-0 w-1 h-full cursor-ew-resize hover:bg-primary/40 z-10"
          title="拖动调整列宽"
        />
        {/* Column header — display only, NOT a drop target (drops go on the
            empty body area below). */}
        <div className="px-3 py-2 border-b border-border bg-card/50">
          <div className="font-medium text-sm truncate">{project.name}</div>
          {project.progress > 0 && (
            <div className="flex items-center gap-2 mt-1">
              <div className="h-1 flex-1 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${project.progress >= 80 ? 'bg-green-500' : project.progress >= 40 ? 'bg-amber-500' : 'bg-red-500'}`}
                  style={{ width: `${project.progress}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground">{project.progress}%</span>
            </div>
          )}
          {project.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{project.description}</p>
          )}
        </div>

        {/* Items list — also the drop target. Dropping anywhere in this
            scroll area (on a row OR on empty space) links/moves the dragged
            object into THIS column's project. Sub-project rows below have
            their own drop handler that stops propagation, so dropping
            directly on a sub-project row drops into the sub-project instead. */}
        <div
          className={`flex-1 overflow-y-auto transition-colors
            ${dragOverTarget === 'self' ? 'bg-primary/10 ring-2 ring-primary ring-inset' : ''}`}
          onDragOver={(e) => { handleObjectDragOver(e); setDragOverTarget('self') }}
          onDragLeave={(e) => {
            // Only clear if we actually left the container, not a child.
            if (e.currentTarget.contains(e.relatedTarget as Node)) return
            setDragOverTarget(null)
          }}
          onDrop={async (e) => {
            e.preventDefault()
            setDragOverTarget(null)
            await performDrop(e, projectId, refreshAfterDrop)
          }}
        >
          {/* Agents section */}
          {agents.length > 0 && (
            <div className="border-b border-border">
              {agents.map((ag) => (
                <button
                  key={`a:${ag.id ?? ag.session_id}`}
                  onClick={() => onOpenAgent?.(ag)}
                  className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-accent/50 transition-colors"
                >
                  <span className="text-xs">🤖</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{ag.name}</div>
                    {ag.last_active_at && (
                      <div className="text-xs text-muted-foreground">
                        最后活跃 {new Date(ag.last_active_at).toLocaleString('zh-CN')}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {subProjects.map(sp => {
            const isProject = sp.type === 'project' || !sp.type
            const isTask = sp.type === 'task'
            const isStep = sp.type === 'step'
            const isDone = sp.status === 'done'
            const isBlocked = isStep && blockedStepIds.has(sp.id)
            const isSelected = selectedChildId === sp.id
            const isDropTarget = dragOverTarget === sp.id

            // Drop handler: project/task accept drops (their contents belong
            // in that container); steps don't (sequential workflow).
            const acceptsDrop = !isStep
            const dropProps = acceptsDrop ? {
              onDragOver: (e: React.DragEvent) => { handleObjectDragOver(e); setDragOverTarget(sp.id) },
              onDragLeave: () => setDragOverTarget(prev => prev === sp.id ? null : prev),
              onDrop: async (e: React.DragEvent) => {
                e.preventDefault()
                e.stopPropagation()
                setDragOverTarget(null)
                await performDrop(e, sp.id, refreshAfterDrop)
              },
            } : {}

            return (
              <div
                key={`p:${sp.id}`}
                draggable={!isBlocked}
                onDragStart={(e) => {
                  if (isProject) {
                    setProjectDragData(e, {
                      kind: 'project-ref',
                      projectId: sp.id,
                      sourceParentId: projectId,
                      name: sp.name,
                    })
                  } else {
                    e.dataTransfer.setData('application/json', JSON.stringify({
                      type: 'project', id: sp.id, name: sp.name
                    }))
                  }
                }}
                {...dropProps}
                onContextMenu={(e) => handleProjectRowContextMenu(e, sp)}
                onClick={() => {
                  if (isBlocked) return
                  setSelectedObjectId(null)
                  onSelectChild(sp.id)
                }}
                className={`w-full text-left px-3 py-2 flex items-start gap-2 text-sm transition-colors
                  ${isSelected
                    ? 'bg-primary text-primary-foreground'
                    : isDropTarget
                      ? 'bg-primary/20 ring-1 ring-primary ring-inset'
                      : isBlocked
                        ? 'opacity-40 cursor-not-allowed'
                        : 'hover:bg-accent/50 cursor-pointer'
                  }`}
                title={isBlocked ? '需要先完成前面的 step' : undefined}
              >
                {/* Leading indicator: color dot for projects, checkbox for tasks/steps */}
                {isProject ? (
                  <ProjectColorDot colors={(sp as any)._rootColors} />
                ) : (
                  // Task = square checkbox, Step = circular checkbox
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (isBlocked) return
                      toggleDone(sp)
                    }}
                    disabled={isBlocked}
                    className={`shrink-0 mt-0.5 w-4 h-4 border flex items-center justify-center
                      ${isStep ? 'rounded-full' : 'rounded'}
                      ${isSelected ? 'border-primary-foreground' : 'border-border'}
                      ${isBlocked ? 'cursor-not-allowed' : 'hover:bg-accent/50'}`}
                    title={isDone ? '标记未完成' : '标记已完成'}
                  >
                    {isDone && <span className={`text-xs ${isSelected ? 'text-primary-foreground' : 'text-primary'}`}>✓</span>}
                    {isBlocked && !isDone && <span className="text-xs">🔒</span>}
                  </button>
                )}

                <span className={`flex-1 min-w-0 break-all ${isDone ? 'line-through opacity-60' : ''}`}>
                  {(sp as any).recurring_days > 0 && <span className="text-xs mr-1">🔁</span>}
                  {sp.name}
                </span>

                {/* Progress % (only for project/task with a set progress) */}
                {!isStep && sp.progress > 0 && (
                  <span className="text-xs opacity-60 shrink-0">{sp.progress}%</span>
                )}
                {/* Chevron only for things you can navigate into */}
                {!isStep && <span className="opacity-40 text-xs shrink-0">›</span>}
              </div>
            )
          })}

          {objects.map(o => {
            // An object row is "highlighted" if either:
            //  - it's the locally-selected row (setSelectedObjectId), OR
            //  - a BrowseColumn has been pushed for it (selectedObjectBrowseId)
            const isHighlighted = selectedObjectId === o.id || selectedObjectBrowseId === o.target
            return (
              <button
                key={`o:${o.id}`}
                draggable
                onDragStart={(e) => {
                  setObjectDragData(e, {
                    kind: 'object-link',
                    id: o.id,
                    name: o.name,
                    target: o.target,
                    type: o.type,
                    sourceProjectId: projectId,
                  })
                }}
                onContextMenu={(e) => handleObjectRowContextMenu(e, o)}
                onClick={() => {
                  setSelectedObjectId(o.id)
                  // Always push a column — handleEnterObject decides
                  // between browse (for folder-likes) and preview (for leaves)
                  onEnterObject?.(o)
                }}
                onDoubleClick={() => { window.lineup.openObject(o.id) }}
                className={`w-full text-left px-3 py-2 flex items-start gap-2 text-sm transition-colors
                  ${isHighlighted ? 'bg-primary text-primary-foreground' : 'hover:bg-accent/50'}`}
              >
                <span className={`text-xs px-1 py-0.5 rounded shrink-0 mt-0.5
                  ${isHighlighted ? 'bg-primary-foreground/20' : 'text-muted-foreground bg-muted'}`}>
                  {typeLabels[o.type] || o.type}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="break-all">{o.name}</div>
                  <div className={`text-xs break-all
                    ${isHighlighted ? 'opacity-70' : 'text-muted-foreground'}`}>
                    {o.target}
                  </div>
                </div>
                {o.has_children && <span className={`text-xs shrink-0 mt-0.5 ${isHighlighted ? 'opacity-70' : 'opacity-40'}`}>›</span>}
              </button>
            )
          })}

          {/* Legacy todos hidden — replaced by task + step hierarchy.
              Data stays in DB for backwards compat, just not shown. */}

          {subProjects.length === 0 && objects.length === 0 && (
            <div className="px-3 py-4 text-sm text-muted-foreground text-center">
              右键点击插入
            </div>
          )}
        </div>
      </div>

      {/* Right-click context menu */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => { setMenu(null); setMenuTarget(null) }}
        />
      )}

      {/* Dialogs */}
      {dialog?.kind === 'new-project' && (
        <InputDialog
          title={`在「${project.name}」下插入子项目`}
          placeholder="项目名称"
          onSubmit={handleCreateProject}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'new-task' && (
        <InputDialog
          title={`在「${project.name}」下插入任务`}
          placeholder="任务名称"
          onSubmit={handleCreateTask}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'new-step' && (
        <InputDialog
          title={`在「${project.name}」下插入 step`}
          placeholder="步骤内容（一行）"
          onSubmit={handleCreateStep}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Pure text input flow (url / script / zotero) */}
      {dialog?.kind === 'text-object-name' && (
        <InputDialog
          title={`插入${dialog.type.label} — 显示名称`}
          placeholder="对象名称"
          onSubmit={(name) => setDialog({ kind: 'text-object-target', type: dialog.type, name })}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'text-object-target' && (
        <InputDialog
          title={`插入${dialog.type.label}「${dialog.name}」— 目标`}
          placeholder={dialog.type.placeholder}
          onSubmit={(target) => handleCreateObject(dialog.name, target, dialog.type.name)}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* File / folder: target came from native picker, now ask for name */}
      {dialog?.kind === 'fs-object-name' && (
        <InputDialog
          title={`插入${dialog.type.label} — 显示名称`}
          placeholder={(() => {
            const parts = dialog.target.split('/')
            return parts[parts.length - 1] || dialog.target
          })()}
          onSubmit={(name) => handleCreateObject(name, dialog.target, dialog.type.name)}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Obsidian / Trilium: browse dialog */}
      {dialog?.kind === 'browse' && (
        <BrowseDialog
          source={dialog.source}
          title={`插入${dialog.type.label}`}
          onSelect={(item: BrowseItem) => {
            handleCreateObject(
              item.name.replace(/\/$/, ''),
              item.target,
              dialog.type.name
            )
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Rename dialogs */}
      {dialog?.kind === 'rename-project' && (
        <InputDialog
          title={`重命名「${dialog.project.name}」`}
          placeholder="新名称"
          initial={dialog.project.name}
          onSubmit={(name) => handleRenameProject(dialog.project, name)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename-object' && (
        <InputDialog
          title={`重命名「${dialog.object.name}」`}
          placeholder="新名称"
          initial={dialog.object.name}
          onSubmit={(name) => handleRenameObject(dialog.object, name)}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Delete confirmations */}
      {dialog?.kind === 'confirm-delete-project' && (
        <ConfirmDialog
          title={dialog.parentCount > 1
            ? `移除「${dialog.project.name}」的引用？`
            : `删除「${dialog.project.name}」？`}
          message={dialog.parentCount > 1
            ? `这个项目在 ${dialog.parentCount} 个位置出现。此操作只会移除当前位置的引用，项目数据、子项目、文件等全部保留。`
            : '⚠️ 这是这个项目的唯一副本。删除后会级联删除所有子项目、对象、agents，不可恢复！如果还有用，建议改为「归档」。'}
          confirmLabel={dialog.parentCount > 1 ? '移除引用' : '确认删除'}
          danger={dialog.parentCount <= 1}
          onConfirm={() => handleDeleteProject(dialog.project, dialog.parentCount)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'relink-object' && (
        <InputDialog
          title={`重新链接「${dialog.object.name}」的目标`}
          placeholder={dialog.object.target}
          initial={dialog.object.target}
          onSubmit={async (newTarget) => {
            if (newTarget !== dialog.object.target) {
              await window.lineup.relinkObject(dialog.object.id, newTarget)
            }
            setDialog(null)
            await load()
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'confirm-delete-object' && (
        <ConfirmDialog
          title={`删除对象「${dialog.object.name}」？`}
          message="只会从 lineup 中删除这条链接引用，不会删除实际文件/笔记。"
          confirmLabel="删除"
          danger
          onConfirm={() => handleDeleteObject(dialog.object)}
          onCancel={() => setDialog(null)}
        />
      )}
    </>
  )
}

/**
 * Color dot(s) for a sub-project row. Colors are pre-computed in
 * getSubProjects (server-side) and passed as a prop — no per-row IPC
 * call, so rendering N project rows doesn't flood the main process.
 */
function ProjectColorDot({ colors }: { colors?: string[] }) {
  const resolved = colors && colors.length > 0 ? colors : ['gray']
  return (
    <span className="flex gap-0.5 shrink-0 mt-1.5">
      {resolved.map((c, i) => (
        <span
          key={i}
          className="w-2.5 h-2.5 rounded-full"
          style={{ background: PROJECT_COLORS[c] || '#94a3b8' }}
        />
      ))}
    </span>
  )
}
