/**
 * SQLite data layer for the Electron main process.
 *
 * Reads/writes the SAME ~/.lineup/lineup.db that the Python CLI and MCP
 * server use. WAL mode ensures safe concurrent access.
 *
 * Uses createRequire to load better-sqlite3 at runtime (not bundled by
 * Rollup) because it's a native addon that can't go through a bundler.
 */

import { join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { createRequire } from 'module'

const nativeRequire = createRequire(import.meta.url || __filename)
const Database = nativeRequire('better-sqlite3')

// Default to ~/.lineup, overridable via LINEUP_DATA_DIR — same env var
// the Electron main process honors for everything else (see index.ts).
// Keeps the demo/sandbox workflow (LINEUP_DATA_DIR=demo-data) self-contained.
const LINEUP_HOME = process.env.LINEUP_DATA_DIR || join(homedir(), '.lineup')
const DB_PATH = join(LINEUP_HOME, 'lineup.db')

// Core schema — created on first launch when no DB exists yet. Lets the
// Electron app boot without requiring Python / `lu init`. Mirrors the
// authoritative schema in lineup/store.py (Python side); migrations below
// cover the diff for older DBs.
const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'project',
    description TEXT DEFAULT '',
    priority INTEGER DEFAULT 3,
    progress INTEGER DEFAULT 0,
    progress_note TEXT DEFAULT '',
    open_count INTEGER DEFAULT 0,
    main_agent_session_id TEXT,
    start_at TEXT,
    due_at TEXT,
    reminder_every_days INTEGER,
    last_reminded_at TEXT,
    important INTEGER NOT NULL DEFAULT 0,
    urgent INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'todo',
    order_index INTEGER,
    color TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    is_inbox INTEGER NOT NULL DEFAULT 0,
    recurring_days INTEGER,
    completed_at TEXT,
    todoist_project_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_parents (
    project_id INTEGER NOT NULL,
    parent_id INTEGER NOT NULL,
    PRIMARY KEY (project_id, parent_id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (parent_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    target TEXT NOT NULL,
    type TEXT DEFAULT 'file',
    default_app TEXT,
    open_count INTEGER DEFAULT 0,
    score REAL NOT NULL DEFAULT 0,
    last_opened_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    due_date TEXT,
    remind_date TEXT,
    done INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    folder_path TEXT,
    name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    system_prompt TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    last_active_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
CREATE INDEX IF NOT EXISTS idx_agents_folder ON agents(folder_path);
`

let _db: any = null

export function getDb(): any {
  if (_db) return _db

  // Auto-create on first launch — no Python required
  if (!existsSync(LINEUP_HOME)) {
    mkdirSync(LINEUP_HOME, { recursive: true })
  }
  const isNew = !existsSync(DB_PATH)

  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  _db.pragma('busy_timeout = 5000')  // wait up to 5s when Python writes concurrently

  if (isNew) {
    _db.exec(CORE_SCHEMA)
    // First-launch seed: if a `seed.sql` sits next to the freshly-created
    // DB, apply it. This is what `npm run demo` triggers — it sets
    // LINEUP_DATA_DIR=<repo>/demo-data, where demo-data/seed.sql is
    // checked into the repo. Users get a populated app on first launch
    // with zero CLI gymnastics. For a normal install (LINEUP_HOME =
    // ~/.lineup), there's no seed.sql so this branch is a no-op.
    const seedPath = join(LINEUP_HOME, 'seed.sql')
    if (existsSync(seedPath)) {
      try {
        _db.exec(readFileSync(seedPath, 'utf8'))
        console.log('[db] applied demo seed from', seedPath)
      } catch (e) {
        console.error('[db] seed.sql exists but failed to apply:', e)
      }
    }
  }

  // ── Migrations ────────────────────────────────────────────────────
  // Add the weighted-score columns if they don't already exist. ALTER TABLE
  // throws when the column is already there, so we wrap each one. This
  // mirrors how lineup/store.py handles its own migrations.
  // Ensure the reserved "收件箱" project exists and attach any orphan tasks
  // to it. Run AFTER the ALTER TABLE migrations below.
  const ensureInbox = (_db: any) => {
    let inbox = _db.prepare("SELECT id FROM projects WHERE is_inbox = 1 LIMIT 1").get()
    if (!inbox) {
      const info = _db.prepare(
        `INSERT INTO projects (name, type, is_inbox, color)
         VALUES ('收件箱', 'project', 1, 'gray')`
      ).run()
      inbox = { id: info.lastInsertRowid }
    }
    // Migrate orphan tasks (no parent) to live under the inbox project
    _db.prepare(`
      INSERT INTO project_parents (project_id, parent_id)
      SELECT t.id, ?
      FROM projects t
      WHERE t.type = 'task'
        AND NOT EXISTS (SELECT 1 FROM project_parents pp WHERE pp.project_id = t.id)
    `).run(inbox.id)
  }

  for (const stmt of [
    `ALTER TABLE objects ADD COLUMN score REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE objects ADD COLUMN last_opened_at TEXT`,
    `ALTER TABLE projects ADD COLUMN main_agent_session_id TEXT`,
    // P1 schema expansion (2026-04-16)
    `ALTER TABLE projects ADD COLUMN start_at TEXT`,
    `ALTER TABLE projects ADD COLUMN due_at TEXT`,
    `ALTER TABLE projects ADD COLUMN reminder_every_days INTEGER`,
    `ALTER TABLE projects ADD COLUMN last_reminded_at TEXT`,
    `ALTER TABLE projects ADD COLUMN important INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE projects ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'`,
    `ALTER TABLE projects ADD COLUMN order_index INTEGER`,
    // 2026-04-16 follow-up
    `ALTER TABLE projects ADD COLUMN color TEXT`,
    `ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE projects ADD COLUMN recurring_days INTEGER`,
    `ALTER TABLE projects ADD COLUMN is_inbox INTEGER NOT NULL DEFAULT 0`,
    // 2026-04-23: per-item Zotero agents. folder_path on these rows points
    // at the item's Zotero storage folder (or a lineup scratch dir); the
    // existing XOR (project_id vs folder_path) still holds. zotero_key is
    // an optional tag so we can list "agents for this item".
    `ALTER TABLE agents ADD COLUMN zotero_key TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_agents_zotero ON agents(zotero_key)`,
    // 2026-05-03: completion timestamp — written when status flips to
    // 'done' so the column UI can show "✓ 完成于 X" on each step.
    `ALTER TABLE projects ADD COLUMN completed_at TEXT`,
  ]) {
    try { _db.exec(stmt) } catch { /* column exists */ }
  }
  // Runs AFTER the ALTERs so the is_inbox column definitely exists
  try { ensureInbox(_db) } catch (e) { console.error('[db] inbox init failed:', e) }

  // One-shot backfill (2026-04-23): historical steps were created BEFORE
  // inheritance was wired up, so they're missing due_at / reminder_every_days
  // / important / urgent from their parent task. Copy them down for every
  // step that still has null due_at. Idempotent — re-running is a no-op
  // because we only touch rows where due_at IS NULL.
  try {
    _db.exec(`
      UPDATE projects
      SET due_at = (
            SELECT t.due_at FROM projects t
            JOIN project_parents pp ON pp.parent_id = t.id
            WHERE pp.project_id = projects.id AND t.type = 'task'
            LIMIT 1
          ),
          reminder_every_days = COALESCE(projects.reminder_every_days, (
            SELECT t.reminder_every_days FROM projects t
            JOIN project_parents pp ON pp.parent_id = t.id
            WHERE pp.project_id = projects.id AND t.type = 'task'
            LIMIT 1
          )),
          important = CASE
            WHEN projects.important = 0 THEN COALESCE((
              SELECT t.important FROM projects t
              JOIN project_parents pp ON pp.parent_id = t.id
              WHERE pp.project_id = projects.id AND t.type = 'task'
              LIMIT 1
            ), 0)
            ELSE projects.important
          END,
          urgent = CASE
            WHEN projects.urgent = 0 THEN COALESCE((
              SELECT t.urgent FROM projects t
              JOIN project_parents pp ON pp.parent_id = t.id
              WHERE pp.project_id = projects.id AND t.type = 'task'
              LIMIT 1
            ), 0)
            ELSE projects.urgent
          END
      WHERE type = 'step' AND due_at IS NULL
    `)
  } catch (e) { console.error('[db] step backfill failed:', e) }

  // Session summary cache — keyed by (session_id, jsonl mtime) so rebuilds
  // invalidate automatically when the underlying conversation changes.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id TEXT PRIMARY KEY,
      folder_path TEXT,
      jsonl_mtime_ms INTEGER NOT NULL,
      model TEXT NOT NULL,
      summary_md TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Rollup (level 2/3) summaries. cluster_key is a stable hash of the
  // sorted child IDs — if cluster membership changes the hash changes and
  // the summary naturally invalidates. child_ids_json stores the list of
  // constituent IDs (session_ids for level 2, cluster_keys for level 3).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_summaries (
      folder_path TEXT NOT NULL,
      level INTEGER NOT NULL,
      cluster_key TEXT NOT NULL,
      child_ids_json TEXT NOT NULL,
      title TEXT NOT NULL,
      summary_md TEXT NOT NULL,
      first_ts TEXT,
      last_ts TEXT,
      session_count INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (folder_path, level, cluster_key)
    )
  `)
  // Track the content of the children used to BUILD each rollup. When any
  // child summary changes (e.g. a session grew and its L1 regenerated),
  // this hash changes and the L2/L3 cache is treated as stale.
  try { _db.exec(`ALTER TABLE cluster_summaries ADD COLUMN content_hash TEXT`) }
  catch { /* column exists */ }

  // Per-time-bucket summaries for Claude Code sessions. slot_index convention:
  //   -1     = whole-day summary
  //   0..5   = 4-hour slots (00-03, 04-07, 08-11, 12-15, 16-19, 20-23)
  //
  // Invalidation: by content_hash of event UUIDs in the bucket. The old
  // schema used a NOT-NULL jsonl_mtime_ms column; we no longer populate
  // it, so INSERTs were throwing NOT NULL violations and nothing ever
  // landed in the cache. Drop + recreate with the clean schema so writes
  // succeed. Existing rows all had content_hash='' (useless) so losing
  // them costs at most one regen per bucket.
  const hasMtimeCol = (_db.prepare(
    "PRAGMA table_info(time_bucket_summaries)"
  ).all() as any[]).some(c => c.name === 'jsonl_mtime_ms')
  if (hasMtimeCol) {
    try { _db.exec(`DROP TABLE time_bucket_summaries`) }
    catch (e) { console.error('[db] failed to drop stale time_bucket_summaries:', e) }
  }
  _db.exec(`
    CREATE TABLE IF NOT EXISTS time_bucket_summaries (
      session_id TEXT NOT NULL,
      date TEXT NOT NULL,
      slot_index INTEGER NOT NULL DEFAULT -1,
      content_hash TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, date, slot_index)
    )
  `)

  // Custom titles for sessions (user-typed or MiMo-generated). Overrides
  // the auto-derived "first user message" name when listing agents.
  // Email body preview cache. Parsing a .emlx + building the HTML view
  // is ~200-500ms per email, and for `message://<MID>` targets we scan
  // thousands of files to find the match. Once parsed the content is
  // static — emails never get rewritten — so we cache by target and
  // invalidate only if the underlying .emlx mtime changed.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS mail_preview_cache (
      target TEXT PRIMARY KEY,
      emlx_path TEXT,
      emlx_mtime_ms INTEGER,
      subject TEXT,
      from_addr TEXT,
      to_addr TEXT,
      cc_addr TEXT,
      date_str TEXT,
      html TEXT,
      text TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  // Attachments JSON sidecar: [{index, name, size, content_type, is_inline_image, available}].
  // Stored alongside the body so MailPreview can render the list without
  // re-parsing the emlx. Inline images are already rewritten as data URLs
  // in `html` so they don't need re-fetching.
  try { _db.exec(`ALTER TABLE mail_preview_cache ADD COLUMN attachments_json TEXT`) }
  catch { /* column exists */ }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS session_titles (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  // last_ts at the time we last ran MiMo auto-title for a session.
  // If the session's current last_ts differs from this, we know there's
  // been new activity → regenerate the auto-title silently.
  try { _db.exec(`ALTER TABLE session_titles ADD COLUMN last_ts TEXT NOT NULL DEFAULT ''`) }
  catch { /* column exists */ }
  return _db
}
