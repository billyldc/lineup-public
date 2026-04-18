"""Zotero plugin for lineup — direct local SQLite access.

Mirrors the obsidian/trilium plugins: this is the *plugin* layer (browse +
search + read for the source); the per-target *type* layer lives in
lineup/types/zotero.

Hierarchy exposed by browse():
    - root (path == "")  → all top-level Zotero collections
    - collection target  → sub-collections + items in that collection
    - item target        → leaf (no children)

Targets are the standard Zotero select URIs so they round-trip through the
ObjectType layer's open_command (which just shells out to `open`):
    collection: zotero://select/library/collections/<key>
    item:       zotero://select/library/items/<key>

DB access uses the `immutable=1` URI parameter — same trick the upstream
zotero-mcp uses — so we don't conflict with Zotero's write lock when the
desktop app is running. We only read, and slightly stale data is fine.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from lineup.plugins import base, register


ZOTERO_DB = Path.home() / "Zotero" / "zotero.sqlite"

COLLECTION_PREFIX = "zotero://select/library/collections/"
ITEM_PREFIX = "zotero://select/library/items/"


def _get_db() -> sqlite3.Connection | None:
    if not ZOTERO_DB.exists():
        return None
    # immutable=1 bypasses Zotero's write lock entirely. Same pattern as
    # zotero-mcp's LocalZoteroReader._get_connection.
    uri = f"file:{ZOTERO_DB}?immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _user_library_id(conn: sqlite3.Connection) -> int:
    """Return the user library's libraryID. Used to filter out group
    libraries from browse/search results.

    Zotero's user library has type='user' and is normally libraryID=1, but
    we look it up by type to be safe.
    """
    row = conn.execute("SELECT libraryID FROM libraries WHERE type = 'user' LIMIT 1").fetchone()
    return row["libraryID"] if row else 1


def _parse_target(target: str) -> tuple[str, str] | None:
    """Parse a zotero://select/library/... URI into (kind, key)."""
    if target.startswith(COLLECTION_PREFIX):
        return ("collection", target[len(COLLECTION_PREFIX):])
    if target.startswith(ITEM_PREFIX):
        return ("item", target[len(ITEM_PREFIX):])
    return None


# Reusable SQL fragments — keep these in sync between browse() and search()
# so item rows look identical across surfaces.
_ITEM_SELECT = """
    SELECT
        i.itemID,
        i.key,
        title_val.value as title,
        GROUP_CONCAT(
            CASE
                WHEN c.lastName IS NOT NULL AND c.firstName IS NOT NULL
                THEN c.lastName || ', ' || c.firstName
                WHEN c.lastName IS NOT NULL THEN c.lastName
                ELSE NULL
            END, '; '
        ) as creators
    FROM items i
    JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
    LEFT JOIN itemData title_data ON i.itemID = title_data.itemID AND title_data.fieldID = 1
    LEFT JOIN itemDataValues title_val ON title_data.valueID = title_val.valueID
    LEFT JOIN itemCreators ic ON i.itemID = ic.itemID
    LEFT JOIN creators c ON ic.creatorID = c.creatorID
"""

_ITEM_FILTER = """
    AND it.typeName NOT IN ('attachment', 'note', 'annotation')
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
"""


def _row_to_item(row: sqlite3.Row) -> base.Item:
    title = row["title"] or "(无标题)"
    creators = row["creators"] or ""
    return base.Item(
        id=ITEM_PREFIX + row["key"],
        name=title,
        target=ITEM_PREFIX + row["key"],
        type="zotero",
        preview=creators,
    )


def _collection_id_for_key(conn: sqlite3.Connection, key: str) -> int | None:
    row = conn.execute(
        "SELECT collectionID FROM collections WHERE key = ?",
        (key,),
    ).fetchone()
    return row["collectionID"] if row else None


def collection_has_children(key: str) -> bool:
    """Quick boolean: does this Zotero collection have ANY children?

    Used by the main process's objectHasChildren() to decide whether
    clicking a zotero collection object should open a BrowseColumn.
    """
    conn = _get_db()
    if not conn:
        return False
    try:
        user_lib = _user_library_id(conn)
        # The collection itself must live in the user library — group library
        # collections are skipped.
        row = conn.execute(
            "SELECT collectionID FROM collections WHERE key = ? AND libraryID = ?",
            (key, user_lib),
        ).fetchone()
        if not row:
            return False
        cid = row["collectionID"]
        # Sub-collections
        sub = conn.execute(
            """
            SELECT 1 FROM collections
            WHERE parentCollectionID = ?
              AND collectionID NOT IN (SELECT collectionID FROM deletedCollections)
            LIMIT 1
            """,
            (cid,),
        ).fetchone()
        if sub:
            return True
        # Items
        itm = conn.execute(
            """
            SELECT 1 FROM collectionItems ci
            JOIN items i ON ci.itemID = i.itemID
            JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
            WHERE ci.collectionID = ?
              AND it.typeName NOT IN ('attachment', 'note', 'annotation')
              AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            LIMIT 1
            """,
            (cid,),
        ).fetchone()
        return itm is not None
    finally:
        conn.close()


class ZoteroPlugin(base.Plugin):
    name = "zotero"
    description = "Zotero library (local SQLite, read-only)"

    def search(self, query: str, limit: int = 10) -> list[base.Item]:
        """Search Zotero items by title (case-insensitive substring).

        Restricted to the user library — group library items are excluded.
        """
        conn = _get_db()
        if not conn:
            return []
        try:
            user_lib = _user_library_id(conn)
            pattern = f"%{query}%"
            sql = _ITEM_SELECT + (
                "WHERE i.libraryID = ? "
                "AND title_val.value LIKE ? "
                + _ITEM_FILTER
                + " GROUP BY i.itemID"
                + " ORDER BY i.dateModified DESC"
                + " LIMIT ?"
            )
            rows = conn.execute(sql, (user_lib, pattern, limit)).fetchall()
            return [_row_to_item(r) for r in rows]
        finally:
            conn.close()

    def browse(self, path: str = "") -> list[base.Item]:
        """Browse Zotero hierarchy.

        path is one of:
            "" (or just COLLECTION_PREFIX) → top-level collections (user lib)
            zotero://select/library/collections/<key> → sub-collections + items
            zotero://select/library/items/<key>       → leaf, returns []

        Group libraries are intentionally excluded for now — only the user
        library is shown.
        """
        conn = _get_db()
        if not conn:
            return []
        try:
            user_lib = _user_library_id(conn)
            parsed = _parse_target(path) if path else None

            if parsed is None:
                # Root: top-level collections of the user library only
                collection_id: int | None = None
            else:
                kind, key = parsed
                if kind == "item":
                    return []  # leaves don't have children
                # Resolve key → collectionID, but only if it's in the user lib
                row = conn.execute(
                    "SELECT collectionID FROM collections WHERE key = ? AND libraryID = ?",
                    (key, user_lib),
                ).fetchone()
                if not row:
                    return []
                collection_id = row["collectionID"]

            items: list[base.Item] = []

            # 1) sub-collections
            if collection_id is None:
                sub_rows = conn.execute(
                    """
                    SELECT c.collectionID, c.key, c.collectionName,
                           ((SELECT COUNT(*) FROM collections sc
                             WHERE sc.parentCollectionID = c.collectionID
                             AND sc.collectionID NOT IN (SELECT collectionID FROM deletedCollections))
                           +
                           (SELECT COUNT(*) FROM collectionItems ci
                            JOIN items i ON ci.itemID = i.itemID
                            JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
                            WHERE ci.collectionID = c.collectionID
                              AND it.typeName NOT IN ('attachment', 'note', 'annotation')
                              AND i.itemID NOT IN (SELECT itemID FROM deletedItems))
                           ) as child_count
                    FROM collections c
                    WHERE c.parentCollectionID IS NULL
                      AND c.libraryID = ?
                      AND c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)
                    ORDER BY c.collectionName COLLATE NOCASE
                    """,
                    (user_lib,),
                ).fetchall()
            else:
                sub_rows = conn.execute(
                    """
                    SELECT c.collectionID, c.key, c.collectionName,
                           ((SELECT COUNT(*) FROM collections sc
                             WHERE sc.parentCollectionID = c.collectionID
                             AND sc.collectionID NOT IN (SELECT collectionID FROM deletedCollections))
                           +
                           (SELECT COUNT(*) FROM collectionItems ci
                            JOIN items i ON ci.itemID = i.itemID
                            JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
                            WHERE ci.collectionID = c.collectionID
                              AND it.typeName NOT IN ('attachment', 'note', 'annotation')
                              AND i.itemID NOT IN (SELECT itemID FROM deletedItems))
                           ) as child_count
                    FROM collections c
                    WHERE c.parentCollectionID = ?
                      AND c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)
                    ORDER BY c.collectionName COLLATE NOCASE
                    """,
                    (collection_id,),
                ).fetchall()

            for r in sub_rows:
                cnt = r["child_count"] or 0
                items.append(base.Item(
                    id=COLLECTION_PREFIX + r["key"],
                    name=f"{r['collectionName']}/",
                    target=COLLECTION_PREFIX + r["key"],
                    type="zotero",
                    preview=f"({cnt} 项)" if cnt else "(空)",
                ))

            # 2) items in this collection (only when browsing inside one)
            if collection_id is not None:
                sql = _ITEM_SELECT + (
                    "JOIN collectionItems ci ON i.itemID = ci.itemID "
                    "WHERE ci.collectionID = ? "
                    + _ITEM_FILTER
                    + " GROUP BY i.itemID"
                    + " ORDER BY title_val.value COLLATE NOCASE"
                )
                item_rows = conn.execute(sql, (collection_id,)).fetchall()
                items.extend(_row_to_item(r) for r in item_rows)

            return items
        finally:
            conn.close()

    def read(self, item_id: str) -> str:
        """Read item metadata as plain text for AI context."""
        # Accept either a bare key or a full URI
        parsed = _parse_target(item_id)
        if parsed:
            kind, key = parsed
        else:
            kind, key = ("item", item_id)
        if kind != "item":
            return f"(集合 {key} 没有可读内容)"

        conn = _get_db()
        if not conn:
            return "错误：Zotero 数据库不存在"
        try:
            row = conn.execute(
                """
                SELECT
                    i.itemID,
                    title_val.value as title,
                    abstract_val.value as abstract,
                    extra_val.value as extra,
                    doi_val.value as doi,
                    GROUP_CONCAT(
                        CASE
                            WHEN c.lastName IS NOT NULL AND c.firstName IS NOT NULL
                            THEN c.lastName || ', ' || c.firstName
                            WHEN c.lastName IS NOT NULL THEN c.lastName
                            ELSE NULL
                        END, '; '
                    ) as creators
                FROM items i
                LEFT JOIN itemData title_data ON i.itemID = title_data.itemID AND title_data.fieldID = 1
                LEFT JOIN itemDataValues title_val ON title_data.valueID = title_val.valueID
                LEFT JOIN itemData abstract_data ON i.itemID = abstract_data.itemID AND abstract_data.fieldID = 2
                LEFT JOIN itemDataValues abstract_val ON abstract_data.valueID = abstract_val.valueID
                LEFT JOIN itemData extra_data ON i.itemID = extra_data.itemID AND extra_data.fieldID = 16
                LEFT JOIN itemDataValues extra_val ON extra_data.valueID = extra_val.valueID
                LEFT JOIN fields doi_f ON doi_f.fieldName = 'DOI'
                LEFT JOIN itemData doi_data ON i.itemID = doi_data.itemID AND doi_data.fieldID = doi_f.fieldID
                LEFT JOIN itemDataValues doi_val ON doi_data.valueID = doi_val.valueID
                LEFT JOIN itemCreators ic ON i.itemID = ic.itemID
                LEFT JOIN creators c ON ic.creatorID = c.creatorID
                WHERE i.key = ?
                GROUP BY i.itemID
                """,
                (key,),
            ).fetchone()
            if not row:
                return f"错误：找不到 Zotero 条目 {key}"

            parts: list[str] = [f"# {row['title'] or '(无标题)'}"]
            if row["creators"]:
                parts.append(f"作者：{row['creators']}")
            if row["doi"]:
                parts.append(f"DOI：{row['doi']}")
            if row["abstract"]:
                parts.append(f"\n## 摘要\n\n{row['abstract']}")
            if row["extra"]:
                parts.append(f"\n## 附加\n\n{row['extra']}")
            return "\n".join(parts)
        finally:
            conn.close()

    def display_target(self, target: str) -> str | None:
        # zotero:// URIs are already pretty enough
        if target.startswith("zotero://"):
            return target
        return None

    def open_command(self, target: str) -> list[str] | None:
        if target.startswith("zotero://"):
            return ["open", target]
        return None


_plugin = ZoteroPlugin()
register(_plugin)
