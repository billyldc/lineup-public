"""Zotero object type.

Targets are Zotero `select` URIs:
    zotero://select/library/items/<key>        — paper / book / etc. (leaf)
    zotero://select/library/collections/<key>  — collection (parent, has children)

Both forms are handled by the same ObjectType and routed through `open` so
macOS hands them to the Zotero app for navigation. Reading metadata for AI
context is delegated to the plugin layer (lineup.plugins.zotero) which talks
directly to ~/Zotero/zotero.sqlite.
"""

from pathlib import Path

from lineup.types import register
from lineup.types.base import ObjectType


class ZoteroType(ObjectType):
    name = "zotero"
    display_label = "文献"
    priority = 70

    @classmethod
    def matches(cls, target: str) -> bool:
        return target.startswith("zotero://")

    @classmethod
    def open_command(cls, target: str, app: str | None = None) -> list[str] | None:
        # zotero:// URIs are opened by macOS `open`, which routes to Zotero.
        return ["open", target]

    @classmethod
    def display_target(cls, target: str) -> str | None:
        return target

    @classmethod
    def read(cls, target: str) -> str | None:
        # Delegate to the plugin (which reads sqlite directly).
        try:
            from lineup.plugins.zotero import ZoteroPlugin
            return ZoteroPlugin().read(target)
        except Exception:
            return None

    @classmethod
    def skill_dir(cls) -> Path | None:
        d = Path(__file__).parent / "skill"
        return d if d.is_dir() else None


# Register at module import time. Done explicitly here (instead of @register)
# so that re-importing this module during testing doesn't double-register.
register(ZoteroType)
