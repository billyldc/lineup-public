import { useState, useEffect, useCallback, useMemo } from 'react'
import type { Agent, SessionData, TimelineEvent } from '../../preload/index'
import { buildTimeTree } from './SessionTimeTree'
import { showTransientToast } from '../lib/sendToMainAgent'
import { dateParts } from '../lib/datetime'

interface SessionInspectorProps {
  agent: Agent
  onClose: () => void
  // Open the session in lineup's embedded pty (ChatPanel tab).
  onResume: (agent: Agent) => void
  // Triggered when the user renames or regenerates the title — parent
  // (AgentsView / App) should refresh its cached Agent list so the new
  // title shows up elsewhere.
  onAgentUpdated?: () => void
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function formatTs(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDate(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function prettyPath(p: string | null): string {
  if (!p) return ''
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

// Single-line icon per tool for the timeline. Falls back to a generic
// square for anything we don't explicitly know.
const toolIcon: Record<string, string> = {
  Edit: '✏️', MultiEdit: '✏️', Write: '📝', Read: '👁',
  Bash: '⌨', Grep: '🔍', Glob: '🔎',
  WebFetch: '🌐', WebSearch: '🌐',
  TodoWrite: '☑', Agent: '🤖', ToolSearch: '🔧',
}

// Collapse noisy event kinds so the timeline stays readable. Thinking and
// tool results are hidden behind per-row toggles; only user + assistant
// text + tool-use lines render by default.
interface FilterState {
  thinking: boolean
  toolResult: boolean
  system: boolean
}

export function SessionInspector({ agent, onClose, onResume, onAgentUpdated }: SessionInspectorProps) {
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [titleGenerating, setTitleGenerating] = useState(false)
  const [openingTerminal, setOpeningTerminal] = useState(false)

  const handleOpenInTerminal = useCallback(async () => {
    if (!agent.folder_path) return
    const hasSession = agent.session_id && agent.session_id.length > 0
    const command = hasSession ? `claude --resume ${agent.session_id}` : 'claude'
    setOpeningTerminal(true)
    try {
      await window.lineup.openExternalTerminalWithCommand(agent.folder_path, command)
    } finally {
      setOpeningTerminal(false)
    }
  }, [agent.folder_path, agent.session_id])

  const handleCopySessionId = useCallback(() => {
    window.lineup.copyToClipboard(agent.session_id)
    showTransientToast(`📋 已复制 ${agent.session_id.slice(0, 8)}…`)
  }, [agent.session_id])

  const handleRenameSubmit = useCallback(async () => {
    await window.lineup.renameSession(agent.session_id, renameDraft)
    setRenaming(false)
    onAgentUpdated?.()
  }, [agent.session_id, renameDraft, onAgentUpdated])

  const handleGenerateTitle = useCallback(async () => {
    if (!agent.folder_path) return
    setTitleGenerating(true)
    try {
      await window.lineup.generateSessionTitle(agent.session_id, agent.folder_path)
      onAgentUpdated?.()
    } finally {
      setTitleGenerating(false)
    }
  }, [agent.session_id, agent.folder_path, onAgentUpdated])

  const [data, setData] = useState<SessionData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterState>({
    thinking: false, toolResult: false, system: false,
  })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<'timeline' | 'stats'>('timeline')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setData(null)
    if (!agent.folder_path) {
      setError(`会话没有关联 folder_path（session=${agent.session_id.slice(0, 8)}）`)
      setLoading(false)
      return
    }
    try {
      const res = await window.lineup.readSession(agent.folder_path, agent.session_id)
      if (res.ok) setData(res.data)
      else setError(res.error)
    } catch (e: any) {
      // Most common: main process hasn't reloaded yet, so the IPC channel
      // isn't registered. Tell the user.
      setError(
        `IPC 调用失败：${e?.message ?? String(e)}\n` +
        `如果看到 "No handler registered" 请重启 electron 开发进程。`
      )
    } finally {
      setLoading(false)
    }
  }, [agent.folder_path, agent.session_id])
  useEffect(() => { load() }, [load])

  const visibleEvents = useMemo(() => {
    if (!data) return []
    return data.events.filter(e => {
      if (e.kind === 'thinking') return filter.thinking
      if (e.kind === 'tool-result') return filter.toolResult
      if (e.kind === 'system') return filter.system
      return true
    })
  }, [data, filter])

  const toggleExpand = (uuid: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(uuid)) next.delete(uuid)
      else next.add(uuid)
      return next
    })
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameSubmit()
                    else if (e.key === 'Escape') setRenaming(false)
                  }}
                  className="flex-1 px-2 py-0.5 text-sm rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="新标题（留空=清除自定义）"
                />
                <button
                  onClick={handleRenameSubmit}
                  className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground"
                >保存</button>
                <button
                  onClick={() => setRenaming(false)}
                  className="text-xs px-2 py-0.5 rounded border border-border"
                >取消</button>
              </div>
            ) : (
              <div className="flex items-center gap-1 group">
                <div className="text-sm font-medium truncate">{agent.name || agent.session_id.slice(0, 8)}</div>
                <button
                  onClick={() => { setRenameDraft(agent.name ?? ''); setRenaming(true) }}
                  className="opacity-0 group-hover:opacity-100 text-xs text-muted-foreground hover:text-foreground transition-opacity"
                  title="重命名"
                >✏️</button>
                <button
                  onClick={handleGenerateTitle}
                  disabled={titleGenerating}
                  className="opacity-0 group-hover:opacity-100 text-xs text-muted-foreground hover:text-foreground transition-opacity disabled:opacity-60"
                  title="让 MiMo 根据会话内容重新生成标题"
                >{titleGenerating ? '…' : '✨'}</button>
              </div>
            )}
            {/* Full session UUID — 🔑 icon copies; full ID stays visible
                so users can verify it's the right session at a glance. */}
            <div className="text-[11px] text-muted-foreground mt-0.5 font-mono flex items-start gap-1">
              <button
                onClick={handleCopySessionId}
                className="hover:text-foreground shrink-0"
                title="复制 session ID 到剪贴板"
              >🔑</button>
              <span className="break-all leading-snug">{agent.session_id}</span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              <button
                onClick={() => agent.folder_path && window.lineup.revealInFinder(agent.folder_path)}
                className="font-mono hover:text-foreground truncate"
                title={agent.folder_path ?? ''}
              >
                📁 {prettyPath(agent.folder_path ?? null)}
              </button>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-sm px-2"
            title="关闭"
          >✕</button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => onResume(agent)}
            disabled={!agent.folder_path}
            className="flex-1 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-60"
            title="在 lineup 内嵌终端（ChatPanel tab）中 --resume 这个 session"
          >💬 lineup 内打开</button>
          <button
            onClick={handleOpenInTerminal}
            disabled={openingTerminal || !agent.folder_path}
            className="flex-1 text-xs px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-60"
            title="macOS Terminal.app 新窗口，zsh print -z 预填 claude --resume 命令（回车即运行）"
          >🖥 {openingTerminal ? '打开中...' : 'Terminal.app'}</button>
          <button
            onClick={load}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-accent"
            title="重新读取 jsonl"
          >↻</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border shrink-0">
        <button
          onClick={() => setTab('timeline')}
          className={`flex-1 text-xs py-2 ${tab === 'timeline' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}
        >⏱ Timeline</button>
        <button
          onClick={() => setTab('stats')}
          className={`flex-1 text-xs py-2 ${tab === 'stats' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}
        >📊 Stats</button>
      </div>

      {loading && (
        <div className="p-6 text-center text-sm text-muted-foreground">加载中...</div>
      )}

      {!loading && !data && (
        <div className="p-6 text-sm text-muted-foreground">
          <div className="font-medium text-foreground mb-2">无法读取会话</div>
          <div className="whitespace-pre-wrap break-words text-xs font-mono">
            {error ?? 'jsonl 不存在或损坏'}
          </div>
          <div className="mt-3 text-xs">
            folder_path: <span className="font-mono">{agent.folder_path ?? '(null)'}</span><br />
            session_id: <span className="font-mono">{agent.session_id}</span>
          </div>
        </div>
      )}

      {!loading && data && tab === 'stats' && <StatsPanel data={data} />}
      {!loading && data && tab === 'timeline' && (
        <TimelineAccordion
          sessionId={agent.session_id}
          folderPath={agent.folder_path ?? ''}
          allEvents={data.events}
          visibleEvents={visibleEvents}
          filter={filter}
          setFilter={setFilter}
          expanded={expanded}
          toggleExpand={toggleExpand}
        />
      )}
    </div>
  )
}

/**
 * Inline accordion that IS the default timeline view. No sidebar.
 *
 *   📅 04-08 周六  42 轮 · 230 工具
 *     [MiMo one-line day summary, auto-fetched]
 *     └─ ▸ 12-16  14 轮  "first user turn headline"
 *            [MiMo slot summary]
 *            [when slot expanded: actual events in that 4h window]
 *     └─ ▸ 16-20  ...
 *   📅 04-09 周日
 *     ...
 *
 * Day summaries auto-fetch on mount (parallel batch). Slot summaries
 * auto-fetch when their parent day is expanded. Everything is cached in
 * time_bucket_summaries so re-opening the same session is instant.
 */
function TimelineAccordion({
  sessionId, folderPath, allEvents, visibleEvents, filter, setFilter, expanded, toggleExpand,
}: {
  sessionId: string
  folderPath: string
  allEvents: TimelineEvent[]
  visibleEvents: TimelineEvent[]
  filter: FilterState
  setFilter: (f: FilterState) => void
  expanded: Set<string>
  toggleExpand: (uuid: string) => void
}) {
  const tree = useMemo(() => buildTimeTree(allEvents), [allEvents])
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const [openSlots, setOpenSlots] = useState<Set<string>>(new Set())
  // Persist summaries to localStorage per session so re-opening the
  // inspector shows them INSTANTLY (no "生成总结中" flash while we wait
  // for the IPC round-trip). Separate keys per session so they don't
  // collide.
  const dayKey = `lineup:sum:day:${sessionId}`
  const slotKey = `lineup:sum:slot:${sessionId}`
  const [daySummaries, setDaySummaries] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(dayKey) || '{}') } catch { return {} }
  })
  const [slotSummaries, setSlotSummaries] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(slotKey) || '{}') } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem(dayKey, JSON.stringify(daySummaries)) } catch {}
  }, [dayKey, daySummaries])
  useEffect(() => {
    try { localStorage.setItem(slotKey, JSON.stringify(slotSummaries)) } catch {}
  }, [slotKey, slotSummaries])
  // Which buckets are in-flight. key: `${date}:${slot}` (slot = -1 for day).
  const [loadingBuckets, setLoadingBuckets] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  // For each event, pre-compute which bucket (date/slot) it belongs to, so
  // slot-expand sections can show events without re-filtering every render.
  // Bucketing MUST agree with SessionTimeTree.buildTimeTree — that's why
  // both go through dateParts (display TZ aware) instead of slicing the
  // raw UTC ISO string.
  const eventIndicesByBucket = useMemo(() => {
    const map = new Map<string, number[]>()
    allEvents.forEach((e, i) => {
      if (!e.ts) return
      const dp = dateParts(new Date(e.ts))
      const pad = (n: number) => String(n).padStart(2, '0')
      const date = `${dp.year}-${pad(dp.month)}-${pad(dp.day)}`
      const slot = Math.floor(dp.hour / 4)
      const key = `${date}:${slot}`
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(i)
    })
    return map
  }, [allEvents])

  // Visible-event lookup (kind filter already applied). Set for O(1) check
  // when slot is expanded.
  const visibleIdxSet = useMemo(() => {
    const s = new Set<TimelineEvent>()
    for (const e of visibleEvents) s.add(e)
    return s
  }, [visibleEvents])

  // Auto-fetch day summaries on mount (for this session). Runs once per
  // sessionId change. Whole-day summary slot_index = -1.
  //
  // Days already cached in localStorage don't show the "生成总结中..."
  // spinner — we still refresh them in the background (cheap, backend
  // cache-hits) so content updates silently. Only NEW days get the
  // loading state.
  useEffect(() => {
    if (!folderPath || tree.days.length === 0) return
    const dayBuckets = tree.days.map(d => ({
      date: d.date,
      slot_index: -1,
      event_indices: eventIndicesByBucket.get(`${d.date}:-1`) ?? dayEventIndices(d.date, eventIndicesByBucket),
    }))
    const keys = dayBuckets.map(b => `${b.date}:-1`)
    // Only show spinner for days we don't have a cached summary for.
    const keysForSpinner = keys.filter(k => {
      const date = k.replace(/:-1$/, '')
      return !daySummaries[date]
    })
    if (keysForSpinner.length > 0) {
      setLoadingBuckets(prev => {
        const next = new Set(prev); keysForSpinner.forEach(k => next.add(k)); return next
      })
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await window.lineup.summarizeBuckets(sessionId, folderPath, dayBuckets)
        if (cancelled) return
        const s: Record<string, string> = {}
        const er: Record<string, string> = {}
        for (const r of res) {
          const k = `${r.date}:-1`
          if (r.summary) s[r.date] = r.summary
          else if (r.error) er[k] = r.error
        }
        if (Object.keys(s).length) setDaySummaries(prev => ({ ...prev, ...s }))
        if (Object.keys(er).length) setErrors(prev => ({ ...prev, ...er }))
      } catch (e: any) {
        // IPC rejection (e.g. backend threw). Mark every pending bucket as
        // errored so the UI stops saying "生成总结中..." forever.
        if (!cancelled) {
          const msg = e?.message ?? String(e)
          setErrors(prev => {
            const next = { ...prev }
            keys.forEach(k => { next[k] = msg })
            return next
          })
        }
      } finally {
        if (!cancelled) {
          setLoadingBuckets(prev => {
            const next = new Set(prev); keys.forEach(k => next.delete(k)); return next
          })
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, folderPath, tree.days.length])

  // When a day is opened, auto-fetch its slot summaries.
  const toggleDay = (date: string) => {
    setOpenDays(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else {
        next.add(date)
        fetchSlotsForDay(date)
      }
      return next
    })
  }

  const fetchSlotsForDay = useCallback((date: string) => {
    const day = tree.days.find(d => d.date === date)
    if (!day) return
    const need = day.slots.filter(s => {
      const k = `${date}:${s.slot_index}`
      return !slotSummaries[k] && !loadingBuckets.has(k)
    })
    if (!need.length) return
    const buckets = need.map(s => ({
      date, slot_index: s.slot_index,
      event_indices: eventIndicesByBucket.get(`${date}:${s.slot_index}`) ?? [],
    }))
    const keys = buckets.map(b => `${b.date}:${b.slot_index}`)
    setLoadingBuckets(prev => {
      const next = new Set(prev); keys.forEach(k => next.add(k)); return next
    })
    ;(async () => {
      try {
        const res = await window.lineup.summarizeBuckets(sessionId, folderPath, buckets)
        const s: Record<string, string> = {}
        const er: Record<string, string> = {}
        for (const r of res) {
          const k = `${r.date}:${r.slot_index}`
          if (r.summary) s[k] = r.summary
          else if (r.error) er[k] = r.error
        }
        if (Object.keys(s).length) setSlotSummaries(prev => ({ ...prev, ...s }))
        if (Object.keys(er).length) setErrors(prev => ({ ...prev, ...er }))
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        setErrors(prev => {
          const next = { ...prev }
          keys.forEach(k => { next[k] = msg })
          return next
        })
      } finally {
        setLoadingBuckets(prev => {
          const next = new Set(prev); keys.forEach(k => next.delete(k)); return next
        })
      }
    })()
  }, [tree, eventIndicesByBucket, sessionId, folderPath, slotSummaries, loadingBuckets])

  const toggleSlot = (date: string, slotIndex: number) => {
    const key = `${date}:${slotIndex}`
    setOpenSlots(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  if (tree.days.length === 0) {
    return (
      <>
        <FilterBar filter={filter} setFilter={setFilter} />
        <div className="p-6 text-center text-sm text-muted-foreground">
          没有带时间戳的事件
        </div>
      </>
    )
  }

  return (
    <>
      <FilterBar filter={filter} setFilter={setFilter} />
      <div className="flex-1 overflow-y-auto">
        {tree.days.map(day => {
          const dayOpen = openDays.has(day.date)
          const dayKey = `${day.date}:-1`
          const daySummary = daySummaries[day.date]
          const dayLoading = loadingBuckets.has(dayKey)
          const dayError = errors[dayKey]
          const weekday = new Date(day.date + 'T00:00:00').toLocaleDateString('zh-CN', { weekday: 'short' })
          return (
            <div key={day.date} className="border-b border-border">
              <button
                onClick={() => toggleDay(day.date)}
                className="w-full text-left px-3 py-2 hover:bg-accent/40 transition-colors"
              >
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="shrink-0 text-muted-foreground">{dayOpen ? '▼' : '▶'}</span>
                  <span className="font-medium">📅 {day.date}</span>
                  <span className="text-xs text-muted-foreground">{weekday}</span>
                  <span className="text-xs text-muted-foreground ml-auto shrink-0 font-mono">
                    {day.user_turns} 轮 · {day.tool_count} 工具
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1 pl-5 break-words">
                  {daySummary
                    ? <span className="text-foreground/90">✨ {daySummary}</span>
                    : dayLoading
                      ? <span className="italic opacity-60">生成总结中...</span>
                      : dayError
                        ? <span className="text-red-500/80">[总结失败: {dayError.slice(0, 60)}]</span>
                        : <span className="italic opacity-60">"{day.headline}"</span>}
                </div>
              </button>

              {dayOpen && day.slots.map(slot => {
                const slotKey = `${day.date}:${slot.slot_index}`
                const slotOpen = openSlots.has(slotKey)
                const slotSummary = slotSummaries[slotKey]
                const slotLoading = loadingBuckets.has(slotKey)
                const slotError = errors[slotKey]
                const startH = String(slot.start_hour).padStart(2, '0')
                const endH   = String(slot.end_hour + 1).padStart(2, '0')
                return (
                  <div key={slot.slot_index} className="border-t border-border/40 bg-card/20">
                    <button
                      onClick={() => toggleSlot(day.date, slot.slot_index)}
                      className="w-full text-left px-3 py-1.5 pl-8 hover:bg-accent/30 transition-colors"
                    >
                      <div className="flex items-baseline gap-2 text-xs">
                        <span className="shrink-0 text-muted-foreground">{slotOpen ? '▼' : '▶'}</span>
                        <span className="font-mono">{startH}:00-{endH}:00</span>
                        <span className="text-muted-foreground ml-auto shrink-0">
                          {slot.user_turns} 轮
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5 pl-5 break-words">
                        {slotSummary
                          ? <span className="text-foreground/85">✨ {slotSummary}</span>
                          : slotLoading
                            ? <span className="italic opacity-60">...</span>
                            : slotError
                              ? <span className="text-red-500/80">[{slotError.slice(0, 50)}]</span>
                              : <span className="italic opacity-60">"{slot.headline}"</span>}
                      </div>
                    </button>
                    {slotOpen && (
                      <div className="border-t border-border/40 bg-background">
                        <SlotEvents
                          date={day.date}
                          slotIndex={slot.slot_index}
                          allEvents={allEvents}
                          visibleEvents={visibleEvents}
                          visibleIdxSet={visibleIdxSet}
                          expanded={expanded}
                          toggleExpand={toggleExpand}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </>
  )
}

// Fallback helper: derive day event indices when the precomputed map has
// no key (shouldn't happen but safe).
function dayEventIndices(date: string, bucketMap: Map<string, number[]>): number[] {
  const out: number[] = []
  for (let s = 0; s < 6; s++) {
    const arr = bucketMap.get(`${date}:${s}`)
    if (arr) out.push(...arr)
  }
  return out
}

function SlotEvents({ date, slotIndex, allEvents, visibleEvents, visibleIdxSet, expanded, toggleExpand }: {
  date: string
  slotIndex: number
  allEvents: TimelineEvent[]
  visibleEvents: TimelineEvent[]
  visibleIdxSet: Set<TimelineEvent>
  expanded: Set<string>
  toggleExpand: (uuid: string) => void
}) {
  const events = useMemo(() => {
    const out: TimelineEvent[] = []
    const pad = (n: number) => String(n).padStart(2, '0')
    for (const e of allEvents) {
      if (!e.ts) continue
      const dp = dateParts(new Date(e.ts))
      const eDate = `${dp.year}-${pad(dp.month)}-${pad(dp.day)}`
      if (eDate !== date) continue
      if (Math.floor(dp.hour / 4) !== slotIndex) continue
      if (!visibleIdxSet.has(e)) continue   // kind filter
      out.push(e)
    }
    return out
  }, [allEvents, date, slotIndex, visibleIdxSet])

  // Silence "visibleEvents unused" warning; it's the authoritative filter
  // source for visibleIdxSet which we DO use.
  void visibleEvents

  if (events.length === 0) {
    return <div className="px-4 py-2 text-xs text-muted-foreground">此时段没有可见事件（调整顶部 filter 查看更多）</div>
  }
  return (
    <>
      {events.map((e, i) => (
        <TimelineRow
          key={e.uuid + ':' + i}
          event={e}
          expanded={expanded.has(e.uuid)}
          onToggle={() => toggleExpand(e.uuid)}
        />
      ))}
    </>
  )
}

function FilterBar({ filter, setFilter }: {
  filter: FilterState
  setFilter: (f: FilterState) => void
}) {
  const t = (k: keyof FilterState) => setFilter({ ...filter, [k]: !filter[k] })
  const btn = (active: boolean, label: string, on: () => void) => (
    <button
      onClick={on}
      className={`text-[11px] px-2 py-0.5 rounded border ${active ? 'bg-accent border-border' : 'border-transparent text-muted-foreground'}`}
    >{label}</button>
  )
  return (
    <div className="px-3 py-1.5 border-b border-border flex items-center gap-1 shrink-0">
      <span className="text-[11px] text-muted-foreground mr-1">显示：</span>
      {btn(filter.thinking, '💭 思考', () => t('thinking'))}
      {btn(filter.toolResult, '↵ 结果', () => t('toolResult'))}
      {btn(filter.system, '⚙ 系统', () => t('system'))}
    </div>
  )
}

function TimelineRow({ event: e, expanded, onToggle }: {
  event: TimelineEvent
  expanded: boolean
  onToggle: () => void
}) {
  const ts = formatTs(e.ts)
  if (e.kind === 'user') {
    const short = (e.text ?? '').split('\n')[0].slice(0, 120)
    const isLong = (e.text ?? '').length > short.length
    return (
      <div className="px-3 py-2 border-l-2 border-primary/60 bg-primary/5">
        <div className="text-[11px] text-muted-foreground mb-0.5 flex justify-between">
          <span>👤 用户</span><span className="font-mono">{ts}</span>
        </div>
        <div
          onClick={isLong ? onToggle : undefined}
          className={`text-sm whitespace-pre-wrap break-words ${isLong ? 'cursor-pointer' : ''}`}
        >
          {expanded || !isLong ? e.text : short + (isLong ? ' …' : '')}
        </div>
      </div>
    )
  }
  if (e.kind === 'assistant-text') {
    const short = (e.text ?? '').split('\n\n')[0].slice(0, 240)
    const isLong = (e.text ?? '').length > short.length
    return (
      <div className="px-3 py-2 border-l-2 border-border">
        <div className="text-[11px] text-muted-foreground mb-0.5 flex justify-between">
          <span>🤖 助手</span><span className="font-mono">{ts}</span>
        </div>
        <div
          onClick={isLong ? onToggle : undefined}
          className={`text-sm whitespace-pre-wrap break-words ${isLong ? 'cursor-pointer' : ''}`}
        >
          {expanded || !isLong ? e.text : short + (isLong ? ' …' : '')}
        </div>
      </div>
    )
  }
  if (e.kind === 'thinking') {
    return (
      <div className="px-3 py-1.5 border-l-2 border-amber-500/40 bg-amber-500/5">
        <div className="text-[11px] text-muted-foreground mb-0.5 flex justify-between">
          <span>💭 思考</span><span className="font-mono">{ts}</span>
        </div>
        <div
          onClick={onToggle}
          className="text-xs text-muted-foreground italic cursor-pointer whitespace-pre-wrap break-words"
        >
          {expanded ? e.text : (e.text ?? '').slice(0, 160) + ' …'}
        </div>
      </div>
    )
  }
  if (e.kind === 'tool-use' && e.tool) {
    const icon = toolIcon[e.tool.name] ?? '🔧'
    const summary = e.tool.summary ?? ''
    const diff =
      (e.tool.added || e.tool.removed)
        ? (
          <span className="ml-2 font-mono text-[11px]">
            {e.tool.added ? <span className="text-green-600">+{e.tool.added}</span> : null}
            {' '}
            {e.tool.removed ? <span className="text-red-600">-{e.tool.removed}</span> : null}
          </span>
        ) : null
    // Click toggles expand so the user can see the full tool args. We always
    // wire up the click handler (not just when truncated) because whether
    // the line visually clips depends on the current pane width — gating on
    // string length would miss short-but-clipped lines like the one in the
    // screenshot.
    return (
      <div
        onClick={onToggle}
        className="px-3 py-1 text-xs border-l-2 border-transparent hover:bg-accent/30 cursor-pointer"
      >
        <div className="flex items-baseline gap-2">
          <span className="shrink-0">{icon}</span>
          <span className="font-medium shrink-0">{e.tool.name}</span>
          <span className={`text-muted-foreground flex-1 font-mono ${expanded ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>
            {summary}
          </span>
          {diff}
          <span className="font-mono text-muted-foreground/60 text-[10px] shrink-0">{ts}</span>
        </div>
      </div>
    )
  }
  if (e.kind === 'tool-result') {
    const err = e.is_error
    return (
      <div className={`px-3 py-1 text-xs ${err ? 'bg-red-500/5 border-l-2 border-red-500/40' : 'bg-muted/30 border-l-2 border-transparent'}`}>
        <div className="text-[11px] text-muted-foreground flex justify-between">
          <span>{err ? '⚠ 错误' : '↵ 结果'}</span><span className="font-mono">{ts}</span>
        </div>
        <div
          onClick={onToggle}
          className="whitespace-pre-wrap break-words font-mono text-muted-foreground cursor-pointer"
        >
          {expanded ? e.text : (e.text ?? '').slice(0, 160) + (((e.text ?? '').length > 160) ? ' …' : '')}
        </div>
      </div>
    )
  }
  if (e.kind === 'system') {
    return (
      <div className="px-3 py-1 text-[11px] text-muted-foreground italic">
        ⚙ {e.text}
      </div>
    )
  }
  return null
}

function StatsPanel({ data }: { data: SessionData }) {
  const s = data.stats
  const totalTokens = s.tokens.input + s.tokens.output + s.tokens.cache_read + s.tokens.cache_creation
  const sortedTools = Object.entries(s.tool_counts).sort((a, b) => b[1] - a[1])
  const maxToolCount = sortedTools[0]?.[1] ?? 1
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4 text-sm">
      <section>
        <SectionTitle>概览</SectionTitle>
        <Row label="开始">{formatDate(s.first_ts)} {formatTs(s.first_ts)}</Row>
        <Row label="结束">{formatDate(s.last_ts)} {formatTs(s.last_ts)}</Row>
        <Row label="时长">{formatDuration(s.duration_ms)}</Row>
        <Row label="消息">{s.user_turns} 用户 · {s.assistant_turns} 助手 · {s.message_count} 条原始记录</Row>
        <Row label="模型">{s.models.join(', ') || '—'}</Row>
        {s.git_branches.length > 0 && <Row label="Git 分支">{s.git_branches.join(', ')}</Row>}
      </section>

      <section>
        <SectionTitle>Token 用量</SectionTitle>
        <Row label="输入">{s.tokens.input.toLocaleString()}</Row>
        <Row label="输出">{s.tokens.output.toLocaleString()}</Row>
        <Row label="缓存读">{s.tokens.cache_read.toLocaleString()}</Row>
        <Row label="缓存写">{s.tokens.cache_creation.toLocaleString()}</Row>
        <Row label="总计">{totalTokens.toLocaleString()}</Row>
      </section>

      <section>
        <SectionTitle>工具调用 ({sortedTools.reduce((a, [, n]) => a + n, 0)})</SectionTitle>
        {sortedTools.length === 0 && <div className="text-xs text-muted-foreground">无</div>}
        {sortedTools.map(([name, n]) => (
          <div key={name} className="flex items-center gap-2 text-xs mb-0.5">
            <span className="shrink-0 w-24 font-mono truncate" title={name}>
              {toolIcon[name] ?? '🔧'} {name}
            </span>
            <div className="flex-1 h-2 bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-primary/60"
                style={{ width: `${(n / maxToolCount) * 100}%` }}
              />
            </div>
            <span className="shrink-0 w-8 text-right font-mono">{n}</span>
          </div>
        ))}
      </section>

      {s.file_changes.length > 0 && (
        <section>
          <SectionTitle>文件改动 ({s.file_changes.length})</SectionTitle>
          {s.file_changes.slice(0, 30).map(fc => (
            <div key={fc.path} className="flex items-baseline gap-2 text-xs mb-0.5">
              <span className="flex-1 font-mono truncate" title={fc.path}>{prettyPath(fc.path)}</span>
              <span className="text-muted-foreground shrink-0">{fc.edits}×</span>
              {fc.added > 0 && <span className="text-green-600 font-mono shrink-0">+{fc.added}</span>}
              {fc.removed > 0 && <span className="text-red-600 font-mono shrink-0">-{fc.removed}</span>}
            </div>
          ))}
          {s.file_changes.length > 30 && (
            <div className="text-[11px] text-muted-foreground mt-1">
              … 还有 {s.file_changes.length - 30} 个文件
            </div>
          )}
        </section>
      )}

      {s.bash_commands.length > 0 && (
        <section>
          <SectionTitle>Bash 命令（前 {s.bash_commands.length} 条）</SectionTitle>
          <div className="space-y-0.5">
            {s.bash_commands.map((c, i) => (
              <div key={i} className="text-xs font-mono text-muted-foreground truncate" title={c}>
                $ {c}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5 border-b border-border pb-0.5">
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-xs mb-0.5">
      <span className="shrink-0 w-16 text-muted-foreground">{label}</span>
      <span className="flex-1 min-w-0 break-words font-mono">{children}</span>
    </div>
  )
}
