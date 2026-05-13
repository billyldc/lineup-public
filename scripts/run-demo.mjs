#!/usr/bin/env node
/**
 * One-command demo launcher.
 *
 *   npm run demo            # populated demo, isolated from your real ~/.lineup
 *   npm run demo --reset    # wipe demo DB, re-seed from seed.sql
 *
 * How it works:
 *   1. Picks a sandbox data dir at <repo>/demo-data/ so your real ~/.lineup
 *      is never touched.
 *   2. If demo-data/lineup.db doesn't exist yet, the Electron main process
 *      auto-creates the schema AND applies demo-data/seed.sql on first
 *      launch (see frontend/src/main/db.ts).
 *   3. Spawns `npm run dev` with LINEUP_DATA_DIR pointed at the sandbox.
 */

import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const DEMO_DIR = join(REPO_ROOT, 'demo-data')
const DB_PATH = join(DEMO_DIR, 'lineup.db')
const FRONTEND_DIR = join(REPO_ROOT, 'frontend')

const wantReset = process.argv.includes('--reset')

const log = (m) => process.stdout.write(`[demo] ${m}\n`)

if (!existsSync(join(FRONTEND_DIR, 'node_modules'))) {
  log('frontend/node_modules missing — running npm install first…')
  const installed = spawnSync('npm', ['install'], {
    cwd: FRONTEND_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (installed.status !== 0) process.exit(installed.status ?? 1)
}

if (!existsSync(DEMO_DIR)) mkdirSync(DEMO_DIR, { recursive: true })

if (wantReset || !existsSync(DB_PATH)) {
  if (wantReset) log('--reset: wiping existing demo DB')
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix
    if (existsSync(p)) rmSync(p)
  }
  log('on first launch, Electron will auto-create the schema + apply seed.sql')
} else {
  log('using existing demo DB (pass --reset to wipe)')
}

log(`launching Electron with LINEUP_DATA_DIR=${DEMO_DIR}`)
log('your real ~/.lineup is untouched. Ctrl+C to quit.')

const child = spawn('npm', ['run', 'dev'], {
  cwd: FRONTEND_DIR,
  env: { ...process.env, LINEUP_DATA_DIR: DEMO_DIR },
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
child.on('exit', (code) => process.exit(code ?? 0))
