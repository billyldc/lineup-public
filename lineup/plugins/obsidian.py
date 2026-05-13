"""Obsidian vault plugin for lineup.

This plugin handles the 'knowledge source' side of Obsidian: searching,
reading, and browsing notes. The 'object type' side (detection, opening
via obsidian:// URI, display path) has been extracted to
lineup.types.obsidian and is now handled by the type registry.
"""

from pathlib import Path

from lineup.plugins import base, register
from lineup.types.obsidian.type import find_vaults


class ObsidianPlugin(base.Plugin):
    name = "obsidian"
    description = "Obsidian vault integration"

    def __init__(self):
        self.vaults = find_vaults()

    def _all_notes(self) -> list[Path]:
        """Get all markdown files across all vaults, deduplicated."""
        seen: set[str] = set()
        notes = []
        for vault in self.vaults:
            for md in vault.rglob("*.md"):
                # skip hidden dirs and .obsidian
                parts = md.relative_to(vault).parts
                if any(p.startswith(".") for p in parts):
                    continue
                key = str(md.resolve())
                if key not in seen:
                    seen.add(key)
                    notes.append(md)
        return notes

    def search(self, query: str, limit: int = 10) -> list[base.Item]:
        """Search notes by filename/path (fuzzy).

        Fuzzy matching works like Alfred / VSCode / Sublime: the query
        characters must appear in the candidate in order, not necessarily
        contiguous. "fcs26" matches "FOCS26-paper221".

        Content search is intentionally NOT done here: vaults with thousands
        of notes would trigger thousands of synchronous file reads, hanging
        the MCP call. Users who want content search can use Obsidian's own
        full-text search.
        """
        from lineup.plugins._fuzzy import fuzzy_score

        query_lower = query.lower()
        scored: list[tuple[int, Path]] = []

        for note in self._all_notes():
            rel = str(note.relative_to(self._vault_of(note)))
            name_score = fuzzy_score(query_lower, note.stem.lower())
            rel_score = fuzzy_score(query_lower, rel.lower())
            score = max(name_score * 10, rel_score * 5)
            if score > 0:
                scored.append((score, note))

        scored.sort(key=lambda x: -x[0])
        top = scored[:limit]

        # Read first-line preview only for the top-N final results — not for
        # every fuzzy match (can be hundreds) or every note (can be thousands).
        results: list[base.Item] = []
        for score, note in top:
            preview = ""
            try:
                with open(note, "r", errors="ignore") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("---"):
                            preview = line[:100]
                            break
            except OSError:
                pass
            results.append(base.Item(
                id=str(note),
                name=note.stem,
                target=str(note),
                type="obsidian",
                default_app="Obsidian",
                preview=preview,
            ))
        return results

    def read(self, item_id: str) -> str:
        """Read a note's content."""
        p = Path(item_id)
        if not p.exists():
            return f"错误：文件不存在 {item_id}"
        try:
            return p.read_text(errors="ignore")
        except OSError as e:
            return f"读取失败：{e}"

    def browse(self, path: str = "") -> list[base.Item]:
        """Browse vault structure.

        - If path is empty: list top-level entries of all vaults, but skip
          nested vaults (the inner vault would otherwise be re-listed again
          when the user drills into the outer vault's folder of the same path).
        - If path is an absolute path (what the frontend passes as an `id`),
          only list the contents of THAT directory. Don't re-walk all vaults,
          otherwise nested vaults produce duplicate entries.
        """
        items = []
        seen: set[str] = set()

        if not path:
            # Root: merge top-level entries from all vaults.
            vault_set = {str(v.resolve()) for v in self.vaults}
            for vault in self.vaults:
                if not vault.exists():
                    continue
                for entry in sorted(vault.iterdir()):
                    if entry.name.startswith("."):
                        continue
                    # Skip entries that are themselves vault roots so nested
                    # vaults don't duplicate when drilling into the outer one.
                    if str(entry.resolve()) in vault_set:
                        continue
                    key = str(entry.resolve())
                    if key in seen:
                        continue
                    seen.add(key)
                    if entry.is_dir():
                        items.append(base.Item(
                            id=str(entry),
                            name=f"{entry.name}/",
                            target=str(entry),
                            type="folder",
                            default_app="Obsidian",
                        ))
                    elif entry.suffix == ".md":
                        items.append(base.Item(
                            id=str(entry),
                            name=entry.stem,
                            target=str(entry),
                            type="obsidian",
                            default_app="Obsidian",
                        ))
                    elif entry.suffix.lower() == ".pdf":
                        # PDFs can live inside obsidian vaults too. Show them
                        # as file type (default app), not obsidian.
                        items.append(base.Item(
                            id=str(entry),
                            name=entry.name,
                            target=str(entry),
                            type="file",
                        ))
            return items

        # Non-empty path: list exactly that directory.
        browse_root = Path(path)
        if not browse_root.exists() or not browse_root.is_dir():
            return []
        for entry in sorted(browse_root.iterdir()):
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                items.append(base.Item(
                    id=str(entry),
                    name=f"{entry.name}/",
                    target=str(entry),
                    type="folder",
                    default_app="Obsidian",
                ))
            elif entry.suffix == ".md":
                items.append(base.Item(
                    id=str(entry),
                    name=entry.stem,
                    target=str(entry),
                    type="obsidian",
                    default_app="Obsidian",
                ))
            elif entry.suffix.lower() == ".pdf":
                items.append(base.Item(
                    id=str(entry),
                    name=entry.name,
                    target=str(entry),
                    type="file",
                ))
        return items

    def list_vaults(self) -> list[dict]:
        """List detected vaults."""
        return [{"path": str(v), "name": v.name} for v in self.vaults]

    # open_command, default_app_for, display_target have been extracted to
    # lineup.types.obsidian.ObsidianType. The plugin no longer needs them —
    # store.py queries the type registry first, falling back to plugins only
    # for types not yet migrated.

    def _vault_of(self, note: Path) -> Path:
        """Find which vault a note belongs to."""
        for v in self.vaults:
            try:
                note.relative_to(v)
                return v
            except ValueError:
                continue
        return note.parent


# Auto-register
_plugin = ObsidianPlugin()
register(_plugin)
