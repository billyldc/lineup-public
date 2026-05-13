"""Object type registry for lineup.

Types are registered at import time via the @register decorator.
The registry is used by store.py to auto-detect types, open objects,
and display targets.
"""

from __future__ import annotations

from lineup.types.base import ObjectType


_TYPES: list[type[ObjectType]] = []


def register(cls: type[ObjectType]) -> type[ObjectType]:
    """Class decorator that registers an ObjectType subclass."""
    _TYPES.append(cls)
    return cls


def all_types() -> list[type[ObjectType]]:
    """All registered types, sorted by priority desc (highest checked first)."""
    return sorted(_TYPES, key=lambda t: t.priority, reverse=True)


def get_for_target(target: str) -> type[ObjectType]:
    """Find the best-matching type for a target string.

    Falls back to FileType (which always matches) if nothing else claims it.
    """
    for t in all_types():
        if t.matches(target):
            return t
    # Should never happen if FileType is registered, but be safe.
    from lineup.types.file import FileType
    return FileType


def get_by_name(name: str) -> type[ObjectType] | None:
    """Look up a type by its name (the string stored in the DB)."""
    for t in _TYPES:
        if t.name == name:
            return t
    return None


def load_all():
    """Import all built-in type modules so they self-register.

    Order doesn't matter — priority on each type class controls match order.
    We just need every module imported so @register runs.
    """
    from lineup.types import url       # noqa: F401
    from lineup.types import zotero    # noqa: F401
    from lineup.types import obsidian  # noqa: F401
    from lineup.types import trilium   # noqa: F401
    from lineup.types import mail      # noqa: F401
    from lineup.types import folder    # noqa: F401
    from lineup.types import script    # noqa: F401
    from lineup.types import contact   # noqa: F401
    from lineup.types import file      # noqa: F401
