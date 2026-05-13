import { useState, useEffect, useCallback, useRef } from 'react'
import { getTimezone, setTimezone } from '../../lib/datetime'
import {
  getHotkey, setHotkey, getDefaultHotkey, formatHotkey, eventToHotkey,
} from '../../lib/hotkey'

/**
 * ⚙ 设置 — knobs that control how lineup behaves day-to-day.
 *
 * Sections, in priority order:
 *   1. 会话休眠 — idle hibernate threshold (renderer-only, localStorage)
 *   2. 启动行为 — fullscreen-on-launch, default tab strategy
 *   3. 缓存维护 — bulk-clear actions + footprint stats
 *   4. 日志 & 数据 — paths + open-in-Finder
 *
 * Adding a new setting? Cheap path: localStorage + a hook here.
 * Anything that needs to flow into a main-process loop (cron intervals)
 * needs a settings.json + main reads on next tick — defer until needed.
 */

const HIBERNATE_KEY = 'lineup:hibernateIdleMinutes'
const FULLSCREEN_KEY = 'lineup:dev:autostartFullscreen'

interface Stats {
  dbSize?: number; dbPath?: string
  memLogSize?: number; memLogPath?: string
  mailPreviewCount?: number
  lineupHome?: string
}

function fmtBytes(n: number | undefined): string {
  if (n == null) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}


export function SettingsView() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="px-6 py-4 border-b border-border">
        <div className="text-xl font-semibold">⚙ 设置</div>
        <div className="text-xs text-muted-foreground mt-1">
          常用开关都放在这里 — 大部分立即生效；少数（cron 间隔）需要重启 lineup
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 max-w-[820px]">
        <HotkeysSection />
        <HibernateSection />
        <TimezoneSection />
        <StartupSection />
        <CacheMaintenanceSection />
        <PathsSection />
      </div>
    </div>
  )
}


// ── Section: hotkeys ────────────────────────────────────────────────

function HotkeysSection() {
  return (
    <Section title="⌨ 快捷键" desc="lineup 内部全局快捷键。点击右侧按钮进入「录制」模式，按下新的组合即可绑定">
      <HotkeyRow
        name="search"
        label="打开搜索面板"
        note="搜索项目和对象 · ⌃Space 在 macOS 被输入法锁住，建议保留 ⌘K 或换 ⌘P"
      />
    </Section>
  )
}

function HotkeyRow({ name, label, note }: {
  name: 'search'; label: string; note?: string
}) {
  const [value, setValue] = useState<string>(() => getHotkey(name))
  const [recording, setRecording] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)

  // When recording, the next non-modifier keypress becomes the new
  // binding. Clicking outside the recording chip cancels.
  useEffect(() => {
    if (!recording) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); setRecording(false); return }
      const combo = eventToHotkey(e)
      if (!combo) return  // raw modifier — wait for a real key
      e.preventDefault()
      setHotkey(name, combo)
      setValue(combo)
      setRecording(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, name])

  const isDefault = value === getDefaultHotkey(name)

  return (
    <div ref={rowRef}>
      <Row label={label}>
        <button
          onClick={() => setRecording(r => !r)}
          className={`text-xs font-mono px-2 py-1 rounded border ${
            recording
              ? 'border-primary bg-primary/15 animate-pulse'
              : 'border-border hover:bg-accent'
          }`}
        >
          {recording ? '按下新组合…  (Esc 取消)' : formatHotkey(value)}
        </button>
        {!isDefault && (
          <button
            onClick={() => {
              setHotkey(name, '')
              setValue(getDefaultHotkey(name))
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >恢复默认 ({formatHotkey(getDefaultHotkey(name))})</button>
        )}
      </Row>
      {note && <Hint>{note}</Hint>}
    </div>
  )
}


// ── Section: idle hibernate ─────────────────────────────────────────

function HibernateSection() {
  const [minutes, setMinutes] = useState<number>(() => {
    const v = parseInt(localStorage.getItem(HIBERNATE_KEY) || '30', 10)
    return Number.isFinite(v) && v > 0 ? v : 30
  })
  const [neverHibernate, setNeverHibernate] = useState<boolean>(() =>
    localStorage.getItem(HIBERNATE_KEY) === 'never'
  )

  useEffect(() => {
    if (neverHibernate) localStorage.setItem(HIBERNATE_KEY, 'never')
    else localStorage.setItem(HIBERNATE_KEY, String(minutes))
  }, [minutes, neverHibernate])

  return (
    <Section title="💤 会话休眠" desc="claude code 自身的内存泄漏会让多个 session 同时跑时累积到几十 GB；lineup 会自动休眠空闲会话来释放内存（kill claude 进程，保留 session id 和滚动历史，下次点击瞬间 resume 回来）">
      <Row label="空闲多久后自动休眠">
        <div className="flex items-center gap-2">
          {[5, 15, 30, 60, 120].map(m => (
            <button
              key={m}
              onClick={() => { setNeverHibernate(false); setMinutes(m) }}
              className={`text-xs px-2.5 py-1 rounded border ${
                !neverHibernate && minutes === m
                  ? 'border-primary bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}
            >{m} 分钟</button>
          ))}
          <input
            type="number"
            min={1}
            value={neverHibernate ? '' : minutes}
            disabled={neverHibernate}
            onChange={e => {
              const v = parseInt(e.target.value, 10)
              if (Number.isFinite(v) && v > 0) setMinutes(v)
            }}
            className="w-20 text-xs px-2 py-1 rounded border border-border bg-muted/30 disabled:opacity-40"
          />
          <span className="text-xs text-muted-foreground">自定义</span>
        </div>
      </Row>
      <Row label="永不自动休眠">
        <Toggle checked={neverHibernate} onChange={setNeverHibernate} />
        <Hint>关掉自动休眠 — 适合 macOS 内存够大、不在意 RSS 的场景</Hint>
      </Row>
      <Note>
        当前活跃会话永远不会被自动休眠 · 已经休眠的会话点 tab 标签即唤醒（透明，无交互）·
        手动早期休眠：把那条会话的 tab 切走，等到达阈值时自动收
      </Note>
    </Section>
  )
}


// ── Section: display timezone ───────────────────────────────────────

const TZ_PRESETS: { tz: string; label: string }[] = [
  { tz: 'Asia/Hong_Kong', label: 'HKT (香港)' },
  { tz: 'Asia/Shanghai', label: 'CST (北京)' },
  { tz: 'America/Los_Angeles', label: 'PT (洛杉矶)' },
  { tz: 'America/New_York', label: 'ET (纽约)' },
  { tz: 'UTC', label: 'UTC' },
]

function TimezoneSection() {
  const [tz, setTz] = useState<string>(() => getTimezone())
  const [now, setNow] = useState<string>('')
  // Live preview — re-render every 30s so the user can see it tick.
  useEffect(() => {
    const tick = () => {
      try {
        setNow(new Intl.DateTimeFormat('zh-CN', {
          timeZone: tz,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).format(new Date()))
      } catch {
        setNow('(无效时区)')
      }
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [tz])

  const isPreset = TZ_PRESETS.some(p => p.tz === tz)
  const apply = (value: string) => { setTz(value); setTimezone(value) }

  return (
    <Section title="🕐 显示时区" desc="lineup 用来格式化所有时间显示的时区。挂 VPN 时 macOS 自动定位可能误判到 UTC，这里显式锁住可以兜底">
      <Row label="时区">
        <div className="flex items-center gap-2 flex-wrap">
          {TZ_PRESETS.map(p => (
            <button
              key={p.tz}
              onClick={() => apply(p.tz)}
              className={`text-xs px-2.5 py-1 rounded border ${
                tz === p.tz
                  ? 'border-primary bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}
            >{p.label}</button>
          ))}
          <input
            type="text"
            placeholder="自定义 IANA (e.g. Europe/London)"
            value={isPreset ? '' : tz}
            onChange={e => apply(e.target.value.trim())}
            className="w-56 text-xs px-2 py-1 rounded border border-border bg-muted/30 font-mono"
          />
        </div>
      </Row>
      <Row label="当前时间">
        <span className="text-xs font-mono text-foreground">{now}</span>
        <Hint>实时按所选时区渲染 — 看着对就是对的</Hint>
      </Row>
      <Note>
        修改即时生效。Agent 总览的时间会立刻按新时区刷新；其它视图随下次 re-render 跟上。
      </Note>
    </Section>
  )
}


// ── Section: startup ────────────────────────────────────────────────

function StartupSection() {
  const [fullscreen, setFullscreen] = useState<boolean>(() =>
    localStorage.getItem(FULLSCREEN_KEY) !== 'false'  // default true
  )
  useEffect(() => {
    localStorage.setItem(FULLSCREEN_KEY, String(fullscreen))
  }, [fullscreen])

  return (
    <Section title="🚀 启动行为" desc="lineup 启动时的默认状态">
      <Row label="启动即全屏（dev 模式）">
        <Toggle checked={fullscreen} onChange={setFullscreen} />
        <Hint>
          开发模式由 <code className="font-mono">npm run dev</code> 通过 <code>LINEUP_FULLSCREEN=1</code> 控制；
          这里只是个偏好记录，下次改 npm script 时参考
        </Hint>
      </Row>
      <Note>
        重启时所有会话默认休眠（仅 active 会话自动唤醒）—— 上次崩到 60 GB 就是因为 48 个 saved tab 重启时一起 spawn claude。
      </Note>
    </Section>
  )
}


// ── Section: cache maintenance ──────────────────────────────────────

function CacheMaintenanceSection() {
  const [stats, setStats] = useState<Stats | null>(null)
  const refresh = useCallback(async () => {
    setStats(await window.lineup.settingsStats())
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function clearMail() {
    if (!confirm('清空所有邮件正文缓存？\n下次点开邮件会重新解析 emlx（只慢一次，会自动重建）。')) return
    setBusy('mail')
    const r = await window.lineup.settingsClearMailPreviewCache()
    setBusy(null)
    setFeedback(r.ok ? `✓ 清空了 ${r.removed} 条邮件缓存` : `✗ ${r.error}`)
    void refresh()
  }

  return (
    <Section title="🧹 缓存维护" desc="清空后下次访问会自动重建；不会丢任何用户数据">
      <Row label="邮件正文缓存">
        <button
          onClick={clearMail}
          disabled={busy === 'mail'}
          className="text-xs px-3 py-1 rounded border border-border hover:bg-accent disabled:opacity-40"
        >{busy === 'mail' ? '清理中…' : '清空'}</button>
        <span className="text-xs text-muted-foreground">
          目前 {stats?.mailPreviewCount ?? '?'} 条 · 下次需要时按需重建
        </span>
      </Row>
      {feedback && (
        <div className="text-xs text-foreground/80 pt-2">{feedback}</div>
      )}
    </Section>
  )
}


// ── Section: paths ──────────────────────────────────────────────────

function PathsSection() {
  const [stats, setStats] = useState<Stats | null>(null)
  useEffect(() => {
    void window.lineup.settingsStats().then(setStats)
  }, [])

  function reveal(p?: string) {
    if (p) void window.lineup.revealInFinder(p)
  }

  return (
    <Section title="📂 数据 & 日志" desc="点击文件名在 Finder 中打开">
      <PathRow
        label="lineup 主目录"
        path={stats?.lineupHome}
        onOpen={() => reveal(stats?.lineupHome)}
      />
      <PathRow
        label="lineup.db"
        path={stats?.dbPath}
        size={fmtBytes(stats?.dbSize)}
        onOpen={() => reveal(stats?.dbPath)}
      />
      <PathRow
        label="memory_log.jsonl"
        path={stats?.memLogPath}
        size={fmtBytes(stats?.memLogSize)}
        onOpen={() => reveal(stats?.memLogPath)}
      />
    </Section>
  )
}


function PathRow({ label, path, size, onOpen }: {
  label: string
  path: string | undefined
  size?: string
  onOpen: () => void
}) {
  return (
    <Row label={label}>
      <button
        onClick={onOpen}
        disabled={!path}
        className="text-xs font-mono text-primary hover:underline truncate max-w-[400px]"
      >{path ? path.replace(/^\/Users\/[^/]+\//, '~/') : '(unavailable)'}</button>
      {size && <span className="text-xs text-muted-foreground">{size}</span>}
    </Row>
  )
}


// ── Layout primitives ──────────────────────────────────────────────

function Section({ title, desc, children }: {
  title: string; desc?: string; children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-sm font-semibold mb-1">{title}</div>
      {desc && <div className="text-xs text-muted-foreground mb-3">{desc}</div>}
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs flex-wrap">
      <div className="text-muted-foreground min-w-[180px] shrink-0">{label}</div>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: {
  checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors ${
        checked ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-background transition-transform ${
        checked ? 'translate-x-4' : 'translate-x-0.5'
      }`} />
    </button>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-muted-foreground">{children}</span>
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] text-muted-foreground italic mt-3 pt-2 border-t border-border/40">
      {children}
    </div>
  )
}
