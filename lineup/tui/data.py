"""Read-side queries for the TUI.

The existing `lineup.store` module returns formatted strings meant for the CLI.
The TUI needs structured rows, so this module wraps the same SQLite database
with small dataclasses. Writes still go through `lineup.store` so that the CLI,
MCP server, and TUI stay in sync.
"""

from dataclasses import dataclass
from lineup import store


@dataclass(frozen=True)
class ProjectRow:
    id: int
    name: str
    type: str
    description: str
    priority: int
    progress: int
    progress_note: str
    open_count: int


@dataclass(frozen=True)
class ObjectRow:
    id: int
    name: str
    target: str
    type: str
    default_app: str | None
    open_count: int


@dataclass(frozen=True)
class TodoRow:
    id: int
    text: str
    due_date: str | None
    done: bool


def _row_to_project(r) -> ProjectRow:
    return ProjectRow(
        id=r["id"],
        name=r["name"],
        type=r["type"] or "project",
        description=r["description"] or "",
        priority=r["priority"] or 0,
        progress=r["progress"] or 0,
        progress_note=r["progress_note"] or "",
        open_count=r["open_count"] or 0,
    )


def list_root_projects() -> list[ProjectRow]:
    """All top-level projects (no parent), sorted by priority desc then name."""
    conn = store.get_db()
    try:
        rows = conn.execute(
            """
            SELECT p.* FROM projects p
            WHERE (p.type IS NULL OR p.type != 'document')
              AND NOT EXISTS (
                  SELECT 1 FROM project_parents pp WHERE pp.project_id = p.id
              )
            ORDER BY p.priority DESC, p.name
            """
        ).fetchall()
        return [_row_to_project(r) for r in rows]
    finally:
        conn.close()


def get_project(project_id: int) -> ProjectRow | None:
    conn = store.get_db()
    try:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return _row_to_project(row) if row else None
    finally:
        conn.close()


def list_sub_projects(project_id: int) -> list[ProjectRow]:
    """Direct sub-projects, sorted by open count (most-used first).

    Sub-projects are conceptually folders in the same flat list as objects
    in the TUI; they need a comparable ordering, so open_count beats
    priority here.
    """
    conn = store.get_db()
    try:
        rows = conn.execute(
            """
            SELECT p.* FROM projects p
            JOIN project_parents pp ON p.id = pp.project_id
            WHERE pp.parent_id = ?
            ORDER BY p.open_count DESC, p.name
            """,
            (project_id,),
        ).fetchall()
        return [_row_to_project(r) for r in rows]
    finally:
        conn.close()


def list_objects(project_id: int) -> list[ObjectRow]:
    """Objects for a project, sorted by open count (most-used first)."""
    conn = store.get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM objects WHERE project_id = ? ORDER BY open_count DESC, name",
            (project_id,),
        ).fetchall()
        return [
            ObjectRow(
                id=r["id"],
                name=r["name"],
                target=r["target"],
                type=r["type"],
                default_app=r["default_app"],
                open_count=r["open_count"] or 0,
            )
            for r in rows
        ]
    finally:
        conn.close()


def list_todos(project_id: int, include_done: bool = False) -> list[TodoRow]:
    conn = store.get_db()
    try:
        if include_done:
            rows = conn.execute(
                "SELECT * FROM todos WHERE project_id = ? ORDER BY done, due_date",
                (project_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM todos WHERE project_id = ? AND done = 0 ORDER BY due_date",
                (project_id,),
            ).fetchall()
        return [
            TodoRow(
                id=r["id"],
                text=r["text"],
                due_date=r["due_date"],
                done=bool(r["done"]),
            )
            for r in rows
        ]
    finally:
        conn.close()
