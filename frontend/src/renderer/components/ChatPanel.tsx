import { useRef, useEffect, useState, useCallback } from 'react'
import { Terminal } from './Terminal'

export interface ChatTab {
  id: string
  label: string
  cwd: string
  // Optional one-shot command to run in this tab's pty (e.g. claude --resume)
  command?: string
  closable: boolean
  /** When true, no pty is running for this tab — the slot is just a label
   *  + scrollback shell. Click to wake (re-spawn claude --resume).
   *  Tabs loaded from localStorage on app start come back hibernated to
   *  avoid the multi-claude memory blowup (each `claude` instance carries
   *  Claude Code's known native-addon leak; 48 of them = 60 GB). */
  hibernated?: boolean
}

/** A prompt waiting to be typed into a tab's pty + Enter-pressed. We never
 *  auto-send: Claude's "Resume from summary?" modal would eat the keys.
 *  The user clicks "▶ 发送" once they've cleared any menus. */
export interface PendingSend {
  id: string
  prompt: string
  /** Display name of the project (for the banner — falls back to tab label). */
  projectName?: string
}

interface ChatPanelProps {
  visible: boolean
  onToggle: () => void
  tabs: ChatTab[]
  activeTabId: string
  onActivateTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  // Rename a tab's display label. Persisted per-cwd in App so any future
  // tab that opens with the same cwd re-uses the name, regardless of
  // which claude session branch it's resuming.
  onRenameTab: (tabId: string, label: string) => void
  /** Toggle hibernate — kills/respawns the pty for that tab. Used by the
   *  per-tab 💤 button and (future) idle auto-hibernation. */
  onSetHibernate: (tabId: string, hibernated: boolean) => void
  // Browser-style drag-to-reorder. Called with the full new order as an
  // array of tab ids.
  onReorderTabs: (tabIds: string[]) => void
  /** Per-tab queue of prompts the user has accepted from inbox proposals
   *  but not yet sent into the terminal. */
  pendingSends?: Record<string, PendingSend[]>
  /** Called after the user 发送 / 取消 's a pending send. Removes the entry
   *  from the queue. */
  onConsumePendingSend?: (tabId: string, sendId: string) => void
}

const MIN_HEIGHT = 150
const MAX_HEIGHT = 1200
const MIN_FONT = 9
const MAX_FONT = 28
const FONT_KEY = 'lineup:terminalFontSize'

export function ChatPanel({
  visible,
  onToggle,
  tabs,
  activeTabId,
  onActivateTab,
  onCloseTab,
  onRenameTab,
  onSetHibernate,
  onReorderTabs,
  pendingSends,
  onConsumePendingSend,
}: ChatPanelProps) {
  // Per-tab activity state: 'running' while pty is streaming, 'idle'
  // once it has gone quiet for ≥800ms. Used to tint tab labels orange.
  const [tabActivity, setTabActivity] = useState<Record<string, 'running' | 'idle'>>({})
  // Per-tab last-activity timestamp (ms). Drives idle auto-hibernate:
  // tabs whose last running output was > N minutes ago AND aren't the
  // active tab get killed to release the per-claude memory leak.
  const lastActivityRef = useRef<Record<string, number>>({})
  // Per-tab "needs-attention" flag — set when a tab transitions from
  // running → idle while NOT being the active tab. Cleared when the user
  // activates the tab. Drives the orange dot next to the tab label and
  // prevents re-firing a notification for the same idle event.
  const [tabNeedsAttention, setTabNeedsAttention] = useState<Record<string, boolean>>({})
  // The live system-notification per tab (kept so we can .close() them
  // when the user activates the tab).
  const notifRef = useRef<Record<string, Notification>>({})
  // Drag-reorder state — id of the tab currently being dragged.
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)

  // Idle auto-hibernate: every 60s, kill the pty for any non-active
  // tab whose last activity is older than the configured threshold.
  // Threshold lives in localStorage so the Settings page can tune it
  // without touching this hot code. Active tab is never auto-hibernated.
  useEffect(() => {
    const tick = () => {
      const minRaw = localStorage.getItem('lineup:hibernateIdleMinutes')
      const minutes = Math.max(1, parseInt(minRaw || '30', 10) || 30)
      const cutoff = Date.now() - minutes * 60_000
      for (const tab of tabs) {
        if (tab.id === activeTabId) continue
        if (tab.hibernated) continue
        const ts = lastActivityRef.current[tab.id]
        // No activity ever recorded? Use mount time as a proxy: stamp
        // it now so the next sweep counts from here. Avoids hibernating
        // a freshly-spawned tab that hasn't streamed any output yet.
        if (ts == null) {
          lastActivityRef.current[tab.id] = Date.now()
          continue
        }
        if (ts < cutoff) {
          onSetHibernate(tab.id, true)
        }
      }
    }
    const t = setInterval(tick, 60_000)
    return () => clearInterval(t)
  }, [tabs, activeTabId, onSetHibernate])

  // Clear attention flag + dismiss notification when the user activates a
  // tab. Also a safety: if the user activates a tab that was already idle
  // with no notification, this is a no-op.
  useEffect(() => {
    if (!activeTabId) return
    setTabNeedsAttention(prev => {
      if (!prev[activeTabId]) return prev
      const { [activeTabId]: _drop, ...rest } = prev
      return rest
    })
    const n = notifRef.current[activeTabId]
    if (n) {
      try { n.close() } catch { /* ignore */ }
      delete notifRef.current[activeTabId]
    }
  }, [activeTabId])

  const handleActivityChange = useCallback(
    (tabId: string) => (state: 'running' | 'idle') => {
      // Stamp last-active on every signal. Running tabs are obviously
      // alive; idle-from-running means claude just finished thinking
      // (worth tracking — user may come back). Pure idle (no prior
      // running) doesn't bump.
      if (state === 'running') lastActivityRef.current[tabId] = Date.now()
      setTabActivity(prev => ({ ...prev, [tabId]: state }))
      // A running → idle transition on a NON-active tab is the "needs
      // your attention" signal (claude finished or is waiting on input).
      if (state === 'idle' && tabId !== activeTabId) {
        // Only flag if we were running — filters out the initial idle
        // state when the pty hasn't produced any output yet.
        setTabActivity(prev => {
          const wasRunning = prev[tabId] === 'running'
          if (wasRunning) {
            setTabNeedsAttention(a => ({ ...a, [tabId]: true }))
            fireNotification(tabId)
          }
          return { ...prev, [tabId]: 'idle' }
        })
      }
    },
    [activeTabId],
  )

  const fireNotification = (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId)
    if (!tab) return
    // Avoid stacking: if a previous notification for this tab is still
    // showing, close it first.
    const prev = notifRef.current[tabId]
    if (prev) { try { prev.close() } catch { /* ignore */ } }
    try {
      const n = new Notification('lineup · Claude 等待中', {
        body: `"${tab.label}" 跑完了或者在等你输入。点一下切换过去。`,
        silent: false,
      })
      n.onclick = () => {
        // Focus the window and activate the tab.
        try { window.focus() } catch { /* ignore */ }
        onActivateTab(tabId)
      }
      notifRef.current[tabId] = n
    } catch { /* Notification API unavailable — silently skip */ }
  }
  // Which tab is currently being renamed inline (null = none).
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  // Tab labels start with a role-marker emoji (🏠 = project main agent,
  // 📁 = ad-hoc folder agent, 🤖 = generic agent, ⭐ = bookmarks, 🪴 = misc)
  // followed by a space and the editable body. The marker is meaningful
  // — without it the tab loses its visual role cue and the saved label
  // can't be recognized as already-tagged on the next reopen, causing
  // double-tagging like "📁 📁 foo". So we lock the marker out of the
  // rename input: edit the body only, re-prepend the marker on save.
  const TAB_PREFIX_RE = /^([🏠📁🤖⭐🪴])\s+/u
  const splitLabel = (label: string): { prefix: string; body: string } => {
    const m = label.match(TAB_PREFIX_RE)
    return m ? { prefix: m[1] + ' ', body: label.slice(m[0].length) } : { prefix: '', body: label }
  }
  const beginRename = (label: string) => setRenameDraft(splitLabel(label).body)
  const commitRename = (tabId: string, originalLabel: string) => {
    const { prefix } = splitLabel(originalLabel)
    const body = renameDraft.trim()
    onRenameTab(tabId, body ? prefix + body : originalLabel)
    setRenamingTabId(null)
  }
  const [height, setHeight] = useState(420)
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem(FONT_KEY)
    const n = saved ? parseInt(saved, 10) : NaN
    return Number.isFinite(n) && n >= MIN_FONT && n <= MAX_FONT ? n : 14
  })
  const dragStartY = useRef<number | null>(null)
  const dragStartHeight = useRef<number>(0)

  // Persist font size
  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize))
  }, [fontSize])

  // Keyboard shortcuts: Cmd/Ctrl + = / - / 0 to zoom in / out / reset.
  // Only active while the chat panel is visible and an xterm is focused,
  // otherwise we'd steal these shortcuts from the rest of the app.
  useEffect(() => {
    if (!visible) return
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return
      // Only when focus is inside the chat panel / a terminal
      const target = e.target as HTMLElement | null
      const inPanel = target?.closest('.lineup-chat-panel')
      if (!inPanel) return
      const consume = () => {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
      }
      if (e.key === '=' || e.key === '+') {
        consume()
        setFontSize(s => Math.min(MAX_FONT, s + 1))
      } else if (e.key === '-' || e.key === '_') {
        consume()
        setFontSize(s => Math.max(MIN_FONT, s - 1))
      } else if (e.key === '0') {
        consume()
        setFontSize(14)
      }
    }
    // Capture phase: intercept before xterm.js consumes the event
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible])

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0]

  // ── Drag-to-resize ─────────────────────────────────────────────

  const handleDragMove = useCallback((e: MouseEvent) => {
    if (dragStartY.current == null) return
    const delta = dragStartY.current - e.clientY
    const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragStartHeight.current + delta))
    setHeight(newHeight)
  }, [])

  const handleDragEnd = useCallback(() => {
    dragStartY.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', handleDragMove)
    window.removeEventListener('mouseup', handleDragEnd)
  }, [handleDragMove])

  function handleDragStart(e: React.MouseEvent) {
    e.preventDefault()
    dragStartY.current = e.clientY
    dragStartHeight.current = height
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handleDragMove)
    window.addEventListener('mouseup', handleDragEnd)
  }

  // Make sure the active tab's terminal gets focus when the panel is shown
  // or when switching tabs. xterm focuses automatically on click but not on
  // mount, so we briefly delay to let layout settle.
  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => {
      const host = document.querySelector<HTMLTextAreaElement>(
        '.xterm-helper-textarea',
      )
      host?.focus()
    }, 50)
    return () => clearTimeout(t)
  }, [visible, activeTabId])

  if (!visible || !activeTab) return null

  return (
    <div
      className="lineup-chat-panel border-t border-border bg-card flex flex-col"
      style={{ height, minHeight: MIN_HEIGHT }}
    >
      {/* Drag handle (resize) */}
      <div
        onMouseDown={handleDragStart}
        className="h-1 -mt-px cursor-ns-resize bg-transparent hover:bg-primary/40 transition-colors shrink-0"
        title="拖动调整高度"
      />

      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-muted/30 shrink-0 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          const isRunning = tabActivity[tab.id] === 'running'
          const needsAttention = tabNeedsAttention[tab.id]
          const isDragging = draggingTabId === tab.id
          // Label color: orange while running (claude is busy). Yellow-ish
          // "attention" marker shown next to the label for tabs that went
          // idle while the user was looking somewhere else.
          const labelColor = isRunning
            ? 'text-orange-400'
            : isActive ? 'text-foreground' : 'text-muted-foreground'
          return (
            <div
              key={tab.id}
              draggable={renamingTabId !== tab.id}
              onDragStart={(e) => {
                setDraggingTabId(tab.id)
                e.dataTransfer.effectAllowed = 'move'
                // Required for Firefox; Chrome also honors a payload.
                e.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragEnd={() => setDraggingTabId(null)}
              onDragOver={(e) => {
                if (!draggingTabId || draggingTabId === tab.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                e.preventDefault()
                const from = draggingTabId
                setDraggingTabId(null)
                if (!from || from === tab.id) return
                const ids = tabs.map(t => t.id)
                const fromIdx = ids.indexOf(from)
                const toIdx = ids.indexOf(tab.id)
                if (fromIdx < 0 || toIdx < 0) return
                const next = ids.slice()
                next.splice(fromIdx, 1)
                next.splice(toIdx, 0, from)
                onReorderTabs(next)
              }}
              className={`flex items-center gap-1 px-3 py-1.5 border-r border-border text-xs cursor-pointer shrink-0 transition-opacity
                ${isActive
                  ? 'bg-card border-b-2 border-b-primary -mb-px'
                  : 'hover:bg-accent/50'
                }
                ${isDragging ? 'opacity-40' : ''}
              `}
              onClick={() => renamingTabId === tab.id ? undefined : onActivateTab(tab.id)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                beginRename(tab.label)
                setRenamingTabId(tab.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                beginRename(tab.label)
                setRenamingTabId(tab.id)
              }}
              title="拖动排序 / 右键双击重命名"
            >
              {/* Status dot: orange while running, amber when pending user attention */}
              {(isRunning || needsAttention) && (
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isRunning ? 'bg-orange-400 animate-pulse' : 'bg-amber-400'
                  }`}
                  title={isRunning ? 'Claude 运行中' : '等你输入/查看'}
                />
              )}
              {renamingTabId === tab.id ? (
                <>
                  {splitLabel(tab.label).prefix && (
                    <span
                      className="text-xs select-none opacity-80"
                      title="图标锁定，无法在重命名里改"
                    >{splitLabel(tab.label).prefix.trim()}</span>
                  )}
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(tab.id, tab.label)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(tab.id, tab.label)
                      else if (e.key === 'Escape') setRenamingTabId(null)
                    }}
                    className="bg-background border border-border rounded px-1 py-0 text-xs w-[180px] focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </>
              ) : (
                // Hibernation is invisible by design — no 💤 prefix, no
                // explicit button. Idle tabs auto-hibernate in the
                // background; clicking the tab silently re-wakes claude.
                <span className={`truncate max-w-[200px] ${labelColor}`}>{tab.label}</span>
              )}
              {tab.closable && renamingTabId !== tab.id && (
                <button
                  onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
                  className="opacity-50 hover:opacity-100 hover:text-destructive ml-1"
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
        <button
          onClick={onToggle}
          className="ml-auto px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
        >
          收起
        </button>
      </div>

      {/* cwd indicator + per-project toolbar */}
      <div className="px-4 py-1 border-b border-border flex items-center gap-2 text-xs shrink-0">
        <span className="text-muted-foreground truncate flex-1">cwd: {activeTab.cwd}</span>
        {/* Project-tab specific actions (id: project:<n>) */}
        {(() => {
          const m = activeTab.id.match(/^project:(\d+)$/)
          if (!m) return null
          const pid = Number(m[1])
          // Strip the main-agent prefix (🏠) to recover the bare project
          // name. Also tolerate the legacy ⭐ prefix so tabs persisted in
          // localStorage from older builds still match.
          const projectName = activeTab.label.replace(/^(🏠|⭐) /, '')
          return (
            <>
              <button
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('lineup:browse:open-project', {
                    detail: { projectId: pid },
                  }))
                }}
                className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent shrink-0"
                title="在上方的 Miller 视图里展开这个项目的完整路径"
              >📁 打开项目</button>
              <button
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('lineup:open-project-claude-md', {
                    detail: { projectId: pid, projectName },
                  }))
                }}
                className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent shrink-0"
                title="编辑这个 agent 的 CLAUDE.md.manual（system prompt 叠层）"
              >📝 CLAUDE.md</button>
              <button
                onClick={() => {
                  // Jump to the Agents view, pre-filtered to this folder.
                  // Useful when the auto-resumed session isn't the one the
                  // user expected — they can see all sessions for this
                  // folder and pick another via single-click.
                  window.dispatchEvent(new CustomEvent('lineup:open-agents-folder', {
                    detail: { folder: activeTab.cwd },
                  }))
                }}
                className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent shrink-0"
                title={`跳到 Agent 总览，筛选当前 cwd（${activeTab.cwd}）下的所有会话`}
              >📜 历史</button>
            </>
          )
        })()}
      </div>

      {/* Pending-send banner: appears for the active tab when one or more
          inbox-proposal prompts are queued for it. User confirms with ▶
          once they've dismissed any Claude modal. */}
      {(pendingSends?.[activeTabId]?.length ?? 0) > 0 && onConsumePendingSend && (
        <PendingSendBanner
          tabId={activeTabId}
          tabLabel={activeTab.label}
          sends={pendingSends![activeTabId]}
          onConsume={(sendId) => onConsumePendingSend(activeTabId, sendId)}
        />
      )}

      {/* Terminals — every tab is mounted full-size; we toggle `visibility`
          (NOT `display`) so hidden terminals keep their layout box. With
          display:none xterm collapses to 0×0 and FitAddon picks the wrong
          column count when you switch back. */}
      <div className="flex-1 relative min-h-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{
                visibility: isActive ? 'visible' : 'hidden',
                pointerEvents: isActive ? 'auto' : 'none',
                zIndex: isActive ? 1 : 0,
              }}
            >
              {tab.hibernated ? (
                // Empty slot — hibernation is invisible to the user.
                // Activating the tab via the strip wakes it (handled by
                // App.handleActivateTab). The blank background matches
                // xterm so there's no flash on transition.
                <div className="w-full h-full bg-[#0a0a0a]" />
              ) : (
                <Terminal
                  tabId={tab.id}
                  cwd={tab.cwd}
                  command={tab.command}
                  fontSize={fontSize}
                  isActive={isActive}
                  onActivityChange={handleActivityChange(tab.id)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}


// ── Pending-send banner ──────────────────────────────────────────────

function PendingSendBanner({ tabId, tabLabel, sends, onConsume }: {
  tabId: string
  tabLabel: string
  sends: PendingSend[]
  onConsume: (sendId: string) => void
}) {
  // Always show the head of the queue. Multiple sends queued is rare, but
  // we expose count so the user knows more is coming.
  const head = sends[0]
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(head.prompt)
  // Reset draft when the head changes (queue advanced).
  useEffect(() => {
    setDraft(head.prompt)
    setEditing(false)
  }, [head.id, head.prompt])

  const send = (text: string) => {
    // Targeted event — the matching Terminal listens for this and writes
    // directly to its pty. We deliberately do NOT touch the clipboard
    // here: clean separation, no surprise side effects on the user's
    // existing clipboard contents.
    window.dispatchEvent(new CustomEvent('lineup:terminal:send', {
      detail: { tabId, text },
    }))
    onConsume(head.id)
  }

  const previewLine = (head.prompt.split('\n').find(l => l.trim()) || head.prompt).slice(0, 120)

  return (
    <div className="border-t border-b-2 border-amber-500/40 bg-amber-500/10 px-3 py-2 shrink-0">
      <div className="flex items-start gap-2">
        <div className="text-xs text-amber-200 shrink-0 pt-0.5">📤</div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-amber-100">
            待发送给 {head.projectName || tabLabel} 的 agent
            {sends.length > 1 && (
              <span className="ml-2 text-[11px] opacity-70">+{sends.length - 1} 个排队中</span>
            )}
          </div>
          {!editing && (
            <div className="text-[11px] text-foreground/80 mt-0.5 truncate font-mono">
              {previewLine}
            </div>
          )}
          {editing && (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              className="mt-1 w-full max-h-[200px] p-2 rounded border border-amber-500/40 bg-background text-[12px] font-mono leading-snug resize-y focus:outline-none focus:ring-1 focus:ring-amber-400"
              rows={Math.min(8, Math.max(3, draft.split('\n').length))}
            />
          )}
        </div>
        <div className="flex gap-1 shrink-0 mt-0.5">
          {!editing ? (
            <>
              <button
                onClick={() => send(head.prompt)}
                className="text-[11px] px-2 py-0.5 rounded bg-amber-500 text-amber-950 font-medium hover:bg-amber-400"
                title="把这条发到当前 agent 终端"
              >▶ 发送</button>
              <button
                onClick={() => setEditing(true)}
                className="text-[11px] px-2 py-0.5 rounded border border-amber-500/40 hover:bg-amber-500/20"
                title="发送前再改一下"
              >✏ 编辑</button>
              <button
                onClick={() => onConsume(head.id)}
                className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent"
                title="不发送，丢弃这条"
              >✕ 取消</button>
            </>
          ) : (
            <>
              <button
                onClick={() => send(draft)}
                disabled={!draft.trim()}
                className="text-[11px] px-2 py-0.5 rounded bg-amber-500 text-amber-950 font-medium hover:bg-amber-400 disabled:opacity-40"
              >▶ 发送</button>
              <button
                onClick={() => { setEditing(false); setDraft(head.prompt) }}
                className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent"
              >返回</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}


