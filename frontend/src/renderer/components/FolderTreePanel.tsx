import { useState, useEffect, useCallback } from 'react'
import type { FolderTree, FolderTreeNode } from '../../preload/index'

interface Props {
  folderPath: string
  // Selected session from AgentsView. If the user drills to an L1 node we
  // can fire this so the parent AgentsView can also update its selection.
  onFocusSession?: (sessionId: string) => void
  // Key that the user was looking at, so drill-down opens at that branch.
  focusSessionId?: string | null
}

/**
 * Multi-level drill-down reviewer for a Claude Code folder:
 *   root (L3) → cluster (L2) → session (L1)
 *
 * Breadcrumbs across the top let you jump any level. The "构建树" button
 * is the only thing that spends money; everything else reads from cache.
 */
export function FolderTreePanel({ folderPath, onFocusSession, focusSessionId }: Props) {
  const [tree, setTree] = useState<FolderTree | null>(null)
  const [path, setPath] = useState<FolderTreeNode[]>([])  // breadcrumb from root downward
  const [loading, setLoading] = useState(true)
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastSpend, setLastSpend] = useState<number | null>(null)

  // Probe cache on mount / folder switch.
  const loadCached = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const t = await window.lineup.getCachedFolderTree(folderPath)
      setTree(t)
      // Auto-drill: if user previously opened a specific session, open at
      // that session's cluster so they don't have to click twice.
      if (t && focusSessionId) {
        const cluster = t.clusters.find(c =>
          (c.children ?? []).some(ch => ch.key === focusSessionId)
        )
        if (cluster) setPath([cluster])
      } else {
        setPath([])
      }
    } finally { setLoading(false) }
  }, [folderPath, focusSessionId])
  useEffect(() => { loadCached() }, [loadCached])

  const build = async () => {
    setBuilding(true); setError(null); setLastSpend(null)
    try {
      const res = await window.lineup.buildFolderTree(folderPath)
      if (res.ok) {
        setTree(res.tree)
        setLastSpend(res.tree.total_cost_spent)
        setPath([])
      } else {
        setError(res.error)
      }
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally { setBuilding(false) }
  }

  // The currently displayed node. If path is empty we show the root
  // overview (if root exists) or the list of clusters (if only one cluster).
  const current: FolderTreeNode | null = path.length ? path[path.length - 1] : null

  // Layer-agnostic view: the "children" list to render below the current
  // summary. At the top level that's the L2 clusters (or the single
  // cluster's sessions if no root exists).
  const visibleChildren: FolderTreeNode[] = (() => {
    if (!tree) return []
    if (!current) return tree.root ? tree.clusters : (tree.clusters[0]?.children ?? [])
    return current.children ?? []
  })()

  // Summary markdown to show in the top card: root > cluster > session.
  const currentSummary: string | null = (() => {
    if (!tree) return null
    if (current) return current.summary_md
    if (tree.root) return tree.root.summary_md
    if (tree.clusters.length === 1) return tree.clusters[0].summary_md
    return null
  })()

  const currentTitle: string = (() => {
    if (current) return current.title
    if (tree?.root) return tree.root.title
    if (tree && tree.clusters.length === 1) return tree.clusters[0].title
    return '概览'
  })()

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Breadcrumb + build button */}
      <div className="px-3 py-2 border-b border-border shrink-0 flex items-center gap-2 text-xs">
        <button
          onClick={() => setPath([])}
          className="font-mono hover:text-primary truncate"
          title={folderPath}
        >📁 {prettyFolder(folderPath)}</button>
        {path.map((n, i) => (
          <span key={n.key} className="flex items-center gap-2 min-w-0">
            <span className="text-muted-foreground">›</span>
            <button
              onClick={() => setPath(path.slice(0, i + 1))}
              className="hover:text-primary truncate max-w-[160px]"
              title={n.title}
            >
              {levelIcon(n.level)} {n.title}
            </button>
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {tree && (
            <button
              onClick={build}
              disabled={building}
              className="px-2 py-0.5 rounded border border-border hover:bg-accent text-[11px]"
              title="如果有新会话或希望重算缺失层级"
            >{building ? '构建中...' : '↻ 更新树'}</button>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          加载缓存...
        </div>
      )}

      {!loading && !tree && !building && (
        <EmptyState folderPath={folderPath} onBuild={build} error={error} />
      )}

      {building && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-sm">
          <div>构建中... 每次会话 + 每层 rollup 都会调 OpenRouter</div>
          <div className="text-xs text-muted-foreground">
            看后端日志跟进进度（第一次可能 1-5 分钟，之后缓存命中就很快）
          </div>
        </div>
      )}

      {!loading && tree && !building && (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {lastSpend != null && (
            <div className="text-[11px] text-muted-foreground px-2 py-1 rounded bg-accent/30 border border-border">
              本次构建新花费 ${lastSpend.toFixed(4)}
              {tree.total_sessions_skipped > 0 && <> · 跳过 {tree.total_sessions_skipped} 个空会话</>}
            </div>
          )}
          {error && (
            <pre className="text-xs font-mono whitespace-pre-wrap text-red-600 bg-red-500/10 border border-red-500/40 rounded p-2">
              {error}
            </pre>
          )}

          {/* Top card: current node's summary */}
          {currentSummary && (
            <section className="border border-border rounded p-3 bg-card/30">
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                {current ? levelName(current.level) : tree.root ? '根节点' : '阶段'}
              </div>
              <div className="text-sm font-medium mb-2">{currentTitle}</div>
              <MarkdownLite text={currentSummary} />
            </section>
          )}

          {/* Children grid */}
          {visibleChildren.length > 0 && (
            <section>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2 px-1">
                {current?.level === 2 || (!current && !tree.root)
                  ? `会话 (${visibleChildren.length})`
                  : `子阶段 (${visibleChildren.length})`}
              </div>
              <div className="space-y-2">
                {visibleChildren.map(child => (
                  <ChildCard
                    key={child.key}
                    node={child}
                    onOpen={() => {
                      if (child.level === 1) {
                        onFocusSession?.(child.key)
                        setPath(prev => [...prev, child])
                      } else {
                        setPath(prev => [...prev, child])
                      }
                    }}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function EmptyState({ folderPath, onBuild, error }: {
  folderPath: string; onBuild: () => void; error: string | null
}) {
  return (
    <div className="flex-1 p-4 text-sm space-y-3">
      <p className="text-muted-foreground">
        还没为 <span className="font-mono text-foreground">{prettyFolder(folderPath)}</span> 构建层级树。
        lineup 会：
      </p>
      <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-0.5">
        <li>读取该文件夹下的所有 Claude 会话</li>
        <li>为每个会话生成 L1 摘要（<span className="font-mono">claude-sonnet-4.7</span>）</li>
        <li>按时间+文件 overlap 聚类成 L2 阶段</li>
        <li>多个阶段再 rollup 成 L3 根节点</li>
        <li>全部缓存到 DB，jsonl/cluster 不变就不重算</li>
      </ul>
      <p className="text-xs text-muted-foreground">
        lineup 这个文件夹的 demo 成本约 $0.30（6 个会话）；其他文件夹按比例。
      </p>
      {error && (
        <pre className="text-xs font-mono whitespace-pre-wrap text-red-600 bg-red-500/10 border border-red-500/40 rounded p-2">
          {error}
        </pre>
      )}
      <button
        onClick={onBuild}
        className="w-full px-3 py-2 rounded bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
      >🌲 构建层级树</button>
    </div>
  )
}

function ChildCard({ node, onOpen }: { node: FolderTreeNode; onOpen: () => void }) {
  const firstLine = node.summary_md
    .split('\n').map(l => l.trim())
    .find(l => l && !l.startsWith('#')) || ''
  return (
    <button
      onClick={onOpen}
      className="w-full text-left p-3 rounded border border-border hover:border-primary hover:bg-accent/30 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">
            {levelIcon(node.level)} {node.title}
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {firstLine.slice(0, 120)}
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground text-right shrink-0 font-mono">
          {node.level === 1
            ? <>{node.key.slice(0, 8)}</>
            : <>{node.session_count} 个会话</>}
          {node.first_ts && (
            <div>{node.first_ts.slice(0, 10)}</div>
          )}
        </div>
      </div>
    </button>
  )
}

function levelIcon(lvl: 1 | 2 | 3): string {
  return lvl === 3 ? '🌲' : lvl === 2 ? '📦' : '💬'
}
function levelName(lvl: 1 | 2 | 3): string {
  return lvl === 3 ? '根节点' : lvl === 2 ? '阶段' : '会话'
}

function prettyFolder(p: string): string {
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

// ── Minimal Markdown renderer (same shape as SessionInspector's) ──────

function MarkdownLite({ text }: { text: string }) {
  const blocks: React.ReactNode[] = []
  const lines = text.split('\n')
  let inList: string[] | null = null
  const flushList = () => {
    if (!inList) return
    blocks.push(
      <ul key={blocks.length} className="list-disc pl-5 space-y-0.5 my-1">
        {inList.map((l, i) => <li key={i}><InlineMd text={l} /></li>)}
      </ul>
    )
    inList = null
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { flushList(); continue }
    if (line.startsWith('## ')) {
      flushList()
      blocks.push(<h3 key={blocks.length} className="text-sm font-semibold mt-3 mb-1 border-b border-border pb-0.5">{line.slice(3)}</h3>)
      continue
    }
    if (line.startsWith('### ')) {
      flushList()
      blocks.push(<h4 key={blocks.length} className="text-xs font-medium uppercase tracking-wide mt-2 mb-0.5 text-muted-foreground">{line.slice(4)}</h4>)
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      inList ??= []
      inList.push(line.replace(/^[-*]\s+/, ''))
      continue
    }
    flushList()
    blocks.push(<p key={blocks.length} className="my-1 text-sm leading-relaxed"><InlineMd text={line} /></p>)
  }
  flushList()
  return <div>{blocks}</div>
}

function InlineMd({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) {
      parts.push(<strong key={i++}>{tok.slice(2, -2)}</strong>)
    } else {
      parts.push(<code key={i++} className="font-mono text-xs px-1 py-0.5 rounded bg-muted">{tok.slice(1, -1)}</code>)
    }
    last = regex.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}
