"""Base class for lineup plugins."""

from dataclasses import dataclass


@dataclass
class Item:
    """A resource discovered by a plugin."""
    id: str            # unique identifier within the plugin
    name: str          # display name
    target: str        # path or URI for lineup to store
    type: str          # lineup object type (file/folder/url/...)
    default_app: str | None = None  # app to open with
    preview: str = ""  # short preview / summary


class Plugin:
    """Base class for knowledge tool plugins.

    Plugins discover resources in external tools and know how to
    represent them as lineup objects (via to_link_args).
    They communicate with lineup core only through:
      - store.link_object(target, name, type, project, default_app)
      - the default_app field for opening
    """

    name: str = ""
    description: str = ""

    def search(self, query: str, limit: int = 10) -> list[Item]:
        """Search for items in the data source."""
        raise NotImplementedError

    def read(self, item_id: str) -> str:
        """Read the content of an item (for AI context)."""
        raise NotImplementedError

    def browse(self, path: str = "") -> list[Item]:
        """Browse the data source by path/hierarchy."""
        raise NotImplementedError

    def to_link_args(self, item: Item) -> dict:
        """Convert an Item to arguments for store.link_object()."""
        return {
            "target": item.target,
            "name": item.name,
            "type": item.type,
            "default_app": item.default_app,
        }

    def display_target(self, target: str) -> str | None:
        """Convert a real target path to a pretty display path.

        Returns None if this plugin doesn't recognize the target.
        e.g. /Users/x/Desktop/科研/科研笔记/note.md -> obsidian://科研笔记/note.md
        """
        return None

    def default_app_for(self, target: str) -> str | None:
        """Return the recommended app for opening this target.

        Returns None if this plugin doesn't recognize the target.
        """
        return None

    def open_command(self, target: str) -> list[str] | None:
        """Return a custom command to open this target, or None to use default.

        Returns e.g. ["open", "obsidian://open?vault=X&file=Y"]
        """
        return None
