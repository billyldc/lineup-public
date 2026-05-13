import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import TurndownService from 'turndown'
import 'katex/dist/katex.min.css'
import { MailPreview } from './MailPreview'

const DEFAULT_PREVIEW_WIDTH = 512  // matches old w-[32rem]
const MIN_PREVIEW_WIDTH = 280
const MAX_PREVIEW_WIDTH = 1200
const STORAGE_PREVIEW_WIDTH = 'lineup:previewWidth'

interface PreviewColumnProps {
  objectType: string
  target: string
  label: string
}

type PreviewKind = 'text' | 'markdown' | 'html' | 'empty' | 'error' | 'binary' | 'image' | 'pdf'

interface PreviewData {
  kind: PreviewKind
  content: string
  mime?: string
  error?: string
}

const typeLabels: Record<string, string> = {
  file: '文件', folder: '文件夹', url: '链接', zotero: '文献',
  trilium: '笔记', obsidian: '笔记', script: '脚本',
}

// Shared turndown instance (stateless, reusable)
const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
})
// Trilium wraps math in <span class="math-tex">\(...\)</span>
turndown.addRule('triliumMathInline', {
  filter: (node) =>
    node.nodeName === 'SPAN' &&
    (node as HTMLElement).classList?.contains('math-tex'),
  replacement: (content) => content.replace(/^\\\((.*)\\\)$/s, '$$$1$$'),
})

function htmlToMarkdown(html: string): string {
  try {
    return turndown.turndown(html)
  } catch {
    return html
  }
}

export function PreviewColumn({ objectType, target, label }: PreviewColumnProps) {
  const [width, setWidth] = useState<number>(() => {
    const v = localStorage.getItem(STORAGE_PREVIEW_WIDTH)
    const n = v ? parseInt(v, 10) : NaN
    return Number.isFinite(n) && n >= MIN_PREVIEW_WIDTH && n <= MAX_PREVIEW_WIDTH
      ? n : DEFAULT_PREVIEW_WIDTH
  })
  const dragStartX = useRef<number | null>(null)
  const dragStartWidth = useRef<number>(0)

  useEffect(() => {
    localStorage.setItem(STORAGE_PREVIEW_WIDTH, String(width))
  }, [width])

  const onResizeMove = useCallback((e: MouseEvent) => {
    if (dragStartX.current == null) return
    const delta = e.clientX - dragStartX.current
    setWidth(Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, dragStartWidth.current + delta)))
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

  const resizeHandle = (
    <div
      onMouseDown={onResizeStart}
      className="absolute top-0 right-0 w-1 h-full cursor-ew-resize hover:bg-primary/40 z-10"
      title="拖动调整宽度"
    />
  )

  // Mail objects use the dedicated MailPreview component — same code path
  // as the inbox inline preview (cache-first, attachments, inline images).
  if (objectType === 'mail' || target.startsWith('message:') || target.startsWith('mailrow:')) {
    return (
      <div style={{ width }} className="border-r border-border flex flex-col h-full shrink-0 overflow-hidden relative">
        {resizeHandle}
        <div className="px-3 py-2 border-b border-border bg-card/50 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">邮件</span>
            <span className="font-medium text-sm truncate">{label}</span>
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); window.lineup.openTarget('mail', target) }}
              className="text-xs text-primary hover:underline shrink-0"
              title="在 Mail.app 中打开"
            >📧</a>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <MailPreview target={target} />
        </div>
      </div>
    )
  }

  // URL objects get a full embedded browser — no IPC preview needed.
  if (objectType === 'url' && target.startsWith('http')) {
    return (
      <div style={{ width }} className="border-r border-border flex flex-col h-full shrink-0 overflow-hidden relative">
        {resizeHandle}
        <div className="px-3 py-2 border-b border-border bg-card/50 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
              {typeLabels[objectType] || objectType}
            </span>
            <span className="font-medium text-sm truncate">{label}</span>
          </div>
          <div className="text-xs text-muted-foreground truncate mt-1">
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); window.lineup.openTarget('url', target) }}
              className="hover:underline"
              title="在浏览器中打开"
            >
              {target}
            </a>
          </div>
        </div>
        <WebviewPane src={target} />
      </div>
    )
  }

  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPreview(null)
    window.lineup.loadPreview({ type: objectType, target })
      .then((data) => {
        if (cancelled) return
        setPreview(data as PreviewData)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setPreview({ kind: 'error', content: '', error: `IPC 失败: ${e?.message || String(e)}` })
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [objectType, target])

  // If preview is HTML (from Trilium), convert to markdown for rendering
  const renderContent = useMemo(() => {
    if (!preview) return null
    if (preview.kind === 'html') {
      return htmlToMarkdown(preview.content)
    }
    return preview.content
  }, [preview])

  return (
    <div style={{ width }} className="border-r border-border flex flex-col h-full shrink-0 overflow-hidden relative">
      {resizeHandle}
      {/* Header */}
      <div className="px-3 py-2 border-b border-border bg-card/50 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
            {typeLabels[objectType] || objectType}
          </span>
          <span className="font-medium text-sm truncate">{label}</span>
        </div>
        <div className="text-xs text-muted-foreground truncate mt-1">{target}</div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="p-4 text-sm text-muted-foreground text-center">加载中...</div>
        )}
        {preview?.kind === 'error' && (
          <div className="p-4 text-sm text-destructive">
            错误: {preview.error}
          </div>
        )}
        {preview?.kind === 'empty' && (
          <div className="p-4 text-sm text-muted-foreground whitespace-pre-wrap">
            {preview.content}
          </div>
        )}
        {preview?.kind === 'binary' && (
          <div className="p-4 text-sm text-muted-foreground">
            {preview.content}
          </div>
        )}
        {preview?.kind === 'image' && (
          <div className="p-4">
            <img src={preview.content} className="max-w-full h-auto" alt={label} />
          </div>
        )}
        {preview?.kind === 'pdf' && (
          <iframe
            // #toolbar=0&navpanes=0 hides Chromium's PDF toolbar/sidebar
            src={`${preview.content}#toolbar=0&navpanes=0`}
            className="w-full h-full border-0 bg-white"
            title={label}
          />
        )}
        {preview && renderContent != null &&
         (preview.kind === 'markdown' || preview.kind === 'html') && (
          <div className="markdown-body px-4 py-3 text-sm">
            <ReactMarkdown
              remarkPlugins={[remarkMath, remarkGfm]}
              rehypePlugins={[rehypeKatex]}
              components={{
                // Intercept ALL rendered links — without this, clicking a
                // link inside an email / trilium preview would hijack the
                // whole Electron window (no address bar, no back, no exit).
                // Send the URL to the system browser via shell.openExternal.
                a: ({ href, children, ...rest }) => (
                  <a
                    {...rest}
                    href={href}
                    onClick={(e) => {
                      e.preventDefault()
                      if (href) window.lineup.openTarget('url', href)
                    }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {renderContent}
            </ReactMarkdown>
          </div>
        )}
        {preview?.kind === 'text' && (
          <pre className="p-3 text-xs whitespace-pre-wrap break-words font-mono leading-relaxed">
            {preview.content}
          </pre>
        )}
      </div>
    </div>
  )
}

/**
 * Embedded browser pane using Electron's <webview> tag. This gives a full
 * Chromium renderer that can load any URL, run JS, store cookies, and
 * let the user interact with the page — no extra packages needed because
 * Electron IS Chromium.
 *
 * Cookies are persisted in `partition: persist:lineup` so login sessions
 * survive app restarts. The user doesn't need to re-login every time.
 *
 * The webview is created via DOM APIs (not JSX) because React doesn't
 * recognise <webview> as a standard element.
 */
function WebviewPane({ src }: { src: string }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const wv = document.createElement('webview') as any
    wv.src = src
    wv.setAttribute('partition', 'persist:lineup')
    wv.setAttribute('allowpopups', '')
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.border = 'none'
    wv.style.background = '#fff'

    host.innerHTML = ''
    host.appendChild(wv)

    return () => {
      try { host.removeChild(wv) } catch { /* already removed */ }
    }
  }, [src])

  return <div ref={hostRef} className="flex-1 min-h-0" />
}
