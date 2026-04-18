"""Obsidian note object type.

Handles detection, opening (via obsidian:// URI), and display of notes
living inside Obsidian vaults. Vault discovery logic lives here so both
the type module and the legacy plugin (lineup.plugins.obsidian) can
share it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import quote

from lineup.types import register
from lineup.types.base import ObjectType


def find_vaults() -> list[Path]:
    """Find Obsidian vaults from Obsidian's config or by scanning common locations."""
    vaults: list[Path] = []

    # Method 1: read Obsidian's own config
    obsidian_config = Path.home() / "Library" / "Application Support" / "obsidian" / "obsidian.json"
    if obsidian_config.exists():
        try:
            data = json.loads(obsidian_config.read_text())
            for _vid, info in data.get("vaults", {}).items():
                p = Path(info.get("path", ""))
                if p.exists():
                    vaults.append(p)
        except (json.JSONDecodeError, KeyError):
            pass

    if vaults:
        return vaults

    # Method 2: fallback - scan common locations for .obsidian dirs
    candidates = [
        Path.home() / "Desktop",
        Path.home() / "Documents",
        Path.home(),
    ]
    for root in candidates:
        for dirpath, dirnames, _filenames in os.walk(root):
            if ".obsidian" in dirnames:
                vaults.append(Path(dirpath))
                dirnames.clear()
            depth = str(dirpath).count(os.sep) - str(root).count(os.sep)
            if depth >= 3:
                dirnames.clear()

    return vaults


# Module-level cache; populated on first use.
_vaults: list[Path] | None = None


def _get_vaults() -> list[Path]:
    global _vaults
    if _vaults is None:
        _vaults = find_vaults()
    return _vaults


def _vault_of(path: Path) -> Path | None:
    """Find which vault a path belongs to (longest prefix match)."""
    for v in sorted(_get_vaults(), key=lambda v: len(str(v)), reverse=True):
        try:
            path.relative_to(v)
            return v
        except ValueError:
            continue
    return None


def _is_in_vault(target: str) -> bool:
    """Check if target path is inside any known Obsidian vault."""
    try:
        return _vault_of(Path(target)) is not None
    except Exception:
        return False


@register
class ObsidianType(ObjectType):
    name = "obsidian"
    display_label = "笔记"
    priority = 60  # above folder/file, below URL/zotero

    @classmethod
    def matches(cls, target: str) -> bool:
        if target.startswith(("http://", "https://", "zotero://")):
            return False
        return _is_in_vault(target)

    @classmethod
    def open_command(cls, target: str, app: str | None = None) -> list[str] | None:
        p = Path(target)

        # For folders, find the first .md file inside to reveal the folder.
        if p.is_dir():
            md_files = sorted(p.glob("*.md"))
            if not md_files:
                md_files = sorted(p.rglob("*.md"))
            if not md_files:
                return None
            p = md_files[0]

        vault = _vault_of(p)
        if vault is None:
            return None

        rel = p.relative_to(vault)
        file_path = str(rel)
        if file_path.endswith(".md"):
            file_path = file_path[:-3]
        uri = f"obsidian://open?vault={quote(vault.name)}&file={quote(file_path)}"
        return ["open", uri]

    @classmethod
    def display_target(cls, target: str) -> str | None:
        p = Path(target)
        vault = _vault_of(p)
        if vault is None:
            return None
        try:
            rel = p.relative_to(vault)
            return f"obsidian://{vault.name}/{rel}"
        except ValueError:
            return None

    @classmethod
    def read(cls, target: str) -> str | None:
        p = Path(target)
        if p.exists() and p.is_file():
            try:
                return p.read_text(errors="ignore")
            except OSError:
                pass
        return None

    @classmethod
    def skill_dir(cls) -> Path | None:
        d = Path(__file__).parent / "skill"
        return d if d.is_dir() else None
