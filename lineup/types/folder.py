"""Folder object type."""

from pathlib import Path

from lineup.types import register
from lineup.types.base import ObjectType


@register
class FolderType(ObjectType):
    name = "folder"
    display_label = "文件夹"
    priority = 40

    @classmethod
    def matches(cls, target: str) -> bool:
        if target.startswith(("http://", "https://", "zotero://")):
            return False
        return Path(target).expanduser().is_dir()

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
