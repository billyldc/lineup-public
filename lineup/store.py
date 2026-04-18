"""SQLite storage layer for lineup."""

import sqlite3
import subprocess
import os
from pathlib import Path
from datetime import datetime

DB_DIR = Path.home() / ".lineup"
DB_PATH = DB_DIR / "lineup.db"
STATE_PATH = DB_DIR / "state.json"


def pretty_target(target: str) -> str:
    """Display-friendly target path.

    Tries the object-type system first, then falls back to plugins, then ~ shortening.
    """
    # 1. Object type system (new)
    try:
        from lineup import types
        types.load_all()
        t = types.get_for_target(target)
        result = t.display_target(target)
        if result is not None:
            return result
    except (ImportError, Exception):
        pass
    # 2. Plugin fallback (legacy — obsidian/trilium still use this path until Phase 2)
    try:
        from lineup import plugins
        if plugins.all_plugins():
            result = plugins.display_target(target)
            if result != target:  # plugins.display_target returns target unchanged on miss
                return result
    except (ImportError, Exception):
        pass
    # 3. Default: ~ shortening
    home = str(Path.home())
    if target.startswith(home):
        return "~" + target[len(home):]
    return target

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- Three levels in the unified hierarchy:
    --   'project'  = long-term workspace, has main agent + objects, user-created
    --   'task'     = concrete unit of work under a project, also has its own agent
    --   'step'     = sequential checklist item under a task, AGENT-created only
    -- type='task' rows are always *parallel* with their siblings.
    -- type='step' rows are always *sequential* within their task parent.
    -- Neither of these rules is configurable — they're baked in to keep
    -- cognitive load low. See memory:project_lineup_prime_directive.
    type TEXT DEFAULT 'project',
    description TEXT DEFAULT '',
    priority INTEGER DEFAULT 3,
    progress INTEGER DEFAULT 0,
    progress_note TEXT DEFAULT '',
    open_count INTEGER DEFAULT 0,
    -- Stable session id for the (project|task)'s main agent.
    main_agent_session_id TEXT,
    -- Date/time gating
    start_at TEXT,
    due_at TEXT,
    -- Recurrence: ping the user every N days until done. Null = no recurrence.
    reminder_every_days INTEGER,
    last_reminded_at TEXT,
    -- Eisenhower quadrant inputs. `urgent` is the user's explicit pin; the
    -- effective urgency for views also ORs in (due_at <= now+3 days).
    important INTEGER NOT NULL DEFAULT 0,
    urgent INTEGER NOT NULL DEFAULT 0,
    -- Lifecycle
    status TEXT NOT NULL DEFAULT 'todo',   -- todo | active | done | cancelled
    -- Order within siblings. Only meaningful for step rows (sequential).
    order_index INTEGER,
    -- Visual / organizational metadata. color is a short preset name
    -- (one of ~8 values); archived hides the project from the default
    -- sidebar list without deleting it. Both only meaningful for
    -- type='project' rows.
    color TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    -- Recurring tasks: when completed, auto-reset after N days.
    -- Steps under this task are also reset. null = not recurring.
    recurring_days INTEGER,
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
    -- Weighted recency score: each open adds 1 after applying a half-life
    -- decay relative to last_opened_at. See main/index.ts:incrementOpen for
    -- the formula.
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
    project_id INTEGER,              -- set if linked to a lineup project
    folder_path TEXT,                -- set if linked to a filesystem folder
    name TEXT NOT NULL,
    session_id TEXT NOT NULL,        -- claude code session UUID (stable across resumes)
    system_prompt TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    last_active_at TEXT,
    CHECK ((project_id IS NULL) != (folder_path IS NULL)),
    FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
CREATE INDEX IF NOT EXISTS idx_agents_folder ON agents(folder_path);
"""


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> str:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = get_db()
    conn.executescript(SCHEMA)
    # Migrations for existing databases
    try:
        conn.execute("ALTER TABLE projects ADD COLUMN open_count INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # Column already exists
    try:
        conn.execute("ALTER TABLE objects ADD COLUMN default_app TEXT")
    except sqlite3.OperationalError:
        pass  # Column already exists
    try:
        conn.execute("ALTER TABLE projects ADD COLUMN progress_note TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass  # Column already exists
    try:
        conn.execute("ALTER TABLE projects ADD COLUMN type TEXT DEFAULT 'project'")
    except sqlite3.OperationalError:
        pass  # Column already exists
    try:
        conn.execute("ALTER TABLE projects ADD COLUMN todoist_project_id TEXT")
    except sqlite3.OperationalError:
        pass  # Column already exists
    try:
        conn.execute("ALTER TABLE objects ADD COLUMN score REAL NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # Column already exists
    try:
        conn.execute("ALTER TABLE objects ADD COLUMN last_opened_at TEXT")
    except sqlite3.OperationalError:
        pass  # Column already exists
    try:
        conn.execute("ALTER TABLE projects ADD COLUMN main_agent_session_id TEXT")
    except sqlite3.OperationalError:
        pass  # Column already exists
    # P1 schema expansion (2026-04-16): task/step types + date gating +
    # Eisenhower flags + lifecycle status.
    for stmt in [
        "ALTER TABLE projects ADD COLUMN start_at TEXT",
        "ALTER TABLE projects ADD COLUMN due_at TEXT",
        "ALTER TABLE projects ADD COLUMN reminder_every_days INTEGER",
        "ALTER TABLE projects ADD COLUMN last_reminded_at TEXT",
        "ALTER TABLE projects ADD COLUMN important INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE projects ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'",
        "ALTER TABLE projects ADD COLUMN order_index INTEGER",
        "ALTER TABLE projects ADD COLUMN color TEXT",
        "ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE projects ADD COLUMN recurring_days INTEGER",
    ]:
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError:
            pass  # Column already exists

    # Ensure agents table exists for existing databases
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER,
            folder_path TEXT,
            name TEXT NOT NULL,
            session_id TEXT NOT NULL,
            system_prompt TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            last_active_at TEXT,
            CHECK ((project_id IS NULL) != (folder_path IS NULL)),
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agents_folder ON agents(folder_path)")

    # Migration: re-detect object types using the type registry.
    # Objects linked before the type system existed may have generic types
    # (file/folder) that should be more specific (obsidian/trilium/url/etc).
    try:
        from lineup import types
        types.load_all()
        objs = conn.execute("SELECT id, target, type FROM objects").fetchall()
        for obj in objs:
            detected = types.get_for_target(obj["target"])
            if detected.name != obj["type"] and detected.priority > 0:
                conn.execute(
                    "UPDATE objects SET type = ? WHERE id = ?",
                    (detected.name, obj["id"]),
                )
        conn.commit()
    except Exception:
        pass  # Non-critical migration; skip if types not available

    conn.close()
    return f"已初始化 lineup，数据存储在 {DB_PATH}"


_TYPE_LABELS = {
    'project': '项目',
    'task': '任务',
    'step': '步骤',
    'document': '文档',
}


def _resolve_parent_by_name(conn, parent_name: str):
    """Look up a parent by name with helpful disambiguation if multiple match.

    Returns (row_dict, None) on unique match, or (None, error_message) if
    the lookup failed.
    """
    rows = conn.execute(
        "SELECT id, name, type FROM projects WHERE name = ?",
        (parent_name,),
    ).fetchall()
    if not rows:
        return None, f"错误：父项目 \"{parent_name}\" 不存在。先用 lineup_list_projects 或 lineup_list_children 确认名字。"
    if len(rows) > 1:
        opts = ", ".join(f"id={r['id']}(type={r['type']})" for r in rows)
        return None, f"错误：有多个名为 \"{parent_name}\" 的项目：{opts}。请用更精确的 parent 名或先 list_children 消歧。"
    return rows[0], None


def create_project(name: str, description: str = "", priority: int = 3, parent: str | None = None, type: str = "project") -> str:
    conn = get_db()
    try:
        # Check duplicate name — and be helpful about it
        existing = conn.execute(
            "SELECT id, type FROM projects WHERE name = ?",
            (name,),
        ).fetchone()
        if existing:
            label = _TYPE_LABELS.get(existing['type'] or 'project', '项目')
            return (
                f"错误：已存在一个叫 \"{name}\" 的{label}（id={existing['id']}, type={existing['type']}）。"
                f"\n先用 lineup_list_children 或 lineup_list_projects 确认是不是同一个。"
                f"如果是同一个就直接用现有的；如果确实要建新的，请换一个不同的名字（例如加日期/编号）。"
            )

        if type == "document":
            priority = 0
        conn.execute(
            "INSERT INTO projects (name, description, priority, type) VALUES (?, ?, ?, ?)",
            (name, description, priority, type),
        )
        project_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

        if parent:
            parent_row = conn.execute("SELECT id, type FROM projects WHERE name = ?", (parent,)).fetchone()
            if not parent_row:
                conn.rollback()
                return f"错误：父项目 \"{parent}\" 不存在"
            # Documents cannot contain projects
            if (parent_row["type"] or "project") == "document" and type != "document":
                conn.rollback()
                return f"错误：文档 \"{parent}\" 下不能创建项目，只能创建子文档"
            conn.execute(
                "INSERT INTO project_parents (project_id, parent_id) VALUES (?, ?)",
                (project_id, parent_row["id"]),
            )

        conn.commit()
        label = _TYPE_LABELS.get(type, "项目")
        msg = f"已创建{label} \"{name}\""
        if parent:
            msg += f"（父项目：{parent}）"
        return msg
    finally:
        conn.close()


def create_task(name: str, parent: str, description: str = "",
                important: bool = False, urgent: bool = False,
                due_at: str | None = None) -> str:
    """Create a task row under a project. Parent MUST be a 'project' type.

    Tasks are PARALLEL with their siblings — they run independently.
    For sequential breakdown of ONE task, use create_step instead.
    """
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id, type FROM projects WHERE name = ?", (name,),
        ).fetchone()
        if existing:
            return (
                f"错误：已有一个叫 \"{name}\" 的{_TYPE_LABELS.get(existing['type'] or 'project', '项目')}"
                f"（id={existing['id']}）。先用 lineup_list_children 确认是不是同一个，"
                f"或者换个更具体的名字再建。"
            )
        parent_row, err = _resolve_parent_by_name(conn, parent)
        if err: return err
        parent_type = parent_row['type'] or 'project'
        if parent_type != 'project':
            return (
                f"错误：父节点 \"{parent}\" 是 {parent_type},不能承载 task。"
                f"task 只能直接挂在 project 下面。"
            )
        # Inherit important/urgent from parent if not explicitly set
        parent_flags = conn.execute(
            "SELECT important, urgent FROM projects WHERE id = ?",
            (parent_row['id'],),
        ).fetchone()
        imp_val = 1 if (important or (parent_flags and parent_flags['important'])) else 0
        urg_val = 1 if (urgent or (parent_flags and parent_flags['urgent'])) else 0
        conn.execute(
            """INSERT INTO projects
               (name, description, priority, type, important, urgent, due_at)
               VALUES (?, ?, 3, 'task', ?, ?, ?)""",
            (name, description, imp_val, urg_val, due_at),
        )
        child_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute(
            "INSERT INTO project_parents (project_id, parent_id) VALUES (?, ?)",
            (child_id, parent_row['id']),
        )
        conn.commit()
        return f"已创建任务 \"{name}\"（父项目：{parent}, id={child_id}）"
    finally:
        conn.close()


def create_step(name: str, parent_task: str) -> str:
    """Create a sequential step under a task.

    Steps are SEQUENTIAL: each step is blocked until its predecessor is
    done. order_index is auto-assigned as max(existing) + 1.
    """
    conn = get_db()
    try:
        parent_row, err = _resolve_parent_by_name(conn, parent_task)
        if err: return err
        parent_type = parent_row['type'] or 'project'
        if parent_type != 'task':
            return (
                f"错误：父节点 \"{parent_task}\" 是 {parent_type},不能承载 step。"
                f"step 只能直接挂在 task 下面。先用 lineup_create_task 建一个任务,再往里面加 step。"
            )
        max_row = conn.execute(
            """SELECT COALESCE(MAX(p.order_index), 0) AS mx FROM projects p
               JOIN project_parents pp ON p.id = pp.project_id
               WHERE pp.parent_id = ? AND p.type = 'step'""",
            (parent_row['id'],),
        ).fetchone()
        order_index = (max_row['mx'] or 0) + 1
        conn.execute(
            """INSERT INTO projects (name, type, priority, order_index)
               VALUES (?, 'step', 3, ?)""",
            (name, order_index),
        )
        child_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute(
            "INSERT INTO project_parents (project_id, parent_id) VALUES (?, ?)",
            (child_id, parent_row['id']),
        )
        conn.commit()
        return f"已创建步骤 \"{name}\"（父任务：{parent_task}, 顺序：{order_index}）"
    finally:
        conn.close()


def set_task_meta(name: str, parent: str | None = None,
                  due_at: str | None = None,
                  important: bool | None = None,
                  urgent: bool | None = None,
                  status: str | None = None,
                  reminder_every_days: int | None = None) -> str:
    """Update mutable fields on an existing task / project / step.

    Only writes fields the caller explicitly passes (None = leave alone).
    Status must be one of: todo | active | done | cancelled.
    """
    conn = get_db()
    try:
        # Find the row. Disambiguate if multiple match by name.
        rows = conn.execute(
            "SELECT id, type FROM projects WHERE name = ?", (name,),
        ).fetchall()
        if not rows:
            return f"错误：找不到叫 \"{name}\" 的 project/task/step"
        target = None
        if len(rows) == 1:
            target = rows[0]
        elif parent:
            parent_row = conn.execute(
                "SELECT id FROM projects WHERE name = ?", (parent,),
            ).fetchone()
            if not parent_row:
                return f"错误：父项目 \"{parent}\" 不存在,无法消歧。"
            match = conn.execute(
                """SELECT p.id, p.type FROM projects p
                   JOIN project_parents pp ON p.id = pp.project_id
                   WHERE p.name = ? AND pp.parent_id = ?""",
                (name, parent_row["id"]),
            ).fetchone()
            if not match:
                return f"错误：\"{parent}\" 下没有叫 \"{name}\" 的子项。"
            target = match
        else:
            opts = ", ".join(f"id={r['id']}(type={r['type']})" for r in rows)
            return (
                f"错误：有多个叫 \"{name}\" 的条目：{opts}。"
                f"请传入 parent 参数消歧。"
            )

        patch: dict[str, object] = {}
        if due_at is not None: patch["due_at"] = due_at or None
        if important is not None: patch["important"] = 1 if important else 0
        if urgent is not None: patch["urgent"] = 1 if urgent else 0
        if status is not None:
            if status not in ("todo", "active", "done", "cancelled"):
                return f"错误：status 必须是 todo/active/done/cancelled 之一，不是 \"{status}\""
            patch["status"] = status
        if reminder_every_days is not None:
            patch["reminder_every_days"] = (
                reminder_every_days if reminder_every_days > 0 else None
            )

        if not patch:
            return "错误：没有要更新的字段。"

        cols = ", ".join(f"{k} = ?" for k in patch.keys())
        conn.execute(
            f"UPDATE projects SET {cols} WHERE id = ?",
            (*patch.values(), target["id"]),
        )
        conn.commit()
        label = _TYPE_LABELS.get(target["type"] or "project", "项目")
        changes = ", ".join(f"{k}={v}" for k, v in patch.items())
        return f"已更新{label} \"{name}\" (id={target['id']}): {changes}"
    finally:
        conn.close()


def list_children(parent: str) -> str:
    """List direct children of a project/task with their types + status.

    Use this BEFORE creating any new project/task/step to avoid duplicates.
    """
    conn = get_db()
    try:
        parent_row, err = _resolve_parent_by_name(conn, parent)
        if err: return err
        rows = conn.execute(
            """SELECT p.id, p.name, p.type, p.status, p.order_index, p.due_at
               FROM projects p
               JOIN project_parents pp ON p.id = pp.project_id
               WHERE pp.parent_id = ?
               ORDER BY
                 CASE p.type
                   WHEN 'project' THEN 0
                   WHEN 'task' THEN 1
                   WHEN 'step' THEN 2
                   ELSE 3
                 END,
                 CASE WHEN p.order_index IS NULL THEN 1 ELSE 0 END,
                 p.order_index,
                 p.name""",
            (parent_row['id'],),
        ).fetchall()
        if not rows:
            return f"\"{parent}\" (id={parent_row['id']}, type={parent_row['type']}) 下没有直接子项。"
        lines = [f"\"{parent}\" (id={parent_row['id']}, type={parent_row['type']}) 的直接子项："]
        for r in rows:
            label = _TYPE_LABELS.get(r['type'] or 'project', r['type'] or '?')
            ord_hint = f" [{r['order_index']}]" if r['type'] == 'step' and r['order_index'] is not None else ''
            due_hint = f" due={r['due_at'][:10]}" if r['due_at'] else ''
            status_hint = f" ({r['status']})" if r['status'] and r['status'] != 'todo' else ''
            lines.append(f"  [{label}]{ord_hint} {r['name']} (id={r['id']}){due_hint}{status_hint}")
        return '\n'.join(lines)
    finally:
        conn.close()


def list_projects(filter_type: str | None = None) -> str:
    """List all projects/documents, optionally filtered by type."""
    conn = get_db()
    try:
        projects = conn.execute("SELECT * FROM projects ORDER BY priority DESC, name").fetchall()
        if not projects:
            return "暂无项目"

        # Build parent-child map
        relations = conn.execute("SELECT project_id, parent_id FROM project_parents").fetchall()
        children_map: dict[int, list[int]] = {}
        has_parent: set[int] = set()
        for r in relations:
            children_map.setdefault(r["parent_id"], []).append(r["project_id"])
            has_parent.add(r["project_id"])

        project_map = {p["id"]: p for p in projects}

        def _format_item(p) -> str:
            is_doc = (p["type"] or "project") == "document"
            if is_doc:
                line = p["name"]
            else:
                line = f"[{p['priority']}] {p['name']}"
            if p["description"]:
                line += f" - {p['description']}"
            if (p["progress"] or 0) > 0:
                line += f" ({p['progress']}%)"
            return line

        def format_tree(pid: int, indent: int = 0) -> list[str]:
            p = project_map[pid]
            prefix = "    " * indent
            if indent > 0:
                prefix = "    " * (indent - 1) + "├── "
            lines = [prefix + _format_item(p)]
            kids = children_map.get(pid, [])
            for i, kid_id in enumerate(kids):
                kid = project_map.get(kid_id)
                if kid:
                    kid_prefix = "    " * indent
                    is_last = i == len(kids) - 1
                    connector = "└── " if is_last else "├── "
                    lines.append(kid_prefix + connector + _format_item(kid))
                    grandkids = children_map.get(kid_id, [])
                    for gk_id in grandkids:
                        sub_lines = format_tree(gk_id, indent + 2)
                        lines.extend(sub_lines)
            return lines

        # Separate roots by type
        roots = [p for p in projects if p["id"] not in has_parent]
        docs = sorted(
            [p for p in roots if (p["type"] or "project") == "document"],
            key=lambda p: -(p["open_count"] or 0),
        )
        projs = [p for p in roots if (p["type"] or "project") != "document"]

        result = []
        if filter_type != "project" and docs:
            result.append("📄 文档：")
            for p in docs:
                result.extend("  " + l for l in format_tree(p["id"]))
        if filter_type != "document" and projs:
            if result:
                result.append("")
            result.append("📁 项目：")
            for p in projs:
                result.extend("  " + l for l in format_tree(p["id"]))

        return "\n".join(result) if result else "暂无项目"
    finally:
        conn.close()


def _read_state() -> dict:
    import json
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text())
    except json.JSONDecodeError:
        return {}


def _write_state(state: dict):
    import json
    STATE_PATH.write_text(json.dumps(state))


def _get_by_id(pid: int | None) -> dict | None:
    if pid is None:
        return None
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_current_project() -> dict | None:
    """Get the current active project (type=project)."""
    return _get_by_id(_read_state().get("current_project_id"))


def get_current_document() -> dict | None:
    """Get the current active document."""
    return _get_by_id(_read_state().get("current_document_id"))


def get_active_context() -> dict | None:
    """Get whichever context (project or document) was last navigated."""
    state = _read_state()
    last = state.get("last_section")
    if last == "document":
        return _get_by_id(state.get("current_document_id")) or _get_by_id(state.get("current_project_id"))
    else:
        return _get_by_id(state.get("current_project_id")) or _get_by_id(state.get("current_document_id"))


def set_current_project(project_id: int | None):
    """Set the current active project."""
    state = _read_state()
    state["current_project_id"] = project_id
    if project_id is not None:
        state["last_section"] = "project"
    elif state.get("last_section") == "project":
        state["last_section"] = "document" if state.get("current_document_id") else None
    _write_state(state)


def set_current_document(document_id: int | None):
    """Set the current active document."""
    state = _read_state()
    state["current_document_id"] = document_id
    if document_id is not None:
        state["last_section"] = "document"
    elif state.get("last_section") == "document":
        state["last_section"] = "project" if state.get("current_project_id") else None
    _write_state(state)


def open_project(name: str) -> str:
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM projects WHERE name = ?", (name,)).fetchone()
        if not row:
            return f"错误：项目 \"{name}\" 不存在"

        set_current_project(row["id"])

        # Increment open count
        conn.execute("UPDATE projects SET open_count = open_count + 1 WHERE id = ?", (row["id"],))
        conn.commit()

        # Build summary
        label = "文档" if (row["type"] or "project") == "document" else "项目"
        lines = [f"已进入{label}：{row['name']}"]
        if row["description"]:
            lines.append(f"描述：{row['description']}")
        pct = row['progress'] or 0
        note = row['progress_note'] or ""
        prog_line = f"优先级：{row['priority']}  进度：{pct}%"
        if note:
            prog_line += f"  {note}"
        lines.append(prog_line)

        # Sub-projects
        kids = conn.execute(
            "SELECT p.* FROM projects p JOIN project_parents pp ON p.id = pp.project_id WHERE pp.parent_id = ?",
            (row["id"],),
        ).fetchall()
        if kids:
            lines.append("\n子项目：")
            for k in kids:
                lines.append(f"  - {k['name']} ({k['progress'] or 0}%)")

        # Objects
        objs = conn.execute(
            "SELECT * FROM objects WHERE project_id = ? ORDER BY open_count DESC",
            (row["id"],),
        ).fetchall()
        if objs:
            lines.append("\n文件/链接：")
            for o in objs:
                type_label = o['type']
                if o['default_app']:
                    type_label += f"/{o['default_app']}"
                lines.append(f"  - {o['name']}  {pretty_target(o['target'])}  [{type_label}]  (打开 {o['open_count']} 次)")

        # Todos
        todos = conn.execute(
            "SELECT * FROM todos WHERE project_id = ? AND done = 0 ORDER BY due_date",
            (row["id"],),
        ).fetchall()
        if todos:
            lines.append("\n待办：")
            for t in todos:
                due = f"  截止: {t['due_date']}" if t["due_date"] else ""
                lines.append(f"  [ ] {t['text']}{due}")

        return "\n".join(lines)
    finally:
        conn.close()


def set_priority(priority: int, project: str | None = None) -> str:
    """Set the priority for a project."""
    if priority < 1 or priority > 5:
        return "错误：优先级应在 1-5 之间"
    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved
    conn = get_db()
    try:
        conn.execute("UPDATE projects SET priority = ? WHERE id = ?", (priority, project_id))
        conn.commit()
        return f"已更新 \"{project_name}\" 优先级：{priority}"
    finally:
        conn.close()


def _resolve_project(project: str | None) -> tuple[int, str] | str:
    """Resolve project by name, or fall back to active context. Returns (id, name) or error string."""
    conn = get_db()
    try:
        if project:
            row = conn.execute("SELECT id, name FROM projects WHERE name = ?", (project,)).fetchone()
            if not row:
                return f"错误：项目 \"{project}\" 不存在"
            return (row["id"], row["name"])
        else:
            cur = get_active_context()
            if not cur:
                return "错误：未指定项目，也没有当前活跃项目。请先用 cd 进入一个项目或文档"
            return (cur["id"], cur["name"])
    finally:
        conn.close()


def link_object(target: str, name: str, type: str = "file", project: str | None = None, default_app: str | None = None) -> str:
    """Link an object (file/folder/URL/zotero/script) to a project."""
    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved

    # Expand ~ in file paths
    if type in ("file", "folder", "script") and target.startswith("~"):
        target = str(Path(target).expanduser())

    # Auto-detect type via the type registry (replaces hardcoded if/elif).
    # Only runs when the caller passed the default type="file", meaning
    # "I don't know, please detect". Explicit types are respected as-is.
    if type == "file":
        try:
            from lineup import types
            types.load_all()
            detected = types.get_for_target(target)
            type = detected.name
        except (ImportError, Exception):
            pass

    conn = get_db()
    try:
        # Check duplicate name within project
        existing = conn.execute(
            "SELECT id FROM objects WHERE project_id = ? AND name = ?",
            (project_id, name),
        ).fetchone()
        if existing:
            return f"错误：项目 \"{project_name}\" 中已存在名为 \"{name}\" 的对象"

        conn.execute(
            "INSERT INTO objects (project_id, name, target, type, default_app) VALUES (?, ?, ?, ?, ?)",
            (project_id, name, target, type, default_app),
        )
        conn.commit()
        msg = f"已将 \"{name}\" ({type}) 链接到项目 \"{project_name}\"\n目标：{target}"
        if default_app:
            msg += f"\n默认应用：{default_app}"
        return msg
    finally:
        conn.close()


def list_objects(project: str | None = None) -> str:
    """List all objects in a project, sorted by open frequency."""
    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved

    conn = get_db()
    try:
        objs = conn.execute(
            "SELECT * FROM objects WHERE project_id = ? ORDER BY open_count DESC, name",
            (project_id,),
        ).fetchall()
        if not objs:
            return f"项目 \"{project_name}\" 中暂无链接对象"

        lines = [f"项目 \"{project_name}\" 的对象："]
        for o in objs:
            type_label = o['type']
            if o['default_app']:
                type_label += f"/{o['default_app']}"
            line = f"  {o['name']}  {pretty_target(o['target'])}  [{type_label}]  (打开 {o['open_count']} 次)"
            lines.append(line)
        return "\n".join(lines)
    finally:
        conn.close()


def open_object(name: str, app: str | None = None, project: str | None = None) -> str:
    """Open an object with the default or specified application. Increments open count."""
    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved

    conn = get_db()
    try:
        obj = conn.execute(
            "SELECT * FROM objects WHERE project_id = ? AND name = ?",
            (project_id, name),
        ).fetchone()
        if not obj:
            return f"错误：项目 \"{project_name}\" 中找不到 \"{name}\""

        # Increment open count
        conn.execute("UPDATE objects SET open_count = open_count + 1 WHERE id = ?", (obj["id"],))
        conn.commit()

        target = obj["target"]
        obj_type = obj["type"]

        # 1. Try the type system for an open command.
        # First try the DB-stored type; if that's a generic type (file/folder),
        # also try auto-detection — the object may have been linked before the
        # type system existed and could be more specific (e.g. obsidian).
        type_cmd = None
        try:
            from lineup import types
            types.load_all()
            t = types.get_by_name(obj_type)
            # Re-detect if DB type is generic but target matches a specific type.
            detected = types.get_for_target(target)
            if detected.priority > (t.priority if t else -1):
                t = detected
            if t is not None:
                # Only pass app override to generic types (file/folder/script).
                # Specific types (obsidian/trilium/url/zotero) have their own
                # open logic and should NOT receive default_app — it would
                # bypass their URI/AppleScript mechanism.
                if t.priority > 0:
                    # Specific type — use its native open, ignore default_app
                    type_cmd = t.open_command(target, app)  # only explicit user override
                else:
                    # Generic type — default_app is the user's chosen app
                    effective_app = app or obj["default_app"]
                    type_cmd = t.open_command(target, effective_app)
        except (ImportError, Exception):
            pass

        if type_cmd:
            try:
                subprocess.Popen(type_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return f"已打开 \"{name}\"：{pretty_target(target)}"
            except Exception as e:
                return f"打开失败：{e}"

        # 2. Fallback: plugin open command (legacy — obsidian/trilium until Phase 2)
        plugin_cmd = None
        if not app:
            try:
                from lineup import plugins
                plugin_cmd = plugins.open_command(target)
            except (ImportError, Exception):
                pass

        if plugin_cmd:
            try:
                subprocess.run(plugin_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return f"已打开 \"{name}\"：{pretty_target(target)}"
            except Exception as e:
                return f"打开失败：{e}"

        # 3. Fallback: ask plugins for default app, then macOS open
        effective_app = app or obj["default_app"]
        if not effective_app:
            try:
                from lineup import plugins
                effective_app = plugins.default_app_for(target)
            except (ImportError, Exception):
                pass

        try:
            if effective_app:
                subprocess.Popen(["open", "-a", effective_app, target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                subprocess.Popen(["open", target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return f"已打开 \"{name}\"：{pretty_target(target)}" + (f"（使用 {effective_app}）" if effective_app else "")
        except Exception as e:
            return f"打开失败：{e}"
    finally:
        conn.close()


def delete_project(name: str) -> str:
    """Delete a project and all its data (objects, todos, parent links). Does NOT delete sub-projects."""
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()
        if not row:
            return f"错误：项目 \"{name}\" 不存在"

        pid = row["id"]
        conn.execute("DELETE FROM objects WHERE project_id = ?", (pid,))
        conn.execute("DELETE FROM todos WHERE project_id = ?", (pid,))
        conn.execute("DELETE FROM project_parents WHERE project_id = ? OR parent_id = ?", (pid, pid))
        conn.execute("DELETE FROM projects WHERE id = ?", (pid,))
        conn.commit()

        # If this was the current project, clear it
        cur = get_current_project()
        if cur and cur["id"] == pid:
            set_current_project(None)

        return f"已删除项目 \"{name}\""
    finally:
        conn.close()


def remove_object(name: str, project: str | None = None) -> str:
    """Remove an object link from a project (does NOT delete the source file)."""
    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved

    conn = get_db()
    try:
        obj = conn.execute(
            "SELECT id, target FROM objects WHERE project_id = ? AND name = ?",
            (project_id, name),
        ).fetchone()
        if not obj:
            return f"错误：项目 \"{project_name}\" 中找不到 \"{name}\""

        conn.execute("DELETE FROM objects WHERE id = ?", (obj["id"],))
        conn.commit()
        return f"已从项目 \"{project_name}\" 中移除 \"{name}\"（源文件未删除）"
    finally:
        conn.close()


# ── Todo ─────────────────────────────────────────────────────────────────

def todo_add(text: str, due_date: str | None = None, remind_date: str | None = None, project: str | None = None) -> str:
    """Add a todo item to a project."""
    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved

    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO todos (project_id, text, due_date, remind_date) VALUES (?, ?, ?, ?)",
            (project_id, text, due_date, remind_date),
        )
        conn.commit()
        msg = f"已添加待办：\"{text}\"（项目：{project_name}）"
        if due_date:
            msg += f"\n截止日期：{due_date}"
        if remind_date:
            msg += f"\n提醒日期：{remind_date}"
        return msg
    finally:
        conn.close()


def todo_done(text: str, project: str | None = None) -> str:
    """Mark a todo item as done. Matches by substring."""
    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved

    conn = get_db()
    try:
        # Try exact match first, then substring
        todo = conn.execute(
            "SELECT id, text FROM todos WHERE project_id = ? AND done = 0 AND text = ?",
            (project_id, text),
        ).fetchone()
        if not todo:
            todo = conn.execute(
                "SELECT id, text FROM todos WHERE project_id = ? AND done = 0 AND text LIKE ?",
                (project_id, f"%{text}%"),
            ).fetchone()
        if not todo:
            # Also search in sub-projects
            sub_ids = _get_all_descendant_ids(conn, project_id)
            for sid in sub_ids:
                todo = conn.execute(
                    "SELECT id, text FROM todos WHERE project_id = ? AND done = 0 AND text LIKE ?",
                    (sid, f"%{text}%"),
                ).fetchone()
                if todo:
                    break
        if not todo:
            return f"错误：找不到匹配 \"{text}\" 的未完成待办"

        conn.execute("UPDATE todos SET done = 1 WHERE id = ?", (todo["id"],))
        conn.commit()
        return f"已完成：\"{todo['text']}\""
    finally:
        conn.close()


def _get_all_descendant_ids(conn: sqlite3.Connection, project_id: int) -> list[int]:
    """Get all descendant project IDs recursively."""
    result = []
    queue = [project_id]
    while queue:
        pid = queue.pop(0)
        kids = conn.execute(
            "SELECT project_id FROM project_parents WHERE parent_id = ?", (pid,)
        ).fetchall()
        for k in kids:
            result.append(k["project_id"])
            queue.append(k["project_id"])
    return result


def todo_list(project: str | None = None, show_done: bool = False) -> str:
    """List todos for a project and all its sub-projects."""
    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved

    conn = get_db()
    try:
        lines = []

        def format_todos(pid: int, pname: str, indent: int = 0):
            prefix = "  " * indent
            where = "WHERE project_id = ?" if show_done else "WHERE project_id = ? AND done = 0"
            todos = conn.execute(
                f"SELECT * FROM todos {where} ORDER BY done, due_date",
                (pid,),
            ).fetchall()

            done_todos = [] if not show_done else conn.execute(
                "SELECT * FROM todos WHERE project_id = ? AND done = 1 ORDER BY due_date",
                (pid,),
            ).fetchall()

            # Get sub-projects
            kids = conn.execute(
                "SELECT p.id, p.name FROM projects p JOIN project_parents pp ON p.id = pp.project_id WHERE pp.parent_id = ?",
                (pid,),
            ).fetchall()

            has_content = len(todos) > 0 or len(kids) > 0
            if has_content:
                lines.append(f"{prefix}{pname}:")
                for t in todos:
                    check = "x" if t["done"] else " "
                    due = f"  截止: {t['due_date']}" if t["due_date"] else ""
                    remind = f"  提醒: {t['remind_date']}" if t["remind_date"] and not t["done"] else ""
                    lines.append(f"{prefix}  [{check}] {t['text']}{due}{remind}")
                for k in kids:
                    format_todos(k["id"], k["name"], indent + 1)

        format_todos(project_id, project_name)

        if not lines:
            return f"项目 \"{project_name}\" 暂无待办事项"
        return "\n".join(lines)
    finally:
        conn.close()


# ── Calendar ─────────────────────────────────────────────────────────────

def calendar_view(month: str | None = None, project: str | None = None) -> str:
    """Show a calendar view for the given month with todo due dates marked.

    month: format "YYYY-MM", defaults to current month
    If no project is specified and no current project, shows all projects' todos.
    """
    import calendar

    # Parse month
    if month:
        try:
            year, mon = map(int, month.split("-"))
        except ValueError:
            return f"错误：月份格式应为 YYYY-MM，收到 \"{month}\""
    else:
        today = datetime.now()
        year, mon = today.year, today.month

    today = datetime.now()
    today_day = today.day if today.year == year and today.month == mon else None

    conn = get_db()
    try:
        # Determine which projects to include
        resolved = _resolve_project(project)
        if isinstance(resolved, str):
            # No current project - show all projects
            all_ids = [r["id"] for r in conn.execute("SELECT id FROM projects").fetchall()]
            project_name = "所有项目"
        else:
            project_id, project_name = resolved
            all_ids = [project_id] + _get_all_descendant_ids(conn, project_id)

        if not all_ids:
            return "暂无项目"

        # Get all todos with due dates in this month
        month_prefix = f"{year:04d}-{mon:02d}"
        placeholders = ",".join("?" * len(all_ids))
        todos = conn.execute(
            f"SELECT t.text, t.due_date, t.done, p.name as project_name FROM todos t JOIN projects p ON t.project_id = p.id WHERE t.project_id IN ({placeholders}) AND t.due_date LIKE ? ORDER BY t.due_date",
            (*all_ids, f"{month_prefix}%"),
        ).fetchall()

        # Build day -> events map
        show_project = project_name == "所有项目"
        day_events: dict[int, list[str]] = {}
        for t in todos:
            try:
                day = int(t["due_date"].split("-")[2])
                if t["done"]:
                    mark = "done"
                elif show_project:
                    mark = f"{t['text']}（{t['project_name']}）"
                else:
                    mark = t["text"]
                day_events.setdefault(day, []).append(mark)
            except (IndexError, ValueError):
                pass

        # Render calendar
        cal = calendar.TextCalendar(firstweekday=0)
        month_name = calendar.month_name[mon]
        lines = [f"  {month_name} {year}  （项目：{project_name}）"]
        lines.append(" Mo Tu We Th Fr Sa Su")

        for week in cal.monthdayscalendar(year, mon):
            row = ""
            for d in week:
                if d == 0:
                    row += "   "
                elif d == today_day:
                    row += f"{d:>2}*"
                elif d in day_events and any(e != "done" for e in day_events[d]):
                    row += f"[{d:>1}]" if d < 10 else f"[{d}]"
                else:
                    row += f"{d:>3}"
            lines.append(row)

        # Show events below calendar
        event_lines = []
        for d in sorted(day_events.keys()):
            active = [e for e in day_events[d] if e != "done"]
            if active:
                for e in active:
                    event_lines.append(f"  [{d:>2}] {e}")
        if event_lines:
            lines.append("")
            lines.extend(event_lines)

        return "\n".join(lines)
    finally:
        conn.close()


# ── Progress ─────────────────────────────────────────────────────────────

def progress_set(percent: int | None, project: str | None = None, note: str | None = None) -> str:
    """Set the progress percentage for a project. Pass None or -1 to clear."""
    if percent is not None and percent == -1:
        percent = None
    if percent is not None and (percent < 0 or percent > 100):
        return "错误：进度应在 0-100 之间"

    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved

    conn = get_db()
    try:
        if note is not None:
            conn.execute("UPDATE projects SET progress = ?, progress_note = ? WHERE id = ?", (percent, note, project_id))
        else:
            conn.execute("UPDATE projects SET progress = ? WHERE id = ?", (percent, project_id))
        conn.commit()
        if percent is None:
            return f"已清除 \"{project_name}\" 的进度"
        bar = _progress_bar(percent)
        msg = f"已更新 \"{project_name}\" 进度：{bar} {percent}%"
        if note is not None:
            msg += f"  {note}"
        return msg
    finally:
        conn.close()


def progress_get(project: str | None = None) -> str:
    """Get progress for a project and all its sub-projects."""
    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved

    conn = get_db()
    try:
        lines = []

        def format_progress(pid: int, pname: str, indent: int = 0):
            p = conn.execute("SELECT progress, progress_note FROM projects WHERE id = ?", (pid,)).fetchone()
            pct = p["progress"] or 0
            bar = _progress_bar(pct)
            prefix = "  " * indent
            note = p["progress_note"] or ""
            line = f"{prefix}{pname}  {bar} {pct}%"
            if note:
                line += f"  {note}"
            lines.append(line)

            kids = conn.execute(
                "SELECT p.id, p.name FROM projects p JOIN project_parents pp ON p.id = pp.project_id WHERE pp.parent_id = ? ORDER BY p.name",
                (pid,),
            ).fetchall()
            for k in kids:
                format_progress(k["id"], k["name"], indent + 1)

        format_progress(project_id, project_name)
        return "\n".join(lines)
    finally:
        conn.close()


def _progress_bar(percent: int, width: int = 20) -> str:
    filled = round(width * percent / 100)
    return "[" + "█" * filled + "░" * (width - filled) + "]"


# ── Cross-project reference ──────────────────────────────────────────────

def link_project(name: str, parent: str) -> str:
    """Add an existing project as a sub-project of another project (cross-reference)."""
    conn = get_db()
    try:
        child = conn.execute("SELECT id, type FROM projects WHERE name = ?", (name,)).fetchone()
        if not child:
            return f"错误：项目 \"{name}\" 不存在"

        parent_row = conn.execute("SELECT id, type FROM projects WHERE name = ?", (parent,)).fetchone()
        if not parent_row:
            return f"错误：父项目 \"{parent}\" 不存在"

        if child["id"] == parent_row["id"]:
            return "错误：不能将项目设为自己的子项目"

        # Documents cannot contain projects
        if (parent_row["type"] or "project") == "document" and (child["type"] or "project") != "document":
            return f"错误：文档 \"{parent}\" 下不能放置项目，只能放置文档"

        # Check if already linked
        existing = conn.execute(
            "SELECT 1 FROM project_parents WHERE project_id = ? AND parent_id = ?",
            (child["id"], parent_row["id"]),
        ).fetchone()
        if existing:
            return f"\"{name}\" 已经是 \"{parent}\" 的子项目了"

        # Check for circular reference: parent cannot be a descendant of child
        descendants = _get_all_descendant_ids(conn, child["id"])
        if parent_row["id"] in descendants:
            return f"错误：会产生循环引用（\"{parent}\" 是 \"{name}\" 的后代项目）"

        conn.execute(
            "INSERT INTO project_parents (project_id, parent_id) VALUES (?, ?)",
            (child["id"], parent_row["id"]),
        )
        conn.commit()
        return f"已将 \"{name}\" 添加为 \"{parent}\" 的子项目（跨项目引用，数据只有一份）"
    finally:
        conn.close()


def move_project(name: str, new_parent: str | None = None) -> str:
    """Move a project to be under a new parent. Removes all old parent links.

    new_parent: target parent project name, or None to move to root.
    """
    conn = get_db()
    try:
        child = conn.execute("SELECT id, type FROM projects WHERE name = ?", (name,)).fetchone()
        if not child:
            return f"错误：项目 \"{name}\" 不存在"

        if new_parent:
            parent_row = conn.execute("SELECT id, type FROM projects WHERE name = ?", (new_parent,)).fetchone()
            if not parent_row:
                return f"错误：目标父项目 \"{new_parent}\" 不存在"
            if child["id"] == parent_row["id"]:
                return "错误：不能将项目移动到自身下面"
            # Documents cannot contain projects
            if (parent_row["type"] or "project") == "document" and (child["type"] or "project") != "document":
                return f"错误：文档 \"{new_parent}\" 下不能放置项目，只能放置文档"
            # Check circular
            descendants = _get_all_descendant_ids(conn, child["id"])
            if parent_row["id"] in descendants:
                return f"错误：会产生循环引用（\"{new_parent}\" 是 \"{name}\" 的后代项目）"

        # Remove all old parent links
        conn.execute("DELETE FROM project_parents WHERE project_id = ?", (child["id"],))

        # Add new parent link (if not moving to root)
        if new_parent:
            conn.execute(
                "INSERT INTO project_parents (project_id, parent_id) VALUES (?, ?)",
                (child["id"], parent_row["id"]),
            )
            conn.commit()
            return f"已将 \"{name}\" 移动到 \"{new_parent}\" 下面"
        else:
            conn.commit()
            return f"已将 \"{name}\" 移动到根目录"
    finally:
        conn.close()


# ── New file ─────────────────────────────────────────────────────────────

def new_file(path: str, app: str | None = None, internal: bool = False, project: str | None = None) -> str:
    """Create a new file and link it to the project.

    - If path starts with an existing linked folder name (e.g. "论文文件夹/notes.md"),
      the file is created inside that folder's real location.
    - If app is specified (e.g. "obsidian"), the file is created in that app's
      configured location.
    - If internal=True, the file is created inside ~/.lineup/files/.
    """
    resolved = _resolve_project(project)
    if isinstance(resolved, str):
        return resolved
    project_id, project_name = resolved

    conn = get_db()
    try:
        # Case 1: path references a linked folder
        parts = path.split("/", 1)
        if len(parts) == 2:
            folder_name, sub_path = parts
            obj = conn.execute(
                "SELECT target, type FROM objects WHERE project_id = ? AND name = ?",
                (project_id, folder_name),
            ).fetchone()
            if obj and obj["type"] == "folder":
                real_path = Path(obj["target"]) / sub_path
                real_path.parent.mkdir(parents=True, exist_ok=True)
                real_path.touch()
                # Auto-link the new file
                file_name = Path(sub_path).name
                link_object(str(real_path), file_name, "file", project_name)
                return f"已创建文件：{real_path}\n已自动链接到项目 \"{project_name}\""

        # Case 2: internal file
        if internal or not app:
            internal_dir = DB_DIR / "files" / str(project_id)
            internal_dir.mkdir(parents=True, exist_ok=True)
            file_name = Path(path).name
            real_path = internal_dir / file_name
            real_path.touch()
            link_object(str(real_path), file_name, "file", project_name)
            return f"已创建内部文件：{real_path}\n已自动链接到项目 \"{project_name}\""

        # Case 3: create in external app
        # For now, we support obsidian by looking for the vault
        if app.lower() == "obsidian":
            # Try common Obsidian vault locations
            vault_candidates = [
                Path.home() / "Documents" / "Obsidian",
                Path.home() / "Obsidian",
                Path.home() / "Documents" / "obsidian-vault",
            ]
            vault_path = None
            for v in vault_candidates:
                if v.exists():
                    vault_path = v
                    break
            if not vault_path:
                return "错误：找不到 Obsidian vault 目录。请手动指定路径或使用 --internal"

            file_name = Path(path).name
            real_path = vault_path / file_name
            real_path.touch()
            link_object(str(real_path), file_name, "file", project_name)
            return f"已在 Obsidian vault 中创建：{real_path}\n已自动链接到项目 \"{project_name}\""

        # Generic app: create internally and open with the app
        internal_dir = DB_DIR / "files" / str(project_id)
        internal_dir.mkdir(parents=True, exist_ok=True)
        file_name = Path(path).name
        real_path = internal_dir / file_name
        real_path.touch()
        link_object(str(real_path), file_name, "file", project_name)
        subprocess.Popen(["open", "-a", app, str(real_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return f"已创建文件：{real_path}（使用 {app} 打开）\n已自动链接到项目 \"{project_name}\""
    finally:
        conn.close()


# ── Agents ───────────────────────────────────────────────────────────────

def create_agent(
    name: str,
    session_id: str,
    project_id: int | None = None,
    folder_path: str | None = None,
    system_prompt: str = "",
) -> int:
    """Create an agent linked to EITHER a project OR a folder path.

    Returns the new agent id.
    """
    if (project_id is None) == (folder_path is None):
        raise ValueError("Exactly one of project_id or folder_path must be set")
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO agents (project_id, folder_path, name, session_id, system_prompt) "
            "VALUES (?, ?, ?, ?, ?)",
            (project_id, folder_path, name, session_id, system_prompt),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def list_agents_for_project(project_id: int) -> list[dict]:
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM agents WHERE project_id = ? ORDER BY created_at",
            (project_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def list_agents_for_folder(folder_path: str) -> list[dict]:
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM agents WHERE folder_path = ? ORDER BY created_at",
            (folder_path,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_agent(agent_id: int) -> None:
    conn = get_db()
    try:
        conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        conn.commit()
    finally:
        conn.close()


def update_agent_last_active(agent_id: int) -> None:
    conn = get_db()
    try:
        conn.execute(
            "UPDATE agents SET last_active_at = datetime('now') WHERE id = ?",
            (agent_id,),
        )
        conn.commit()
    finally:
        conn.close()
