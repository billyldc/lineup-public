/**
 * SQLite data layer for the Electron main process.
 *
 * Reads/writes ~/.lineup/lineup.db. WAL mode ensures safe concurrent
 * access with external tools (Python CLI, MCP server).
 *
 * On first launch, auto-creates the directory + schema so Python is NOT
 * required for basic project management.
 */

import { join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync } from 'fs'
import { createRequire } from 'module'

const nativeRequire = createRequire(import.meta.url || __filename)
const Database = nativeRequire('better-sqlite3')

const DB_DIR = join(homedir(), '.lineup')
const DB_PATH = join(DB_DIR, 'lineup.db')

/** Core schema — created on first launch. Matches lineup/store.py SCHEMA. */
const SCHEMA = `
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
    recurring_days INTEGER,
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
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true })
  }

  const isNew = !existsSync(DB_PATH)
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')

  if (isNew) {
    _db.exec(SCHEMA)
  }

  // Migrations for existing databases (idempotent)
  for (const stmt of [
    `ALTER TABLE objects ADD COLUMN score REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE objects ADD COLUMN last_opened_at TEXT`,
    `ALTER TABLE projects ADD COLUMN main_agent_session_id TEXT`,
    `ALTER TABLE projects ADD COLUMN start_at TEXT`,
    `ALTER TABLE projects ADD COLUMN due_at TEXT`,
    `ALTER TABLE projects ADD COLUMN reminder_every_days INTEGER`,
    `ALTER TABLE projects ADD COLUMN last_reminded_at TEXT`,
    `ALTER TABLE projects ADD COLUMN important INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE projects ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'`,
    `ALTER TABLE projects ADD COLUMN order_index INTEGER`,
    `ALTER TABLE projects ADD COLUMN color TEXT`,
    `ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE projects ADD COLUMN recurring_days INTEGER`,
  ]) {
    try { _db.exec(stmt) } catch { /* column exists */ }
  }
  return _db
}
