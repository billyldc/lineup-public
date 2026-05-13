import { useState, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import TurndownService from 'turndown'
import { showTransientToast } from '../lib/sendToMainAgent'

// Single shared turndown instance — stateless / safe to reuse across
// renders. Configured to match the existing PreviewColumn so emails and
// linked-Trilium notes render with consistent style.
const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
})
// Word/Outlook stuffs CSS + mso conditional blocks inside <style>/<head>;
// turndown doesn't strip these by default, so the raw `@font-face` etc.
// would leak into the rendered body. Remove them outright.
turndown.remove(['style', 'script', 'head', 'meta', 'link', 'title'])
// Strip HTML comments — Outlook wraps its CSS in `<!-- ... -->` inside
// <style>, but they also appear standalone (`<!--[if mso]>...<![endif]-->`)
// and turndown otherwise emits them as text.
turndown.addRule('skipComments', {
  filter: (node) => node.nodeType === 8,
  replacement: () => '',
})
// Drop empty paragraphs that emails are full of (`<p>&nbsp;</p>` etc).
turndown.addRule('skipEmptyP', {
  filter: (node) =>
    node.nodeName === 'P' && !(node.textContent?.trim()) && !node.querySelector('img'),
  replacement: () => '',
})
// Marketing-email "table-as-layout" → emit just the inner content. Real
// data tables (rare in mail) get GFM table syntax via the default rule.
turndown.addRule('flattenLayoutTables', {
  filter: (node) => {
    if (node.nodeName !== 'TABLE') return false
    const cells = node.querySelectorAll('td, th')
    // Heuristic: if there's just one cell or the table has no <th>, it's
    // almost certainly being abused for layout.
    return cells.length <= 1 || node.querySelectorAll('th').length === 0
  },
  replacement: (_content, node) => {
    // Walk children and join their text/markdown — flat. No bars.
    const html = (node as HTMLElement).innerHTML || ''
    return turndown.turndown(html) + '\n\n'
  },
})

function htmlToMarkdown(html: string): string {
  try { return turndown.turndown(html) }
  catch { return html }
}

/**
 * Inline email preview pane. Renders headers + body (HTML or plain text)
 * + attachments list. Used in:
 *   - Inbox views (under AI summary, when user clicks 🔗 原文)
 *   - Project preview (when an email object is selected)
 *
 * Click flow for attachments: button → mail:saveAttachment IPC → file
 * lands in ~/Downloads → toast confirmation.
 *
 * The HTML body comes from `lu mail preview` which has already rewritten
 * `cid:` references to inline data: URLs, so images render without any
 * external network requests.
 */

interface MailPreviewProps {
  target: string
  /** Optional — passed through so the resolver can fall back to metadata
   *  search when Mail.app has recycled the original ROWID. */
  inboxItemId?: number
  /** Compact mode hides headers + uses smaller padding (for inbox rows). */
  compact?: boolean
}

interface MailData {
  subject?: string
  from?: string
  to?: string
  cc?: string
  date?: string
  html?: string
  text?: string
  attachments?: Array<{
    index: number
    name: string
    size: number
    content_type: string
    is_inline_image?: boolean
    available?: boolean
  }>
}

function fmtSize(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function MailPreview({ target, inboxItemId, compact }: MailPreviewProps) {
  const [data, setData] = useState<MailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    window.lineup.mailFullPreview({ target, inboxItemId })
      .then(r => {
        if (cancelled) return
        if (!r.ok) {
          setError(r.error || '加载失败')
        } else {
          setData(r as MailData)
        }
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(e?.message || String(e))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [target, inboxItemId])

  if (loading) {
    return (
      <div className={`text-xs text-muted-foreground ${compact ? 'py-2' : 'py-4'}`}>
        加载邮件正文…
      </div>
    )
  }
  if (error) {
    return (
      <div className={`text-xs text-destructive ${compact ? 'py-2' : 'py-4'}`}>
        ✗ {error}
      </div>
    )
  }
  if (!data) return null

  return (
    <div className={`flex flex-col gap-2 ${compact ? 'mt-2' : 'mt-3'}`}>
      {/* Headers — skip in compact mode (inbox row already shows author + date) */}
      {!compact && <MailHeaders data={data} />}

      {/* Attachments */}
      {data.attachments && data.attachments.length > 0 && (
        <AttachmentList
          attachments={data.attachments}
          target={target}
          inboxItemId={inboxItemId}
        />
      )}

      {/* Body */}
      <MailBody html={data.html} text={data.text} compact={compact} />
    </div>
  )
}


function MailHeaders({ data }: { data: MailData }) {
  return (
    <div className="text-xs space-y-0.5 px-3 py-2 rounded bg-muted/40 border border-border">
      {data.subject && <div className="font-medium text-sm">{data.subject}</div>}
      {data.from && <div><span className="text-muted-foreground">From: </span>{data.from}</div>}
      {data.to && <div className="truncate"><span className="text-muted-foreground">To: </span>{data.to}</div>}
      {data.cc && <div className="truncate"><span className="text-muted-foreground">Cc: </span>{data.cc}</div>}
      {data.date && <div className="text-muted-foreground">{data.date}</div>}
    </div>
  )
}


function AttachmentList({
  attachments, target, inboxItemId,
}: {
  attachments: NonNullable<MailData['attachments']>
  target: string
  inboxItemId?: number
}) {
  // Hide pure inline images from the user-facing list — they're already
  // embedded in the rendered HTML body, listing them again is just noise.
  const visible = attachments.filter(a => !a.is_inline_image)
  if (visible.length === 0) return null
  const [busy, setBusy] = useState<number | null>(null)

  async function save(idx: number) {
    setBusy(idx)
    try {
      const r = await window.lineup.mailSaveAttachment({ target, index: idx, inboxItemId })
      if (r.ok) {
        showTransientToast(`✓ 已保存到 ~/Downloads/${r.name}`, 2400)
      } else {
        showTransientToast(`✗ ${r.error || '保存失败'}`, 3000)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="text-xs">
      <div className="text-muted-foreground mb-1">📎 附件 ({visible.length})</div>
      <div className="flex flex-col gap-1">
        {visible.map(a => (
          <div
            key={a.index}
            className="flex items-center gap-2 px-2 py-1 rounded border border-border bg-card/40"
          >
            <span className="flex-1 truncate font-mono">{a.name}</span>
            <span className="text-muted-foreground shrink-0">{fmtSize(a.size)}</span>
            {a.available ? (
              <button
                onClick={() => save(a.index)}
                disabled={busy === a.index}
                className="text-primary hover:underline disabled:opacity-50 shrink-0"
              >
                {busy === a.index ? '…' : '⤓ 下载'}
              </button>
            ) : (
              <span
                className="text-muted-foreground shrink-0"
                title="邮件未完整下载，请先在 Mail.app 中打开该邮件让它把附件拉下来"
              >未下载</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}


function MailBody({
  html, text, compact,
}: {
  html?: string
  text?: string
  compact?: boolean
}) {
  // Convert HTML body → markdown so the email renders in the same style as
  // the rest of lineup (no iframe, no embedded CSS, dark-mode-correct,
  // CJK-friendly). Inline images already arrive as data: URLs (from the
  // Python preview's cid: rewriting), so they survive turndown as
  // ![](data:...) and ReactMarkdown happily renders them.
  const markdown = useMemo(() => {
    if (html) return htmlToMarkdown(html)
    return text || ''
  }, [html, text])

  if (markdown) {
    return (
      <div className={`markdown-body px-4 py-2 text-sm leading-relaxed
                       max-h-[800px] overflow-auto rounded bg-muted/20 border border-border/40`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Intercept ALL link clicks — without this, clicking a link in
            // an email body would hijack the whole Electron window.
            a: ({ href, children, ...rest }) => (
              <a
                {...rest}
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (href && !href.startsWith('data:') && !href.startsWith('cid:')) {
                    window.lineup.openTarget('url', href)
                  }
                }}
              >
                {children}
              </a>
            ),
            // Cap inline image height so a single huge marketing banner
            // doesn't dominate the pane.
            img: ({ src, alt }) =>
              src ? <img src={src} alt={alt || ''} style={{ maxHeight: 360, maxWidth: '100%' }} /> : null,
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    )
  }
  // text-only fallback (rare; html should always be set if anything is).
  if (text) {
    return (
      <pre className={`whitespace-pre-wrap break-words font-mono text-xs leading-relaxed px-3 py-2 rounded bg-muted/30 ${compact ? 'max-h-[400px]' : 'max-h-[800px]'} overflow-auto`}>
        {text}
      </pre>
    )
  }
  return <div className="text-xs text-muted-foreground italic py-2">(邮件正文为空)</div>
}
