import { useState, useEffect, useCallback, useRef } from 'react'
import { Sidebar, type SidebarView } from './components/Sidebar'
import { Column } from './components/Column'
import { BrowseColumn, type BrowseSource } from './components/BrowseColumn'
import { PreviewColumn } from './components/PreviewColumn'
import { ChatPanel, type ChatTab, type PendingSend } from './components/ChatPanel'
import { ProjectClaudeMdDrawer } from './components/ProjectClaudeMdDrawer'
import { Inspector } from './components/Inspector'
import { TodayView } from './components/views/TodayView'
import { EisenhowerView } from './components/views/EisenhowerView'
import { InboxView } from './components/views/InboxView'
import { AgentsView } from './components/views/AgentsView'
import { SettingsView } from './components/views/SettingsView'
import { ViewErrorBoundary } from './components/ViewErrorBoundary'
import { SessionInspector } from './components/SessionInspector'
import { InputDialog } from './components/InputDialog'
import { SearchPanel } from './components/SearchPanel'
import { matchHotkey, getHotkey } from './lib/hotkey'
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

// Default cwd for the "通用" tab — the lineup root, so the general agent
// can access all projects via MCP and has its own CLAUDE.md with rules.
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
    // Restored tabs come back HIBERNATED — Claude Code has a documented
    // native-addon memory leak (tracked upstream as #32752 / #22188 etc.),
    // and previously every saved tab spawned a `claude --resume` on
    // launch, multiplying the per-process leak by N. The active tab gets
    // the auto-wake; everything else stays asleep until clicked.
    const activeId = localStorage.getItem(STORAGE_ACTIVE)
    const updated = parsed.map((t: ChatTab) => {
      const base = t.id === 'default' ? { ...t, cwd: LINEUP_HOME } : t
      const shouldHibernate = base.id !== 'default' && base.id !== activeId
      return shouldHibernate ? { ...base, hibernated: true } : { ...base, hibernated: false }
    })
    const hasDefault = updated.some((t: ChatTab) => t.id === 'default')
    return hasDefault ? updated : [defaultTab(), ...updated]
  } catch {
    return [defaultTab()]
  }
}

const STORAGE_PATH = 'lineup:navPath'
function loadStoredPath(): NavEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_PATH)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Lightweight validation — ignore entries that don't match our schema.
    const ok: NavEntry[] = []
    for (const e of parsed) {
      if (!e || typeof e !== 'object') continue
      if (e.kind === 'project' && typeof e.id === 'number') ok.push(e)
      else if (e.kind === 'browse' && typeof e.source === 'string' && typeof e.target === 'string' && typeof e.label === 'string') ok.push(e)
      else if (e.kind === 'preview' && typeof e.objectType === 'string' && typeof e.target === 'string' && typeof e.label === 'string') ok.push(e)
    }
    return ok
  } catch { return [] }
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [path, setPath] = useState<NavEntry[]>(() => loadStoredPath())
  // Persist the column/navigation path so restarts land you back on the
  // same project (or browse/preview stack) you were looking at.
  useEffect(() => {
    localStorage.setItem(STORAGE_PATH, JSON.stringify(path))
  }, [path])
  const [chatVisible, setChatVisible] = useState<boolean>(
    () => localStorage.getItem(STORAGE_VISIBLE) === '1'
  )
  const [chatTabs, setChatTabs] = useState<ChatTab[]>(() => loadStoredTabs())
  const [activeTabId, setActiveTabId] = useState<string>(
    () => localStorage.getItem(STORAGE_ACTIVE) || 'default'
  )
  // Per-tab queue of prompts waiting to be sent into that tab's pty. We
  // never auto-paste-and-press-Enter because Claude can show modal prompts
  // ("Resume from summary?") that would eat the keystrokes. Instead the
  // ChatPanel renders a banner above the terminal with a 发送 button, and
  // the user clicks it once they've cleared any menus.
  const [pendingSends, setPendingSends] = useState<Record<string, PendingSend[]>>({})

  const consumePendingSend = useCallback((tabId: string, sendId: string) => {
    setPendingSends(prev => {
      const list = prev[tabId] || []
      const next = list.filter(s => s.id !== sendId)
      if (next.length === 0) {
        const { [tabId]: _drop, ...rest } = prev
        return rest
      }
      return { ...prev, [tabId]: next }
    })
  }, [])

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

  // Global "open main agent" event — fired by right-click "发送给通用 agent"
  // menus in 收件箱 / 信息源. Activates the default chat tab and makes the
  // panel visible. Clipboard writing is the caller's concern; we just
  // handle the UI reveal.
  useEffect(() => {
    const handler = () => {
      setActiveTabId('default')
      setChatVisible(true)
    }
    window.addEventListener('lineup:chat:activate-main', handler)
    return () => window.removeEventListener('lineup:chat:activate-main', handler)
  }, [])

  // Validate cached project tabs against the live ensureMainAgent on
  // boot. localStorage may carry stale cwds from before the Plan C
  // nested-virtual-dir migration — agent processes spawned in those
  // stale cwds end up writing CLAUDE.md.manual to the wrong place.
  // Refresh the cwd in-place; the tab is already hibernated so the next
  // wake will mount Terminal with the new cwd. If a tab points at a
  // project that no longer exists, drop it.
  useEffect(() => {
    const projectTabs = chatTabs.filter(t => t.id.startsWith('project:'))
    if (projectTabs.length === 0) return
    let cancelled = false
    void (async () => {
      const updates = new Map<string, { cwd: string; command: string } | null>()
      for (const tab of projectTabs) {
        const pid = parseInt(tab.id.slice('project:'.length), 10)
        if (!Number.isFinite(pid)) continue
        try {
          const info = await window.lineup.ensureMainAgent(pid)
          if (!info) { updates.set(tab.id, null); continue }
          const freshCmd = info.sessionId ? `claude --resume ${info.sessionId}` : 'claude'
          if (info.cwd !== tab.cwd || freshCmd !== tab.command) {
            updates.set(tab.id, { cwd: info.cwd, command: freshCmd })
          }
        } catch {
          // Ignore — leave the tab as-is.
        }
      }
      if (cancelled || updates.size === 0) return
      setChatTabs(prev => prev.flatMap(t => {
        if (!updates.has(t.id)) return [t]
        const u = updates.get(t.id)
        if (u === null) return []  // project gone → drop tab
        return [{ ...t, cwd: u.cwd, command: u.command }]
      }))
    })()
    return () => { cancelled = true }
    // Run once on mount only — re-running on every chatTabs change
    // would loop. New tabs created later use handleOpenMainAgent which
    // already does its own freshness check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Promote any 📁 / agent: / session: tab whose cwd is actually a
  // project's virtual dir into a project:N tab. Catches the case
  // where the user opened the project main agent via AgentsView
  // BEFORE we added handleOpenAgent's promotion path, which
  // permanently mislabeled it as a folder agent.
  useEffect(() => {
    const candidates = chatTabs.filter(t =>
      !t.id.startsWith('project:') && t.id !== 'default' &&
      typeof t.cwd === 'string' && t.cwd.includes('/.lineup/projects/')
    )
    if (candidates.length === 0) return
    let cancelled = false
    void (async () => {
      const replacements = new Map<string, {
        projectId: number; cwd: string; command: string; label: string
      }>()
      for (const tab of candidates) {
        const match = await window.lineup.findProjectByVirtualPath(tab.cwd)
        if (!match) continue
        // Resolve the real cwd + session via ensureMainAgent so the
        // new project:N tab is born with fresh state.
        const info = await window.lineup.ensureMainAgent(match.id)
        if (!info) continue
        const cmd = info.sessionId ? `claude --resume ${info.sessionId}` : 'claude'
        const truncated = match.name.length > 30 ? match.name.slice(0, 30) + '…' : match.name
        replacements.set(tab.id, {
          projectId: match.id,
          cwd: info.cwd,
          command: cmd,
          label: `🏠 ${truncated}`,
        })
      }
      if (cancelled || replacements.size === 0) return
      setChatTabs(prev => prev.flatMap(t => {
        const r = replacements.get(t.id)
        if (!r) return [t]
        const newId = `project:${r.projectId}`
        // If a project:N tab already exists, just drop this folder
        // dup; otherwise replace in place.
        if (prev.some(p => p.id === newId)) return []
        return [{
          ...t,
          id: newId,
          label: r.label,
          cwd: r.cwd,
          command: r.command,
          hibernated: true,  // start hibernated; user click wakes it
        }]
      }))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // CLAUDE.md.manual editor drawer state. Triggered by the 📝 buttons in
  // ChatPanel (per-project tab) and Inspector (project rows). One drawer
  // at a time — switching projects swaps content.
  const [claudeMdDrawer, setClaudeMdDrawer] = useState<
    { projectId: number; projectName: string } | null
  >(null)
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ projectId: number; projectName: string }>
      const d = ev?.detail
      if (!d || typeof d.projectId !== 'number') return
      setClaudeMdDrawer({ projectId: d.projectId, projectName: d.projectName || `项目 ${d.projectId}` })
    }
    window.addEventListener('lineup:open-project-claude-md', handler)
    return () => window.removeEventListener('lineup:open-project-claude-md', handler)
  }, [])

  // 📜 历史 button (ChatPanel) → switch to AgentsView with the cwd
  // pre-filled in the search box. Lets the user audit / pick another
  // session for this folder when the auto-resume picks the wrong one.
  const [agentsInitialQuery, setAgentsInitialQuery] = useState<string | null>(null)
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ folder: string }>
      const f = ev?.detail?.folder
      if (typeof f !== 'string' || !f) return
      setAgentsInitialQuery(f)
      setView('agents')
    }
    window.addEventListener('lineup:open-agents-folder', handler)
    return () => window.removeEventListener('lineup:open-agents-folder', handler)
  }, [])

  // Drill the Miller column path to a project. Fired by the ChatPanel's
  // "📁 打开项目" button (and reusable from anywhere else that needs to
  // jump to a known project). We resolve ancestors via the backend so the
  // path includes every parent — opening a leaf task properly reveals its
  // chain in the column view rather than just floating it at the root.
  useEffect(() => {
    const handler = async (e: Event) => {
      const ev = e as CustomEvent<{ projectId: number }>
      const pid = ev?.detail?.projectId
      if (typeof pid !== 'number') return
      const r = await window.lineup.projectListAncestors(pid)
      if (!r.ok || !r.ancestors || r.ancestors.length === 0) return
      setView('columns')
      setPath(r.ancestors.map(a => ({ kind: 'project' as const, id: a.id })))
    }
    window.addEventListener('lineup:browse:open-project', handler)
    return () => window.removeEventListener('lineup:browse:open-project', handler)
  }, [])

  // Queue a prompt for a project's main-agent terminal + open / focus the
  // tab. Fired by the AI proposal review panel when the user accepts (or
  // rewrites) a dispatch_agent proposal. The prompt sits in pendingSends
  // until the user clicks "发送" in the ChatPanel banner — we never
  // auto-type because Claude may show a "Resume from summary?" modal
  // that would eat the keystrokes.
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{
        projectId: number
        projectName?: string
        prompt: string
      }>
      const detail = ev?.detail
      if (!detail || typeof detail.projectId !== 'number' || typeof detail.prompt !== 'string') return
      const tabId = `project:${detail.projectId}`
      const send: PendingSend = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: detail.prompt,
        projectName: detail.projectName,
      }
      setPendingSends(prev => ({
        ...prev,
        [tabId]: [...(prev[tabId] || []), send],
      }))
      void handleOpenMainAgent(detail.projectId)
    }
    window.addEventListener('lineup:chat:queue-prompt', handler)
    return () => window.removeEventListener('lineup:chat:queue-prompt', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatTabs])
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
  useEffect(() => {
    localStorage.setItem('lineup:view', view)
    // Clear task selection when switching views
    setSelectedViewTaskId(null)
  }, [view])

  // Sidebar state — user can manually collapse the project sidebar if
  // they want more room; we don't toggle it on view change anymore.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // Right-side Inspector is hidden in views that ship their own preview
  // pane. Currently no such views in the public release.
  const hideRightInspector = false

  // Live counts for the sidebar view buttons. Refetched on every refreshSignal.
  const [todayCount, setTodayCount] = useState(0)
  const [inboxCount, setInboxCount] = useState(0)
  useEffect(() => {
    window.lineup.getTodayTasks().then(ts => setTodayCount(ts.length))
    window.lineup.getInboxTasks().then(ts => setInboxCount(ts.length))
  }, [refreshSignal, view])

  // Quick-add dialog state
  const [quickAddOpen, setQuickAddOpen] = useState(false)

  // When in a task-list view (today/eisenhower/inbox), single-click a task
  // to select it — Inspector shows its detail without leaving the view.
  const [selectedViewTaskId, setSelectedViewTaskId] = useState<number | null>(null)

  // Agent-review mode: when the user single-clicks a session in AgentsView,
  // hold a ref to that Agent so the right panel renders SessionInspector
  // instead of the project Inspector. Cleared when leaving the agents view
  // or when the user hits ✕ in the inspector header.
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  useEffect(() => { if (view !== 'agents') setSelectedAgent(null) }, [view])

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

  // Keyboard navigation (ArrowLeft removed — interferes with terminal use)

  const handleSelectRoot = (id: number) => {
    setPath([{ kind: 'project', id }])
  }

  // Jump from a task-list view back to Miller columns focused on this task.
  // parent_id is always set now (inbox tasks live under the reserved 收件箱
  // project). We stack [parent, task] so the Inspector + columns are aligned.
  const handleJumpToTask = async (task: TaskViewRow) => {
    setView('columns')
    let parentId = task.parent_id
    if (parentId == null) {
      // Legacy orphan task (shouldn't happen after migration, but be safe)
      parentId = await window.lineup.getInboxProjectId()
    }
    if (parentId != null) {
      setPath([
        { kind: 'project', id: parentId },
        { kind: 'project', id: task.id },
      ])
    } else {
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

  // Global search hotkey (default ⌘K). Configurable in Settings →
  // 搜索快捷键. Steals from text inputs intentionally — search is the
  // user's escape hatch and they expect ⌘K to work from anywhere.
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (matchHotkey(getHotkey('search'), e)) {
        e.preventDefault()
        setSearchOpen(true)
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
  // Per-cwd custom tab titles. When the user right-click-renames a chat
  // tab, we save the new label under the tab's cwd so that ANY future
  // tab opened for the same project/folder (regardless of which session
  // branch it's resuming) shows the same custom label. Different session
  // branches share the window name but keep their own session history.
  // (Was: cwd-keyed tab title storage — replaced by per-tab-id storage
  // below because 🏠 project main and 📁 folder agents can share a cwd.)
  // Per-tab-id label storage — the cwd-keyed approach merged 🏠 project
  // main and 📁 folder-agent labels for any pair sharing a cwd, which
  // sticks the wrong icon on the wrong tab. Keying by tab id keeps the
  // role-specific prefix intact across reloads.
  const TAB_TITLES_BY_ID_KEY = 'lineup:tabTitlesById'
  const loadTabTitlesById = (): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(TAB_TITLES_BY_ID_KEY) || '{}') } catch { return {} }
  }
  const getTabTitleForId = (tabId: string, fallback: string): string => {
    const m = loadTabTitlesById()
    return m[tabId] || fallback
  }
  const setTabTitleForId = (tabId: string, label: string) => {
    const m = loadTabTitlesById()
    if (label.trim()) m[tabId] = label.trim()
    else delete m[tabId]
    try { localStorage.setItem(TAB_TITLES_BY_ID_KEY, JSON.stringify(m)) } catch { /* ignore */ }
  }

  const handleOpenAgent = async (agent: Agent) => {
    // Promote to project main-agent tab if the agent's cwd is exactly
    // a project's virtual dir (~/.lineup/projects/.../<projectName>).
    // Otherwise the folder-agent path below labels it as "📁 …" and
    // creates a separate `folder:` tab id, which means the user ends
    // up with two tabs for the same logical project — one 🏠 (if they
    // opened it from sidebar) and one 📁 (if they opened it from
    // AgentsView). Single source of truth: project main agent.
    if (agent.folder_path && agent.folder_path.startsWith('/Users/')) {
      const match = await window.lineup.findProjectByVirtualPath(agent.folder_path)
      if (match) {
        await handleOpenMainAgent(match.id)
        return
      }
    }

    const hasSession = agent.session_id && agent.session_id.length > 0
    const tabId = agent.id != null
      ? `agent:${agent.id}`
      : hasSession
        ? `session:${agent.session_id}`
        : `folder:${agent.folder_path ?? agent.name}`
    const cwd = agent.folder_path ?? LINEUP_HOME
    const alreadyExists = chatTabs.some(t => t.id === tabId)

    if (!alreadyExists) {
      // Folder-agent prefix: 📁 marks "ad-hoc claude session bound to a
      // folder, not to a lineup project". Distinguishes from 🏠 (project
      // main agent). Skip if the auto-title already starts with a known
      // marker emoji so we don't double-up.
      const truncated = agent.name.length > 30 ? agent.name.slice(0, 30) + '…' : agent.name
      const alreadyTagged = /^[🏠📁🤖⭐🪴]/.test(truncated)
      // For folder agents, prefix the parent lineup project so two
      // folders with the same basename in different projects (e.g.
      // 实习/cv_ai_automation vs 学习/cv_ai_automation) don't collide
      // visually. Falls back to bare name if no parent project is found
      // (unlinked folder).
      let parentName: string | null = null
      if (agent.folder_path && agent.project_id != null) {
        parentName = projects.find(p => p.id === agent.project_id)?.name ?? null
        if (!parentName) {
          const fetched = await window.lineup.getProject(agent.project_id)
          parentName = fetched?.name ?? null
        }
      }
      const derivedLabel = alreadyTagged
        ? truncated
        : agent.folder_path
          ? (parentName ? `📁 ${parentName} / ${truncated}` : `📁 ${truncated}`)
          : truncated
      // Stored-label lookup keyed by the tab id (not cwd) — same cwd can
      // be hosting both a project main agent (🏠) and an ad-hoc folder
      // agent (📁), so cwd-keyed storage cross-pollutes the icon. tabId
      // already encodes the role (`project:N` vs `agent:N`/`session:S`).
      const newTab: ChatTab = {
        id: tabId,
        label: getTabTitleForId(tabId, derivedLabel),
        cwd,
        // If session exists, resume it; otherwise start fresh (zshrc wrapper
        // will create + store the session automatically).
        command: hasSession ? `claude --resume ${agent.session_id}` : 'claude',
        closable: true,
      }
      setChatTabs(prev => [...prev, newTab])
    } else {
      // Tab exists from a previous session — make sure it's awake.
      // Without this, clicking "💬 lineup 内打开" on a hibernated tab
      // just sets activeTabId, the Terminal stays unmounted, the
      // user sees a black slot and thinks the button broke.
      setChatTabs(prev => prev.map(t =>
        t.id === tabId && t.hibernated ? { ...t, hibernated: false } : t
      ))
    }
    setActiveTabId(tabId)
    setChatVisible(true)
  }

  const handleActivateTab = (tabId: string) => {
    setActiveTabId(tabId)
    // Wake on activate — clicking a hibernated tab in the strip is the
    // most natural "I want to use this now" signal. Skip the manual
    // click on the placeholder.
    setChatTabs(prev => prev.map(t =>
      t.id === tabId && t.hibernated ? { ...t, hibernated: false } : t
    ))
  }

  const handleCloseTab = (tabId: string) => {
    setChatTabs(prev => prev.filter(t => t.id !== tabId))
    if (activeTabId === tabId) setActiveTabId('default')
  }

  // Rename a chat tab's label. Persists under the tab's cwd so any future
  // tab for the same folder reuses the name. Updates ALL open tabs sharing
  // that cwd to the new label (not strictly required, but nice UX).
  // 💤 hibernate / wake — flip the flag and React swaps in/out the
  // Terminal vs HibernatedPlaceholder. The Terminal's own cleanup
  // effect kills the pty when it unmounts, so just toggling the flag
  // is enough. Activating a hibernated tab also wakes it, so the user
  // can either click 💤 → label, or click the placeholder body.
  const handleSetHibernate = (tabId: string, hibernated: boolean) => {
    setChatTabs(prev => prev.map(t => t.id === tabId ? { ...t, hibernated } : t))
  }

  const handleRenameTab = (tabId: string, label: string) => {
    const target = chatTabs.find(t => t.id === tabId)
    if (!target) return
    // Storage is per-tab-id so role-specific prefix (🏠 vs 📁) survives
    // reloads even when two tabs share a cwd.
    setTabTitleForId(tabId, label)
    setChatTabs(prev => prev.map(t => t.id === tabId ? { ...t, label } : t))
  }

  // Spawn (or re-activate) the main agent tab for a project. The main
  // agent's pty runs in the project's virtual folder at
  // ~/.lineup/projects/<slug>/ which lineup keeps in sync with the DB.
  const handleOpenMainAgent = async (pid: number) => {
    const tabId = `project:${pid}`
    // Always re-resolve cwd + session_id from ensureMainAgent. Existing
    // tabs in localStorage may carry STALE cwd values from before lineup
    // switched to the nested-virtual-folder layout (or before chrome_tab
    // → url, or any other refactor). If the live cwd or command differs,
    // drop the stale tab so the new one below picks up the fresh values.
    const info = await window.lineup.ensureMainAgent(pid)
    if (!info) return
    const freshCommand = info.sessionId ? `claude --resume ${info.sessionId}` : 'claude'
    const existing = chatTabs.find(t => t.id === tabId)
    if (existing) {
      const stale = existing.cwd !== info.cwd || existing.command !== freshCommand
      if (!stale) {
        // Same cwd + command — just activate (and wake if hibernated).
        setChatTabs(prev => prev.map(t =>
          t.id === tabId && t.hibernated ? { ...t, hibernated: false } : t
        ))
        setActiveTabId(tabId)
        setChatVisible(true)
        return
      }
      // Stale: drop the cached tab so the create path below remounts
      // Terminal with the fresh cwd/command.
      setChatTabs(prev => prev.filter(t => t.id !== tabId))
    }
    // The cached `projects` array only holds roots + pinned (see
    // db:listProjects). Sub-projects / tasks aren't in it, so fall back
    // to a direct DB read — otherwise we'd label them "project 164"
    // instead of e.g. "🏠 华为-上海-数通".
    let projectName = projects.find(p => p.id === pid)?.name
    if (!projectName) {
      const fetched = await window.lineup.getProject(pid)
      projectName = fetched?.name
    }
    // 🏠 marks "this tab is the project's main agent" — i.e. the
    // long-term claude session bound to this project's main_agent_session_id.
    // Distinct from ad-hoc agent tabs (no prefix) and conflict-free with
    // ⭐ which is already used for the browser bookmarks button.
    const derivedLabel = projectName ? `🏠 ${projectName}` : `项目 ${pid}`
    const label = derivedLabel.length > 30 ? derivedLabel.slice(0, 30) + '…' : derivedLabel
    // Stored by tab id (project:N), not by cwd, so a folder agent in the
    // same cwd can't poison this tab's label. Discard stale "project N"
    // / "项目 N" labels left by an earlier bug where we couldn't resolve
    // sub-project names.
    const stored = getTabTitleForId(tabId, '')
    const isStaleLabel = /^(project|项目)\s+\d+$/i.test(stored)
    const finalLabel = (stored && !isStaleLabel) ? stored : label
    // Always pin the project to a specific session id when we have one.
    // Plain `claude` would prompt "resume last?" with the cwd's most
    // recent session, which can be wrong — e.g. a stale virtual-folder
    // session masking the real linked-folder one. ensureMainAgent now
    // resolves the right id (DB → wrapper cache → newest jsonl).
    const command = info.sessionId ? `claude --resume ${info.sessionId}` : 'claude'
    const newTab: ChatTab = {
      id: tabId,
      label: finalLabel,
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
          onSelectView={(v) => setView(prev => (prev === v && v !== 'columns') ? 'columns' : v)}
          todayCount={todayCount}
          inboxCount={inboxCount}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed(c => !c)}
        />

        {view === 'today' && (
          <TodayView
            refreshSignal={refreshSignal}
            onSelectTask={(t) => setSelectedViewTaskId(t.id)}
            onJumpToTask={handleJumpToTask}
            selectedTaskId={selectedViewTaskId}
          />
        )}
        {view === 'eisenhower' && (
          <EisenhowerView
            refreshSignal={refreshSignal}
            onSelectTask={(t) => setSelectedViewTaskId(t.id)}
            onJumpToTask={handleJumpToTask}
            selectedTaskId={selectedViewTaskId}
          />
        )}
        {view === 'inbox' && (
          <InboxView
            refreshSignal={refreshSignal}
            onSelectTask={(t) => setSelectedViewTaskId(t.id)}
            onJumpToTask={handleJumpToTask}
            onQuickAdd={() => setQuickAddOpen(true)}
            selectedTaskId={selectedViewTaskId}
          />
        )}
        {view === 'agents' && (
          <AgentsView
            refreshSignal={refreshSignal}
            onOpenAgent={handleOpenAgent}
            onSelectAgent={setSelectedAgent}
            selectedAgentSessionId={selectedAgent?.session_id ?? null}
            initialQuery={agentsInitialQuery}
            onConsumeInitialQuery={() => setAgentsInitialQuery(null)}
          />
        )}
        {view === 'settings' && (
          <ViewErrorBoundary resetKey={view} viewName="设置">
            <SettingsView />
          </ViewErrorBoundary>
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

        {hideRightInspector ? null : selectedAgent ? (
          <div className="w-[360px] min-w-[280px] max-w-[600px] border-l border-border flex flex-col shrink-0">
            <SessionInspector
              agent={selectedAgent}
              onClose={() => setSelectedAgent(null)}
              onResume={handleOpenAgent}
              onAgentUpdated={() => setRefreshSignal(k => k + 1)}
            />
          </div>
        ) : (
          <Inspector
            projectId={(() => {
              // In task-list views, show the selected task's detail.
              if (view !== 'columns' && selectedViewTaskId != null) return selectedViewTaskId
              // In columns view, show the deepest project in the path.
              for (let i = path.length - 1; i >= 0; i--) {
                if (path[i].kind === 'project') return (path[i] as { kind: 'project'; id: number }).id
              }
              return null
            })()}
            // Auto-expand when viewing a project/task in columns, or when a
            // task is selected in a view. Collapse only when looking at an
            // object preview (last path entry isn't a project).
            autoVisible={
              (view !== 'columns' && selectedViewTaskId != null) ||
              path.length === 0 ||
              path[path.length - 1].kind === 'project'
            }
            refreshSignal={refreshSignal}
            onOpenMainAgent={handleOpenMainAgent}
            onProjectsChanged={refresh}
          />
        )}
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
        onRenameTab={handleRenameTab}
        onSetHibernate={handleSetHibernate}
        onReorderTabs={(ids) => {
          setChatTabs(prev => {
            const byId = new Map(prev.map(t => [t.id, t]))
            return ids.map(id => byId.get(id)).filter((t): t is ChatTab => !!t)
          })
        }}
        pendingSends={pendingSends}
        onConsumePendingSend={consumePendingSend}
      />

      {quickAddOpen && (
        <InputDialog
          title="快速添加任务"
          placeholder="任务内容"
          onSubmit={handleQuickAdd}
          onCancel={() => setQuickAddOpen(false)}
        />
      )}

      {claudeMdDrawer && (
        <ProjectClaudeMdDrawer
          projectId={claudeMdDrawer.projectId}
          projectName={claudeMdDrawer.projectName}
          onClose={() => setClaudeMdDrawer(null)}
        />
      )}

      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenProject={(pid) => {
          // Reuse the existing project-open event handler so the
          // Miller columns drill all the way down to the project,
          // showing every ancestor — same UX as clicking a breadcrumb
          // from inside chat / Inspector.
          window.dispatchEvent(new CustomEvent('lineup:browse:open-project', {
            detail: { projectId: pid },
          }))
        }}
        onOpenObject={(oid) => {
          // openObject uses the type registry to dispatch (open in
          // Finder / Preview / browser / etc).
          void window.lineup.openObject(oid)
        }}
      />
    </div>
  )
}
