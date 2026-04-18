"""URL object type."""

from pathlib import Path

from lineup.types import register
from lineup.types.base import ObjectType


@register
class UrlType(ObjectType):
    name = "url"
    display_label = "链接"
    priority = 80

    @classmethod
    def matches(cls, target: str) -> bool:
        return target.startswith(("http://", "https://"))

    @classmethod
    def open_command(cls, target: str, app: str | None = None) -> list[str] | None:
        if app:
            return ["open", "-a", app, target]
        return ["open", target]

    @classmethod
    def display_target(cls, target: str) -> str | None:
        # Keep URLs as-is, they're already readable.
        return target

    @classmethod
    def skill_dir(cls) -> Path | None:
        d = Path(__file__).parent / "skill"
        return d if d.is_dir() else None
