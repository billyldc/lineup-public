"""lineup plugin system."""

from lineup.plugins.base import Plugin

_plugins: dict[str, Plugin] = {}


def register(plugin: Plugin):
    """Register a plugin instance."""
    _plugins[plugin.name] = plugin


def get(name: str) -> Plugin | None:
    return _plugins.get(name)


def all_plugins() -> dict[str, Plugin]:
    return _plugins


def display_target(target: str) -> str:
    """Convert a target path to a pretty display path using plugins.

    Tries each plugin; if none recognizes it, falls back to ~ shortening.
    """
    for plugin in _plugins.values():
        result = plugin.display_target(target)
        if result is not None:
            return result
    # Fallback: shorten home dir to ~
    from pathlib import Path
    home = str(Path.home())
    if target.startswith(home):
        return "~" + target[len(home):]
    return target


def open_command(target: str) -> list[str] | None:
    """Ask plugins for a custom open command. Returns None if no plugin claims it."""
    for plugin in _plugins.values():
        result = plugin.open_command(target)
        if result is not None:
            return result
    return None


def default_app_for(target: str) -> str | None:
    """Ask plugins what app should open this target. Returns None if unknown."""
    for plugin in _plugins.values():
        result = plugin.default_app_for(target)
        if result is not None:
            return result
    return None


def load_all():
    """Import all built-in plugins so they self-register."""
    from lineup.plugins import obsidian  # noqa: F401
    from lineup.plugins import trilium  # noqa: F401
    from lineup.plugins import zotero  # noqa: F401
    from lineup.plugins import mail  # noqa: F401
