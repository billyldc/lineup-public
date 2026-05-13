import { useEffect, useRef, useState } from 'react'
import { formatHotkey, getHotkey } from '../lib/hotkey'

/**
 * Global ⌘K search modal. Hits search:query on every keystroke
 * (debounced 100ms). Shows projects + objects side-by-side; Enter or
 * click opens. Esc / clicking the backdrop closes.
 *
 * Why a modal and not a sidebar: speed-of-thought search is its own
 * mode — we want focus stolen, key bindings intercepted, and the user
 * one keystroke away from dismissing.
 */

interface ProjectHit {
  id: number
  name: string
  description: string | null
  type: string
}
interface ObjectHit {
  id: number
  name: string
  target: string
  type: string
  project_id: number
  project_name: string
}

interface Props {
  open: boolean
  onClose: () => void
  /** Drill the Miller columns to a project. */
  onOpenProject: (projectId: number) => void
  /** Open an object via lineup's usual open command. */
  onOpenObject: (objectId: number) => void
}

export function SearchPanel({ open, onClose, onOpenProject, onOpenObject }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{
    projects: ProjectHit[]; objects: ObjectHit[]
  }>({ projects: [], objects: [] })
  const [activeIdx, setActiveIdx] = useState(0)  // flat index over projects+objects
  // CJK IME / 中文输入法 fix: the IME's Enter (used to commit pinyin →
  // English/Chinese) reaches the input the same way as a user-pressed
  // Enter. To avoid the "type 'gpt' + Enter just opened the top result"
  // surprise, Enter only activates AFTER the user has explicitly used
  // ↑/↓ at least once. Reset on every query change so a fresh search
  // starts in the same protected state.
  const [hasNavigated, setHasNavigated] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when opened; reset state when closed.
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults({ projects: [], objects: [] })
      setActiveIdx(0)
      setHasNavigated(false)
      // Defer focus so the modal has rendered.
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // Debounced search.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(async () => {
      if (!query.trim()) {
        setResults({ projects: [], objects: [] })
        return
      }
      const r = await window.lineup.search(query)
      setResults(r)
      setActiveIdx(0)
      setHasNavigated(false)  // new query → re-arm the Enter guard
    }, 100)
    return () => clearTimeout(t)
  }, [query, open])

  if (!open) return null

  const flatHits: Array<
    | { kind: 'project'; hit: ProjectHit }
    | { kind: 'object'; hit: ObjectHit }
  > = [
    ...results.projects.map(p => ({ kind: 'project' as const, hit: p })),
    ...results.objects.map(o => ({ kind: 'object' as const, hit: o })),
  ]

  const activate = (i: number) => {
    const item = flatHits[i]
    if (!item) return
    if (item.kind === 'project') onOpenProject(item.hit.id)
    else onOpenObject(item.hit.id)
    onClose()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    // Hard-skip every key while IME composition is active — Chrome
    // exposes this via nativeEvent.isComposing on the React wrapper.
    // The IME's Enter to commit pinyin shows up as Enter with
    // isComposing=true on most setups; on rare ones the Enter event
    // fires WITHOUT the composing flag, which is exactly the case
    // hasNavigated below is the safety net for.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(flatHits.length - 1, i + 1))
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
      // Require an explicit arrow press before Enter commits, so the
      // IME's commit-Enter (or accidental Enter right after typing)
      // doesn't unexpectedly open the first hit.
      if (!hasNavigated) return
      e.preventDefault()
      activate(activeIdx)
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
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <span className="text-muted-foreground text-sm">🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="搜索项目和对象 (名称 / 描述 / 路径)…"
            className="flex-1 bg-transparent text-sm outline-none"
          />
          <span className="text-[10px] text-muted-foreground font-mono">
            {formatHotkey(getHotkey('search'))}
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          {!query.trim() && (
            <div className="text-xs text-muted-foreground text-center py-8">
              输入关键词开始搜索 · <span className="font-mono">↑↓</span> 选中后{' '}
              <span className="font-mono">Enter</span> 打开 ·{' '}
              <span className="font-mono">Esc</span> 关闭
            </div>
          )}
          {query.trim() && flatHits.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-8">
              没有匹配的项目或对象
            </div>
          )}
          {results.projects.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-4 pt-3 pb-1">
                项目 ({results.projects.length})
              </div>
              {results.projects.map((p, i) => (
                <Row
                  key={`p${p.id}`}
                  active={activeIdx === i}
                  onClick={() => activate(i)}
                  onMouseEnter={() => setActiveIdx(i)}
                  icon={p.type === 'document' ? '📄' : '📁'}
                  title={p.name}
                  subtitle={p.description || undefined}
                />
              ))}
            </div>
          )}
          {results.objects.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-4 pt-3 pb-1">
                对象 ({results.objects.length})
              </div>
              {results.objects.map((o, i) => {
                const idx = results.projects.length + i
                return (
                  <Row
                    key={`o${o.id}`}
                    active={activeIdx === idx}
                    onClick={() => activate(idx)}
                    onMouseEnter={() => setActiveIdx(idx)}
                    icon={iconForType(o.type)}
                    title={o.name}
                    subtitle={`${o.project_name} · ${prettyTarget(o.target)}`}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


function Row({ active, onClick, onMouseEnter, icon, title, subtitle }: {
  active: boolean
  onClick: () => void
  onMouseEnter: () => void
  icon: string
  title: string
  subtitle?: string
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`w-full text-left px-4 py-2 flex items-center gap-3 text-sm
                  ${active ? 'bg-primary/15 text-foreground' : 'hover:bg-accent/50'}`}
    >
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate">{title}</div>
        {subtitle && (
          <div className="text-xs text-muted-foreground truncate">{subtitle}</div>
        )}
      </div>
    </button>
  )
}


function iconForType(t: string): string {
  switch (t) {
    case 'folder': return '📂'
    case 'file': return '📄'
    case 'url': return '🔗'
    case 'zotero': return '📚'
    case 'mail': return '✉'
    case 'contact': return '👤'
    case 'obsidian': return '🟣'
    case 'trilium': return '📓'
    case 'script': return '⚙'
    default: return '🔹'
  }
}

function prettyTarget(t: string): string {
  if (t.startsWith('/Users/')) return t.replace(/^\/Users\/[^/]+\//, '~/')
  if (t.length > 60) return t.slice(0, 60) + '…'
  return t
}
