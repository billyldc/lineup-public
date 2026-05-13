/**
 * Memory monitor for diagnosing lineup's runaway-RSS issue (the user
 * reports occasional 60GB spikes). Samples every 30s and logs to
 * ~/.lineup/memory_log.jsonl so we have a timeline to correlate against
 * user actions / cron events when a leak fires.
 *
 * Captures three sources:
 *   1. Electron processes via app.getAppMetrics() — main, renderers,
 *      utility, GPU. Each row has workingSetSize + privateBytes + CPU.
 *   2. Spawned pty subprocesses (claude, uv) via `ps -o pid,rss,comm`.
 *      Includes children of each pty so claude's helper processes count.
 *   3. Lineup state breadcrumbs (pty count, etc) for correlation.
 *
 * Storage shape — one JSON object per line, newest at the tail.
 * Rotation: keep ~100k lines (≈35 days at 30s) — bounded disk usage.
 */

import { app } from 'electron'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { join, dirname } from 'path'
import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync,
} from 'fs'

const LOG_PATH = join(homedir(), '.lineup', 'memory_log.jsonl')
const SAMPLE_INTERVAL_MS = 30_000
const MAX_LINES = 100_000


export interface ProcSample {
  pid: number
  type: string                  // 'Browser' | 'Tab' | 'Utility' | 'GPU' | ...
  name?: string
  workingSetMb: number
  privateMb?: number
  cpuPct?: number
}

export interface PtySample {
  pid: number
  cmd?: string
  rssMb: number
}

export interface MemorySample {
  ts: string
  uptime_s: number
  totalMb: number               // sum of all tracked processes (rough top-line)
  main: ProcSample | null
  renderers: ProcSample[]
  utility: ProcSample[]
  others: ProcSample[]
  ptys: PtySample[]
  ptyCount: number
}


let _started = false
let _ptyPidsProvider: (() => number[]) | null = null
let _rotateCheckCounter = 0


export function startMemoryMonitor(getPtyPids: () => number[]): void {
  if (_started) return
  _started = true
  _ptyPidsProvider = getPtyPids
  // First sample 5s after app ready to give Electron time to spin up its
  // helper processes (otherwise the first sample is artificially light).
  setTimeout(() => { void tick() }, 5_000)
  setInterval(() => { void tick() }, SAMPLE_INTERVAL_MS)
}


async function tick(): Promise<void> {
  try {
    const sample = await captureSample()
    appendSample(sample)
  } catch (e: any) {
    console.log('[memory] sample failed:', e?.message ?? e)
  }
}


export async function captureSample(): Promise<MemorySample> {
  const metrics = app.getAppMetrics()
  let main: ProcSample | null = null
  const renderers: ProcSample[] = []
  const utility: ProcSample[] = []
  const others: ProcSample[] = []
  let total = 0
  for (const m of metrics) {
    const ws = (m.memory.workingSetSize || 0) / 1024  // KB → MB
    total += ws
    const proc: ProcSample = {
      pid: m.pid,
      type: m.type,
      name: m.name,
      workingSetMb: round1(ws),
      privateMb: round1((m.memory.privateBytes || 0) / 1024),
      cpuPct: round1(m.cpu?.percentCPUUsage ?? 0),
    }
    if (m.type === 'Browser') main = proc
    else if (m.type === 'Tab' || m.type === 'Renderer') renderers.push(proc)
    else if (m.type === 'Utility') utility.push(proc)
    else others.push(proc)
  }
  const ptyRss = await capturePtyRss()
  for (const p of ptyRss) total += p.rssMb
  return {
    ts: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    totalMb: round1(total),
    main, renderers, utility, others,
    ptys: ptyRss,
    ptyCount: _ptyPidsProvider?.().length ?? 0,
  }
}


async function capturePtyRss(): Promise<PtySample[]> {
  if (!_ptyPidsProvider) return []
  const pids = _ptyPidsProvider().filter(p => p > 0)
  if (pids.length === 0) return []
  // Also pull descendants — claude spawns helper processes that count
  // toward lineup-attributable memory. We collect via `pgrep -P` per pid
  // and union into one ps call.
  const allPids = new Set<number>(pids)
  await Promise.all(pids.map(p => new Promise<void>((res) => {
    execFile('pgrep', ['-P', String(p)], (err, stdout) => {
      if (!err) {
        for (const child of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
          const n = parseInt(child, 10)
          if (Number.isFinite(n)) allPids.add(n)
        }
      }
      res()
    })
  })))
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,rss=,comm=', '-p', [...allPids].join(',')], (err, stdout) => {
      if (err) return resolve([])
      const out: PtySample[] = []
      for (const line of stdout.split('\n')) {
        const t = line.trim()
        if (!t) continue
        const m = t.match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (!m) continue
        out.push({
          pid: parseInt(m[1], 10),
          rssMb: round1(parseInt(m[2], 10) / 1024),
          cmd: m[3].trim(),
        })
      }
      resolve(out)
    })
  })
}


function appendSample(sample: MemorySample): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, JSON.stringify(sample) + '\n', 'utf8')
    maybeRotate()
  } catch { /* never break the app over a log write */ }
}


function maybeRotate(): void {
  // Cheap line-count check every ~120 samples (every ~1h at 30s rate).
  if (++_rotateCheckCounter < 120) return
  _rotateCheckCounter = 0
  try {
    const content = readFileSync(LOG_PATH, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    if (lines.length > MAX_LINES) {
      const tail = lines.slice(-MAX_LINES)
      writeFileSync(LOG_PATH, tail.join('\n') + '\n')
    }
  } catch { /* ignore */ }
}


export function getRecentSamples(limit = 200): MemorySample[] {
  try {
    if (!existsSync(LOG_PATH)) return []
    const lines = readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
    const tail = lines.slice(-limit)
    const out: MemorySample[] = []
    for (const line of tail) {
      try { out.push(JSON.parse(line)) } catch { /* skip malformed */ }
    }
    return out
  } catch { return [] }
}


export function getLogPath(): string { return LOG_PATH }


function round1(n: number): number { return Math.round(n * 10) / 10 }
