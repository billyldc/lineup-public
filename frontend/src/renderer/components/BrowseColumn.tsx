/**
 * A column that shows the contents of a filesystem folder, Obsidian vault
 * folder, or Trilium note sub-tree. Unlike Column (which reads from the
 * lineup DB), BrowseColumn reads live from the plugin source.
 *
 * Single-click on a sub-folder → push another BrowseColumn.
 * Double-click on any item → open externally via the type system.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { BrowseItem, Agent } from '../../preload/index'
import { setObjectDragData } from '../lib/drag'

const DEFAULT_BROWSE_WIDTH = 288
const MIN_BROWSE_WIDTH = 200
const MAX_BROWSE_WIDTH = 700

function loadBrowseWidth(source: string, target: string): number {
  const v = localStorage.getItem(`lineup:colWidth:browse:${source}:${target}`)
  const n = v ? parseInt(v, 10) : NaN
  return Number.isFinite(n) && n >= MIN_BROWSE_WIDTH && n <= MAX_BROWSE_WIDTH
    ? n : DEFAULT_BROWSE_WIDTH
}

const typeLabels: Record<string, string> = {
  file: '文件', folder: '文件夹', url: '链接', zotero: '文献',
  trilium: '笔记', obsidian: '笔记', script: '脚本',
}

export type BrowseSource = 'obsidian' | 'trilium' | 'fs' | 'zotero'

const sourceHeaderLabel: Record<BrowseSource, string> = {
  obsidian: 'Obsidian',
  trilium: 'Trilium',
  fs: 'Finder',
  zotero: 'Zotero',
}

interface BrowseColumnProps {
  source: BrowseSource
  target: string
  label: string
  selectedChildId: string | null
  onSelectChild: (itemId: string, item: BrowseItem) => void
  onOpenAgent?: (agent: Agent) => void
}

function isDirectory(item: BrowseItem, source: BrowseSource): boolean {
  return (
    item.name.endsWith('/') ||
    item.type === 'folder' ||
    (source === 'trilium' && item.preview.includes('子笔记')) ||
    // zotero: collection URIs are folders, item URIs are leaves
    (source === 'zotero' && item.target.startsWith('zotero://select/library/collections/'))
  )
}

async function loadChildren(source: BrowseSource, target: string): Promise<BrowseItem[]> {
  if (source === 'obsidian') return window.lineup.browseObsidian(target)
  if (source === 'trilium') return window.lineup.browseTrilium(target)
  if (source === 'fs') return window.lineup.browseFs(target)
  if (source === 'zotero') return window.lineup.browseZotero(target)
  return []
}

export function BrowseColumn({ source, target, label, selectedChildId, onSelectChild, onOpenAgent }: BrowseColumnProps) {
  const [items, setItems] = useState<BrowseItem[]>([])
  const [loading, setLoading] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [width, setWidth] = useState<number>(() => loadBrowseWidth(source, target))
  const dragStartX = useRef<number | null>(null)
  const dragStartWidth = useRef<number>(0)

  useEffect(() => { setWidth(loadBrowseWidth(source, target)) }, [source, target])
  useEffect(() => {
    localStorage.setItem(`lineup:colWidth:browse:${source}:${target}`, String(width))
  }, [source, target, width])

  const onResizeMove = useCallback((e: MouseEvent) => {
    if (dragStartX.current == null) return
    const delta = e.clientX - dragStartX.current
    setWidth(Math.min(MAX_BROWSE_WIDTH, Math.max(MIN_BROWSE_WIDTH, dragStartWidth.current + delta)))
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
    setLoading(true)
    try {
      setItems(await loadChildren(source, target))
      // Discover + list agents only for filesystem folders
      if (source === 'fs') {
        setAgents(await window.lineup.listAgentsForFolder(target))
      } else {
        setAgents([])
      }
    } finally {
      setLoading(false)
    }
  }, [source, target])

  useEffect(() => { load() }, [load])

  return (
    <div
      style={{ width }}
      className="border-r border-border flex flex-col h-full shrink-0 overflow-hidden relative"
    >
      <div
        onMouseDown={onResizeStart}
        className="absolute top-0 right-0 w-1 h-full cursor-ew-resize hover:bg-primary/40 z-10"
        title="拖动调整列宽"
      />
      {/* Header */}
      <div className="px-3 py-2 border-b border-border bg-card/50">
        <div className="font-medium text-sm flex items-start gap-2">
          <span className="opacity-60 text-xs shrink-0 mt-0.5">{sourceHeaderLabel[source]}</span>
          <span className="break-all">{label}</span>
        </div>
      </div>

      {/* Items list */}
      <div className="flex-1 overflow-y-auto">
        {/* Agents section (fs only) */}
        {agents.length > 0 && (
          <div className="border-b border-border">
            {agents.map((ag) => (
              <button
                key={`a:${ag.id ?? ag.session_id}`}
                onClick={() => onOpenAgent?.(ag)}
                className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-accent/50 transition-colors"
              >
                <span className="text-xs">{ag.is_db ? '🤖' : '💬'}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{ag.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {ag.message_count != null && `${ag.message_count} 条消息 · `}
                    {ag.last_modified && new Date(ag.last_modified).toLocaleDateString('zh-CN')}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="px-3 py-4 text-sm text-muted-foreground text-center">
            加载中...
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground text-center">
            （空）
          </div>
        ) : (
          items.map((item) => {
            const isDir = isDirectory(item, source)
            const isSelected = selectedChildId === item.id
            return (
              <button
                key={item.id}
                draggable
                onDragStart={(e) => {
                  // Map the BrowseColumn source to a lineup type. trilium /
                  // obsidian / zotero items are stored uniformly under their
                  // source's type regardless of folder/leaf. fs uses
                  // item.type directly (file or folder).
                  const lineupType =
                    source === 'trilium' ? 'trilium'
                    : source === 'obsidian' ? 'obsidian'
                    : source === 'zotero' ? 'zotero'
                    : item.type
                  setObjectDragData(e, {
                    kind: 'object-link',
                    name: item.name.replace(/\/$/, ''),
                    target: item.target,
                    type: lineupType,
                  })
                }}
                onClick={() => onSelectChild(item.id, item)}
                onDoubleClick={async () => {
                  if (isDir) return
                  // Map the browse source to a lineup type, same way as
                  // dragStart does, then ask main to open it.
                  const lineupType =
                    source === 'trilium' ? 'trilium'
                    : source === 'obsidian' ? 'obsidian'
                    : source === 'zotero' ? 'zotero'
                    : item.type
                  await window.lineup.openTarget(lineupType, item.target)
                }}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors
                  ${isSelected
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent/50'
                  }`}
              >
                <span className="text-xs opacity-60 shrink-0 mt-0.5">
                  {isDir ? '📁' : '📄'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="break-all">{item.name.replace(/\/$/, '')}</div>
                  {item.preview && (
                    <div className={`text-xs break-all ${isSelected ? 'opacity-70' : 'text-muted-foreground'}`}>
                      {item.preview}
                    </div>
                  )}
                </div>
                {isDir && <span className="opacity-40 text-xs">›</span>}
                {!isDir && (
                  <span className={`text-xs opacity-40 ${isSelected ? 'opacity-70' : ''}`}>
                    {typeLabels[item.type] || item.type}
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

export { isDirectory }
