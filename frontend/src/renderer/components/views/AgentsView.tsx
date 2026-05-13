import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { Agent } from '../../../preload/index'
import { dateParts } from '../../lib/datetime'

interface AgentsViewProps {
  refreshSignal: number
  onOpenAgent: (agent: Agent) => void
  onSelectAgent: (agent: Agent) => void
  selectedAgentSessionId: string | null
  /** When set (e.g. user clicked the 📜 历史 button on a project tab),
   *  pre-fill the search box with this string so the list filters down
   *  to that folder. Caller should clear via onConsumeInitialQuery after
   *  the prop is observed so the user can edit freely afterwards. */
  initialQuery?: string | null
  onConsumeInitialQuery?: () => void
}

type Bucket = { folder: string; sessions: Agent[]; latest: string }
type ActivityFilter = 'all' | '1d' | '1w' | '1m'
const STORAGE_FILTER = 'lineup:agentsActivityFilter'
const FILTER_LABELS: Record<ActivityFilter, string> = {
  all: '全部', '1d': '近 1 天', '1w': '近 1 周', '1m': '近 1 月',
}
const FILTER_CUTOFF_MS: Record<ActivityFilter, number> = {
  all: Infinity,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // All field extraction goes through dateParts so the user's configured
  // display TZ wins over the renderer's OS-derived TZ (which can drift
  // when a VPN moves the geo-IP into a different region).
  const dp = dateParts(d)
  const np = dateParts(new Date())
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameDay = dp.year === np.year && dp.month === np.month && dp.day === np.day
  if (sameDay) {
    return `今天 ${pad(dp.hour)}:${pad(dp.minute)}`
  }
  const diffMs = Date.now() - d.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays > 0 && diffDays < 7) return `${diffDays} 天前`
  return `${dp.year}-${pad(dp.month)}-${pad(dp.day)} ${pad(dp.hour)}:${pad(dp.minute)}`
}

// Collapse the home dir into ~/ for compactness, like most terminals do.
function prettyPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

export function AgentsView({
  refreshSignal, onOpenAgent, onSelectAgent, selectedAgentSessionId,
  initialQuery, onConsumeInitialQuery,
}: AgentsViewProps) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(() => {
    const v = localStorage.getItem(STORAGE_FILTER)
    return v === '1d' || v === '1w' || v === '1m' || v === 'all' ? v : 'all'
  })
  useEffect(() => { localStorage.setItem(STORAGE_FILTER, activityFilter) }, [activityFilter])

  // When the parent passes a one-shot initialQuery (📜 历史 from a chat
  // tab), populate the search box and consume it so future renders don't
  // overwrite the user's edits.
  useEffect(() => {
    if (initialQuery && initialQuery.trim()) {
      setQuery(initialQuery)
      onConsumeInitialQuery?.()
    }
  }, [initialQuery, onConsumeInitialQuery])
  // Row-level context menu state.
  const [menu, setMenu] = useState<
    | { agent: Agent; x: number; y: number }
    | null
  >(null)
  const [renameTarget, setRenameTarget] = useState<Agent | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [titleGenerating, setTitleGenerating] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [menu])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.lineup.listAllAgents()
      setAgents(list)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load, refreshSignal])

  // Background auto-title: fire MiMo for sessions that don't have a
  // fresh auto-title. Runs once per (sessionId, lastTs) combination, so
  // repeat AgentsView loads don't re-fire for sessions that are stable.
  // Titles arrive silently — we patch `agents` in place when results land.
  const autoTitledRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (agents.length === 0) return
    const payload = agents
      .filter(a =>
        a.folder_path &&
        a.last_modified &&
        !autoTitledRef.current.has(`${a.session_id}:${a.last_modified}`)
      )
      .map(a => ({
        sessionId: a.session_id,
        folderPath: a.folder_path!,
        lastTs: a.last_modified!,
      }))
    if (payload.length === 0) return
    // Mark all as "in-flight / done" upfront so a reload before we get
    // results doesn't re-fire.
    for (const p of payload) autoTitledRef.current.add(`${p.sessionId}:${p.lastTs}`)
    let cancelled = false
    window.lineup.autoTitleSessions(payload).then((results) => {
      if (cancelled) return
      // Build a patch map of {session_id → new title} for sessions where
      // MiMo actually produced one (skipped/cached/error → no patch).
      const patch = new Map<string, string>()
      for (const r of results) if (r.title) patch.set(r.sessionId, r.title)
      if (patch.size === 0) return
      setAgents(prev => prev.map(a => {
        const t = patch.get(a.session_id)
        return t ? { ...a, name: t } : a
      }))
    }).catch(() => { /* swallow — next load will retry */ })
    return () => { cancelled = true }
  }, [agents])

  // Group sessions by folder so the user sees each project / cwd as a
  // collection, and branches within it sorted newest-first. Apply both
  // the free-text query AND the activity-window filter here.
  const now = Date.now()
  const cutoff = FILTER_CUTOFF_MS[activityFilter]
  const visibleAgents = useMemo(() => {
    const q = query.trim().toLowerCase()
    return agents.filter(a => {
      if (q) {
        const hay = (a.name + ' ' + (a.folder_path ?? '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (cutoff !== Infinity) {
        const ts = a.last_modified ?? a.last_active_at
        if (!ts) return false
        const t = new Date(ts).getTime()
        if (!Number.isFinite(t) || now - t > cutoff) return false
      }
      return true
    })
  }, [agents, query, cutoff, now])

  const buckets: Bucket[] = useMemo(() => {
    const byFolder = new Map<string, Agent[]>()
    for (const a of visibleAgents) {
      const folder = a.folder_path ?? '(unknown)'
      if (!byFolder.has(folder)) byFolder.set(folder, [])
      byFolder.get(folder)!.push(a)
    }
    const list: Bucket[] = []
    for (const [folder, sessions] of byFolder) {
      sessions.sort((a, b) =>
        (b.last_modified ?? b.last_active_at ?? '').localeCompare(
          a.last_modified ?? a.last_active_at ?? ''
        )
      )
      const latest = sessions[0]?.last_modified ?? sessions[0]?.last_active_at ?? ''
      list.push({ folder, sessions, latest })
    }
    list.sort((a, b) => b.latest.localeCompare(a.latest))
    return list
  }, [visibleAgents])

  const totalBranches = visibleAgents.length
  const totalFolders = buckets.length
  const allBranches = agents.length

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-xl font-semibold">🤖 Agent 总览</div>
            <div className="text-xs text-muted-foreground mt-1">
              {loading
                ? '加载中...'
                : activityFilter === 'all'
                  ? `${totalFolders} 个文件夹，${totalBranches} 个会话`
                  : `${totalFolders} 个文件夹，${totalBranches} / ${allBranches} 个会话（${FILTER_LABELS[activityFilter]}）`}
            </div>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs px-3 py-1 rounded border border-border hover:bg-accent disabled:opacity-50"
            title="重新扫描"
          >
            ↻ 刷新
          </button>
        </div>
        <div className="mt-3 flex items-center gap-1">
          {(['all', '1d', '1w', '1m'] as ActivityFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setActivityFilter(f)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                activityFilter === f
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:bg-accent/50 text-muted-foreground'
              }`}
            >{FILTER_LABELS[f]}</button>
          ))}
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选（文件夹路径或会话名）..."
          className="mt-3 w-full px-3 py-1.5 text-sm rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {!loading && buckets.length === 0 && (
          <div className="text-center text-sm text-muted-foreground py-12">
            {agents.length === 0 ? '还没有 claude 会话记录' : '没有匹配的结果'}
          </div>
        )}

        {buckets.map((b) => (
          <section key={b.folder} className="border-b border-border">
            <header className="px-6 py-2 bg-card/50 sticky top-0 z-10 flex items-center gap-2">
              <span className="text-sm">📁</span>
              <button
                onClick={() => window.lineup.revealInFinder(b.folder)}
                className="text-sm font-mono text-foreground hover:text-primary truncate text-left"
                title={`${b.folder}（点击在 Finder 中显示）`}
              >
                {prettyPath(b.folder)}
              </button>
              <span className="text-xs text-muted-foreground ml-auto shrink-0">
                {b.sessions.length} 个分支 · 最近 {formatDate(b.latest)}
              </span>
            </header>

            <div>
              {b.sessions.map((s) => (
                <button
                  key={s.session_id || `${s.id}`}
                  onClick={() => onSelectAgent(s)}
                  onDoubleClick={() => onOpenAgent(s)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ agent: s, x: e.clientX, y: e.clientY })
                  }}
                  className={`w-full text-left px-6 py-2 flex items-start gap-3 transition-colors border-t border-border/50 first:border-t-0
                    ${selectedAgentSessionId === s.session_id
                      ? 'bg-primary/10'
                      : 'hover:bg-accent/50'}`}
                  title="单击查看详情 · 双击在 lineup 内嵌终端打开 · 右键更多选项"
                >
                  <span className="text-xs text-muted-foreground shrink-0 mt-0.5">
                    {s.is_db ? '★' : '·'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{s.name || s.session_id.slice(0, 8)}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                      <span className="font-mono">{s.session_id.slice(0, 8)}</span>
                      {typeof s.message_count === 'number' && s.message_count > 0 && (
                        <span>· {s.message_count} 条消息</span>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 mt-0.5">
                    {formatDate(s.last_modified ?? s.last_active_at ?? '')}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Row context menu */}
      {menu && (
        <div
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 bg-popover border border-border rounded shadow-lg py-1 text-sm min-w-[200px]"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            onClick={() => {
              setRenameDraft(menu.agent.name ?? '')
              setRenameTarget(menu.agent)
              setMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-accent"
          >✏️ 重命名</button>
          <button
            onClick={async () => {
              if (!menu.agent.folder_path) { setMenu(null); return }
              setTitleGenerating(menu.agent.session_id)
              const sid = menu.agent.session_id
              const fp = menu.agent.folder_path
              setMenu(null)
              try {
                await window.lineup.generateSessionTitle(sid, fp)
                load()
              } finally {
                setTitleGenerating(null)
              }
            }}
            disabled={titleGenerating === menu.agent.session_id}
            className="w-full text-left px-3 py-1.5 hover:bg-accent disabled:opacity-60"
          >{titleGenerating === menu.agent.session_id ? '⏳ 生成中...' : '✨ 让 MiMo 生成标题'}</button>
          <button
            onClick={() => {
              window.lineup.copyToClipboard(menu.agent.session_id)
              setMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-accent"
          >🔑 复制 session ID</button>
          <div className="border-t border-border my-1" />
          <button
            onClick={async () => {
              const ag = menu.agent
              setMenu(null)
              // Resolve a cwd that ACTUALLY matches where the jsonl
              // lives, not the per-line cwd field (which can drift from
              // storage location after fork / auto-compact / lineup
              // re-mount). Falls back to folder_path only when there's
              // no session_id (fresh-spawn case, no resume needed).
              let cwd = ag.folder_path ?? ''
              if (ag.session_id) {
                const r = await window.lineup.resolveResumeCwd(ag.session_id)
                if (r.ok && r.cwd) {
                  cwd = r.cwd
                } else if (!cwd) {
                  alert(`无法定位 session ${ag.session_id.slice(0,8)}：${r.error ?? '未知错误'}`)
                  return
                }
                // If resolveResumeCwd failed but we have a folder_path,
                // fall through and try anyway — at worst the user sees
                // claude's own "no session found" error and can cd
                // manually. Better than refusing to open the terminal.
              }
              if (!cwd) { return }
              await window.lineup.openExternalTerminalWithCommand(
                cwd,
                ag.session_id ? `claude --resume ${ag.session_id}` : 'claude',
              )
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-accent"
          >🖥 在 Terminal 打开（预填 --resume）</button>
          <button
            onClick={() => { onOpenAgent(menu.agent); setMenu(null) }}
            className="w-full text-left px-3 py-1.5 hover:bg-accent"
          >💬 在 lineup 内嵌终端打开</button>
        </div>
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setRenameTarget(null)}
        >
          <div
            className="bg-popover border border-border rounded-lg shadow-xl p-4 w-[420px] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium mb-2">重命名会话</div>
            <div className="text-xs text-muted-foreground font-mono mb-3 truncate">
              {renameTarget.session_id}
            </div>
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  await window.lineup.renameSession(renameTarget.session_id, renameDraft)
                  setRenameTarget(null)
                  load()
                } else if (e.key === 'Escape') setRenameTarget(null)
              }}
              placeholder="新标题（留空 = 清除自定义，回到自动标题）"
              className="w-full px-3 py-1.5 text-sm rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setRenameTarget(null)}
                className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent"
              >取消</button>
              <button
                onClick={async () => {
                  await window.lineup.renameSession(renameTarget.session_id, renameDraft)
                  setRenameTarget(null)
                  load()
                }}
                className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground"
              >保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
