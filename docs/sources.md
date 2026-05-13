# Connecting information sources

Lineup links external "knowledge" alongside projects: notes, papers, tasks, files, and email. Each source is a tiny plugin that does three things — `browse`, `search`, `read` — and exposes its items as lineup objects you can drag into a project, open in the original app, or feed to an AI agent.

Out of the box, lineup ships with these source plugins (all opt-in — they only activate if the underlying app is installed):

| Source       | What it surfaces                       | Requires                                  |
| ------------ | -------------------------------------- | ----------------------------------------- |
| **Apple Mail** | Messages from any Mail.app account   | macOS + Mail.app + Full Disk Access       |
| Obsidian     | Notes from one or more vaults          | Obsidian + vault on disk                  |
| Trilium      | Notes from a Trilium server            | Trilium Notes + `triliumServerUrl` config |
| Zotero       | Papers, collections, PDFs              | Zotero desktop app                        |
| Todoist      | Projects (one-way sync to lineup)      | `td` CLI on `PATH`                        |

The two most useful sources for daily work are **Apple Mail** (because everyone's inbox is a mess) and **Obsidian** (because notes are where context lives). The rest of this page focuses on email — the others are straightforward (install the app, point lineup at the data dir).

---

## Apple Mail

Lineup reads Mail.app's local SQLite index directly. **No AppleScript, no IMAP credentials, no third-party API**. It's instant, works for every account Mail.app already syncs (iCloud, Gmail via OAuth, Exchange, university IMAP, anything you've added in System Settings), and it's read-only — lineup never modifies Mail.

### How it works

Mail.app keeps an SQLite "Envelope Index" at `~/Library/Mail/V10/MailData/Envelope Index` that contains the headers, dates, sender names, and read flags for **every message in every account**. Bodies live as `.emlx` files in the per-account folders. The lineup plugin queries this index for browse/search, then parses the corresponding `.emlx` on demand for previews.

The upshot:

- If a message is visible in Mail.app, lineup can find it. Tens of thousands of messages search in milliseconds.
- If you've never opened Mail.app, lineup has nothing to read.
- New mail shows up the moment Mail.app finishes syncing — no separate poll loop on lineup's side.

### Setup

1. **Add the account in Mail.app.** Open Mail → Settings → Accounts → `+`, sign in. Wait until the inbox finishes its first sync (the spinner stops in the bottom-left).

2. **Grant Full Disk Access.** macOS guards the Mail data folder. Open System Settings → Privacy & Security → Full Disk Access, then toggle on **both**:

   - **Terminal.app** — needed if you use the `lu` CLI or run the Python MCP server from a shell.
   - **Electron** (the app named "lineup" or, during dev, "Electron") — needed for the desktop app to read mail.

   If you skip this step, the mail source silently returns zero results. There's no error, because macOS lies to readers about whether the file exists.

3. **Verify.** In the lineup app, click the Browse button on any column and pick **Mail** from the source list. You should see your mailboxes. Alternately, from a shell:

   ```bash
   uv run lu browse mail
   uv run lu search mail "invoice"
   ```

   Both should return results within a second or two.

### Using mail in lineup

Once the source is live, you can:

- **Drag a message into a project.** It becomes a lineup object with a `message://` URL that opens back to the exact thread in Mail.app.
- **Search across all accounts.** The search bar at the top of the Browse dialog hits the full Envelope Index.
- **Preview inline.** Click a mail object in a Miller column — the preview pane parses the `.emlx`, renders the HTML, lists attachments, and offers to save them.
- **Feed it to an agent.** The MCP server exposes `lineup_mail_search` and `lineup_mail_read` tools. Per-project Claude Code sessions can pull mail context into their working set without copy-pasting.

### Troubleshooting

- **"No results" but Mail.app shows messages.** Almost always Full Disk Access. macOS won't tell you it's blocking the read — re-grant it, then **quit and reopen lineup** (the file handle is cached at startup).
- **Some messages appear without bodies.** Mail.app evicts old `.emlx` files for IMAP / Exchange accounts when "Download attachments" is set to "Recent" or "None". The Envelope Index still has the metadata, so the message shows up in search, but the preview pane will say "(body not cached)". Open the message in Mail.app once to re-download it, or change the account's download policy.
- **A mail link opens to the wrong message.** Mail.app reuses ROWIDs after deletes. Lineup tries to verify a target by its RFC `Message-ID` header; if the local file is gone, it falls back to ROWID and may land on a different message. Re-link from the current search results to fix.

### Other email setups (Gmail-direct, IMAP-only, no Mail.app)

The shipped plugin is Mail.app-specific because reading a local SQLite is dramatically simpler and faster than IMAP. If you don't use Mail.app, two options:

1. **Add the account to Mail.app anyway, just for indexing.** Mail.app handles OAuth for Gmail/Outlook, deals with Exchange auth, and syncs in the background. You don't have to actually use it as your mail client.
2. **Write a new plugin.** Subclass `lineup.plugins.base.Plugin`, implement `browse`/`search`/`read`, call `register(YourPlugin())`. The Obsidian plugin (`lineup/plugins/obsidian.py`, ~200 lines) is a good template — it queries a local filesystem instead of a SQLite index, but the shape is the same. Drop it in `lineup/plugins/` and it auto-loads.

---

## Obsidian

1. Add or create a vault somewhere on disk.
2. Lineup auto-detects vaults under `~/Documents` and `~/Obsidian`. To point it elsewhere, edit `~/.lineup/config.json`:

   ```json
   { "obsidianVaultRoots": ["~/Notes", "~/work/vault"] }
   ```

3. Browse → Obsidian. You'll see vaults → folders → notes. Drag a note into a project; lineup stores an `obsidian://` URL that opens at the right vault and file.

## Trilium

1. Run Trilium Notes (desktop) or point to a Trilium server.
2. Add the server URL to `~/.lineup/config.json`:

   ```json
   { "triliumServerUrl": "http://localhost:37840" }
   ```

3. Browse → Trilium.

## Zotero

1. Install Zotero. Make sure the desktop app has run at least once (creates the SQLite library).
2. Lineup auto-detects `~/Zotero/zotero.sqlite`. Override via:

   ```json
   { "zoteroDbPath": "~/path/to/zotero.sqlite" }
   ```

3. Zotero must be quit (or not opened the DB exclusively) for lineup to read — Zotero acquires an exclusive lock. The plugin uses read-only mode but Zotero's lock will still block. Workaround: enable "Better BibTeX" or use a Zotero copy. For most users, just quit Zotero when you want to browse from lineup.

## Todoist

1. Install the `td` CLI (`brew install Doist/td/td`).
2. `td login`.
3. `uv run lu todoist sync` once. Lineup creates one project per Todoist project (skipping Inbox).

---

## Writing your own source plugin

Plugins are ~100–200 lines of Python. Put a new file in `lineup/plugins/`, subclass `Plugin`, implement the three methods, and call `register(...)` at module bottom — the loader picks it up next launch.

Minimal skeleton:

```python
from lineup.plugins import base, register


class MySourcePlugin(base.Plugin):
    name = "mysource"
    description = "My custom knowledge source"

    def browse(self, path: str = "") -> list[base.Item]:
        # Return folders/files/notes at this path (empty = root).
        ...

    def search(self, query: str, limit: int = 10) -> list[base.Item]:
        # Full-text or metadata search.
        ...

    def read(self, item_id: str) -> str:
        # Return the body of one item as text (for AI context).
        ...


register(MySourcePlugin())
```

`base.Item` carries `id`, `name`, `target` (the URI lineup will store), `type` (e.g. `"file"`, `"url"`, `"obsidian"`), and an optional `default_app`. Existing plugins in `lineup/plugins/` are the best reference — `obsidian.py` for filesystem-backed, `zotero.py` for SQLite-backed, `mail.py` for the heaviest case (SQLite + on-disk blob parsing + caching).
