"""Apple Mail object type.

Two supported target formats — both open in Mail.app:

- `message://<url-encoded RFC Message-ID>` — canonical (manual inserts +
  agent proposals after resolve_target)
- `mailrow:<ROWID>` — legacy / inbox-adapter-raw. We resolve on the fly
  at open time so old links still work.
"""

from __future__ import annotations

from urllib.parse import unquote

from lineup.types import register
from lineup.types.base import ObjectType


@register
class MailType(ObjectType):
    name = "mail"
    display_label = "邮件"
    priority = 70

    @classmethod
    def matches(cls, target: str) -> bool:
        return target.startswith("message:") or target.startswith("mailrow:")

    @classmethod
    def open_command(cls, target: str, app: str | None = None) -> list[str] | None:
        # Legacy mailrow: resolve to a message:// URL first, then open.
        if target.startswith("mailrow:"):
            try:
                from lineup.plugins.mail import MailPlugin
                resolved = MailPlugin().resolve_target(target)
                if resolved:
                    return ["open", resolved]
            except Exception:
                pass
            # Fallback — tell `open` to hand off to Mail.app anyway (it'll
            # just open Mail; message won't auto-focus but user gets there).
            return ["open", "-a", "Mail"]
        # message:// URL: pass through — macOS routes it to Mail.app.
        return ["open", target]

    @classmethod
    def display_target(cls, target: str) -> str | None:
        if target.startswith("message:"):
            rest = target[len("message:"):].lstrip("/")
            try: decoded = unquote(rest)
            except Exception: decoded = rest
            return f"mail://{decoded[:60]}"
        if target.startswith("mailrow:"):
            return f"mail://#{target[len('mailrow:'):]}"
        return None
