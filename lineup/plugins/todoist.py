"""Todoist integration: sync Todoist projects/tasks into lineup.

Project sync is the first piece. Task triage and completion-sync are
planned but not implemented here yet.

This module is intentionally NOT a `Plugin` subclass — the plugin base
is for knowledge sources (Obsidian, Trilium) that surface objects, while
this is a sync layer between two project-management systems.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass

from lineup import store


# Default skips: Inbox is conceptually the inbox feeder, lineup shouldn't
# create a project for it.
DEFAULT_SKIP_NAMES = {"Inbox", "收件箱"}


class TodoistError(RuntimeError):
    pass


def is_available() -> bool:
    """Whether the `td` CLI is on PATH."""
    return shutil.which("td") is not None


@dataclass(frozen=True)
class TodoistProject:
    id: str
    name: str
    parent_id: str | None
    url: str

    @property
    def is_inbox(self) -> bool:
        return self.name in DEFAULT_SKIP_NAMES


def fetch_projects() -> list[TodoistProject]:
    """Fetch all Todoist projects via `td project list --json`."""
    if not is_available():
        raise TodoistError(
            "找不到 td 命令。请先：npm install -g @doist/todoist-cli && td auth login"
        )

    result = subprocess.run(
        ["td", "project", "list", "--json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise TodoistError(f"td project list 失败：{result.stderr.strip()}")

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise TodoistError(f"无法解析 td 输出：{e}") from e

    raw = payload.get("results", payload) if isinstance(payload, dict) else payload
    out: list[TodoistProject] = []
    for p in raw:
        out.append(
            TodoistProject(
                id=str(p.get("id", "")),
                name=p.get("name", ""),
                parent_id=p.get("parentId"),
                url=p.get("url", ""),
            )
        )
    return out


# ── Sync planning ───────────────────────────────────────────────────────────


@dataclass
class SyncAction:
    """One step in a sync plan.

    kind values:
      "skip"           — Inbox or user-skipped, do nothing
      "already-linked" — lineup project is already linked to this Todoist project
                          (names may differ — that's allowed and intentional)
      "link"           — name match between an unlinked lineup project and a Todoist
                          project → set todoist_project_id (no new project created)
      "create"         — no match anywhere → would create a new lineup project
                          (only applied when --create-missing is set)
    """

    kind: str
    todoist: TodoistProject
    lineup_id: int | None = None
    lineup_name: str | None = None
    note: str = ""


def plan_sync(
    todoist_projects: list[TodoistProject],
    *,
    extra_skip: set[str] | None = None,
) -> list[SyncAction]:
    """Compute what would happen if we synced these Todoist projects into lineup.

    Pure read; does not mutate the database.
    """
    skip = set(DEFAULT_SKIP_NAMES) | (extra_skip or set())

    conn = store.get_db()
    try:
        rows = conn.execute(
            "SELECT id, name, todoist_project_id FROM projects"
        ).fetchall()
    finally:
        conn.close()

    by_tid: dict[str, dict] = {}
    by_name: dict[str, dict] = {}
    for r in rows:
        d = {"id": r["id"], "name": r["name"], "todoist_project_id": r["todoist_project_id"]}
        if d["todoist_project_id"]:
            by_tid[d["todoist_project_id"]] = d
        by_name[d["name"]] = d

    actions: list[SyncAction] = []
    for tp in todoist_projects:
        if tp.name in skip:
            actions.append(SyncAction("skip", tp, note="Inbox/skipped"))
            continue

        existing = by_tid.get(tp.id)
        if existing is not None:
            note = (
                f"names differ: lineup「{existing['name']}」"
                if existing["name"] != tp.name
                else ""
            )
            actions.append(
                SyncAction(
                    "already-linked",
                    tp,
                    lineup_id=existing["id"],
                    lineup_name=existing["name"],
                    note=note,
                )
            )
            continue

        existing_by_name = by_name.get(tp.name)
        if existing_by_name is not None and not existing_by_name["todoist_project_id"]:
            actions.append(
                SyncAction(
                    "link",
                    tp,
                    lineup_id=existing_by_name["id"],
                    lineup_name=existing_by_name["name"],
                    note="name match",
                )
            )
            continue

        actions.append(SyncAction("create", tp, lineup_name=tp.name))

    return actions


# ── Sync application ───────────────────────────────────────────────────────


@dataclass
class SyncSummary:
    linked: int = 0
    created: int = 0
    create_skipped: int = 0
    skipped: int = 0
    already: int = 0


# ── Manual link/unlink ─────────────────────────────────────────────────────


def link_project(todoist_ref: str, lineup_name: str) -> str:
    """Manually link an existing lineup project to a Todoist project.

    todoist_ref: Todoist project name, or `id:xxxxx`.
    lineup_name: lineup project name (must already exist).
    """
    todoist_projects = fetch_projects()

    if todoist_ref.startswith("id:"):
        tid = todoist_ref[3:]
        match = next((p for p in todoist_projects if p.id == tid), None)
        if match is None:
            return f"错误：找不到 Todoist 项目 id={tid}"
    else:
        candidates = [p for p in todoist_projects if p.name == todoist_ref]
        if not candidates:
            return f"错误：找不到 Todoist 项目「{todoist_ref}」"
        if len(candidates) > 1:
            ids = ", ".join(c.id for c in candidates)
            return f"错误：Todoist 中有多个同名项目「{todoist_ref}」({ids})。请用 id:xxx 指定"
        match = candidates[0]

    conn = store.get_db()
    try:
        row = conn.execute(
            "SELECT id, name, todoist_project_id FROM projects WHERE name = ?",
            (lineup_name,),
        ).fetchone()
        if row is None:
            return f"错误：lineup 中找不到项目「{lineup_name}」"
        if row["todoist_project_id"] == match.id:
            return f"已经链接过了：lineup #{row['id']}「{row['name']}」↔ Todoist「{match.name}」"
        if row["todoist_project_id"]:
            return (
                f"错误：lineup 项目「{row['name']}」已经链接到另一个 Todoist 项目"
                f"（id={row['todoist_project_id']}）。如要替换请先 unlink"
            )

        other = conn.execute(
            "SELECT id, name FROM projects WHERE todoist_project_id = ?",
            (match.id,),
        ).fetchone()
        if other:
            return (
                f"错误：Todoist 项目「{match.name}」已经被 lineup #{other['id']}"
                f"「{other['name']}」占用。请先 unlink 那个"
            )

        conn.execute(
            "UPDATE projects SET todoist_project_id = ? WHERE id = ?",
            (match.id, row["id"]),
        )
        conn.commit()
        return f"已链接：lineup #{row['id']}「{row['name']}」↔ Todoist「{match.name}」"
    finally:
        conn.close()


def unlink_project(lineup_name: str) -> str:
    """Remove the Todoist link from a lineup project (lineup project itself stays)."""
    conn = store.get_db()
    try:
        row = conn.execute(
            "SELECT id, name, todoist_project_id FROM projects WHERE name = ?",
            (lineup_name,),
        ).fetchone()
        if row is None:
            return f"错误：lineup 中找不到项目「{lineup_name}」"
        if not row["todoist_project_id"]:
            return f"lineup 项目「{row['name']}」未链接到任何 Todoist 项目"
        old = row["todoist_project_id"]
        conn.execute(
            "UPDATE projects SET todoist_project_id = NULL WHERE id = ?",
            (row["id"],),
        )
        conn.commit()
        return f"已解除链接：lineup #{row['id']}「{row['name']}」 (was todoist:{old})"
    finally:
        conn.close()


def apply_sync(actions: list[SyncAction], *, create_missing: bool) -> SyncSummary:
    """Apply a sync plan. Mutating.

    create_missing: if False, "create" actions are skipped (counted in
    create_skipped). This makes it safe to dry-run, then apply, then
    later opt in to creation.
    """
    summary = SyncSummary()
    conn = store.get_db()
    try:
        for a in actions:
            if a.kind == "skip":
                summary.skipped += 1
            elif a.kind == "already-linked":
                summary.already += 1
            elif a.kind == "link":
                conn.execute(
                    "UPDATE projects SET todoist_project_id = ? WHERE id = ?",
                    (a.todoist.id, a.lineup_id),
                )
                summary.linked += 1
            elif a.kind == "create":
                if not create_missing:
                    summary.create_skipped += 1
                    continue
                conn.execute(
                    "INSERT INTO projects (name, type, priority, todoist_project_id) "
                    "VALUES (?, 'project', 3, ?)",
                    (a.todoist.name, a.todoist.id),
                )
                summary.created += 1
        conn.commit()
    finally:
        conn.close()
    return summary
