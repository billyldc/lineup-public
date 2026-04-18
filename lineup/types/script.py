"""Script object type."""

from pathlib import Path

from lineup.types import register
from lineup.types.base import ObjectType

_SCRIPT_SUFFIXES = {".sh", ".py", ".bash", ".zsh"}


@register
class ScriptType(ObjectType):
    name = "script"
    display_label = "脚本"
    priority = 50

    @classmethod
    def matches(cls, target: str) -> bool:
        if target.startswith(("http://", "https://", "zotero://")):
            return False
        return Path(target).suffix.lower() in _SCRIPT_SUFFIXES

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
        if p.exists():
            try:
                return p.read_text(errors="ignore")
            except OSError:
                pass
        return None
