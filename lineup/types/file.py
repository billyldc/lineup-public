"""Generic file object type — the fallback when nothing else matches."""

from pathlib import Path

from lineup.types import register
from lineup.types.base import ObjectType


@register
class FileType(ObjectType):
    name = "file"
    display_label = "文件"
    priority = 0  # lowest — checked last, always matches

    @classmethod
    def matches(cls, target: str) -> bool:
        # Fallback: matches everything that isn't obviously a URI.
        return True

    @classmethod
    def open_command(cls, target: str, app: str | None = None) -> list[str] | None:
        if app:
            return ["open", "-a", app, target]
        return ["open", target]

    @classmethod
    def display_target(cls, target: str) -> str | None:
        home = str(Path.home())
        if target.startswith(home):
            return "~" + target[len(home):]
        return None

    @classmethod
    def read(cls, target: str) -> str | None:
        p = Path(target).expanduser()
        if p.exists() and p.is_file():
            try:
                return p.read_text(errors="ignore")[:50000]  # cap for large files
            except OSError:
                pass
        return None
