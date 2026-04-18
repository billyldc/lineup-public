# lineup

A project management desktop app with Miller-column navigation, task/step hierarchy, and AI agent integration.

Built with Electron + React + TypeScript + Tailwind CSS + better-sqlite3.

## Features

**Project management**
- Miller-column (Finder-style) navigation for projects, tasks, and files
- Three-level hierarchy: **project** → **task** → **step** (sequential checklist)
- Drag-and-drop: move/copy objects between projects, reference projects in multiple locations
- Eisenhower matrix (important × urgent) with auto-urgent from due dates
- Recurring tasks with auto-reset
- Today / Eisenhower / Inbox filtered views

**File integration**
- Preview files inline: Markdown (with LaTeX math), PDF, images, DOCX, XLSX, HTML
- Preview URLs via embedded browser (with persistent cookies)
- Link objects from filesystem, Obsidian vaults, Trilium notes, Zotero collections

**AI agent system** *(optional, requires [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code))*
- Embedded terminal (xterm.js + node-pty) running Claude Code per project
- Per-project virtual workspace with auto-generated CLAUDE.md
- Agent dispatch: main agent can orchestrate sub-agents across folders
- MCP integration for structured project/task/step management

## Quick start

```bash
git clone https://github.com/billyldc/lineup-public.git
cd lineup-public/frontend
npm install
npm run dev
```

The app auto-creates `~/.lineup/lineup.db` on first launch — no Python required for basic project management.

### Troubleshooting native modules

Electron uses a different Node ABI than system Node, so `better-sqlite3` and `node-pty` must be rebuilt against Electron's version. The `postinstall` script does this automatically, but if you see `NODE_MODULE_VERSION` errors:

```bash
npx electron-rebuild -f -o better-sqlite3
```

**node-pty requires Python with `distutils`.** On Python 3.12+ (where distutils was removed), you'll need:

```bash
pip3 install setuptools
npx electron-rebuild -f -o node-pty
```

If `node-pty` fails to build, the embedded terminal / chat panel will be disabled but the rest of the app still works.

### Optional: Python backend (for CLI + MCP + agent features)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv sync
uv run lu init
```

### Optional: Claude Code integration

Install [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), then the embedded terminal and per-project agents will activate automatically.

## Architecture

```
lineup/
  frontend/          # Electron + React app
    src/main/        # Main process: SQLite, IPC, pty manager
    src/preload/     # Context bridge
    src/renderer/    # React UI components
  lineup/            # Python backend (optional)
    store.py         # SQLite data layer
    server.py        # MCP server
    cli.py           # CLI commands
    types/           # Object type registry
    plugins/         # Knowledge source plugins
  ~/.lineup/
    lineup.db        # SQLite database (WAL mode)
    projects/        # Virtual project folders for agents
    config.json      # Optional configuration
```

## Configuration

Create `~/.lineup/config.json` to customize paths (all fields optional):

```json
{
  "triliumServerUrl": "http://localhost:37840",
  "zoteroDbPath": "~/Zotero/zotero.sqlite"
}
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Cmd+N | Quick-add task to Inbox |
| Left arrow | Go back one column |
| Esc | Go to root |
| Cmd +/- / Cmd+0 | Terminal font size |

## Tech stack

- **Frontend**: Electron 41, React 19, TypeScript, Tailwind CSS v4
- **Database**: better-sqlite3 (WAL mode, shared with Python)
- **Terminal**: xterm.js + node-pty
- **Markdown**: react-markdown + remark-math + rehype-katex
- **Preview**: mammoth (DOCX), SheetJS (XLSX), turndown (HTML to MD)

## License

MIT
