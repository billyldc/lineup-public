import { useState, useEffect, useCallback, useMemo } from 'react'
import type { MemorySample } from '../../preload/index'

/**
 * Live memory pill — small status display showing total RSS attributable
 * to lineup (Electron processes + spawned ptys + their descendants).
 *
 * Click to expand a panel that breaks down by process. Surface for the
 * "lineup eats 60GB sometimes" diagnosis loop — the user can correlate
 * spikes against trends in the recent-samples chart and find the
 * offending process by type.
 *
 * Backed by:
 *   - memory:current  — instant snapshot, polled every 5s for the pill
 *   - memory:recent   — up to 200 historical samples, fetched on expand
 */

function fmtMb(n: number | undefined): string {
  if (n == null) return '?'
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`
  return `${Math.round(n)} MB`
}


export function MemoryPill() {
  const [snap, setSnap] = useState<MemorySample | null>(null)
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async () => {
    const r = await window.lineup.memoryCurrent()
    if (r.ok && r.sample) setSnap(r.sample)
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    // Poll every 5s — the underlying log writes every 30s, but the live
    // snapshot is captured fresh so the pill responds quickly to spikes.
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  if (!snap) return null

  // Color thresholds tuned for "user complains at 60GB" — green under 4GB,
  // amber 4-8GB, red above 8GB. Tweak as we learn the normal-running band.
  const total = snap.totalMb
  const color = total < 4096 ? 'text-emerald-400'
    : total < 8192 ? 'text-amber-400'
    : 'text-red-400'

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        className={`text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent ${color} font-mono`}
        title="点击查看进程级别内存"
      >
        🧠 {fmtMb(total)}
      </button>
      {open && <MemoryPanel onClose={() => setOpen(false)} />}
    </>
  )
}


function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [samples, setSamples] = useState<MemorySample[] | null>(null)
  const [logPath, setLogPath] = useState<string>('')

  useEffect(() => {
    void window.lineup.memoryRecent(200).then(r => {
      if (r.ok) {
        setSamples(r.samples || [])
        setLogPath(r.logPath || '')
      }
    })
  }, [])

  const latest = samples && samples.length > 0 ? samples[samples.length - 1] : null

  // Trend stats — peak, avg over visible window, and trajectory tag
  // ("rising fast" if last 5 samples are climbing).
  const trend = useMemo(() => {
    if (!samples || samples.length < 2) return null
    const totals = samples.map(s => s.totalMb)
    const peak = Math.max(...totals)
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length
    const last = totals[totals.length - 1]
    const fiveAgo = totals.length >= 6 ? totals[totals.length - 6] : totals[0]
    const delta5 = last - fiveAgo
    const minutes = samples.length >= 6
      ? (new Date(samples[samples.length - 1].ts).getTime() -
         new Date(samples[samples.length - 6].ts).getTime()) / 60000
      : null
    return { peak, avg, last, delta5, minutes }
  }, [samples])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end p-4 bg-black/30"
      onClick={onClose}
    >
      <div
        className="w-[720px] max-w-[95vw] max-h-[80vh] overflow-y-auto bg-background border border-border rounded-lg shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">🧠 lineup 内存监控</div>
            <div className="text-[11px] text-muted-foreground mt-0.5 font-mono break-all">
              log: {logPath.replace(/^\/Users\/[^/]+\//, '~/')}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-accent"
          >✕</button>
        </div>

        {!latest && (
          <div className="p-6 text-sm text-muted-foreground italic">
            还没有内存采样数据。lineup 启动 5 秒后会有第一条记录，之后每 30 秒一条。
          </div>
        )}

        {latest && trend && (
          <>
            {/* Trend stats */}
            <div className="px-4 py-3 grid grid-cols-4 gap-3 text-xs border-b border-border bg-muted/20">
              <Stat label="当前" value={fmtMb(trend.last)} />
              <Stat
                label="近期峰值"
                value={fmtMb(trend.peak)}
                hint={`过去 ${samples?.length ?? 0} 个样本`}
              />
              <Stat label="平均" value={fmtMb(trend.avg)} />
              <Stat
                label={trend.minutes ? `近 ${Math.round(trend.minutes)} 分钟` : '近 5 个样本'}
                value={(trend.delta5 >= 0 ? '+' : '') + fmtMb(Math.abs(trend.delta5))}
                hint={trend.delta5 > 100 ? '⚠ 在涨' : trend.delta5 < -100 ? '在降' : '平稳'}
                color={trend.delta5 > 500 ? 'text-red-400'
                  : trend.delta5 > 100 ? 'text-amber-400'
                  : 'text-emerald-400'}
              />
            </div>

            {/* Trend chart — sparkline of last 60 samples */}
            <Sparkline samples={samples!.slice(-60)} />

            {/* Process breakdown */}
            <div className="px-4 py-3 space-y-3 text-xs">
              <div>
                <div className="text-muted-foreground mb-1.5">📦 Electron 进程</div>
                {latest.main && <ProcRow proc={latest.main} role="主进程" />}
                {latest.renderers.length > 0 && latest.renderers
                  .sort((a, b) => b.workingSetMb - a.workingSetMb)
                  .map((r, i) => <ProcRow key={r.pid} proc={r} role={`渲染 #${i + 1}`} />)}
                {latest.utility.length > 0 && latest.utility
                  .sort((a, b) => b.workingSetMb - a.workingSetMb)
                  .map((r) => <ProcRow key={r.pid} proc={r} role="Utility" />)}
                {latest.others.length > 0 && latest.others
                  .sort((a, b) => b.workingSetMb - a.workingSetMb)
                  .map((r) => <ProcRow key={r.pid} proc={r} role={r.type} />)}
              </div>

              {latest.ptys.length > 0 && (
                <div>
                  <div className="text-muted-foreground mb-1.5">
                    🖥 终端子进程（{latest.ptyCount} 个 pty + 后代）
                  </div>
                  {latest.ptys
                    .sort((a, b) => b.rssMb - a.rssMb)
                    .map(p => (
                      <PtyRow key={p.pid} pty={p} />
                    ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}


function Stat({
  label, value, hint, color,
}: {
  label: string; value: string; hint?: string; color?: string
}) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-mono ${color || ''}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  )
}


function ProcRow({ proc, role }: {
  proc: { pid: number; type: string; name?: string; workingSetMb: number; cpuPct?: number }
  role: string
}) {
  const big = proc.workingSetMb > 1024
  return (
    <div className={`flex items-center gap-2 py-0.5 font-mono ${big ? 'text-amber-400' : ''}`}>
      <span className="text-muted-foreground w-16 shrink-0">{role}</span>
      <span className="w-14 shrink-0 text-right">{fmtMb(proc.workingSetMb)}</span>
      <span className="text-muted-foreground text-[10px] w-12 shrink-0 text-right">
        {proc.cpuPct != null ? `${proc.cpuPct.toFixed(0)}%` : ''}
      </span>
      <span className="text-foreground/70 truncate flex-1">
        {proc.name || `pid ${proc.pid}`}
      </span>
    </div>
  )
}


function PtyRow({ pty }: { pty: { pid: number; cmd?: string; rssMb: number } }) {
  const big = pty.rssMb > 1024
  return (
    <div className={`flex items-center gap-2 py-0.5 font-mono ${big ? 'text-amber-400' : ''}`}>
      <span className="text-muted-foreground w-16 shrink-0">pid {pty.pid}</span>
      <span className="w-14 shrink-0 text-right">{fmtMb(pty.rssMb)}</span>
      <span className="text-foreground/70 truncate flex-1">{pty.cmd || ''}</span>
    </div>
  )
}


function Sparkline({ samples }: { samples: MemorySample[] }) {
  if (samples.length < 2) return null
  const totals = samples.map(s => s.totalMb)
  const min = Math.min(...totals)
  const max = Math.max(...totals)
  const range = Math.max(max - min, 1)
  const w = 680, h = 60, pad = 4
  const xStep = (w - pad * 2) / (samples.length - 1)
  const points = totals.map((t, i) => {
    const x = pad + i * xStep
    const y = pad + (h - pad * 2) * (1 - (t - min) / range)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  // Color the line by trajectory of last quarter window
  const lastQ = totals.slice(-Math.max(2, Math.floor(samples.length / 4)))
  const trend = lastQ[lastQ.length - 1] - lastQ[0]
  const stroke = trend > 200 ? '#f87171' : trend < -200 ? '#34d399' : '#94a3b8'

  return (
    <div className="px-4 py-2 border-b border-border bg-muted/10">
      <div className="text-[10px] text-muted-foreground mb-1">
        最近 {samples.length} 个采样（每 30 秒一个）— 范围 {fmtMb(min)} → {fmtMb(max)}
      </div>
      <svg width={w} height={h} className="w-full">
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          points={points}
        />
      </svg>
    </div>
  )
}
