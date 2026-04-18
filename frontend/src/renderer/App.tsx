import { useState, useEffect, useCallback, useRef } from 'react'
import { Sidebar, type SidebarView } from './components/Sidebar'
import { Column } from './components/Column'
import { BrowseColumn, type BrowseSource } from './components/BrowseColumn'
import { PreviewColumn } from './components/PreviewColumn'
import { ChatPanel, type ChatTab } from './components/ChatPanel'
import { Inspector } from './components/Inspector'
import { TodayView } from './components/views/TodayView'
import { EisenhowerView } from './components/views/EisenhowerView'
import { InboxView } from './components/views/InboxView'
import { InputDialog } from './components/InputDialog'
import type { Project, ObjectRow, Agent, TaskViewRow } from '../preload/index'

/**
 * Each entry in the navigation path represents one column.
 *
 * - project: a lineup project, shown by <Column projectId=.../>
 * - browse: a folder-like object being browsed live from a plugin source,
 *           shown by <BrowseColumn .../>. target is the filesystem path or
 *           trilium noteId that the source understands.
 */
export type NavEntry =
  | { kind: 'project'; id: number }
  | { kind: 'browse'; source: BrowseSource; target: string; label: string }
  | { kind: 'preview'; objectType: string; target: string; label: string }

function entryKey(entry: NavEntry): string {
  if (entry.kind === 'project') return `p:${entry.id}`
  if (entry.kind === 'browse') return `b:${entry.source}:${entry.target}`
  return `v:${entry.objectType}:${entry.target}`
}

// Default cwd for the "通用" tab — read from preload (which computes
// os.homedir() + '/.lineup') so no hardcoded path.
const LINEUP_HOME = window.lineup.LINEUP_HOME

const defaultTab = (): ChatTab => ({
  id: 'default',
  label: '通用',
  cwd: LINEUP_HOME,
  command: 'claude',
  closable: false,
})

// localStorage keys for chat panel state — survive app restarts so agent
// tabs auto-resume their claude sessions when the user reopens lineup.
const STORAGE_TABS = 'lineup:chatTabs'
const STORAGE_ACTIVE = 'lineup:chatActiveTabId'
const STORAGE_VISIBLE = 'lineup:chatVisible'

function loadStoredTabs(): ChatTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_TABS)
    if (!raw) return [defaultTab()]
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return [defaultTab()]
    // Always replace the default tab's cwd with the current LINEUP_HOME
    // so config changes take effect even when tabs are cached in localStorage.
    const updated = parsed.map((t: ChatTab) =>
      t.id === 'default' ? { ...t, cwd: LINEUP_HOME } : t
    )
    const hasDefault = updated.some((t: ChatTab) => t.id === 'default')
    return hasDefault ? updated : [defaultTab(), ...updated]
  } catch {
    return [defaultTab()]
  }
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [path, setPath] = useState<NavEntry[]>([])
  const [chatVisible, setChatVisible] = useState<boolean>(
    () => localStorage.getItem(STORAGE_VISIBLE) === '1'
  )
  const [chatTabs, setChatTabs] = useState<ChatTab[]>(() => loadStoredTabs())
  const [activeTabId, setActiveTabId] = useState<string>(
    () => localStorage.getItem(STORAGE_ACTIVE) || 'default'
  )

  // Persist chat panel state on every change so the same set of tabs comes
  // back across app restarts. Each agent tab's pty respawns with its same
  // `claude --resume <session_id>` so the conversation history is preserved
  // by claude itself.
  useEffect(() => {
    localStorage.setItem(STORAGE_TABS, JSON.stringify(chatTabs))
  }, [chatTabs])
  useEffect(() => {
    localStorage.setItem(STORAGE_ACTIVE, activeTabId)
  }, [activeTabId])
  useEffect(() => {
    localStorage.setItem(STORAGE_VISIBLE, chatVisible ? '1' : '0')
  }, [chatVisible])
  // Bumped whenever a drag-drop or other cross-column mutation happens.
  // Each <Column> re-runs its load() when this changes.
  const [refreshSignal, setRefreshSignal] = useState(0)
  const [showArchived, setShowArchived] = useState<boolean>(
    () => localStorage.getItem('lineup:showArchived') === '1'
  )
  useEffect(() => {
    localStorage.setItem('lineup:showArchived', showArchived ? '1' : '0')
  }, [showArchived])

  // Top-level view. 'columns' is the default Miller-column project browser;
  // the other three are filtered task lists.
  const [view, setView] = useState<SidebarView>(
    () => (localStorage.getItem('lineup:view') as SidebarView) || 'columns'
  )
  useEffect(() => { localStorage.setItem('lineup:view', view) }, [view])

  // Live counts for the sidebar view buttons. Refetched on every refreshSignal.
  const [todayCount, setTodayCount] = useState(0)
  const [inboxCount, setInboxCount] = useState(0)
  useEffect(() => {
    window.lineup.getTodayTasks().then(ts => setTodayCount(ts.length))
    window.lineup.getInboxTasks().then(ts => setInboxCount(ts.length))
  }, [refreshSignal, view])

  // Quick-add dialog state
  const [quickAddOpen, setQuickAddOpen] = useState(false)

  const columnsRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const list = await window.lineup.listProjects({ includeArchived: showArchived })
    setProjects(list)
  }, [showArchived])

  // "Objects changed somewhere" — refresh projects list + force every
  // <Column> to reload via refreshSignal.
  const handleObjectsChanged = useCallback(() => {
    setRefreshSignal(k => k + 1)
    refresh()
  }, [refresh])

  // Watch for DB mutations from outside the renderer (i.e. MCP server
  // writing on behalf of an agent). Debounced in main to ~400ms.
  useEffect(() => {
    const unsub = window.lineup.onDbExternalChange(() => {
      handleObjectsChanged()
    })
    return unsub
  }, [handleObjectsChanged])

  useEffect(() => { refresh() }, [refresh])

  // Auto-scroll right when new columns appear
  useEffect(() => {
    if (columnsRef.current) {
      columnsRef.current.scrollLeft = columnsRef.current.scrollWidth
    }
  }, [path.length])

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setPath(p => p.length > 0 ? p.slice(0, -1) : p)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setPath([])
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  const handleSelectRoot = (id: number) => {
    setPath([{ kind: 'project', id }])
  }

  // Switch from a task-list view back to the Miller columns focused on
  // the task's parent project (or just the task itself if orphan).
  const handleJumpToTask = async (task: TaskViewRow) => {
    setView('columns')
    if (task.parent_id != null) {
      // Stack the parent project + the task so the Inspector and
      // Miller column both show the right thing.
      setPath([
        { kind: 'project', id: task.parent_id },
        { kind: 'project', id: task.id },
      ])
    } else {
      // Orphan task — just show its own column
      setPath([{ kind: 'project', id: task.id }])
    }
  }

  // ⌘N quick-add: creates an orphan task and jumps to the inbox view.
  const handleQuickAdd = async (name: string) => {
    if (!name.trim()) return
    await window.lineup.quickAddTask(name.trim())
    setQuickAddOpen(false)
    setView('inbox')
    handleObjectsChanged()
  }

  // Global ⌘N / Ctrl+N listener for quick-add
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        // Don't steal from text inputs / textareas — user may be typing
        const tgt = e.target as HTMLElement | null
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return
        e.preventDefault()
        setQuickAddOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Select a child at depth N: truncate to depth+1 and append.
  const pushAt = (depth: number, entry: NavEntry) => {
    setPath(p => [...p.slice(0, depth + 1), entry])
  }

  // When a sub-project is clicked inside a project Column
  const handleSelectSubProject = (depth: number, childId: number) => {
    pushAt(depth, { kind: 'project', id: childId })
  }

  // When an object is clicked inside a project Column:
  //  - folder-like → push BrowseColumn
  //  - leaf → push PreviewColumn
  const handleEnterObject = (depth: number, obj: ObjectRow) => {
    if (obj.has_children) {
      let source: BrowseSource | null = null
      if (obj.type === 'obsidian') source = 'obsidian'
      else if (obj.type === 'trilium') source = 'trilium'
      else if (obj.type === 'folder') source = 'fs'
      else if (obj.type === 'zotero') source = 'zotero'
      if (source) {
        pushAt(depth, { kind: 'browse', source, target: obj.target, label: obj.name })
        return
      }
    }
    // Leaf: preview column
    pushAt(depth, {
      kind: 'preview',
      objectType: obj.type,
      target: obj.target,
      label: obj.name,
    })
  }

  // When an item is clicked inside a BrowseColumn:
  //  - folder → push another BrowseColumn
  //  - leaf   → push PreviewColumn
  const handleEnterBrowseChild = (
    depth: number,
    source: BrowseSource,
    itemId: string,
    itemName: string,
    itemType: string,  // BrowseItem.type
  ) => {
    const isDir = itemName.endsWith('/') || itemType === 'folder' ||
      (source === 'trilium' && itemName.includes(''))
    const cleanName = itemName.replace(/\/$/, '')

    if (source === 'fs') {
      // For fs: use itemType (file vs folder) directly
      if (itemType === 'folder') {
        pushAt(depth, { kind: 'browse', source, target: itemId, label: cleanName })
      } else {
        pushAt(depth, { kind: 'preview', objectType: 'file', target: itemId, label: cleanName })
      }
      return
    }

    if (source === 'obsidian') {
      // Obsidian browse returns type=folder for dirs, type=file for .md
      if (itemType === 'folder') {
        pushAt(depth, { kind: 'browse', source, target: itemId, label: cleanName })
      } else {
        pushAt(depth, { kind: 'preview', objectType: 'obsidian', target: itemId, label: cleanName })
      }
      return
    }

    if (source === 'trilium') {
      // Trilium: determine via preview (no cheap way from renderer).
      // For now: if name ends with '/' → treat as folder.
      if (itemName.endsWith('/')) {
        pushAt(depth, { kind: 'browse', source, target: itemId, label: cleanName })
      } else {
        pushAt(depth, { kind: 'preview', objectType: 'trilium', target: itemId, label: cleanName })
      }
      return
    }

    if (source === 'zotero') {
      // Zotero: collection URIs are folders, item URIs are leaves.
      // The browse plugin returns folder names with a trailing '/' so we
      // can also fall back to that as a hint, but the URI prefix is the
      // authoritative test.
      const isCollection = itemId.startsWith('zotero://select/library/collections/')
      if (isCollection) {
        pushAt(depth, { kind: 'browse', source, target: itemId, label: cleanName })
      } else {
        pushAt(depth, { kind: 'preview', objectType: 'zotero', target: itemId, label: cleanName })
      }
      return
    }

    // Fallback
    if (isDir) {
      pushAt(depth, { kind: 'browse', source, target: itemId, label: cleanName })
    } else {
      pushAt(depth, { kind: 'preview', objectType: 'file', target: itemId, label: cleanName })
    }
  }

  // ── Chat tabs (each tab hosts a real pty terminal) ──────────────────

  const handleOpenAgent = (agent: Agent) => {
    const hasSession = agent.session_id && agent.session_id.length > 0
    const tabId = agent.id != null
      ? `agent:${agent.id}`
      : hasSession
        ? `session:${agent.session_id}`
        : `folder:${agent.folder_path ?? agent.name}`
    const cwd = agent.folder_path ?? HOME
    const alreadyExists = chatTabs.some(t => t.id === tabId)

    if (!alreadyExists) {
      const newTab: ChatTab = {
        id: tabId,
        label: agent.name.length > 30 ? agent.name.slice(0, 30) + '…' : agent.name,
        cwd,
        // If session exists, resume it; otherwise start fresh (zshrc wrapper
        // will create + store the session automatically).
        command: hasSession ? `claude --resume ${agent.session_id}` : 'claude',
        closable: true,
      }
      setChatTabs(prev => [...prev, newTab])
    }
    setActiveTabId(tabId)
    setChatVisible(true)
  }

  const handleActivateTab = (tabId: string) => setActiveTabId(tabId)

  const handleCloseTab = (tabId: string) => {
    setChatTabs(prev => prev.filter(t => t.id !== tabId))
    if (activeTabId === tabId) setActiveTabId('default')
  }

  // Spawn (or re-activate) the main agent tab for a project. The main
  // agent's pty runs in the project's virtual folder at
  // ~/.lineup/projects/<slug>/ which lineup keeps in sync with the DB.
  const handleOpenMainAgent = async (pid: number) => {
    const tabId = `project:${pid}`
    // If already open, just activate
    if (chatTabs.some(t => t.id === tabId)) {
      setActiveTabId(tabId)
      setChatVisible(true)
      return
    }
    const info = await window.lineup.ensureMainAgent(pid)
    if (!info) return
    const project = projects.find(p => p.id === pid)
    const label = project ? `⭐ ${project.name}` : `project ${pid}`
    const command = info.sessionId ? `claude --resume ${info.sessionId}` : 'claude'
    const newTab: ChatTab = {
      id: tabId,
      label: label.length > 30 ? label.slice(0, 30) + '…' : label,
      cwd: info.cwd,
      command,
      closable: true,
    }
    setChatTabs(prev => [...prev, newTab])
    setActiveTabId(tabId)
    setChatVisible(true)
  }

  // Figure out which child id/key at each column is currently selected (so
  // we can highlight it when showing the next column).
  // For browse/preview entries, the `target` serves as the child id in the
  // parent column's list (since both Column and BrowseColumn key leaves by
  // their target/id).
  const selectedChildAt = (depth: number): { projectId: number | null; browseId: string | null } => {
    const next = path[depth + 1]
    if (!next) return { projectId: null, browseId: null }
    if (next.kind === 'project') return { projectId: next.id, browseId: null }
    return { projectId: null, browseId: next.target }
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="flex flex-1 min-h-0">
        <Sidebar
          projects={projects}
          selectedId={path[0]?.kind === 'project' ? path[0].id : null}
          onSelect={handleSelectRoot}
          onRefresh={refresh}
          onObjectsChanged={handleObjectsChanged}
          showArchived={showArchived}
          onToggleShowArchived={() => setShowArchived(v => !v)}
          view={view}
          onSelectView={setView}
          todayCount={todayCount}
          inboxCount={inboxCount}
        />

        {view === 'today' && (
          <TodayView refreshSignal={refreshSignal} onJumpToTask={handleJumpToTask} />
        )}
        {view === 'eisenhower' && (
          <EisenhowerView refreshSignal={refreshSignal} onJumpToTask={handleJumpToTask} />
        )}
        {view === 'inbox' && (
          <InboxView
            refreshSignal={refreshSignal}
            onJumpToTask={handleJumpToTask}
            onQuickAdd={() => setQuickAddOpen(true)}
          />
        )}
        {view === 'columns' && <div
          ref={columnsRef}
          className="flex-1 flex overflow-x-auto bg-background"
        >
          {path.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <p className="text-lg mb-1">lineup</p>
                <p className="text-sm">← 从侧边栏选择项目</p>
                <p className="text-sm">→ 进入子项目 · ← 返回 · Esc 回主页</p>
                <p className="text-xs mt-3 opacity-60">⌘N 快速添加任务到收件箱</p>
              </div>
            </div>
          ) : (
            path.map((entry, depth) => {
              const sel = selectedChildAt(depth)
              if (entry.kind === 'project') {
                return (
                  <Column
                    key={`${depth}:${entryKey(entry)}`}
                    projectId={entry.id}
                    selectedChildId={sel.projectId}
                    selectedObjectBrowseId={sel.browseId}
                    onSelectChild={(childId) => handleSelectSubProject(depth, childId)}
                    onEnterObject={(obj) => handleEnterObject(depth, obj)}
                    onOpenAgent={handleOpenAgent}
                    onColumnsChanged={handleObjectsChanged}
                    refreshSignal={refreshSignal}
                    isLast={depth === path.length - 1}
                  />
                )
              }
              if (entry.kind === 'browse') {
                return (
                  <BrowseColumn
                    key={`${depth}:${entryKey(entry)}`}
                    source={entry.source}
                    target={entry.target}
                    label={entry.label}
                    selectedChildId={sel.browseId}
                    onSelectChild={(itemId, item) => handleEnterBrowseChild(depth, entry.source, itemId, item.name, item.type)}
                    onOpenAgent={handleOpenAgent}
                  />
                )
              }
              // Preview column
              return (
                <PreviewColumn
                  key={`${depth}:${entryKey(entry)}`}
                  objectType={entry.objectType}
                  target={entry.target}
                  label={entry.label}
                />
              )
            })
          )}
        </div>}

        <Inspector
          projectId={(() => {
            for (let i = path.length - 1; i >= 0; i--) {
              if (path[i].kind === 'project') return (path[i] as { kind: 'project'; id: number }).id
            }
            return null
          })()}
          // Auto-collapse when user is looking at a preview/browse (last
          // path entry isn't a project). Auto-expand when viewing a project.
          autoVisible={path.length === 0 || path[path.length - 1].kind === 'project'}
          refreshSignal={refreshSignal}
          onOpenMainAgent={handleOpenMainAgent}
          onProjectsChanged={refresh}
        />
      </div>

      {!chatVisible && (
        <button
          onClick={() => setChatVisible(true)}
          className="border-t border-border px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors text-left shrink-0"
        >
          💬 Claude — 点击打开终端
        </button>
      )}

      <ChatPanel
        visible={chatVisible}
        onToggle={() => setChatVisible(false)}
        tabs={chatTabs}
        activeTabId={activeTabId}
        onActivateTab={handleActivateTab}
        onCloseTab={handleCloseTab}
      />

      {quickAddOpen && (
        <InputDialog
          title="快速添加任务"
          placeholder="任务内容"
          onSubmit={handleQuickAdd}
          onCancel={() => setQuickAddOpen(false)}
        />
      )}
    </div>
  )
}
