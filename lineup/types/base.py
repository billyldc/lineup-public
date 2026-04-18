"""ObjectType base class — the unified interface for all object types in lineup.

Each type knows how to:
- Detect whether a target string belongs to it (matches)
- Open the target with the right application (open_command)
- Display the target path in a human-friendly way (display_target)
- Read the target's content for AI context (read)
- Point to a skill directory that teaches the chat agent how to handle this type (skill_dir)
"""

from __future__ import annotations

from pathlib import Path


class ObjectType:
    """Base class for object types. Subclass and override the classmethods."""

    name: str = ""              # unique id, stored in objects.type column
    display_label: str = ""     # shown in TUI type column (e.g. "文件", "链接")
    priority: int = 0           # higher = checked first in matches(); 0 = fallback

    @classmethod
    def matches(cls, target: str) -> bool:
        """Return True if this type should handle the given target string."""
        return False

    @classmethod
    def open_command(cls, target: str, app: str | None = None) -> list[str] | None:
        """Return the argv to open this target, or None to let the default handler run."""
        return None

    @classmethod
    def display_target(cls, target: str) -> str | None:
        """Return a pretty display string for this target, or None to use the default."""
        return None

    @classmethod
    def read(cls, target: str) -> str | None:
        """Read the target's content as text for AI context. Optional."""
        return None

    @classmethod
    def skill_dir(cls) -> Path | None:
        """Path to a skill/ directory (sibling to this module) for chat agent context.

        Return None if this type has no skill files.
        """
        return None
