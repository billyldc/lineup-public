# Agent session browser

Lineup discovers conversations from multiple agent toolchains, all read-only:

| Agent | Storage | View | Resume in lineup |
| --- | --- | --- | --- |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | ✅ | ✅ |
| [openclaw](https://openclaw.dev) | same as Claude Code (it's a Claude Code wrapper) — auto-detected by path | ✅ | ✅ |
| [Codex](https://github.com/openai/codex) | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` | ✅ | ❌ (see below) |
| Hermes | `~/.hermes/sessions/<YYYYMMDD>_<HHMMSS>_<id>.jsonl` | ✅ | ❌ |

Each row in the Agents view gets a coloured badge for its agent of origin. Filter chips at the top of the view let you narrow to a single source. Drilling into a session opens the inspector with the full prompt+response timeline, model, tokens (where the source records them), and tool call summary.

## Adding a new agent

Most agents drop one JSONL per session. To add a reader:

1. Open `frontend/src/main/sessionSources.ts`.
2. Add a `listFooSessions()` that walks the agent's session dir and returns `SessionListEntry[]` (one per file). Cheap path: open each file and read enough lines to find cwd + first user message + last timestamp. Most agents put a `session_meta` row at the top.
3. Add a `readFooSession(filePath)` that fully parses one file into `SessionData` (timeline + stats). Map the agent's roles to the existing `TimelineEvent.kind` union (`user`, `assistant-text`, `thinking`, `tool-use`, `tool-result`, `system`).
4. Register the source in `listExternalSessions()` (just push your `list…` results onto the array).

The Codex (~120 lines) and Hermes (~80 lines) readers are good templates.

## Codex resume in the embedded terminal — what would it take?

Right now, double-clicking a Codex session in the Agents view does nothing — lineup hides the "open in lineup terminal" affordance for non-Claude sources. Codex does support `codex resume <session-id>`, so adding lineup-side resume is small. Here's the punch list:

- **Pty spawn** (~5 lines). `frontend/src/main/index.ts:spawnPty` already takes an arbitrary `command` string and writes it into a freshly spawned interactive shell. Add a new `ChatTab.kind: 'claude' | 'codex'` field; when `kind === 'codex'`, set `command = \`codex resume ${sessionId}\`` instead of `claude --resume`. No changes to xterm.js or the shell wrapper — codex's TUI renders fine on `xterm-256color`.

- **Resume cwd resolution** (~10 lines). Codex records `cwd` in the `session_meta` line, same as Claude. Reuse the existing pattern: read the jsonl header to get the cwd, then `spawn shell with cwd=that_dir` and `command=codex resume <id>`. The session_meta line is already parsed in `sessionSources.ts:codexHeader`.

- **ChatTab persistence** (~5 lines). The `lineup:chatTabs` localStorage entry stores `{id, label, cwd, command}`. Add `kind` to that shape (default `'claude'`) so a restored Codex tab spawns the right command. The hibernated-on-restart path doesn't need to change.

- **Auth / config**. Codex auth lives at `~/.codex/auth.json` — it's machine-wide, just like `~/.claude/credentials`. Lineup doesn't have to do anything; if `codex` works in your terminal, it works in the embedded pty.

- **Open-in-Terminal context menu** (~3 lines). Same gate, just emit `codex resume <id>` instead of `claude --resume <id>`. Reuse the existing `openExternalTerminalWithCommand` IPC.

- **Things that DON'T port over (and how to handle them)**:
  - The `agents` SQLite table — DB-backed agents are a Claude-Code specific concept tied to per-project `main_agent_session_id`. Codex sessions just stay discovery-only (no DB row, no project link). The list-row badge `★` won't appear on them — that's correct.
  - `resolveResumeCwd` — uses Claude's flat `~/.claude/projects/<encoded>/` shape to handle rename / fork cases. Codex doesn't have that drift problem (the cwd is right there in `session_meta`), so we skip it.
  - `generateSessionTitle` (MimoGenerate) — current prompt assumes Claude's jsonl event schema. Either skip auto-titling for Codex, or write a small adapter that walks `events[]` (already normalised) instead of the raw jsonl. Pick "skip" for v1.

**Estimated effort**: half a day for the basic resume path, including testing that `codex resume` plays nice with the embedded pty across a few sessions. Add another half-day if you want auto-title parity.

**Why it's deferred**: lineup's chat panel was modeled around Claude's `--resume` semantics. The Codex CLI uses subcommands (`codex resume`, `codex fork`) and its TUI handles its own keybindings; making the lineup-side keyboard-shortcut layer behave well across both takes some manual exploration. Not hard, just hasn't been done yet.

## Hermes resume

Hermes doesn't have a documented CLI for resuming a recorded session yet — it's primarily an agent runtime, not a chat client. View-only is the right answer.
