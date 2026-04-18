"""Trilium note object type.

Handles detection, display, opening (via AppleScript desktop navigation),
and reading of Trilium notes. Targets are Trilium noteId strings
(alphanumeric, 8+ chars).

Opening uses AppleScript to activate the TriliumNext desktop app and
navigate to the note (via tab switching or Ctrl+T search). The browser
approach (localhost web UI) doesn't work because the web UI mirrors the
desktop app's state and ignores the URL hash.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from lineup.types import register
from lineup.types.base import ObjectType


# TriliumNext server address. When running on a remote Mac Mini,
# use its IP. The web UI at this address supports direct note
# navigation via URL hash (#/notes/<noteId>).
TRILIUM_SERVER = "http://localhost:37840"

TRILIUM_DATA = Path.home() / "Library" / "Application Support" / "trilium-data"
TRILIUM_DB = TRILIUM_DATA / "document.db"


def _get_db() -> sqlite3.Connection | None:
    if not TRILIUM_DB.exists():
        return None
    conn = sqlite3.connect(str(TRILIUM_DB))
    conn.row_factory = sqlite3.Row
    return conn


def _is_note_id(target: str) -> bool:
    return bool(re.match(r'^[a-zA-Z0-9_]{8,}$', target))


def _note_exists(target: str) -> bool:
    if not _is_note_id(target):
        return False
    conn = _get_db()
    if not conn:
        return False
    try:
        row = conn.execute(
            "SELECT noteId FROM notes WHERE noteId = ? AND isDeleted = 0",
            (target,),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def _note_breadcrumb(conn: sqlite3.Connection, note_id: str) -> str:
    parts: list[str] = []
    current = note_id
    for _ in range(10):
        row = conn.execute(
            "SELECT n.title, b.parentNoteId FROM notes n "
            "JOIN branches b ON n.noteId = b.noteId AND b.isDeleted = 0 "
            "WHERE n.noteId = ? AND n.isDeleted = 0 LIMIT 1",
            (current,),
        ).fetchone()
        if not row or current == "root":
            break
        parts.append(row["title"])
        current = row["parentNoteId"]
    parts.reverse()
    return "/".join(parts)


def _html_to_text(html: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", html)
    text = re.sub(r"</(p|div|li|h[1-6])>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


@register
class TriliumType(ObjectType):
    name = "trilium"
    display_label = "笔记"
    priority = 65  # above obsidian (which does filesystem checks)

    @classmethod
    def matches(cls, target: str) -> bool:
        return _note_exists(target)

    @classmethod
    def open_command(cls, target: str, app: str | None = None) -> list[str] | None:
        """Open a note in the browser via the TriliumNext server's web UI.

        Uses the remote server URL so the web UI is independent (no
        desktop state mirroring). The URL hash #/notes/<noteId> navigates
        directly to the note.
        """
        if not _is_note_id(target):
            return None
        return ["open", f"{TRILIUM_SERVER}/#root/{target}"]

    @classmethod
    def display_target(cls, target: str) -> str | None:
        if not _is_note_id(target):
            return None
        conn = _get_db()
        if not conn:
            return None
        try:
            row = conn.execute(
                "SELECT noteId FROM notes WHERE noteId = ? AND isDeleted = 0",
                (target,),
            ).fetchone()
            if not row:
                return None
            breadcrumb = _note_breadcrumb(conn, target)
            return f"trilium://{breadcrumb}"
        finally:
            conn.close()

    @classmethod
    def read(cls, target: str) -> str | None:
        if not _is_note_id(target):
            return None
        conn = _get_db()
        if not conn:
            return None
        try:
            row = conn.execute(
                "SELECT n.title, n.type, bl.content "
                "FROM notes n "
                "LEFT JOIN blobs bl ON n.blobId = bl.blobId "
                "WHERE n.noteId = ? AND n.isDeleted = 0",
                (target,),
            ).fetchone()
            if not row:
                return None

            breadcrumb = _note_breadcrumb(conn, target)
            header = f"# {row['title']}\n路径：{breadcrumb}\n\n"

            content = row["content"] or ""
            if row["type"] == "text":
                return header + _html_to_text(content)
            elif row["type"] == "code":
                return header + content
            else:
                return header + f"（{row['type']} 类型，无法显示文本内容）"
        finally:
            conn.close()

    @classmethod
    def skill_dir(cls) -> Path | None:
        d = Path(__file__).parent / "skill"
        return d if d.is_dir() else None
