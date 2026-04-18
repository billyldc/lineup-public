-- Demo data for screenshots / first-impression tour.
--
-- Usage:
--   LINEUP_DATA_DIR=$(pwd)/demo-data npm run dev    # creates empty DB
--   sqlite3 demo-data/lineup.db < demo-data/seed.sql
--
-- Populates: 3 root projects (research/work/personal), sub-projects, tasks
-- with various due dates (including today), steps, and orphan Inbox tasks.

INSERT INTO projects (name, type, color, important, urgent, status, order_index) VALUES
  ('research', 'project', 'blue', 1, 0, 'todo', 0),
  ('work', 'project', 'orange', 1, 1, 'todo', 1),
  ('personal', 'project', 'green', 0, 0, 'todo', 2);

-- Research sub-projects + tasks
INSERT INTO projects (name, type, color, important, urgent, status, order_index) VALUES
  ('paper submission', 'project', NULL, 1, 1, 'todo', 0),
  ('literature review', 'task', NULL, 1, 0, 'todo', 1),
  ('draft introduction', 'task', NULL, 1, 1, 'todo', 2);

INSERT INTO project_parents (project_id, parent_id) VALUES
  (4, 1), (5, 1), (6, 4);

-- Steps for "draft introduction" (one already done)
INSERT INTO projects (name, type, important, urgent, status, order_index) VALUES
  ('outline key contributions', 'step', 0, 0, 'done', 0),
  ('first pass draft', 'step', 0, 0, 'todo', 1),
  ('cite related work', 'step', 0, 0, 'todo', 2);

INSERT INTO project_parents (project_id, parent_id) VALUES
  (7, 6), (8, 6), (9, 6);

-- Work tasks with future due dates
INSERT INTO projects (name, type, important, urgent, status, due_at, order_index) VALUES
  ('Q2 roadmap review', 'task', 1, 1, 'todo', date('now', 'localtime', '+3 days'), 0),
  ('weekly 1:1 prep', 'task', 0, 1, 'todo', date('now', 'localtime', '+1 day'), 1),
  ('vendor contract review', 'task', 1, 0, 'todo', date('now', 'localtime', '+12 days'), 2);

INSERT INTO project_parents (project_id, parent_id) VALUES
  (10, 2), (11, 2), (12, 2);

-- Personal tasks
INSERT INTO projects (name, type, important, urgent, status, order_index) VALUES
  ('book dentist appointment', 'task', 0, 1, 'todo', 0),
  ('renew gym membership', 'task', 0, 0, 'todo', 1);

INSERT INTO project_parents (project_id, parent_id) VALUES
  (13, 3), (14, 3);

-- Tasks due TODAY (for Today view)
INSERT INTO projects (name, type, important, urgent, status, due_at, order_index) VALUES
  ('reply to advisor email', 'task', 1, 1, 'todo', date('now', 'localtime'), 3),
  ('submit expense report', 'task', 0, 1, 'todo', date('now', 'localtime'), 4),
  ('pick up dry cleaning', 'task', 0, 1, 'todo', date('now', 'localtime'), 5);

INSERT INTO project_parents (project_id, parent_id) VALUES
  (15, 1), (16, 2), (17, 3);

-- Orphan tasks for Inbox (no project_parents entry)
INSERT INTO projects (name, type, important, urgent, status, order_index) VALUES
  ('read Grokking Algorithms chapter 3', 'task', 0, 0, 'todo', 0),
  ('brainstorm blog post ideas', 'task', 0, 0, 'todo', 1),
  ('try new coffee shop on Main St', 'task', 0, 0, 'todo', 2);

-- Objects (files / links)
INSERT INTO objects (project_id, name, target, type) VALUES
  (4, 'submission guidelines', 'https://icml.cc/Conferences/2026/Dates', 'url'),
  (4, 'overleaf draft', 'https://www.overleaf.com/project/abc123', 'url'),
  (1, 'research notes', '/tmp/demo-notes.md', 'file');

UPDATE projects SET open_count = 8 WHERE id = 1;
UPDATE projects SET open_count = 15 WHERE id = 2;
UPDATE projects SET open_count = 3 WHERE id = 3;
