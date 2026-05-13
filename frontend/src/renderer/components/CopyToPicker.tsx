import { useEffect, useRef, useState } from 'react'
import { showActionToast } from '../lib/sendToMainAgent'

/**
 * Modal picker for the "📎 引用到…" right-click action. Shows all
 * valid destination projects/tasks (filtered server-side per
 * containment rules + descendant exclusion), with client-side
 * substring search. Keyboard nav matches SearchPanel: ↑↓ to walk
 * results, Enter to confirm, Esc to close.
 *
 * "引用" not "副本": creates a multi-parent link (or an objects-table
 * sibling row) — the source isn't cloned, just made reachable from a
 * second place. Edit-once-applies-everywhere is the point.
 */

interface Dest {
  id: number
  name: string
  type: string
  breadcrumb: string
}

interface Props {
  /** Display label for the source row, just used in the header. */
  sourceLabel: string
  sourceKind: 'project' | 'object'
  sourceId: number
  onClose: () => void
  /** Called after a successful link. The page should refresh its
   *  column / list view. */
  onLinked: () => void
}

export function CopyToPicker({
  sourceLabel, sourceKind, sourceId, onClose, onLinked,
}: Props) {
  const [query, setQuery] = useState('')
  const [dests, setDests] = useState<Dest[]>([])
  const [loading, setLoading] = useState(true)
  const [activeIdx, setActiveIdx] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // CJK IME guard — see SearchPanel for rationale. The IME's commit-
  // Enter shouldn't fire createReference; require an explicit ↑/↓
  // press first.
  const [hasNavigated, setHasNavigated] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Load destinations once on mount.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.lineup.listCopyDestinations({ sourceKind, sourceId })
      .then(list => {
        if (cancelled) return
        setDests(list)
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    setTimeout(() => inputRef.current?.focus(), 0)
    return () => { cancelled = true }
  }, [sourceKind, sourceId])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? dests.filter(d =>
        d.name.toLowerCase().includes(q) ||
        d.breadcrumb.toLowerCase().includes(q))
    : dests

  // Keep activeIdx in range as filtered shrinks. Re-arm the Enter
  // guard whenever the query changes so a fresh search starts safe.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0)
  }, [filtered.length, activeIdx])
  useEffect(() => { setHasNavigated(false) }, [query])

  async function commit(dest: Dest) {
    if (submitting) return
    setSubmitting(true); setError(null)
    const r = await window.lineup.createReference({
      sourceKind, sourceId, destId: dest.id,
    })
    setSubmitting(false)
    if (!r.ok) {
      setError(r.error || '引用失败')
      return
    }
    onLinked()
    onClose()
    // Fire-and-forget top-right toast with a countdown bar. Clicking
    // it drills the Miller columns to the new dest (reusing the
    // existing lineup:browse:open-project handler that resolves the
    // full ancestor chain). Auto-dismiss on timeout if user doesn't
    // care to jump.
    showActionToast({
      message: `✓ 已引用到「${dest.name}」`,
      hint: '点击跳转到新位置',
      durationMs: 5000,
      onClick: () => {
        window.dispatchEvent(new CustomEvent('lineup:browse:open-project', {
          detail: { projectId: dest.id },
        }))
      },
    })
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.nativeEvent.isComposing) return  // IME composition
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(filtered.length - 1, i + 1))
      setHasNavigated(true)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(0, i - 1))
      setHasNavigated(true)
      return
    }
    if (e.key === 'Enter') {
      if (!hasNavigated) return  // require explicit selection first
      e.preventDefault()
      const target = filtered[activeIdx]
      if (target) void commit(target)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[90vw] max-h-[70vh] flex flex-col bg-popover border border-border rounded-lg shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border">
          <div className="text-sm font-semibold">📎 引用 “{sourceLabel}” 到…</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            不会复制内容，只是让它同时出现在另一个项目下面（多 parent 链接）
          </div>
        </div>
        <div className="px-4 py-2 border-b border-border flex items-center gap-2">
          <span className="text-muted-foreground text-sm">🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="筛选目标项目…"
            className="flex-1 bg-transparent text-sm outline-none"
          />
          <span className="text-xs text-muted-foreground">
            {filtered.length} / {dests.length}
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="text-xs text-muted-foreground text-center py-8">加载中…</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-8">
              {dests.length === 0
                ? '没有可用的目标项目'
                : '没有匹配的项目'}
            </div>
          )}
          {filtered.map((d, i) => (
            <button
              key={d.id}
              onClick={() => commit(d)}
              onMouseEnter={() => setActiveIdx(i)}
              className={`w-full text-left px-4 py-2 flex items-center gap-3 text-sm
                          ${activeIdx === i ? 'bg-primary/15 text-foreground' : 'hover:bg-accent/50'}`}
            >
              <span className="shrink-0">{d.type === 'task' ? '☐' : '📁'}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate">{d.name}</div>
                {d.breadcrumb && d.breadcrumb !== d.name && (
                  <div className="text-xs text-muted-foreground truncate">{d.breadcrumb}</div>
                )}
              </div>
            </button>
          ))}
        </div>
        {error && (
          <div className="px-4 py-2 text-xs text-destructive border-t border-border">
            {error}
          </div>
        )}
        <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground">
          <span className="font-mono">↑↓</span> 选中后{' '}
          <span className="font-mono">Enter</span> 确认 ·{' '}
          <span className="font-mono">Esc</span> 关闭
        </div>
      </div>
    </div>
  )
}
