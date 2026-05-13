/**
 * External agent session sources beyond Claude Code.
 *
 * Lineup's AgentsView started life pointed exclusively at
 * ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl — the local transcripts
 * Claude Code drops on disk. That gets every Claude session for free,
 * including ones launched by openclaw (which is itself a Claude Code
 * wrapper and uses the same store).
 *
 * This module adds two more sources:
 *
 *   - Codex (OpenAI Codex CLI / ChatGPT Codex)
 *     ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
 *     Line 1 is `{type:"session_meta", payload:{id,cwd,...}}`;
 *     subsequent lines are `{type:"response_item", payload:{type:"message",role,content[]}}`.
 *
 *   - Hermes
 *     ~/.hermes/sessions/<YYYYMMDD>_<HHMMSS>_<id>.jsonl
 *     Line 1 is `{role:"session_meta", tools:[...]}`;
 *     subsequent lines are `{role:"user"|"assistant", content, timestamp?, reasoning?}`.
 *     Hermes does NOT record cwd, so we fall back to its session id as the bucket name.
 *
 * Both sources are read-only here. We can list, parse, and inspect them,
 * but lineup can't *resume* them in its embedded terminal (the chat panel
 * is wired to spawn `claude --resume <id>`, not codex / hermes), so the
 * "open in lineup" affordances in AgentsView are gated on source === 'claude'.
 */

import { existsSync, readdirSync, statSync, createReadStream } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'

import type { TimelineEvent, SessionData, SessionStats } from './index'

export type SessionSource = 'claude' | 'codex' | 'hermes'

export interface SessionListEntry {
  session_id: string
  source: SessionSource
  folder_path: string | null
  /** First user message, truncated. Falls back to session id slice. */
  name: string
  /** ISO timestamp — latest activity in the transcript. */
  last_modified: string
  message_count: number
  /** Absolute path of the underlying jsonl, so the dispatcher can re-open it without a second filesystem walk. */
  file_path: string
}

const MAX_TEXT = 4000
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

// ── Codex ────────────────────────────────────────────────────────────

const CODEX_ROOT = join(homedir(), '.codex', 'sessions')

/**
 * Walk ~/.codex/sessions/YYYY/MM/DD/ for rollout-*.jsonl files.
 * Codex organises by date, so we walk three levels and collect.
 */
function findCodexJsonls(): string[] {
  if (!existsSync(CODEX_ROOT)) return []
  const out: string[] = []
  const years = safeReaddir(CODEX_ROOT)
  for (const y of years) {
    const yDir = join(CODEX_ROOT, y)
    if (!isDir(yDir)) continue
    for (const m of safeReaddir(yDir)) {
      const mDir = join(yDir, m)
      if (!isDir(mDir)) continue
      for (const d of safeReaddir(mDir)) {
        const dDir = join(mDir, d)
        if (!isDir(dDir)) continue
        for (const f of safeReaddir(dDir)) {
          if (f.endsWith('.jsonl')) out.push(join(dDir, f))
        }
      }
    }
  }
  return out
}

/**
 * Cheap metadata pass — just enough for the session-list row.
 *
 * Early-exits as soon as we've found the session_meta line + the first
 * non-`<environment_context>` user message. Without this cap, scanning
 * a 49GB codex history blew the renderer's V8 heap when ~10k files
 * streamed in parallel.
 *
 * Returns null `lastTs` — caller uses the file's mtime for "last
 * activity", which is accurate for codex (it doesn't append no-op rows
 * on resume the way claude-code does).
 */
async function codexHeader(path: string, sizeBytes: number): Promise<{
  id: string | null
  cwd: string | null
  firstUserText: string | null
  count: number
}> {
  let id: string | null = null
  let cwd: string | null = null
  let firstUserText: string | null = null
  let count = 0
  // We don't know message count without a full scan, but the renderer
  // only displays it as a "≥ N" hint. Cheap proxy: rows ≈ bytes / avg.
  // Real value is available after the user opens the inspector.
  await iterLinesUntil(path, (line) => {
    if (!line.trim()) return false
    count++
    if (id && cwd && firstUserText) return true  // early exit
    let o: any
    try { o = JSON.parse(line) } catch { return false }
    if (o.type === 'session_meta' && o.payload) {
      id = id ?? o.payload.id ?? null
      cwd = cwd ?? o.payload.cwd ?? null
    }
    if (!firstUserText && o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'user') {
      const text = codexExtractText(o.payload.content)
      if (text && !/^<environment_context>/.test(text)) firstUserText = text
    }
    return false
  })
  // Backfill an approximate count when we early-exited. Picks the larger
  // of `count` (lines we actually read) and a rough estimate from size.
  if (count < 40 && sizeBytes > 4096) {
    const estimate = Math.max(count, Math.round(sizeBytes / 800))
    count = estimate
  }
  return { id, cwd, firstUserText, count }
}

function codexExtractText(content: any): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .filter((p: any) => p && (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text'))
      .map((p: any) => p.text ?? '')
      .join('\n')
      .trim()
    return text || null
  }
  return null
}

// Per-(path,mtime) cache so repeat list calls don't re-parse files whose
// header content hasn't changed. Codex sessions are append-only once
// closed, so the cache survives indefinitely for stale files.
const codexHeaderCache = new Map<string, {
  mtimeMs: number
  id: string | null
  cwd: string | null
  firstUserText: string | null
  count: number
}>()

export async function listCodexSessions(): Promise<SessionListEntry[]> {
  const files = findCodexJsonls()
  if (files.length === 0) return []
  const out: SessionListEntry[] = []

  // Bound parallelism: 49GB of codex history (Mac mini has 10k files)
  // OOMs V8 if we Promise.all the whole tree at once. 16-way is enough
  // to saturate an SSD without ballooning heap.
  const CONCURRENCY = 16
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= files.length) return
      const filePath = files[i]
      let stat
      try { stat = statSync(filePath) } catch { continue }

      const cached = codexHeaderCache.get(filePath)
      let header: { id: string | null; cwd: string | null; firstUserText: string | null; count: number }
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        header = cached
      } else {
        header = await codexHeader(filePath, stat.size)
        codexHeaderCache.set(filePath, { mtimeMs: stat.mtimeMs, ...header })
      }

      const fname = filePath.split('/').pop() ?? ''
      // rollout-2025-11-27T00-19-04-019ac0f6-157d-7e81-ada7-d975345d811b.jsonl
      const idFromName = fname.replace(/^rollout-/, '').replace(/\.jsonl$/, '').match(/[a-f0-9-]{36}$/i)?.[0] ?? null
      const sessionId = header.id ?? idFromName ?? fname
      out.push({
        session_id: sessionId,
        source: 'codex',
        folder_path: header.cwd,
        name: header.firstUserText
          ? truncate(header.firstUserText.replace(/\n/g, ' '), 80)
          : sessionId.slice(0, 8),
        // mtime is honest for codex — unlike claude, codex doesn't append
        // no-op rows on resume, so file timestamp == last activity.
        last_modified: stat.mtime.toISOString(),
        message_count: header.count,
        file_path: filePath,
      })
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  return out
}

/** Build a Claude-shaped SessionData out of a codex rollout. */
export async function readCodexSession(filePath: string): Promise<SessionData> {
  const events: TimelineEvent[] = []
  const tool_counts: Record<string, number> = {}
  let session_id = ''
  let folder_path: string | null = null
  let first_ts = ''
  let last_ts = ''
  let user_turns = 0
  let assistant_turns = 0
  let message_count = 0
  const tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
  const models = new Set<string>()

  await iterLines(filePath, (line) => {
    if (!line.trim()) return
    message_count++
    let o: any
    try { o = JSON.parse(line) } catch { return }
    const ts = typeof o.timestamp === 'string' ? o.timestamp : ''
    if (ts) {
      if (!first_ts || ts < first_ts) first_ts = ts
      if (!last_ts || ts > last_ts) last_ts = ts
    }
    if (o.type === 'session_meta' && o.payload) {
      session_id = session_id || o.payload.id || ''
      folder_path = folder_path || o.payload.cwd || null
      return
    }
    if (o.type === 'response_item' && o.payload) {
      const p = o.payload
      if (p.type === 'message') {
        const text = codexExtractText(p.content) ?? ''
        const uuid = p.id ?? ''
        if (p.role === 'user') {
          if (/^<environment_context>/.test(text)) return  // skip codex's synthetic system primer
          user_turns++
          events.push({ kind: 'user', ts, uuid, text: truncate(text, MAX_TEXT) })
        } else if (p.role === 'assistant') {
          assistant_turns++
          events.push({ kind: 'assistant-text', ts, uuid, text: truncate(text, MAX_TEXT) })
        } else if (p.role === 'system') {
          events.push({ kind: 'system', ts, uuid, text: truncate(text, 600) })
        }
      } else if (p.type === 'reasoning') {
        const text = codexExtractText(p.summary) ?? codexExtractText(p.content) ?? ''
        if (text) events.push({ kind: 'thinking', ts, uuid: p.id ?? '', text: truncate(text, MAX_TEXT) })
      } else if (p.type === 'function_call' || p.type === 'tool_use') {
        const name = p.name ?? p.function?.name ?? 'tool'
        tool_counts[name] = (tool_counts[name] ?? 0) + 1
        let summary = ''
        try {
          const args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments ?? {})
          summary = truncate(JSON.stringify(args), 140)
        } catch { summary = String(p.arguments ?? '') }
        events.push({
          kind: 'tool-use', ts, uuid: p.id ?? '',
          tool: { name, id: p.call_id ?? p.id ?? '', summary },
        })
      } else if (p.type === 'function_call_output' || p.type === 'tool_result') {
        const text = typeof p.output === 'string' ? p.output : codexExtractText(p.output) ?? JSON.stringify(p.output ?? '')
        events.push({
          kind: 'tool-result', ts, uuid: p.id ?? '',
          tool_use_id: p.call_id ?? '',
          text: truncate(text, 1200),
        })
      }
    }
    if (typeof o.payload?.model === 'string') models.add(o.payload.model)
  })

  const stats: SessionStats = {
    first_ts, last_ts,
    duration_ms: first_ts && last_ts ? Math.max(0, new Date(last_ts).getTime() - new Date(first_ts).getTime()) : 0,
    user_turns, assistant_turns,
    tool_counts,
    file_changes: [],
    bash_commands: [],
    tokens,
    models: [...models],
    message_count,
    git_branches: [],
  }
  return { session_id, folder_path, events, stats }
}

// ── Hermes ───────────────────────────────────────────────────────────

const HERMES_ROOT = join(homedir(), '.hermes', 'sessions')

const hermesHeaderCache = new Map<string, {
  mtimeMs: number
  firstUserText: string | null
  count: number
}>()

export async function listHermesSessions(): Promise<SessionListEntry[]> {
  if (!existsSync(HERMES_ROOT)) return []
  const files = safeReaddir(HERMES_ROOT).filter(f => f.endsWith('.jsonl'))
  if (files.length === 0) return []
  const out: SessionListEntry[] = []
  const CONCURRENCY = 16
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= files.length) return
      const file = files[i]
      const filePath = join(HERMES_ROOT, file)
      let stat
      try { stat = statSync(filePath) } catch { continue }
      const cached = hermesHeaderCache.get(filePath)
      let header: { firstUserText: string | null; count: number }
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        header = cached
      } else {
        header = await hermesHeader(filePath, stat.size)
        hermesHeaderCache.set(filePath, { mtimeMs: stat.mtimeMs, ...header })
      }
      const sessionId = file.replace(/\.jsonl$/, '')
      out.push({
        session_id: sessionId,
        source: 'hermes',
        // Hermes doesn't record cwd. Use a synthetic bucket so the
        // AgentsView group header doesn't call revealInFinder() on a
        // path that doesn't exist as a real folder.
        folder_path: '~/.hermes/sessions',
        name: header.firstUserText
          ? truncate(header.firstUserText.replace(/\n/g, ' '), 80)
          : sessionId,
        // mtime is fine for hermes — file is append-only per conversation.
        last_modified: stat.mtime.toISOString(),
        message_count: header.count,
        file_path: filePath,
      })
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  return out
}

async function hermesHeader(path: string, sizeBytes: number): Promise<{
  firstUserText: string | null
  count: number
}> {
  let firstUserText: string | null = null
  let count = 0
  await iterLinesUntil(path, (line) => {
    if (!line.trim()) return false
    count++
    if (firstUserText) return true
    let o: any
    try { o = JSON.parse(line) } catch { return false }
    if (!firstUserText && o.role === 'user' && typeof o.content === 'string') {
      firstUserText = o.content
    }
    return false
  })
  if (count < 10 && sizeBytes > 4096) count = Math.max(count, Math.round(sizeBytes / 600))
  return { firstUserText, count }
}

export async function readHermesSession(filePath: string): Promise<SessionData> {
  const events: TimelineEvent[] = []
  let first_ts = ''
  let last_ts = ''
  let user_turns = 0
  let assistant_turns = 0
  let message_count = 0
  const tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
  const models = new Set<string>()

  await iterLines(filePath, (line) => {
    if (!line.trim()) return
    message_count++
    let o: any
    try { o = JSON.parse(line) } catch { return }
    const ts = typeof o.timestamp === 'string' ? o.timestamp : ''
    if (ts) {
      if (!first_ts || ts < first_ts) first_ts = ts
      if (!last_ts || ts > last_ts) last_ts = ts
    }
    if (typeof o.model === 'string') models.add(o.model)
    if (o.role === 'session_meta') return  // tool defs, skip
    const content = typeof o.content === 'string' ? o.content : ''
    if (o.role === 'user') {
      user_turns++
      events.push({ kind: 'user', ts, uuid: o.id ?? '', text: truncate(content, MAX_TEXT) })
    } else if (o.role === 'assistant') {
      assistant_turns++
      if (typeof o.reasoning === 'string' && o.reasoning) {
        events.push({ kind: 'thinking', ts, uuid: (o.id ?? '') + ':reasoning', text: truncate(o.reasoning, MAX_TEXT) })
      }
      events.push({ kind: 'assistant-text', ts, uuid: o.id ?? '', text: truncate(content, MAX_TEXT) })
    } else if (o.role === 'system') {
      events.push({ kind: 'system', ts, uuid: o.id ?? '', text: truncate(content, 600) })
    }
  })

  const session_id = filePath.split('/').pop()!.replace(/\.jsonl$/, '')
  const stats: SessionStats = {
    first_ts, last_ts,
    duration_ms: first_ts && last_ts ? Math.max(0, new Date(last_ts).getTime() - new Date(first_ts).getTime()) : 0,
    user_turns, assistant_turns,
    tool_counts: {},
    file_changes: [],
    bash_commands: [],
    tokens,
    models: [...models],
    message_count,
    git_branches: [],
  }
  return { session_id, folder_path: null, events, stats }
}

// ── Cross-source helpers ─────────────────────────────────────────────

/** Aggregate codex + hermes. Caller layers on the existing claude list. */
export async function listExternalSessions(): Promise<SessionListEntry[]> {
  const [codex, hermes] = await Promise.all([listCodexSessions(), listHermesSessions()])
  return [...codex, ...hermes]
}

/**
 * Openclaw is *not* a separate file source — it's a Claude Code wrapper, so
 * its sessions live under ~/.claude/projects/-Users-X--openclaw-workspace/.
 * The list-row UI can call this on a Claude session entry to tag it for the
 * badge. Returns 'openclaw' if the path looks like an openclaw workspace,
 * else 'claude'.
 */
export function flavorClaudeSession(folderPath: string | null | undefined): 'claude' | 'openclaw' {
  if (!folderPath) return 'claude'
  if (/[\\/](\.openclaw|openclaw-workspace)([\\/]|$)/.test(folderPath)) return 'openclaw'
  return 'claude'
}

// ── Helpers ──────────────────────────────────────────────────────────

function safeReaddir(p: string): string[] {
  try { return readdirSync(p) } catch { return [] }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

function iterLines(path: string, cb: (line: string) => void): Promise<void> {
  return new Promise((resolve) => {
    const stream = createInterface({
      input: createReadStream(path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    stream.on('line', cb)
    stream.on('close', () => resolve())
    stream.on('error', () => resolve())
  })
}

/**
 * Like iterLines, but `cb` returns true to early-exit. Critical for the
 * cheap-header pass over codex's date-tree, where files can be 10+ MB
 * and we only need the first few lines. Closing the readline interface
 * also closes the underlying stream so we stop reading from disk.
 */
function iterLinesUntil(path: string, cb: (line: string) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stream = createReadStream(path, { encoding: 'utf8' })
    const iface = createInterface({ input: stream, crlfDelay: Infinity })
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    iface.on('line', (line: string) => {
      if (done) return
      if (cb(line)) {
        iface.close()
        stream.destroy()
        finish()
      }
    })
    iface.on('close', finish)
    iface.on('error', finish)
    stream.on('error', finish)
  })
}
