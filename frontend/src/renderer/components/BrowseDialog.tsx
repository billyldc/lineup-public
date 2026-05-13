import { useState, useEffect, useRef } from 'react'
import type { BrowseItem } from '../../preload/index'

type Source = 'obsidian' | 'trilium' | 'zotero' | 'mail'

interface BrowseDialogProps {
  source: Source
  title: string
  onSelect: (item: BrowseItem) => void
  onCancel: () => void
}

const sourceLabels: Record<Source, string> = {
  obsidian: 'Obsidian',
  trilium: 'Trilium',
  zotero: 'Zotero',
  mail: 'Apple Mail',
}

interface Crumb {
  path: string
  label: string
}

export function BrowseDialog({ source, title, onSelect, onCancel }: BrowseDialogProps) {
  const [items, setItems] = useState<BrowseItem[]>([])
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ path: '', label: '根目录' }])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<BrowseItem | null>(null)
  const [query, setQuery] = useState('')
  // Mail-specific: track sync state so we can show feedback + disable button.
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const searchTimer = useRef<number | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const isSearchMode = query.trim().length > 0

  const loadBrowse = async (path: string) => {
    setLoading(true)
    setSelected(null)
    try {
      const list =
        source === 'obsidian' ? await window.lineup.browseObsidian(path)
        : source === 'trilium' ? await window.lineup.browseTrilium(path)
        : source === 'mail'    ? await window.lineup.browseMail(path)
        : await window.lineup.browseZotero(path)
      setItems(list)
    } finally {
      setLoading(false)
    }
  }

  const runSearch = async (q: string) => {
    setLoading(true)
    setSelected(null)
    try {
      const list =
        source === 'obsidian' ? await window.lineup.searchObsidian(q)
        : source === 'trilium' ? await window.lineup.searchTrilium(q)
        : source === 'mail'    ? await window.lineup.searchMail(q)
        : await window.lineup.searchZotero(q)
      setItems(list)
    } finally {
      setLoading(false)
    }
  }

  // Initial browse load
  useEffect(() => {
    loadBrowse('')
    // focus search on mount
    setTimeout(() => searchInputRef.current?.focus(), 50)
  }, [source])

  // Debounced search
  useEffect(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current)
    if (!isSearchMode) {
      // Back to browse mode — show the current crumb's contents
      loadBrowse(crumbs[crumbs.length - 1]?.path ?? '')
      return
    }
    searchTimer.current = window.setTimeout(() => {
      runSearch(query.trim())
    }, 250)
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  function isDirectory(item: BrowseItem): boolean {
    return item.name.endsWith('/') || item.type === 'folder' ||
      (source === 'trilium' && item.preview.includes('子笔记')) ||
      (source === 'zotero' && item.target.startsWith('zotero://select/library/collections/'))
  }

  // Double-click (or enter key) on a folder: descend into it
  function enterFolder(item: BrowseItem) {
    if (!isDirectory(item)) {
      setSelected(item)
      return
    }
    setQuery('')
    const newCrumbs = [...crumbs, { path: item.id, label: item.name.replace(/\/$/, '') }]
    setCrumbs(newCrumbs)
    loadBrowse(item.id)
  }

  function goUp(toIndex: number) {
    setQuery('')
    const newCrumbs = crumbs.slice(0, toIndex + 1)
    setCrumbs(newCrumbs)
    loadBrowse(newCrumbs[newCrumbs.length - 1].path)
  }

  function confirm() {
    if (selected) onSelect(selected)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-popover border border-border rounded-lg shadow-xl w-[600px] max-w-[90vw] h-[520px] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border shrink-0">
          <div className="text-sm font-medium flex items-center gap-2">
            <span>{title} — 浏览 {sourceLabels[source]}</span>
            {source === 'mail' && (
              <button
                onClick={async () => {
                  setSyncing(true)
                  setSyncError(null)
                  try {
                    const r = await window.lineup.syncMail()
                    if (!r.ok) setSyncError(r.error ?? 'unknown error')
                    // Reload browse/search to reflect newly cached rows.
                    if (isSearchMode) await runSearch(query.trim())
                    else await loadBrowse(crumbs[crumbs.length - 1]?.path ?? '')
                  } finally {
                    setSyncing(false)
                  }
                }}
                disabled={syncing}
                className="ml-auto text-xs px-2 py-0.5 rounded border border-border hover:bg-accent disabled:opacity-50"
                title="从 Mail.app 拉最新 200 封/账户 到本地缓存（可能几十秒）"
              >{syncing ? '同步中...' : '🔄 同步邮件'}</button>
            )}
          </div>
          {source === 'mail' && syncError && (
            <div className="text-[11px] text-red-500 mt-1 font-mono">{syncError}</div>
          )}

          {/* Search input */}
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                if (query) { e.stopPropagation(); setQuery('') }
                // else let parent onClick close the dialog
              } else if (e.key === 'Enter' && selected) {
                e.preventDefault()
                confirm()
              }
            }}
            placeholder="🔍 搜索（按标题和内容）..."
            className="w-full mt-2 px-3 py-1.5 bg-input border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />

          {/* Breadcrumbs (only in browse mode) */}
          {!isSearchMode && (
            <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground flex-wrap">
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span>/</span>}
                  <button
                    onClick={() => goUp(i)}
                    className="hover:text-foreground hover:underline"
                  >
                    {c.label}
                  </button>
                </span>
              ))}
            </div>
          )}
          {isSearchMode && (
            <div className="mt-2 text-xs text-muted-foreground">
              搜索结果（{items.length} 条）
            </div>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-muted-foreground text-sm">加载中...</div>
          ) : items.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground text-sm">
              {isSearchMode ? '没有匹配的结果' : '（空）'}
            </div>
          ) : (
            items.map((item) => {
              const isDir = isDirectory(item)
              const isSelected = selected?.id === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => setSelected(item)}
                  onDoubleClick={() => enterFolder(item)}
                  className={`w-full text-left px-4 py-2 flex items-center gap-2 text-sm transition-colors
                    ${isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-accent/50'}`}
                >
                  <span className="text-xs opacity-60 shrink-0">{isDir ? '📁' : '📄'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{item.name.replace(/\/$/, '')}</div>
                    {item.preview && (
                      <div className={`text-xs truncate ${isSelected ? 'opacity-70' : 'text-muted-foreground'}`}>
                        {item.preview}
                      </div>
                    )}
                  </div>
                  {isDir && !isSearchMode && <span className="text-xs opacity-40 shrink-0">›</span>}
                </button>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center gap-2 shrink-0">
          <div className="text-xs text-muted-foreground flex-1 truncate">
            {selected
              ? `已选择: ${selected.name.replace(/\/$/, '')}`
              : isSearchMode
                ? '输入关键词搜索，单击选择结果'
                : '单击选择 · 双击文件夹进入'}
          </div>
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-md hover:bg-accent transition-colors"
          >
            取消
          </button>
          <button
            onClick={confirm}
            disabled={!selected}
            className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
          >
            插入
          </button>
        </div>
      </div>
    </div>
  )
}
