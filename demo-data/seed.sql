-- Demo data for screenshots / first-impression tour.
--
-- Usage:
--   LINEUP_DATA_DIR=$(pwd)/demo-data npm --prefix frontend run dev   # creates empty DB
--   <Ctrl+C>
--   sqlite3 demo-data/lineup.db < demo-data/seed.sql
--   LINEUP_DATA_DIR=$(pwd)/demo-data npm --prefix frontend run dev   # relaunch
--
-- Showcases:
--   * 4 root projects with color + pin-to-sidebar
--   * Sub-projects → tasks → steps (3-level hierarchy)
--   * Recurring task ("weekly status update", resets every 7 days)
--   * Pinned projects appear in the sidebar quick-list
--   * Tasks due today (Today view) and within 3 days (Eisenhower auto-urgent)
--   * Orphan tasks in Inbox (Quick-Add ⌘N target)
--   * Mixed object types: url, file, folder, with descriptions
--   * Progress + progress_note on a sub-project
--
-- Anything that talks to external systems (Apple Mail / Obsidian / Zotero /
-- Claude Code sessions) is NOT seeded here — those sources only come alive
-- once you install the underlying app and follow docs/sources.md.

BEGIN TRANSACTION;

-- ── Root projects (pinned to sidebar) ──────────────────────────────────
INSERT INTO projects (name, type, color, important, urgent, status, pinned, order_index, description) VALUES
  ('research',  'project', 'blue',   1, 0, 'todo', 1, 0, 'PhD work — papers in flight, reading list, advisor 1:1s.'),
  ('work',      'project', 'orange', 1, 1, 'todo', 1, 1, 'Day-job project tracker.'),
  ('personal',  'project', 'green',  0, 0, 'todo', 0, 2, 'Errands, health, side reading.'),
  ('blog',      'project', 'purple', 0, 0, 'todo', 1, 3, 'Long-form writing.');

-- ── Research sub-projects + tasks + steps ──────────────────────────────
INSERT INTO projects (name, type, color, important, urgent, status, order_index, progress, progress_note, description) VALUES
  ('paper submission',     'project', NULL, 1, 1, 'todo', 0, 45, 'intro draft underway, methods section blocked on results', 'Submission for the spring deadline.'),
  ('literature review',    'task',    NULL, 1, 0, 'todo', 1, 0, '', ''),
  ('draft introduction',   'task',    NULL, 1, 1, 'todo', 2, 30, '', '');

INSERT INTO project_parents (project_id, parent_id) VALUES (5, 1), (6, 1), (7, 5);

-- Steps for "draft introduction" — sequential checklist (one done)
INSERT INTO projects (name, type, important, urgent, status, order_index) VALUES
  ('outline key contributions',         'step', 0, 0, 'done', 0),
  ('first pass draft',                  'step', 0, 0, 'todo', 1),
  ('cite related work',                 'step', 0, 0, 'todo', 2),
  ('tighten claims after re-reading',   'step', 0, 0, 'todo', 3);

INSERT INTO project_parents (project_id, parent_id) VALUES (8, 7), (9, 7), (10, 7), (11, 7);

-- ── Work sub-projects + tasks ──────────────────────────────────────────
INSERT INTO projects (name, type, important, urgent, status, due_at, order_index, description) VALUES
  ('Q2 roadmap review',    'task', 1, 1, 'todo', date('now', 'localtime', '+3 days'),  0, ''),
  ('weekly 1:1 prep',      'task', 0, 1, 'todo', date('now', 'localtime', '+1 day'),   1, ''),
  ('vendor contract review','task',1, 0, 'todo', date('now', 'localtime', '+12 days'), 2, ''),
  ('weekly status update', 'task', 0, 0, 'done', NULL,                                  3, 'Auto-resets every 7 days. Last marked done yesterday.');

UPDATE projects SET recurring_days = 7 WHERE name = 'weekly status update';

INSERT INTO project_parents (project_id, parent_id) VALUES (12, 2), (13, 2), (14, 2), (15, 2);

-- ── Personal tasks ────────────────────────────────────────────────────
INSERT INTO projects (name, type, important, urgent, status, order_index) VALUES
  ('book dentist appointment', 'task', 0, 1, 'todo', 0),
  ('renew gym membership',     'task', 0, 0, 'todo', 1),
  ('reply to a friend''s message', 'task', 0, 1, 'todo', 2);

INSERT INTO project_parents (project_id, parent_id) VALUES (16, 3), (17, 3), (18, 3);

-- ── Blog sub-projects ─────────────────────────────────────────────────
INSERT INTO projects (name, type, color, important, urgent, status, order_index, description) VALUES
  ('post: SQLite tricks',  'project', NULL, 0, 0, 'todo', 0, 'Draft about lessons from shipping a desktop app on SQLite.'),
  ('post idea backlog',    'task',    NULL, 0, 0, 'todo', 1, '');

INSERT INTO project_parents (project_id, parent_id) VALUES (19, 4), (20, 4);

-- ── Tasks due TODAY (Today view) ──────────────────────────────────────
INSERT INTO projects (name, type, important, urgent, status, due_at, order_index) VALUES
  ('reply to advisor email',  'task', 1, 1, 'todo', date('now', 'localtime'), 4),
  ('submit expense report',   'task', 0, 1, 'todo', date('now', 'localtime'), 4),
  ('pick up dry cleaning',    'task', 0, 1, 'todo', date('now', 'localtime'), 3);

INSERT INTO project_parents (project_id, parent_id) VALUES (21, 1), (22, 2), (23, 3);

-- ── Orphan tasks (Inbox — no project_parents row) ─────────────────────
INSERT INTO projects (name, type, important, urgent, status, order_index) VALUES
  ('read Designing Data-Intensive Applications ch. 3', 'task', 0, 0, 'todo', 0),
  ('brainstorm blog post ideas',                       'task', 0, 0, 'todo', 1),
  ('try new coffee shop on Main St',                   'task', 0, 0, 'todo', 2),
  ('idea: tool for tracking paper references',         'task', 0, 0, 'todo', 3);

-- ── Objects (linked files / URLs / folders) ───────────────────────────
INSERT INTO objects (project_id, name, target, type) VALUES
  (5,  'submission guidelines',     'https://icml.cc/Conferences/2026/Dates',          'url'),
  (5,  'overleaf draft',            'https://www.overleaf.com/project/abc123',         'url'),
  (5,  'related-work spreadsheet',  'https://docs.google.com/spreadsheets/d/example',  'url'),
  (1,  'research notes',            '/tmp/lineup-demo/research-notes.md',              'file'),
  (1,  'lab wiki',                  'https://example.org/lab/wiki',                    'url'),
  (2,  'team handbook',             'https://example.com/handbook',                    'url'),
  (2,  'Q2 OKRs draft',             '/tmp/lineup-demo/q2-okrs.md',                     'file'),
  (4,  'drafts folder',             '/tmp/lineup-demo/drafts',                         'folder'),
  (19, 'outline',                   '/tmp/lineup-demo/drafts/sqlite-tricks.md',        'file');

-- ── open_count drives sidebar ordering ───────────────────────────────
UPDATE projects SET open_count = 24 WHERE id = 1;
UPDATE projects SET open_count = 38 WHERE id = 2;
UPDATE projects SET open_count = 6  WHERE id = 3;
UPDATE projects SET open_count = 11 WHERE id = 4;
UPDATE projects SET open_count = 19 WHERE id = 5;
UPDATE projects SET open_count = 4  WHERE id = 19;

COMMIT;
