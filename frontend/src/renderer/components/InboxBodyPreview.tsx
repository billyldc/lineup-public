import { useEffect, useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import TurndownService from 'turndown'
import { MailPreview } from './MailPreview'

/**
 * Reusable inline preview for any inbox item — emails, RSS articles, or
 * any other source the Python backend populated into `inbox_items`.
 *
 * Routing:
 *   - sourceKind === 'email' AND url present  → <MailPreview> (markdown,
 *     uses mail_preview_cache, attachments + inline images)
 *   - everything else → fetch inboxGetItem(id), render content_html via
 *     turndown→ReactMarkdown, or content_text in a <pre> if no html.
 */

interface Props {
  inboxItemId: number
  sourceKind: string
  url: string | null
  compact?: boolean
}

/** When the feed didn't ship body content (or only shipped a short
 *  stub description) but we have a URL, offer a one-click fetch that
 *  scrapes the original page. Two presentations:
 *    - empty body: full-width primary control with explanation
 *    - stubMode:   compact secondary link below the existing stub
 *  Used for RSS items from feeds like Google DeepMind / OpenAI that
 *  ship title-only or one-sentence descriptions. */
function FetchArticleButton({
  inboxItemId, url, compact, onFetched, stubMode,
}: {
  inboxItemId: number; url: string; compact?: boolean; stubMode?: boolean
  onFetched: (html: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className={`text-xs ${compact ? 'py-2' : 'py-4'}`}>
      {!stubMode && (
        <span className="text-muted-foreground italic mr-2">原 feed 未提供正文</span>
      )}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true); setError(null)
          const r = await window.lineup.inboxFetchArticleBody(inboxItemId)
          setBusy(false)
          if (r.ok && r.content_html) {
            onFetched(r.content_html)
          } else {
            setError(r.error || '抓取失败')
          }
        }}
        className="px-2 py-0.5 rounded border border-border hover:bg-accent disabled:opacity-50"
      >{busy
        ? '抓取中…'
        : (stubMode ? '📥 抓取完整正文' : '📥 抓取原文正文')}</button>
      {stubMode && (
        <span className="ml-2 text-muted-foreground">
          feed 只给了简短描述（{'<'} 400 字）
        </span>
      )}
      {error && (
        <span className="ml-2 text-destructive">
          {error} · <a
            href={url}
            onClick={(e) => { e.preventDefault(); window.lineup.openTarget('url', url) }}
            className="underline"
          >直接打开原文</a>
        </span>
      )}
    </div>
  )
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
})
// Word/Outlook stuffs CSS + mso conditional blocks inside <style>/<head>;
// turndown doesn't strip them by default, so we'd see `@font-face`,
// `panose-1`, `mso-list` etc. dumped at the top of the rendered body.
turndown.remove(['style', 'script', 'head', 'meta', 'link', 'title'])
turndown.addRule('skipComments', {
  filter: (node) => node.nodeType === 8,
  replacement: () => '',
})
turndown.addRule('skipEmptyP', {
  filter: (node) =>
    node.nodeName === 'P' && !(node.textContent?.trim()) && !node.querySelector('img'),
  replacement: () => '',
})

function htmlToMarkdown(html: string): string {
  try { return turndown.turndown(html) }
  catch { return html }
}


export function InboxBodyPreview({ inboxItemId, sourceKind, url, compact }: Props) {
  // Email path: delegate to MailPreview (already does cache + markdown).
  if (sourceKind === 'email' && url) {
    return <MailPreview target={url} inboxItemId={inboxItemId} compact={compact} />
  }
  return <NonEmailBody inboxItemId={inboxItemId} url={url} compact={compact} />
}


function NonEmailBody({ inboxItemId, url, compact }: {
  inboxItemId: number
  url: string | null
  compact?: boolean
}) {
  const [data, setData] = useState<{
    content_html: string | null
    content_text: string | null
    summary: string | null
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.lineup.inboxGetItem(inboxItemId).then(item => {
      if (cancelled) return
      // inboxGetItem returns the InboxItemFull row when found, or null/error.
      // Treat unexpected shapes as "no content" rather than throwing.
      if (item && typeof item === 'object') {
        setData({
          content_html: (item as { content_html?: string | null }).content_html ?? null,
          content_text: (item as { content_text?: string | null }).content_text ?? null,
          summary: (item as { summary?: string | null }).summary ?? null,
        })
      }
      setLoading(false)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [inboxItemId])

  const markdown = useMemo(() => {
    if (!data) return ''
    if (data.content_html) return htmlToMarkdown(data.content_html)
    return data.content_text || data.summary || ''
  }, [data])

  if (loading) {
    return <div className={`text-xs text-muted-foreground ${compact ? 'py-2' : 'py-4'}`}>加载正文…</div>
  }
  if (!markdown) {
    // Empty body but we have a URL → offer one-click scrape. On
    // success update local state with the fetched HTML so render
    // proceeds without a refetch.
    if (url) {
      return (
        <FetchArticleButton
          inboxItemId={inboxItemId}
          url={url}
          compact={compact}
          onFetched={(html) => setData(prev => ({
            content_html: html,
            content_text: prev?.content_text ?? null,
            summary: prev?.summary ?? null,
          }))}
        />
      )
    }
    return <div className={`text-xs text-muted-foreground italic ${compact ? 'py-2' : 'py-4'}`}>（无可预览的正文）</div>
  }

  // Stub-body case: feed shipped only a tiny description (typical for
  // Google DeepMind / Google AI / some OpenAI items). Show what we
  // have, but offer a "fetch full body" affordance below so the user
  // can pull the actual article on demand.
  // Threshold 400 chars: real articles are >1k; RSS stubs are usually
  // a one-sentence sales line of <250 chars.
  const looksStubby = markdown.length < 400 && !!url && !data?.content_html
  return (
    <div className={`markdown-body ${compact ? 'mt-2' : 'mt-3'} px-4 py-2 text-sm leading-relaxed
                    max-h-[800px] overflow-auto rounded bg-muted/20 border border-border/40`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
          img: ({ src, alt }) =>
            src ? <img src={src} alt={alt || ''} style={{ maxHeight: 360, maxWidth: '100%' }} /> : null,
        }}
      >
        {markdown}
      </ReactMarkdown>
      {looksStubby && url && (
        <div className="mt-3 pt-2 border-t border-border/40">
          <FetchArticleButton
            inboxItemId={inboxItemId}
            url={url}
            compact
            onFetched={(html) => setData(prev => ({
              content_html: html,
              content_text: prev?.content_text ?? null,
              summary: prev?.summary ?? null,
            }))}
            stubMode
          />
        </div>
      )}
    </div>
  )
}
