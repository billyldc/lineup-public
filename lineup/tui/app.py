"""Textual app for lineup.

Two screens:

- ProjectListScreen: all root projects, sorted by priority.
- ProjectDetailScreen: progress, sub-projects, todos, objects (sorted by open count).

Plus modal screens for create / delete / link / remove, and an embedded
ChatPanel widget docked on the right side of every screen. Press `c` to
toggle the panel; messages go through `claude --print --output-format json`
in the background, with the session_id captured from the first response so
subsequent messages resume the same conversation. Chat history lives on the
App so it survives push_screen / pop_screen.

Widgets are given stable ids so Pilot tests can `query_one("#project-table")`
and assert state without parsing rendered output. SVG snapshots cover
visual regression.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, Horizontal, Vertical
from textual.reactive import reactive
from textual.screen import ModalScreen, Screen
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Header,
    Input,
    Label,
    RichLog,
    Static,
)

import lineup
from lineup import store
from lineup.tui import data


# Repo root, derived from the package location so it works wherever lineup
# is installed.
LINEUP_REPO_ROOT = Path(lineup.__file__).resolve().parent.parent

# The chat panel runs `claude --print` with cwd in this isolated subdir.
# Reason: Claude Code stores sessions per-cwd, so using the repo root would
# collide with any parent Claude Code session the user might be running in
# the same dir. The .chat subdir is also the natural place for future
# "copy project context in" work — drop files here and the agent sees them.
LINEUP_CHAT_CWD = LINEUP_REPO_ROOT / ".chat"

def _generate_chat_claude_md() -> str:
    """Generate CLAUDE.md with a reference to all installed type skills."""
    header = """\
# lineup chat scratch directory

This directory is the cwd for the embedded chat panel in the lineup TUI.
It exists to keep the chat session isolated from any parent Claude Code
session running in `..` (the lineup repo).

The lineup MCP server is registered globally, so `lineup_*` tools work
regardless of cwd. Use them to read and modify the user's project state.
"""
    # Discover available skills
    try:
        from lineup import types as _types
        _types.load_all()
        skills = []
        for t in _types.all_types():
            sd = t.skill_dir()
            if sd is not None and sd.is_dir():
                skills.append(t)
    except Exception:
        skills = []

    if skills:
        header += "\n## Available object-type skills\n\n"
        for t in skills:
            header += f"- `skills/{t.name}/SKILL.md` — how to handle {t.display_label} ({t.name})\n"
        header += "\nRead these skill files to understand how to open, read, and manage each object type.\n"

    return header


def _copy_type_skills(chat_cwd: Path) -> None:
    """One-time static copy of all type skill/ dirs into .chat/skills/."""
    import shutil as _shutil

    try:
        from lineup import types as _types
        _types.load_all()
    except Exception:
        return

    skills_dir = chat_cwd / "skills"
    skills_dir.mkdir(exist_ok=True)

    for t in _types.all_types():
        src = t.skill_dir()
        if src is None or not src.is_dir():
            continue
        dst = skills_dir / t.name
        if dst.exists():
            _shutil.rmtree(dst)
        _shutil.copytree(src, dst)


# ── Chat data model ────────────────────────────────────────────────────────


@dataclass
class ChatMessage:
    role: str  # "user" or "assistant"
    text: str


@dataclass
class ChatState:
    """All chat state lives here, owned by the App so it survives screen changes."""

    history: list[ChatMessage] = field(default_factory=list)
    session_id: str | None = None  # captured from first claude response
    pending: bool = False  # True while a request is in flight


def _bar(percent: int, width: int = 20) -> str:
    filled = round(width * percent / 100)
    return "[" + "█" * filled + "░" * (width - filled) + "]"


class FlexDataTable(DataTable):
    """DataTable that distributes column widths proportionally to the
    container width, enabling automatic text wrapping. Set `col_ratios`
    after adding columns — widths are recalculated immediately AND on
    every subsequent resize.

    Example:
        table = FlexDataTable()
        table.add_column("名称")
        table.add_column("描述")
        table.col_ratios = [1, 3]   # 描述 gets 3x the width of 名称
    """

    _col_ratios: list[int] = []

    @property
    def col_ratios(self) -> list[int]:
        return self._col_ratios

    @col_ratios.setter
    def col_ratios(self, value: list[int]) -> None:
        self._col_ratios = value
        self._recalc_widths()

    def _recalc_widths(self) -> None:
        if not self._col_ratios or not self.columns:
            return
        cols = list(self.columns.values())
        if len(cols) != len(self._col_ratios):
            return
        width = self.size.width if self.size.width > 0 else 80
        padding_total = len(cols) * self.cell_padding * 2
        available = max(20, width - padding_total - 2)
        total = sum(self._col_ratios)
        for col, ratio in zip(cols, self._col_ratios):
            col.width = max(3, available * ratio // total)
            col.auto_width = False

    def on_resize(self, event) -> None:
        self._recalc_widths()



# ── Modal helpers ──────────────────────────────────────────────────────────


class ConfirmModal(ModalScreen[bool]):
    """Yes/no confirm dialog. Returns True for yes, False for no/cancel."""

    BINDINGS = [
        Binding("escape", "cancel", "取消"),
        Binding("y", "confirm", "确认"),
        Binding("n", "cancel", "取消"),
    ]

    def __init__(self, prompt: str) -> None:
        super().__init__()
        self._prompt = prompt

    def compose(self) -> ComposeResult:
        with Container(id="modal-box", classes="modal-box"):
            yield Label(self._prompt, id="confirm-prompt")
            with Horizontal(id="confirm-buttons"):
                yield Button("确认 (y)", id="confirm-yes", variant="error")
                yield Button("取消 (n)", id="confirm-no")

    def action_confirm(self) -> None:
        self.dismiss(True)

    def action_cancel(self) -> None:
        self.dismiss(False)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "confirm-yes")


class TextInputModal(ModalScreen[str | None]):
    """Single-field text input. Returns the entered text or None if cancelled."""

    BINDINGS = [
        Binding("escape", "cancel", "取消"),
    ]

    def __init__(self, title: str, placeholder: str = "", initial: str = "") -> None:
        super().__init__()
        self._title = title
        self._placeholder = placeholder
        self._initial = initial

    def compose(self) -> ComposeResult:
        with Container(id="modal-box", classes="modal-box"):
            yield Label(self._title, id="input-title")
            yield Input(
                value=self._initial,
                placeholder=self._placeholder,
                id="input-field",
            )
            with Horizontal(id="input-buttons"):
                yield Button("确认 (Enter)", id="input-ok", variant="primary")
                yield Button("取消 (Esc)", id="input-cancel")

    def on_mount(self) -> None:
        self.query_one("#input-field", Input).focus()

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        value = event.value.strip()
        self.dismiss(value if value else None)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "input-ok":
            value = self.query_one("#input-field", Input).value.strip()
            self.dismiss(value if value else None)
        else:
            self.dismiss(None)


class TwoFieldModal(ModalScreen[tuple[str, str] | None]):
    """Two-field input modal (e.g. for linking objects: target + name)."""

    BINDINGS = [
        Binding("escape", "cancel", "取消"),
    ]

    def __init__(
        self,
        title: str,
        field1_label: str,
        field2_label: str,
        field1_placeholder: str = "",
        field2_placeholder: str = "",
    ) -> None:
        super().__init__()
        self._title = title
        self._f1 = field1_label
        self._f2 = field2_label
        self._p1 = field1_placeholder
        self._p2 = field2_placeholder

    def compose(self) -> ComposeResult:
        with Container(id="modal-box", classes="modal-box"):
            yield Label(self._title, id="input-title")
            yield Label(self._f1)
            yield Input(placeholder=self._p1, id="input-field-1")
            yield Label(self._f2)
            yield Input(placeholder=self._p2, id="input-field-2")
            with Horizontal(id="input-buttons"):
                yield Button("确认", id="two-ok", variant="primary")
                yield Button("取消 (Esc)", id="two-cancel")

    def on_mount(self) -> None:
        self.query_one("#input-field-1", Input).focus()

    def action_cancel(self) -> None:
        self.dismiss(None)

    def _submit(self) -> None:
        v1 = self.query_one("#input-field-1", Input).value.strip()
        v2 = self.query_one("#input-field-2", Input).value.strip()
        if not v1 or not v2:
            return  # require both
        self.dismiss((v1, v2))

    def on_input_submitted(self, event: Input.Submitted) -> None:
        # Enter on field 1 → focus field 2; on field 2 → submit
        if event.input.id == "input-field-1":
            self.query_one("#input-field-2", Input).focus()
        else:
            self._submit()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "two-ok":
            self._submit()
        else:
            self.dismiss(None)


# ── Chat panel ─────────────────────────────────────────────────────────────


DEFAULT_CHAT_PANEL_WIDTH = 50
MIN_CHAT_PANEL_WIDTH = 20
MAX_CHAT_PANEL_WIDTH = 200


class ChatPanel(Vertical):
    """Embedded chat panel docked to the right of every screen.

    Reads/writes chat state from `app.chat_state` (shared across screens).
    Messages are sent via `claude --print --output-format json` in a worker;
    responses are appended to the chat log.

    Hidden by default; toggled via `c` at the screen level. Width is
    adjustable via app-level `ctrl+w`.
    """

    DEFAULT_CSS = """
    ChatPanel {
        dock: right;
        width: 50;
        background: $surface;
        border-left: heavy $primary;
        display: none;
        layout: vertical;
    }
    ChatPanel.-visible {
        display: block;
    }
    ChatPanel #chat-log {
        height: 1fr;
        padding: 1 1;
        background: $surface;
    }
    ChatPanel #chat-status {
        height: 1;
        padding: 0 2;
        color: $text-muted;
    }
    ChatPanel #chat-input {
        height: 3;
        margin: 0 1 1 1;
    }
    """

    panel_width: reactive[int] = reactive(DEFAULT_CHAT_PANEL_WIDTH)

    def watch_panel_width(self, new_width: int) -> None:
        """Reactively resize the panel when panel_width changes."""
        self.styles.width = new_width

    def compose(self) -> ComposeResult:
        yield RichLog(id="chat-log", wrap=True, markup=True, highlight=False)
        yield Static("", id="chat-status")
        yield Input(placeholder="问 claude…  (esc 返回主界面)", id="chat-input")

    def on_mount(self) -> None:
        self.refresh_view()

    @property
    def state(self) -> ChatState:
        return self.app.chat_state  # type: ignore[attr-defined]

    def is_visible(self) -> bool:
        return self.has_class("-visible")

    def show(self) -> None:
        self.add_class("-visible")
        self.refresh_view()
        self.query_one("#chat-input", Input).focus()

    def hide(self) -> None:
        self.remove_class("-visible")
        # Send focus back to the screen's main content
        self.app.set_focus(None)

    def toggle(self) -> None:
        if self.is_visible():
            self.hide()
        else:
            self.show()

    def refresh_view(self) -> None:
        """Repopulate the log + status from current app state."""
        log = self.query_one("#chat-log", RichLog)
        log.clear()
        for msg in self.state.history:
            if msg.role == "user":
                log.write(f"[bold cyan]you[/]  {msg.text}")
            else:
                log.write(f"[bold green]claude[/]  {msg.text}")
            log.write("")  # spacing
        status = self.query_one("#chat-status", Static)
        if self.state.pending:
            status.update("● 思考中…")
        else:
            sid = self.state.session_id
            status.update(f"● 会话 {sid[:8]}…" if sid else "● 新会话")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        if not text or self.state.pending:
            return
        event.input.value = ""
        # Optimistically append the user message and refresh.
        self.state.history.append(ChatMessage("user", text))
        self.state.pending = True
        self.refresh_view()
        # Hand off to the app, which knows how to drive the worker.
        self.app.send_chat_message(text)  # type: ignore[attr-defined]


# ── Project list ────────────────────────────────────────────────────────────


# Actions that must be suppressed when the chat panel has focus,
# so single-letter keys go to the chat input instead of triggering bindings.
_CHAT_SUPPRESSED_ACTIONS = {
    "app.quit",  # q
    "refresh",   # r
    "new_project",  # n
    "delete_project",  # d
    "open_project",  # enter / right (list)
    "link_object",  # o
    "remove_object",  # x
    "open_item",  # enter / right (detail)
    "go_parent",  # left
    "go_root_or_close_chat",  # esc (detail) — ctrl+q handles close when chatting
    "app.toggle_chat",  # c
}


class _ChatAwareScreen(Screen):
    """Mixin-style base that suppresses single-key bindings while chat is open."""

    def _chat_panel_is_open(self) -> bool:
        try:
            panel = self.query_one(ChatPanel)
            return panel.is_visible()
        except Exception:
            return False

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        """Return False to block an action when the chat panel is active."""
        if self._chat_panel_is_open() and action in _CHAT_SUPPRESSED_ACTIONS:
            return False
        return True


class ProjectListScreen(_ChatAwareScreen):
    BINDINGS = [
        Binding("q", "app.quit", "退出"),
        Binding("ctrl+c", "app.quit", "退出", show=False),
        Binding("ctrl+q", "app.close_chat", "关闭Chat", show=False),
        Binding("enter", "open_project", "打开", show=False),
        Binding("right", "open_project", "→进入"),
        Binding("r", "refresh", "刷新"),
        Binding("n", "new_project", "新建"),
        Binding("d", "delete_project", "删除"),
        Binding("c", "app.toggle_chat", "Chat"),
        Binding("escape", "app.close_chat", "", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        yield FlexDataTable(id="project-table", cursor_type="row", zebra_stripes=True)
        yield ChatPanel(id="chat-panel")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "lineup"
        self.sub_title = "所有项目"
        table = self.query_one("#project-table", FlexDataTable)
        table.add_column("优先级")
        table.add_column("名称")
        table.add_column("进度")
        table.add_column("描述")
        table.col_ratios = [2, 5, 2, 8]  # 描述最宽,名称次之
        self._reload(table)
        table.focus()

    def _reload(self, table: DataTable | None = None) -> None:
        if table is None:
            table = self.query_one("#project-table", FlexDataTable)
        table.clear()
        for p in data.list_root_projects():
            table.add_row(
                str(p.priority),
                p.name,
                f"{p.progress}%" if p.progress else "",
                p.description,
                key=str(p.id),
                height=None,  # auto-height: rows expand to fit wrapped text
            )

    def action_refresh(self) -> None:
        self._reload()

    def _project_id_at_cursor(self) -> int | None:
        table = self.query_one("#project-table", FlexDataTable)
        if table.row_count == 0:
            return None
        try:
            row_key = table.coordinate_to_cell_key(table.cursor_coordinate).row_key
        except Exception:
            return None
        if row_key.value is None:
            return None
        return int(row_key.value)

    def _project_at_cursor(self) -> data.ProjectRow | None:
        pid = self._project_id_at_cursor()
        if pid is None:
            return None
        return data.get_project(pid)

    def action_open_project(self) -> None:
        project_id = self._project_id_at_cursor()
        if project_id is not None:
            self.app.push_screen(ProjectDetailScreen(project_id))

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        if event.row_key.value is None:
            return
        self.app.push_screen(ProjectDetailScreen(int(event.row_key.value)))

    # ── CRUD ────────────────────────────────────────────────────────────

    def action_new_project(self) -> None:
        def after(name: str | None) -> None:
            if not name:
                return
            store.create_project(name)
            self._reload()

        self.app.push_screen(
            TextInputModal("新建项目", placeholder="项目名称…"),
            after,
        )

    def action_delete_project(self) -> None:
        proj = self._project_at_cursor()
        if proj is None:
            return

        def after(confirmed: bool) -> None:
            if not confirmed:
                return
            store.delete_project(proj.name)
            self._reload()

        self.app.push_screen(
            ConfirmModal(f"删除项目「{proj.name}」？\n（对象/待办会一起删除，子项目保留）"),
            after,
        )

    def chat_context(self) -> str | None:
        return None  # no specific project context from the list view


# ── Project detail ─────────────────────────────────────────────────────────


# Display labels for object types in the unified items table.
_OBJECT_TYPE_LABELS = {
    "file": "文件",
    "folder": "文件夹",
    "url": "链接",
    "zotero": "文献",
    "trilium": "笔记",
    "obsidian": "笔记",
    "script": "脚本",
}


class ProjectDetailScreen(_ChatAwareScreen):
    BINDINGS = [
        Binding("left", "go_parent", "←上级"),
        Binding("right", "open_item", "→进入", show=False),
        Binding("enter", "open_item", "打开", show=False),
        Binding("escape", "go_root_or_close_chat", "esc主页"),
        Binding("q", "app.quit", "退出"),
        Binding("ctrl+c", "app.quit", "退出", show=False),
        Binding("ctrl+q", "app.close_chat", "关闭Chat", show=False),
        Binding("r", "refresh", "刷新"),
        Binding("o", "link_object", "新建对象"),
        Binding("x", "remove_object", "删除对象"),
        Binding("c", "app.toggle_chat", "Chat"),
    ]

    def __init__(self, project_id: int) -> None:
        super().__init__()
        self.project_id = project_id

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        yield Static("", id="detail-progress")
        with Horizontal(id="detail-columns"):
            with Vertical(id="detail-left"):
                yield Static("项目 + 对象（按打开次数排序）", classes="section-title")
                yield FlexDataTable(id="items-table", cursor_type="row", zebra_stripes=True)
            with Vertical(id="detail-right"):
                yield Static("待办", classes="section-title")
                yield FlexDataTable(id="todos-table", cursor_type="row")
        yield ChatPanel(id="chat-panel")
        yield Footer()

    def action_go_parent(self) -> None:
        """← go up one level (back to parent project or root list)."""
        self.app.pop_screen()

    def action_go_root_or_close_chat(self) -> None:
        """Esc: close chat if open, otherwise pop all the way to root list."""
        try:
            panel = self.query_one(ChatPanel)
        except Exception:
            panel = None
        if panel is not None and panel.is_visible():
            panel.hide()
            return
        # Pop all screens back to root (ProjectListScreen)
        while not isinstance(self.app.screen, ProjectListScreen):
            self.app.pop_screen()

    def on_mount(self) -> None:
        items_table = self.query_one("#items-table", FlexDataTable)
        items_table.add_column("类型")
        items_table.add_column("名称")
        items_table.add_column("打开")
        items_table.add_column("详情")
        items_table.col_ratios = [2, 4, 1, 7]

        todo_table = self.query_one("#todos-table", FlexDataTable)
        todo_table.add_column(" ")
        todo_table.add_column("内容")
        todo_table.add_column("截止")
        todo_table.col_ratios = [1, 5, 3]

        self._reload()
        items_table.focus()

    def _reload(self) -> None:
        project = data.get_project(self.project_id)
        if project is None:
            self.title = "lineup"
            self.sub_title = "（项目已删除）"
            return

        self.title = f"lineup · {project.name}"
        self.sub_title = f"优先级 {project.priority}"

        progress_widget = self.query_one("#detail-progress", Static)
        bar = _bar(project.progress)
        line = f"进度 {bar} {project.progress}%"
        if project.progress_note:
            line += f"  — {project.progress_note}"
        if project.description:
            line += f"\n{project.description}"
        progress_widget.update(line)

        items_table = self.query_one("#items-table", FlexDataTable)
        items_table.clear()

        # Projects on top (folders), sorted by open count desc.
        for sp in data.list_sub_projects(self.project_id):
            detail = f"优先级 {sp.priority}"
            if sp.progress:
                detail += f" · {sp.progress}%"
            if sp.progress_note:
                detail += f" · {sp.progress_note}"
            elif sp.description:
                detail += f" · {sp.description}"
            items_table.add_row(
                "项目",
                sp.name,
                str(sp.open_count),
                detail,
                key=f"p:{sp.id}",
                height=None,
            )

        # Objects below (files), sorted by open count desc (data layer).
        for o in data.list_objects(self.project_id):
            type_label = _OBJECT_TYPE_LABELS.get(o.type, o.type)
            items_table.add_row(
                type_label,
                o.name,
                str(o.open_count),
                store.pretty_target(o.target),
                key=f"o:{o.name}",
                height=None,
            )

        todo_table = self.query_one("#todos-table", FlexDataTable)
        todo_table.clear()
        for t in data.list_todos(self.project_id):
            todo_table.add_row("[x]" if t.done else "[ ]", t.text, t.due_date or "", height=None)

    def action_refresh(self) -> None:
        self._reload()

    def chat_context(self) -> str | None:
        project = data.get_project(self.project_id)
        if project is None:
            return None
        return (
            f"The user is currently viewing the lineup project "
            f"\"{project.name}\" (priority {project.priority}, "
            f"progress {project.progress}%) in the lineup TUI. "
            f"Default to operating on this project when commands are ambiguous."
        )

    # ── Cursor / row helpers ──────────────────────────────────────────

    def _row_key_at_cursor(self) -> str | None:
        items_table = self.query_one("#items-table", FlexDataTable)
        if items_table.row_count == 0:
            return None
        try:
            row_key = items_table.coordinate_to_cell_key(items_table.cursor_coordinate).row_key
        except Exception:
            return None
        return row_key.value  # encoded as "p:<id>" or "o:<name>"

    # ── Drill-in / open ────────────────────────────────────────────────

    def action_open_item(self) -> None:
        key = self._row_key_at_cursor()
        if key is None:
            return
        if key.startswith("p:"):
            sub_id = int(key[2:])
            self.app.push_screen(ProjectDetailScreen(sub_id))
        elif key.startswith("o:"):
            self._open_object(key[2:])

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        key = event.row_key.value
        if key is None:
            return
        if key.startswith("p:"):
            self.app.push_screen(ProjectDetailScreen(int(key[2:])))
        elif key.startswith("o:"):
            self._open_object(key[2:])

    def _open_object(self, obj_name: str) -> None:
        """Open an object via the type system (which calls the right app)."""
        project = data.get_project(self.project_id)
        if project is None:
            return
        result = store.open_object(obj_name, project=project.name)
        self.notify(result)

    # ── CRUD ────────────────────────────────────────────────────────────

    def action_link_object(self) -> None:
        project = data.get_project(self.project_id)
        if project is None:
            return

        def after(result: tuple[str, str] | None) -> None:
            if result is None:
                return
            target, name = result
            store.link_object(target, name, project=project.name)
            self._reload()

        self.app.push_screen(
            TwoFieldModal(
                title=f"为「{project.name}」链接对象",
                field1_label="目标 (路径 / URL / zotero://…)",
                field2_label="显示名称",
                field1_placeholder="~/Documents/notes.md 或 https://...",
                field2_placeholder="对象名称",
            ),
            after,
        )

    def action_remove_object(self) -> None:
        key = self._row_key_at_cursor()
        if key is None:
            return
        if not key.startswith("o:"):
            self.notify("光标在项目行上。x 只能删除对象（文件/链接）。", severity="warning")
            return
        obj_name = key[2:]
        project = data.get_project(self.project_id)
        if project is None:
            return

        def after(confirmed: bool) -> None:
            if not confirmed:
                return
            store.remove_object(obj_name, project=project.name)
            self._reload()

        self.app.push_screen(
            ConfirmModal(f"从「{project.name}」中移除对象「{obj_name}」？\n（不会删除源文件）"),
            after,
        )


# ── App ────────────────────────────────────────────────────────────────────


CSS = """
Screen {
    layers: base overlay;
    overflow-x: hidden;
}

#detail-progress {
    padding: 1 2;
    background: $boost;
    color: $text;
    width: 100%;
}

.section-title {
    padding: 1 2 0 2;
    text-style: bold;
    color: $accent;
}

#detail-columns {
    height: 1fr;
    width: 100%;
}

#detail-left {
    width: 2fr;
    overflow-x: hidden;
}

#detail-right {
    width: 1fr;
    overflow-x: hidden;
}

DataTable {
    height: auto;
    max-height: 20;
    width: 100%;
    overflow-x: hidden;
}

ModalScreen {
    align: center middle;
}

.modal-box {
    width: 60;
    height: auto;
    padding: 1 2;
    background: $surface;
    border: thick $primary;
}

#confirm-buttons, #input-buttons {
    margin-top: 1;
    height: auto;
    align: right middle;
}

#confirm-buttons Button, #input-buttons Button {
    margin-left: 1;
}

#confirm-prompt, #input-title {
    margin-bottom: 1;
    text-style: bold;
}
"""


class LineupApp(App):
    CSS = CSS
    TITLE = "lineup"

    BINDINGS = [
        Binding("c", "toggle_chat", "Chat"),
        Binding("ctrl+b", "set_chat_width", "调宽度"),
    ]

    CHAT_MODEL = "sonnet"  # Sonnet 4.5 alias resolved by claude --model
    CHAT_CWD = LINEUP_CHAT_CWD  # overridable in tests

    def __init__(self) -> None:
        super().__init__()
        self.chat_state = ChatState()

    def get_default_screen(self) -> Screen:
        return ProjectListScreen()

    # ── Chat panel control ──────────────────────────────────────────────

    def _ensure_chat_cwd(self) -> Path:
        """Create the isolated chat cwd on first use.

        On first creation:
        - Writes CLAUDE.md (generated with skill references)
        - Copies all type skill/ dirs into .chat/skills/ (static, one-time)

        CLAUDE.md is regenerated each time (it's auto-generated, not user-edited).
        Skills are re-copied each time to pick up any newly installed types.
        """
        cwd = self.CHAT_CWD
        cwd.mkdir(parents=True, exist_ok=True)
        # Always regenerate CLAUDE.md so skill references stay up to date.
        claude_md = cwd / "CLAUDE.md"
        claude_md.write_text(_generate_chat_claude_md())
        # Copy all type skills into .chat/skills/
        _copy_type_skills(cwd)
        return cwd

    def _current_chat_panel(self) -> ChatPanel | None:
        if isinstance(self.screen, ModalScreen):
            return None
        try:
            return self.screen.query_one(ChatPanel)
        except Exception:
            return None

    def action_toggle_chat(self) -> None:
        panel = self._current_chat_panel()
        if panel is None:
            return
        panel.toggle()

    def action_close_chat(self) -> None:
        """Esc on the project list: close panel if open, otherwise no-op."""
        panel = self._current_chat_panel()
        if panel is not None and panel.is_visible():
            panel.hide()

    def action_set_chat_width(self) -> None:
        """Open a small modal to set the chat panel width in cells."""
        panel = self._current_chat_panel()
        if panel is None or not panel.is_visible():
            return

        def after(value: str | None) -> None:
            if value is None:
                return
            try:
                n = int(value)
            except ValueError:
                self.notify(f"请输入整数，收到 {value!r}", severity="warning")
                return
            if n < MIN_CHAT_PANEL_WIDTH or n > MAX_CHAT_PANEL_WIDTH:
                self.notify(
                    f"宽度需在 {MIN_CHAT_PANEL_WIDTH}–{MAX_CHAT_PANEL_WIDTH} 之间，收到 {n}",
                    severity="warning",
                )
                return
            panel.panel_width = n

        self.push_screen(
            TextInputModal(
                title=f"chat 面板宽度 (cells, {MIN_CHAT_PANEL_WIDTH}-{MAX_CHAT_PANEL_WIDTH})",
                initial=str(panel.panel_width),
                placeholder="例如: 60",
            ),
            after,
        )

    # ── Sending a message ──────────────────────────────────────────────

    def _build_chat_command(self, text: str, context: str | None) -> list[str]:
        """Build argv for one --print call.

        - Uses --resume <session_id> if we already have one (captured from a
          previous response), otherwise the call creates a fresh session and
          we capture the new id from the JSON output.
        - --output-format json so we get a clean structured response with
          `result` and `session_id` fields.
        - Optional --append-system-prompt for current screen context.
        """
        cmd = [
            "claude",
            "--print",
            "--output-format",
            "json",
            "--model",
            self.CHAT_MODEL,
        ]
        if self.chat_state.session_id:
            cmd.extend(["--resume", self.chat_state.session_id])
        if context:
            cmd.extend(["--append-system-prompt", context])
        cmd.append(text)
        return cmd

    def _current_screen_context(self) -> str | None:
        if isinstance(self.screen, ModalScreen):
            return None
        context_fn: Callable[[], str | None] | None = getattr(
            self.screen, "chat_context", None
        )
        return context_fn() if context_fn else None

    def send_chat_message(self, text: str) -> None:
        """Entry point for the panel: kick off a worker that calls claude."""
        if shutil.which("claude") is None:
            self._on_chat_error("找不到 claude 命令。请先安装 Claude Code")
            return
        context = self._current_screen_context()
        self.run_worker(
            self._chat_worker(text, context),
            exclusive=True,
            group="chat",
        )

    async def _chat_worker(self, text: str, context: str | None) -> None:
        """Run claude --print in the background and post the result back."""
        cwd = self._ensure_chat_cwd()
        cmd = self._build_chat_command(text, context)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, stderr_b = await proc.communicate()
        except FileNotFoundError:
            self._on_chat_error("找不到 claude 命令")
            return
        except Exception as e:
            self._on_chat_error(f"调用 claude 失败：{e}")
            return

        if proc.returncode != 0:
            err = stderr_b.decode("utf-8", errors="replace").strip()
            self._on_chat_error(f"claude 退出码 {proc.returncode}: {err or '(无 stderr)'}")
            return

        try:
            payload = json.loads(stdout_b.decode("utf-8", errors="replace"))
        except json.JSONDecodeError as e:
            self._on_chat_error(f"无法解析 claude 输出：{e}")
            return

        result_text = payload.get("result") or payload.get("text") or ""
        session_id = payload.get("session_id")
        self._on_chat_success(result_text, session_id)

    def _on_chat_success(self, text: str, session_id: str | None) -> None:
        if session_id and not self.chat_state.session_id:
            self.chat_state.session_id = session_id
        self.chat_state.history.append(ChatMessage("assistant", text))
        self.chat_state.pending = False
        panel = self._current_chat_panel()
        if panel is not None:
            panel.refresh_view()

    def _on_chat_error(self, message: str) -> None:
        self.chat_state.history.append(ChatMessage("assistant", f"[错误] {message}"))
        self.chat_state.pending = False
        panel = self._current_chat_panel()
        if panel is not None:
            panel.refresh_view()


def run() -> None:
    LineupApp().run()
