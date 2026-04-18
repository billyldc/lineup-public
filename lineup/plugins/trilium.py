"""Trilium Notes plugin for lineup - reads local SQLite database directly.

This plugin handles the 'knowledge source' side of Trilium: searching,
reading, and browsing notes. The 'object type' side (detection, opening
via AppleScript, display path) has been extracted to lineup.types.trilium
and is now handled by the type registry.
"""

import json
import re
from pathlib import Path

from lineup.plugins import base, register
from lineup.types.trilium.type import (
    _get_db,
    _html_to_text,
    _note_breadcrumb,
)


class TriliumPlugin(base.Plugin):
    name = "trilium"
    description = "Trilium Notes integration (local SQLite)"

    def search(self, query: str, limit: int = 10) -> list[base.Item]:
        conn = _get_db()
        if not conn:
            return []
        try:
            query_lower = query.lower()
            # Search by title (weighted higher), then by content
            results: list[tuple[int, base.Item]] = []

            # Title match
            rows = conn.execute(
                "SELECT n.noteId, n.title, n.type, n.blobId "
                "FROM notes n WHERE n.isDeleted = 0 AND n.title LIKE ? "
                "ORDER BY n.dateModified DESC LIMIT ?",
                (f"%{query}%", limit * 3),
            ).fetchall()
            seen = set()
            for r in rows:
                if r["noteId"] in seen:
                    continue
                seen.add(r["noteId"])
                preview = ""
                if r["blobId"]:
                    blob = conn.execute(
                        "SELECT substr(content, 1, 200) as preview FROM blobs WHERE blobId = ?",
                        (r["blobId"],),
                    ).fetchone()
                    if blob and blob["preview"]:
                        preview = _html_to_text(blob["preview"])[:100]

                breadcrumb = _note_breadcrumb(conn, r["noteId"])
                results.append((10, base.Item(
                    id=r["noteId"],
                    name=r["title"],
                    target=r["noteId"],
                    type="trilium",
                    preview=f"{breadcrumb}  {preview}" if preview else breadcrumb,
                )))

            # Content match (only if we need more results)
            if len(results) < limit:
                content_rows = conn.execute(
                    "SELECT n.noteId, n.title, n.blobId "
                    "FROM notes n "
                    "JOIN blobs bl ON n.blobId = bl.blobId "
                    "WHERE n.isDeleted = 0 AND n.type = 'text' "
                    "AND bl.content LIKE ? "
                    "ORDER BY n.dateModified DESC LIMIT ?",
                    (f"%{query}%", limit * 2),
                ).fetchall()
                for r in content_rows:
                    if r["noteId"] in seen:
                        continue
                    seen.add(r["noteId"])
                    preview = ""
                    if r["blobId"]:
                        blob = conn.execute(
                            "SELECT substr(content, 1, 200) as preview FROM blobs WHERE blobId = ?",
                            (r["blobId"],),
                        ).fetchone()
                        if blob and blob["preview"]:
                            preview = _html_to_text(blob["preview"])[:100]
                    breadcrumb = _note_breadcrumb(conn, r["noteId"])
                    results.append((1, base.Item(
                        id=r["noteId"],
                        name=r["title"],
                        target=r["noteId"],
                        type="trilium",
                        preview=f"{breadcrumb}  {preview}" if preview else breadcrumb,
                    )))

            results.sort(key=lambda x: -x[0])
            return [item for _, item in results[:limit]]
        finally:
            conn.close()

    def read(self, item_id: str) -> str:
        """Read a note's content as plain text."""
        conn = _get_db()
        if not conn:
            return "错误：Trilium 数据库不存在"
        try:
            row = conn.execute(
                "SELECT n.title, n.type, bl.content "
                "FROM notes n "
                "LEFT JOIN blobs bl ON n.blobId = bl.blobId "
                "WHERE n.noteId = ? AND n.isDeleted = 0",
                (item_id,),
            ).fetchone()
            if not row:
                return f"错误：笔记 {item_id} 不存在"

            breadcrumb = _note_breadcrumb(conn, item_id)
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

    def browse(self, path: str = "") -> list[base.Item]:
        """Browse Trilium note tree. path is a noteId (default: root's children)."""
        conn = _get_db()
        if not conn:
            return []
        try:
            parent_id = path or "root"
            rows = conn.execute(
                "SELECT n.noteId, n.title, n.type, "
                "(SELECT COUNT(*) FROM branches cb WHERE cb.parentNoteId = n.noteId AND cb.isDeleted = 0) as child_count "
                "FROM notes n "
                "JOIN branches b ON n.noteId = b.noteId AND b.isDeleted = 0 "
                "WHERE b.parentNoteId = ? AND n.isDeleted = 0 "
                "ORDER BY b.notePosition",
                (parent_id,),
            ).fetchall()

            items = []
            for r in rows:
                # Skip system notes
                if r["type"] == "launcher":
                    continue
                has_children = r["child_count"] > 0
                items.append(base.Item(
                    id=r["noteId"],
                    name=f"{r['title']}/" if has_children else r["title"],
                    target=r["noteId"],
                    type="trilium",
                    preview=f"({r['child_count']} 子笔记)" if has_children else "",
                ))
            return items
        finally:
            conn.close()

    # display_target and open_command have been extracted to
    # lineup.types.trilium.TriliumType. Delegating stubs are kept so the
    # old plugin interface doesn't break if something still calls through it.

    def display_target(self, target: str) -> str | None:
        from lineup.types.trilium.type import TriliumType
        return TriliumType.display_target(target)

    def open_command(self, target: str) -> list[str] | None:
        from lineup.types.trilium.type import TriliumType
        return TriliumType.open_command(target)


# Auto-register
_plugin = TriliumPlugin()
register(_plugin)
