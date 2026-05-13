"""Apple Mail plugin for lineup — DB-first, no AppleScript.

Reads Mail.app's Envelope Index SQLite directly at
  ~/Library/Mail/V10/MailData/Envelope Index
which contains metadata for ALL accounts (including slow Exchange/IMAP
accounts) — tens of thousands of messages, all queryable in ms.

Requires macOS Full Disk Access on whatever process runs lineup:
  System Settings → Privacy & Security → Full Disk Access
add Terminal.app + the Electron binary.

Target format stored by lineup for a mail object:
  - `message://<url-encoded RFC Message-ID>`  — preferred, opens at
    the exact message in Mail.app via native URL scheme
  - `mailrow:<ROWID>` — fallback when we can't find the local .emlx
    (server-only messages). On open we look up + open the file with
    Mail.app directly.
"""

from __future__ import annotations

import sqlite3
import subprocess
from pathlib import Path
from urllib.parse import quote, unquote

from lineup.plugins import base, register


MAIL_ROOT = Path.home() / "Library" / "Mail" / "V10"
ENVELOPE_INDEX = MAIL_ROOT / "MailData" / "Envelope Index"


def _envelope_available() -> bool:
    try:
        with ENVELOPE_INDEX.open("rb") as f:
            f.read(16)
        return True
    except OSError:
        return False


def _connect_envelope() -> sqlite3.Connection:
    """Open the Envelope Index read-only so we don't fight Mail.app for locks."""
    uri = f"file:{ENVELOPE_INDEX}?mode=ro&immutable=0"
    return sqlite3.connect(uri, uri=True, timeout=5)


# ── lineup-side preview cache (populated by Electron prewarm) ──────────

def _read_preview_cache(target: str) -> dict | None:
    """Look up an already-parsed body in lineup.db's mail_preview_cache.

    Populated by the Electron main process whenever an email enters the
    inbox (see frontend prewarmMailCache). Reading from here is the only
    path that survives Mail.app evicting the .emlx after sync — which is
    the failure MCP agents kept hitting when they tried to read inbox
    emails by message:// id.

    Returns the same dict shape `preview()` builds from .emlx, or None
    if the row is missing / DB unreachable.
    """
    try:
        from lineup.store import DB_PATH
    except Exception:
        return None
    if not DB_PATH.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=2)
    except sqlite3.Error:
        return None
    try:
        row = conn.execute(
            "SELECT subject, from_addr, to_addr, cc_addr, date_str, "
            "html, text, attachments_json "
            "FROM mail_preview_cache WHERE target = ?",
            (target,),
        ).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    if not row:
        return None
    subject, from_addr, to_addr, cc_addr, date_str, html, text, atts_json = row
    # Skip empty rows (cache could in theory hold a placeholder; today it
    # only stores fully-parsed bodies). If both bodies are empty there's
    # nothing useful to return — let preview() fall through to .emlx.
    if not (html or text):
        return None
    out: dict = {}
    if subject:   out["subject"] = subject
    if from_addr: out["from"] = from_addr
    if to_addr:   out["to"] = to_addr
    if cc_addr:   out["cc"] = cc_addr
    if date_str:  out["date"] = date_str
    if html:      out["html"] = html
    if text:      out["text"] = text
    if atts_json:
        try:
            import json as _json
            out["attachments"] = _json.loads(atts_json)
        except Exception:
            pass
    return out


# ── emlx file resolution ───────────────────────────────────────────────

def _account_uuid_and_mailbox(url: str) -> tuple[str | None, str | None]:
    """Decode a mailbox URL into (account_uuid, mailbox_display_name).

    Examples:
      ews://53BD8569-.../%E6%94%B6%E4%BB%B6%E7%AE%B1  →
          ('53BD8569-...', '收件箱')
      imap://EEC41231-.../INBOX                      →
          ('EEC41231-...', 'INBOX')
      imap://EEC41231-.../%5BGmail%5D/All%20Mail     →
          ('EEC41231-...', '[Gmail]/All Mail')
    """
    if "://" not in url:
        return None, None
    _scheme, rest = url.split("://", 1)
    if "/" in rest:
        uuid, path = rest.split("/", 1)
        return uuid, unquote(path)
    return rest, None


def _find_emlx(rowid: int, account_uuid: str | None, mailbox_name: str | None) -> Path | None:
    """Locate the .emlx file for a given ROWID.

    Mail stores emlx under:
      MAIL_ROOT/<account_uuid>/<mailbox>.mbox/<inner_uuid>/Data/<d1>/<d2>/Messages/<ROWID>.emlx

    The <d1>/<d2>/ numeric path is undocumented; we just rglob. For a
    fully-specified (account, mailbox) we narrow the search to that mbox
    which keeps rglob fast; fall back to a global rglob if narrower search
    finds nothing.

    Falls back to `<ROWID>.partial.emlx` for messages whose body Mail.app
    hasn't fully downloaded yet — common on IMAP/EWS accounts in 'optimize
    storage' mode. The partial file still has all headers + a body part,
    enough for our preview pipeline.
    """
    candidates = [f"{rowid}.emlx", f"{rowid}.partial.emlx"]
    if account_uuid and mailbox_name:
        mbox = MAIL_ROOT / account_uuid / f"{mailbox_name}.mbox"
        if mbox.exists():
            for name in candidates:
                for p in mbox.rglob(f"Messages/{name}"):
                    return p
    # Fall back to full-tree rglob — slower but reliable.
    for name in candidates:
        for p in MAIL_ROOT.rglob(f"Messages/{name}"):
            return p
    return None


def _parse_rfc_message_id(emlx_path: Path) -> str | None:
    """Extract the RFC 5322 Message-ID from an .emlx file's headers only.

    emlx format: first line = byte length of the message, then the raw
    RFC822 message, then an Apple plist (metadata). We only need the
    headers, which are at the start, so reading the first ~16KB is enough.

    Uses email.parser so RFC 5322 header folding (continuation lines
    starting with whitespace) is handled correctly — naïve line-splitting
    used to truncate Message-IDs at their first fold, producing garbage
    URLs like "message:// 69e0... %40prod-..." that Mail can't open.
    """
    from email.parser import BytesParser
    from email.policy import default
    try:
        with emlx_path.open("rb") as f:
            first = f.readline()
            try:
                length = int(first.strip())
                head = f.read(min(16384, length))
            except ValueError:
                f.seek(0)
                head = f.read(16384)
    except OSError:
        return None
    try:
        msg = BytesParser(policy=default).parsebytes(head, headersonly=True)
    except Exception:
        return None
    mid = (msg.get("Message-ID") or "").strip()
    if not mid:
        return None
    if mid.startswith("<") and mid.endswith(">"):
        mid = mid[1:-1]
    # Strip any stray whitespace that survived the fold-unfolding — Message
    # IDs must be a single dot-atom@dot-atom with no whitespace.
    mid = "".join(mid.split())
    return mid or None


def _search_rowid_by_metadata(
    conn: sqlite3.Connection, meta: dict,
) -> tuple[int, str] | None:
    """Find the current ROWID of an email by sender + subject when its
    original ROWID has been recycled by Mail.app.

    Strategy: match on (sender_addr, subject) — almost always unique within
    a mailbox in practice. We try the original mailbox first (most common
    when nothing actually moved and the index just got rebuilt), then any
    other mailbox in the same account (covers move-to-archive / Gmail
    relabel cases).

    Returns (rowid, mailbox_url) or None.
    """
    sender_addr = (meta.get("sender_addr") or "").strip()
    subject = (meta.get("subject") or "").strip()
    mailbox_url = (meta.get("mailbox_url") or "").strip()
    if not sender_addr or not subject:
        return None

    # Subject prefix-match — Mail sometimes prepends "Re:" / "Fwd:" or the
    # user-facing subject differs slightly from what we synced. The first
    # 40 chars are stable enough to be unique while tolerating the prefix.
    subject_like = f"%{subject[:40]}%"

    # First pass: same mailbox (covers index rebuild / no-move case).
    if mailbox_url:
        row = conn.execute(
            """
            SELECT m.ROWID, mb.url
            FROM messages m
            JOIN mailboxes mb ON mb.ROWID = m.mailbox
            JOIN addresses a ON a.ROWID = m.sender
            JOIN subjects s ON s.ROWID = m.subject
            WHERE a.address = ?
              AND s.subject LIKE ?
              AND mb.url = ?
              AND m.deleted = 0
            ORDER BY m.date_received DESC
            LIMIT 1
            """,
            (sender_addr, subject_like, mailbox_url),
        ).fetchone()
        if row:
            return row[0], row[1]

    # Second pass: same account (UUID prefix from the original mailbox URL).
    # Covers move-to-trash / Gmail label changes — message survives but its
    # mailbox URL changes.
    if mailbox_url and "://" in mailbox_url:
        scheme, rest = mailbox_url.split("://", 1)
        account_uuid = rest.split("/", 1)[0] if "/" in rest else rest
        row = conn.execute(
            """
            SELECT m.ROWID, mb.url
            FROM messages m
            JOIN mailboxes mb ON mb.ROWID = m.mailbox
            JOIN addresses a ON a.ROWID = m.sender
            JOIN subjects s ON s.ROWID = m.subject
            WHERE a.address = ?
              AND s.subject LIKE ?
              AND mb.url LIKE ?
              AND m.deleted = 0
            ORDER BY m.date_received DESC
            LIMIT 1
            """,
            (sender_addr, subject_like, f"{scheme}://{account_uuid}/%"),
        ).fetchone()
        if row:
            return row[0], row[1]
    return None


def _target_for_rowid(
    rowid: int, account_uuid: str | None, mailbox_name: str | None
) -> str:
    """Build the lineup target string for a message.

    Prefer `message://<RFC-MID>` (opens at exact message in Mail). If the
    local .emlx isn't present or lacks a parseable Message-ID, fall back
    to `mailrow:<ROWID>` which we resolve at open-time instead.
    """
    emlx = _find_emlx(rowid, account_uuid, mailbox_name)
    if emlx:
        mid = _parse_rfc_message_id(emlx)
        if mid:
            return "message://" + quote(mid, safe="@")
    return f"mailrow:{rowid}"


# ── Helpers for browse / search ────────────────────────────────────────

def _fmt_date(ts: int | None) -> str:
    if not ts:
        return ""
    # Mail.app's date_received is a standard Unix timestamp.
    from datetime import datetime
    try:
        return datetime.fromtimestamp(ts).isoformat(timespec="minutes")
    except (ValueError, OSError):
        return ""


def _account_label(url: str) -> str:
    """Derive a human-friendly account label from a mailbox URL."""
    uuid, mbox = _account_uuid_and_mailbox(url)
    return uuid or "(unknown)"


# Base SELECT used by browse / search. Joins surface subject + sender.
_BASE_SELECT = """
SELECT m.ROWID,
       m.date_received,
       COALESCE(s.subject, ''),
       COALESCE(a.address, ''),
       COALESCE(a.comment, ''),
       mb.url,
       m.read
FROM messages m
LEFT JOIN subjects s ON s.ROWID = m.subject
LEFT JOIN addresses a ON a.ROWID = m.sender
LEFT JOIN mailboxes mb ON mb.ROWID = m.mailbox
WHERE m.deleted = 0
"""


def _row_to_item(row, *, resolve_target: bool = True) -> base.Item:
    rowid, date_ts, subject, sender_addr, sender_name, mailbox_url, read = row
    uuid, mbox_name = _account_uuid_and_mailbox(mailbox_url or "")
    target = (
        _target_for_rowid(rowid, uuid, mbox_name)
        if resolve_target
        else f"mailrow:{rowid}"
    )
    # Display: prefer sender name (comment), fall back to address.
    sender_disp = sender_name or sender_addr
    unread = not read
    label = ("● " if unread else "") + (subject or "(无主题)")[:140]
    preview_bits = []
    if sender_disp:
        preview_bits.append(sender_disp)
    dt = _fmt_date(date_ts)
    if dt:
        preview_bits.append(dt.replace("T", " "))
    if mbox_name and mbox_name != "INBOX":
        preview_bits.append(f"📁 {mbox_name}")
    return base.Item(
        id=str(rowid),
        name=label,
        target=target,
        type="mail",
        default_app="Mail",
        preview=" · ".join(preview_bits),
    )


# ── Plugin ─────────────────────────────────────────────────────────────

class MailPlugin(base.Plugin):
    name = "mail"
    description = "Apple Mail integration (direct Envelope Index query)"

    def _check_available(self) -> list[base.Item] | None:
        if not _envelope_available():
            return [base.Item(
                id="help:fda",
                name="[Mail Envelope Index 不可访问]",
                target="",
                type="mail",
                preview=(
                    "需要在 System Settings → Privacy & Security → "
                    "Full Disk Access 里给 Terminal + Electron 授权"
                ),
            )]
        return None

    def browse(self, path: str = "") -> list[base.Item]:
        stub = self._check_available()
        if stub is not None:
            return stub
        conn = _connect_envelope()
        try:
            if path.startswith("account:"):
                uuid = path[len("account:"):]
                # Match any mailbox whose URL contains this UUID.
                rows = conn.execute(
                    _BASE_SELECT +
                    " AND mb.url LIKE ?"
                    " ORDER BY m.date_received DESC LIMIT 80",
                    (f"%://{uuid}/%",),
                ).fetchall()
                return [_row_to_item(r) for r in rows]

            # Top level: list accounts (as folders) + 40 most recent.
            acct_rows = conn.execute("""
                SELECT DISTINCT substr(mb.url,
                                       instr(mb.url, '://') + 3,
                                       36) AS acct
                FROM mailboxes mb
                JOIN messages m ON m.mailbox = mb.ROWID
                WHERE m.deleted = 0
            """).fetchall()
            account_items: list[base.Item] = []
            for (uuid,) in acct_rows:
                if not uuid:
                    continue
                count_row = conn.execute(
                    "SELECT COUNT(*) FROM messages m "
                    "JOIN mailboxes mb ON mb.ROWID = m.mailbox "
                    "WHERE m.deleted = 0 AND mb.url LIKE ?",
                    (f"%://{uuid}/%",),
                ).fetchone()
                cnt = count_row[0] if count_row else 0
                account_items.append(base.Item(
                    id=f"account:{uuid}",
                    name=f"{uuid[:8]}… ({cnt})/",
                    target=f"account:{uuid}",
                    type="folder",
                    preview=f"Apple Mail 账户 · {cnt} 封",
                ))
            recent_rows = conn.execute(
                _BASE_SELECT + " ORDER BY m.date_received DESC LIMIT 40"
            ).fetchall()
            return account_items + [_row_to_item(r) for r in recent_rows]
        finally:
            conn.close()

    def search(self, query: str, limit: int = 30) -> list[base.Item]:
        stub = self._check_available()
        if stub is not None:
            return stub
        q = f"%{query}%"
        conn = _connect_envelope()
        try:
            rows = conn.execute(
                _BASE_SELECT +
                " AND (s.subject LIKE ? OR a.address LIKE ? OR a.comment LIKE ?)"
                " ORDER BY m.date_received DESC LIMIT ?",
                (q, q, q, limit),
            ).fetchall()
            return [_row_to_item(r) for r in rows]
        finally:
            conn.close()

    def resolve_target(
        self, target: str, *, fallback_metadata: dict | None = None,
    ) -> str | None:
        """Normalize any mail target to the canonical `message://<encoded-MID>`.

        - `message://...` is verified to still resolve in the local Mail
          index. Mail.app moves emails between mailboxes (trash, Gmail
          relabels) and updates Message-IDs on copy, so a message:// URL
          we cached at sync time can become a "Mail can't open the URL"
          dialog. When fallback_metadata is provided we re-resolve.
        - `mailrow:<ROWID>` is resolved via Envelope Index → emlx →
          Message-ID. Same metadata fallback if ROWID is gone.

        Returns None if even the fallback can't find a matching email.
        """
        if not _envelope_available():
            # Without Envelope Index access we can't probe — pass through
            # message:// unchanged and bail on mailrow:.
            return target if target.startswith("message:") else None

        import sqlite3

        conn = sqlite3.connect(f"file:{ENVELOPE_INDEX}?mode=ro", uri=True, timeout=5)
        try:
            # ── message:// path ─────────────────────────────────────
            # The cached URL was correct AT SYNC TIME, but Mail.app
            # rewrites Message-IDs when emails copy between mailboxes
            # (Gmail "All Mail" relabels especially) so the URL we
            # stored may now point at a Message-ID that no email locally
            # has. When we have inbox_item metadata (sender/subject/
            # mailbox), use it as the authoritative source — search by
            # those fields, find the email's CURRENT location, build a
            # fresh URL. This bypasses the cached MID's potential staleness.
            #
            # Without metadata we just return the input unchanged
            # (best-effort — Mail may or may not be able to open it).
            if target.startswith("message:"):
                if fallback_metadata:
                    found = _search_rowid_by_metadata(conn, fallback_metadata)
                    if found:
                        new_rowid, new_mailbox_url = found
                        uuid, mbox_name = _account_uuid_and_mailbox(new_mailbox_url)
                        emlx = _find_emlx(new_rowid, uuid, mbox_name)
                        if emlx:
                            new_mid = _parse_rfc_message_id(emlx)
                            if new_mid:
                                return "message://" + quote(new_mid, safe="@")
                # No metadata or metadata search failed — return input.
                # Mail will try; if it fails the user sees the dialog,
                # but at least non-stale URLs still work as before.
                return target

            # ── mailrow: path ───────────────────────────────────────
            if not target.startswith("mailrow:"):
                return None
            try:
                rowid = int(target[len("mailrow:"):])
            except ValueError:
                return None

            row = conn.execute(
                "SELECT mb.url FROM messages m "
                "JOIN mailboxes mb ON mb.ROWID = m.mailbox "
                "WHERE m.ROWID = ?",
                (rowid,),
            ).fetchone()
            mailbox_url = row[0] if row else None

            if not row and fallback_metadata:
                rowid, mailbox_url = _search_rowid_by_metadata(conn, fallback_metadata) or (None, None)
                if rowid is None:
                    return None
        finally:
            conn.close()

        if mailbox_url is None:
            return None
        uuid, mbox_name = _account_uuid_and_mailbox(mailbox_url)
        emlx = _find_emlx(rowid, uuid, mbox_name)
        if not emlx:
            return None
        mid = _parse_rfc_message_id(emlx)
        if not mid:
            return None
        return "message://" + quote(mid, safe="@")

    def preview(self, item_id: str, *, fallback_metadata: dict | None = None) -> dict:
        """Return parsed email metadata + HTML/text body for preview.

        Accepts mailrow:<ROWID> (preferred) or message://<url-encoded-MID>.

        With `fallback_metadata` (sender_addr / subject / mailbox_url —
        same shape resolve_target uses), we do a point query in the
        Envelope Index by metadata to get the current ROWID, then
        load the emlx directly. This is what the prewarm path uses to
        avoid the slow rglob *.emlx scan when stage 1 (rowid lookup) /
        stage 2 (Message-ID match) both miss because Mail.app rewrote
        the email's identity since sync.
        """
        from email import policy
        from email.parser import BytesParser
        from urllib.parse import unquote
        # Cache short-circuit: every email that lands in the lineup inbox
        # gets its body cached in mail_preview_cache by the Electron
        # prewarm path. Hit that cache first — it's the only source that
        # survives Mail.app evicting the .emlx, and MCP agents
        # (lineup_mail_read) need it to work for inbox-routed targets
        # whose underlying file may already have rotated.
        cached = _read_preview_cache(item_id)
        if cached:
            return cached
        emlx_path: Path | None = None
        rowid: int | None = None
        if item_id.startswith("mailrow:"):
            try: rowid = int(item_id[len("mailrow:"):])
            except ValueError: rowid = None
        elif item_id.isdigit():
            rowid = int(item_id)
        elif item_id.startswith("message:"):
            # Two paths for message://, in order of cost:
            #   1. fallback_metadata gives us a fast point lookup → emlx
            #   2. without metadata, we have to rglob (slow for 30k files)
            if fallback_metadata and _envelope_available():
                import sqlite3
                conn = sqlite3.connect(f"file:{ENVELOPE_INDEX}?mode=ro", uri=True, timeout=5)
                try:
                    found = _search_rowid_by_metadata(conn, fallback_metadata)
                    if found:
                        new_rowid, mailbox_url = found
                        uuid, mbox_name = _account_uuid_and_mailbox(mailbox_url)
                        cand = _find_emlx(new_rowid, uuid, mbox_name)
                        if cand:
                            emlx_path = cand
                finally:
                    conn.close()
            if not emlx_path:
                # rglob fallback. Cap iteration so a non-existent message
                # doesn't pin the disk for minutes.
                mid = unquote(item_id.split("://", 1)[-1])
                mid = "".join(mid.split())
                scanned = 0
                for p in MAIL_ROOT.rglob("*.emlx"):
                    scanned += 1
                    if scanned > 5000:
                        break
                    try:
                        if _parse_rfc_message_id(p) == mid:
                            emlx_path = p
                            break
                    except Exception: continue

        if rowid is not None and not _envelope_available():
            return {"error": "Envelope Index 不可访问（需 Full Disk Access）"}
        if rowid is not None:
            import sqlite3
            conn = sqlite3.connect(f"file:{ENVELOPE_INDEX}?mode=ro", uri=True, timeout=5)
            try:
                row = conn.execute(
                    "SELECT mb.url FROM messages m "
                    "JOIN mailboxes mb ON mb.ROWID = m.mailbox "
                    "WHERE m.ROWID = ?",
                    (rowid,),
                ).fetchone()
                # Mailrow:N stale-ROWID fallback — same logic as resolve_target.
                # Mail.app aggressively recycles ROWIDs; metadata search
                # finds the email at its current rowid.
                if not row and fallback_metadata:
                    found = _search_rowid_by_metadata(conn, fallback_metadata)
                    if found:
                        rowid, mailbox_url = found
                        row = (mailbox_url,)
            finally:
                conn.close()
            if row:
                uuid, mbox_name = _account_uuid_and_mailbox(row[0])
                emlx_path = _find_emlx(rowid, uuid, mbox_name)

        if not emlx_path or not emlx_path.exists():
            return {"error": "本地未找到该邮件（.emlx 未下载）"}

        # Parse the .emlx (skip Apple's length prefix if present).
        try:
            with emlx_path.open("rb") as f:
                first = f.readline()
                try:
                    length = int(first.strip())
                    raw = f.read(length)
                except ValueError:
                    f.seek(0)
                    raw = f.read()
        except OSError as e:
            return {"error": f"读取 .emlx 失败: {e}"}

        try:
            msg = BytesParser(policy=policy.default).parsebytes(raw)
        except Exception as e:
            return {"error": f"MIME 解析失败: {e}"}

        # Pick best body: prefer HTML, fall back to text.
        html_body = None
        text_body = None
        try:
            html_part = msg.get_body(preferencelist=("html",))
            if html_part is not None:
                html_body = html_part.get_content()
        except Exception: pass
        try:
            text_part = msg.get_body(preferencelist=("plain",))
            if text_part is not None:
                text_body = text_part.get_content()
        except Exception: pass

        # Walk attachments + inline images. We do TWO passes:
        #   1) Build a {cid: data_url} map for inline images, so when we
        #      rewrite the HTML body, <img src="cid:..."> shows the actual
        #      image instead of a broken link.
        #   2) Collect non-inline (or non-image) parts as "attachments" —
        #      surfaced to the renderer for download/listing.
        # We index by mime walk position so a later save-attachment call
        # can re-locate the same part deterministically.
        import base64
        attachments: list[dict] = []
        cid_to_data_url: dict[str, str] = {}
        for idx, part in enumerate(msg.walk()):
            if part.is_multipart():
                continue
            content_type = part.get_content_type()
            disposition = (part.get_content_disposition() or "").lower()
            cid = (part.get("Content-ID") or "").strip("<>")
            filename = part.get_filename() or ""
            try:
                payload = part.get_payload(decode=True) or b""
            except Exception:
                payload = b""
            # Inline images referenced by cid: in the HTML body — rewrite
            # those so the rendered preview actually shows them.
            is_inline_image = (
                content_type.startswith("image/")
                and (cid or disposition == "inline")
                and cid
            )
            if is_inline_image and payload:
                b64 = base64.b64encode(payload).decode("ascii")
                cid_to_data_url[cid] = f"data:{content_type};base64,{b64}"
            # Treat as attachment when it has a filename OR an explicit
            # attachment disposition. This excludes the html/plain bodies
            # (no filename, no attachment disposition). Zero-payload
            # parts can happen on .partial.emlx files where Mail.app
            # hasn't fully downloaded the attachment — surface them
            # anyway with `available: false` so the UI can prompt the user
            # to download in Mail.app.
            is_attachment = bool(filename) or disposition == "attachment"
            if is_attachment:
                attachments.append({
                    "index": idx,
                    "name": filename or f"part-{idx}.{content_type.split('/')[-1]}",
                    "size": len(payload),
                    "content_type": content_type,
                    "is_inline_image": is_inline_image,
                    "available": len(payload) > 0,
                })

        # Rewrite cid: references in HTML to embedded data URLs. Keeps the
        # email self-contained — no external requests, no broken images.
        if html_body and cid_to_data_url:
            import re as _re
            def _replace_cid(m: _re.Match) -> str:
                cid = m.group(1).strip()
                return cid_to_data_url.get(cid, m.group(0))
            html_body = _re.sub(
                r'src=["\']cid:([^"\']+)["\']',
                _replace_cid,
                html_body,
                flags=_re.IGNORECASE,
            )

        def hdr(name: str) -> str:
            v = msg.get(name, "")
            return str(v) if v else ""

        # Include emlx path + mtime so the caller (main/index.ts cache) can
        # invalidate when the underlying file changes.
        try:
            mtime_ms = int(emlx_path.stat().st_mtime * 1000)
        except OSError:
            mtime_ms = 0
        return {
            "subject": hdr("Subject"),
            "from": hdr("From"),
            "to": hdr("To"),
            "cc": hdr("Cc"),
            "date": hdr("Date"),
            "html": html_body or "",
            "text": text_body or "",
            "attachments": attachments,
            "emlx_path": str(emlx_path),
            "emlx_mtime_ms": mtime_ms,
        }

    def save_attachment(
        self, item_id: str, index: int, dest_dir: Path,
    ) -> dict:
        """Extract one attachment from an email and write it to dest_dir.

        index is the MIME walk position returned by preview()'s attachments
        list. Returns {"ok": True, "path": str, "name": str} or {"error": ...}.
        """
        from email import policy
        from email.parser import BytesParser
        emlx_path = self._locate_emlx(item_id)
        if not emlx_path:
            return {"error": "本地未找到该邮件"}
        try:
            with emlx_path.open("rb") as f:
                first = f.readline()
                try:
                    length = int(first.strip())
                    raw = f.read(length)
                except ValueError:
                    f.seek(0)
                    raw = f.read()
            msg = BytesParser(policy=policy.default).parsebytes(raw)
        except (OSError, Exception) as e:
            return {"error": f"解析失败: {e}"}

        target_part = None
        for idx, part in enumerate(msg.walk()):
            if idx == index:
                target_part = part
                break
        if target_part is None:
            return {"error": f"附件 #{index} 未找到"}

        try:
            payload = target_part.get_payload(decode=True) or b""
        except Exception as e:
            return {"error": f"提取附件 payload 失败: {e}"}

        # Sanitize filename — strip path separators, fall back to a generic
        # name if the email didn't supply one.
        name = target_part.get_filename() or f"attachment-{index}.bin"
        name = name.replace("/", "_").replace("\\", "_").lstrip(".")
        dest = dest_dir / name
        # Disambiguate if a file with the same name already exists.
        if dest.exists():
            stem, _, suffix = name.rpartition(".")
            base = stem if stem else name
            ext = f".{suffix}" if stem else ""
            n = 1
            while dest.exists():
                dest = dest_dir / f"{base} ({n}){ext}"
                n += 1
        try:
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(payload)
        except OSError as e:
            return {"error": f"写文件失败: {e}"}
        return {"ok": True, "path": str(dest), "name": dest.name, "size": len(payload)}

    def _locate_emlx(self, item_id: str) -> Path | None:
        """Shared helper: find the emlx file for any supported item_id form.

        Mirrors the lookup branches in preview() — extracted so save_attachment
        can reuse it without duplicating the ROWID-vs-Message-ID dispatch.
        """
        from urllib.parse import unquote
        rowid: int | None = None
        if item_id.startswith("mailrow:"):
            try: rowid = int(item_id[len("mailrow:"):])
            except ValueError: return None
        elif item_id.isdigit():
            rowid = int(item_id)
        elif item_id.startswith("message:"):
            mid = unquote(item_id.split("://", 1)[-1])
            mid = "".join(mid.split())
            for p in MAIL_ROOT.rglob("*.emlx"):
                try:
                    if _parse_rfc_message_id(p) == mid:
                        return p
                except Exception: continue
            return None
        if rowid is None:
            return None
        if not _envelope_available():
            return None
        import sqlite3
        conn = sqlite3.connect(f"file:{ENVELOPE_INDEX}?mode=ro", uri=True, timeout=5)
        try:
            row = conn.execute(
                "SELECT mb.url FROM messages m "
                "JOIN mailboxes mb ON mb.ROWID = m.mailbox "
                "WHERE m.ROWID = ?",
                (rowid,),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        uuid, mbox_name = _account_uuid_and_mailbox(row[0])
        return _find_emlx(rowid, uuid, mbox_name)

    def read(self, item_id: str) -> str:
        """Return the raw body of a linked email.

        item_id accepts:
          - a numeric ROWID (stringified)
          - `mailrow:<ROWID>`
          - `message://<url-encoded RFC MID>` (we look the ROWID up)
        """
        rowid: int | None = None
        if item_id.startswith("mailrow:"):
            try:
                rowid = int(item_id[len("mailrow:"):])
            except ValueError:
                return ""
        elif item_id.isdigit():
            rowid = int(item_id)
        elif item_id.startswith("message:"):
            mid = unquote(item_id.split("://", 1)[-1])
            conn = _connect_envelope()
            try:
                # Headers → RFC Message-ID isn't stored in Envelope Index
                # directly; fall back to scanning .emlx files. Rare path.
                pass
            finally:
                conn.close()
            # Fallback: read via `grep` across emlx files (slow — last resort)
            for p in MAIL_ROOT.rglob("*.emlx"):
                if _parse_rfc_message_id(p) == mid:
                    return p.read_text(errors="ignore")
            return ""

        if rowid is None:
            return ""
        conn = _connect_envelope()
        try:
            row = conn.execute(
                "SELECT mb.url FROM messages m "
                "JOIN mailboxes mb ON mb.ROWID = m.mailbox "
                "WHERE m.ROWID = ?",
                (rowid,),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return ""
        uuid, mbox_name = _account_uuid_and_mailbox(row[0])
        emlx = _find_emlx(rowid, uuid, mbox_name)
        if not emlx:
            return ""
        try:
            return emlx.read_text(errors="ignore")
        except OSError:
            return ""


# Auto-register
_plugin = MailPlugin()
register(_plugin)


# ── Public helper used by `lu mail sync` (now effectively a no-op since
#    we query the live DB, but kept for CLI compatibility). ──────────────

def sync(per_account_limit: int = 200, account: str | None = None, verbose: bool = False) -> dict:
    """Previously synced via JXA. With the Envelope Index approach there's
    nothing to sync — reads are live. Return a status summary."""
    del per_account_limit, account, verbose
    if not _envelope_available():
        return {
            "ok": False,
            "error": (
                "Envelope Index DB unreadable. Grant Full Disk Access to "
                "your Terminal and to the Electron binary, then restart."
            ),
        }
    conn = _connect_envelope()
    try:
        counts = dict(conn.execute("""
            SELECT substr(mb.url,
                          instr(mb.url, '://') + 3,
                          36) AS acct,
                   COUNT(*)
            FROM messages m JOIN mailboxes mb ON mb.ROWID = m.mailbox
            WHERE m.deleted = 0
            GROUP BY acct
        """).fetchall())
    finally:
        conn.close()
    total = sum(counts.values())
    return {
        "ok": True,
        "total": total,
        "accounts": counts,
        "notes": [
            "查询直接走 Mail.app 的 Envelope Index SQLite（只读），"
            "无需显式同步——打开 Mail 就是最新状态。",
        ],
    }
