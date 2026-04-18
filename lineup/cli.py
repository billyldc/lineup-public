"""lineup CLI - quick project browser."""

import os
import click
from lineup import store
from lineup import plugins

plugins.load_all()


def styled_header(text: str) -> str:
    return click.style(text, bold=True)


def styled_dim(text: str) -> str:
    return click.style(text, dim=True)


def styled_ok(text: str) -> str:
    return click.style(text, fg="green")


def styled_warn(text: str) -> str:
    return click.style(text, fg="yellow")


def styled_err(text: str) -> str:
    return click.style(text, fg="red")


def priority_color(p: int) -> str:
    colors = {5: "red", 4: "yellow", 3: "white", 2: "cyan", 1: "blue"}
    return colors.get(p, "white")


def colored_bar(percent: int, width: int = 20) -> str:
    filled = round(width * percent / 100)
    if percent >= 80:
        color = "green"
    elif percent >= 40:
        color = "yellow"
    else:
        color = "red"
    bar = click.style("█" * filled, fg=color) + styled_dim("░" * (width - filled))
    return f"[{bar}]"


@click.group(invoke_without_command=True)
@click.pass_context
def cli(ctx):
    """lineup - project management from the terminal."""
    if ctx.invoked_subcommand is None:
        # Default: show current project overview, or list all projects
        cur = store.get_active_context()
        if cur:
            ctx.invoke(show)
        else:
            ctx.invoke(ls)


@cli.command()
def init():
    """Initialize lineup."""
    click.echo(store.init_db())


@cli.command()
def ui():
    """Launch the Textual TUI."""
    try:
        from lineup.tui.app import run as run_tui
    except ImportError as e:
        raise click.ClickException(
            f"未安装 TUI 依赖：{e}\n请运行：uv sync --extra ui"
        )
    run_tui()


# ── Browse (JSON output for frontend) ──────────────────────────────────────


@cli.group("browse")
def browse_group():
    """Browse external data sources (outputs JSON for programmatic use)."""


def _items_to_json(items):
    import json
    return json.dumps([{
        "id": i.id,
        "name": i.name,
        "target": i.target,
        "type": i.type,
        "default_app": i.default_app,
        "preview": i.preview,
    } for i in items], ensure_ascii=False)


@browse_group.command("obsidian")
@click.argument("path", required=False, default="")
def browse_obsidian(path):
    """List Obsidian vault contents at PATH (empty = vault roots)."""
    import json
    obs = plugins.get("obsidian")
    if obs is None:
        click.echo(json.dumps({"error": "obsidian plugin not loaded"}))
        return
    click.echo(_items_to_json(obs.browse(path)))


@browse_group.command("trilium")
@click.argument("parent_id", required=False, default="")
def browse_trilium(parent_id):
    """List Trilium notes under PARENT_ID (empty = root children)."""
    import json
    tri = plugins.get("trilium")
    if tri is None:
        click.echo(json.dumps({"error": "trilium plugin not loaded"}))
        return
    click.echo(_items_to_json(tri.browse(parent_id)))


@browse_group.command("zotero")
@click.argument("path", required=False, default="")
def browse_zotero(path):
    """List Zotero collections / items at PATH (empty = top-level collections).

    PATH is a Zotero select URI:
        zotero://select/library/collections/<key>  → that collection's children
        zotero://select/library/items/<key>        → empty (leaf)
    """
    import json
    zot = plugins.get("zotero")
    if zot is None:
        click.echo(json.dumps({"error": "zotero plugin not loaded"}))
        return
    click.echo(_items_to_json(zot.browse(path)))


# ── Search (JSON output for frontend) ──────────────────────────────────────


@cli.group("search")
def search_group():
    """Search external data sources (outputs JSON for programmatic use)."""


@search_group.command("obsidian")
@click.argument("query")
@click.option("--limit", default=20, help="Max results")
def search_obsidian(query, limit):
    """Search Obsidian notes by filename and content."""
    import json
    obs = plugins.get("obsidian")
    if obs is None:
        click.echo(json.dumps({"error": "obsidian plugin not loaded"}))
        return
    click.echo(_items_to_json(obs.search(query, limit=limit)))


@search_group.command("trilium")
@click.argument("query")
@click.option("--limit", default=20, help="Max results")
def search_trilium(query, limit):
    """Search Trilium notes by title and content."""
    import json
    tri = plugins.get("trilium")
    if tri is None:
        click.echo(json.dumps({"error": "trilium plugin not loaded"}))
        return
    click.echo(_items_to_json(tri.search(query, limit=limit)))


@search_group.command("zotero")
@click.argument("query")
@click.option("--limit", default=20, help="Max results")
def search_zotero(query, limit):
    """Search Zotero items by title."""
    import json
    zot = plugins.get("zotero")
    if zot is None:
        click.echo(json.dumps({"error": "zotero plugin not loaded"}))
        return
    click.echo(_items_to_json(zot.search(query, limit=limit)))


# ── Types ──────────────────────────────────────────────────────────────────


@cli.group("types")
def types_group():
    """Object type system commands."""


@types_group.command("list")
def types_list():
    """Show all registered object types and their skill status."""
    from lineup import types
    types.load_all()
    click.echo(styled_header(f"已注册 {len(types.all_types())} 个对象类型："))
    for t in types.all_types():
        skill = t.skill_dir()
        has_skill = "✓ skill" if skill and skill.is_dir() else "  —"
        click.echo(
            f"  [{t.priority:>3}] {t.name:<12} {t.display_label:<6} {has_skill}"
        )


# ── Todoist sync ───────────────────────────────────────────────────────────


@cli.group()
def todoist():
    """Todoist integration commands."""


def _action_marker(kind: str) -> str:
    return {
        "skip": styled_dim("·"),
        "already-linked": styled_dim("="),
        "link": click.style("↔", fg="cyan"),
        "create": styled_ok("+"),
    }.get(kind, "?")


@todoist.command("sync")
@click.option("--dry-run", is_flag=True, default=False, help="只显示计划，不写入数据库")
@click.option(
    "--create-missing/--no-create-missing",
    default=False,
    help="为没有匹配的 Todoist 项目在 lineup 创建新项目",
)
@click.option(
    "--skip",
    multiple=True,
    metavar="NAME",
    help="额外跳过的 Todoist 项目名（Inbox 默认跳过，可重复指定）",
)
@click.option("--yes", "-y", is_flag=True, default=False, help="跳过确认直接执行")
def todoist_sync(dry_run, create_missing, skip, yes):
    """Sync Todoist projects → lineup projects.

    Strategy: name match links existing lineup projects to Todoist; otherwise
    a project is created in lineup (only with --create-missing). Inbox is
    skipped by default.
    """
    from lineup.plugins import todoist as td_plugin

    try:
        projects = td_plugin.fetch_projects()
    except td_plugin.TodoistError as e:
        raise click.ClickException(str(e))

    actions = td_plugin.plan_sync(projects, extra_skip=set(skip))

    click.echo(styled_header(f"Todoist → lineup 同步计划（{len(projects)} 个 Todoist 项目）"))
    counts: dict[str, int] = {}
    for a in actions:
        counts[a.kind] = counts.get(a.kind, 0) + 1
        marker = _action_marker(a.kind)
        line = f"  {marker} {a.todoist.name}"
        if a.lineup_id is not None:
            line += styled_dim(f"  → lineup #{a.lineup_id} ({a.lineup_name})")
        if a.note:
            line += styled_dim(f"  [{a.note}]")
        if a.kind == "create":
            if create_missing:
                line += styled_dim("  — 将在 lineup 中新建")
            else:
                line += styled_dim("  — 跳过（用 --create-missing 才会创建）")
        click.echo(line)

    click.echo()
    summary_bits = [f"{k}={v}" for k, v in sorted(counts.items())]
    click.echo(styled_dim("  ".join(summary_bits)))

    if dry_run:
        click.echo(styled_dim("\n--dry-run，未执行任何修改"))
        return

    will_mutate = any(
        a.kind == "link" or (a.kind == "create" and create_missing) for a in actions
    )
    if not will_mutate:
        click.echo(styled_dim("\n没有需要写入的变更"))
        return

    if not yes and not click.confirm("\n执行以上同步？"):
        click.echo("已取消")
        return

    summary = td_plugin.apply_sync(actions, create_missing=create_missing)
    click.echo(
        styled_ok(
            f"完成：linked={summary.linked}, created={summary.created}, "
            f"create_skipped={summary.create_skipped}, "
            f"already={summary.already}, skipped={summary.skipped}"
        )
    )


@todoist.command("link")
@click.argument("todoist_ref")
@click.argument("lineup_name")
def todoist_link(todoist_ref, lineup_name):
    """手动把一个 lineup 项目链接到 Todoist 项目。

    TODOIST_REF: Todoist 项目名称，或 id:xxx
    LINEUP_NAME: lineup 项目名称（必须已存在）
    """
    from lineup.plugins import todoist as td_plugin
    try:
        click.echo(td_plugin.link_project(todoist_ref, lineup_name))
    except td_plugin.TodoistError as e:
        raise click.ClickException(str(e))


@todoist.command("unlink")
@click.argument("lineup_name")
def todoist_unlink(lineup_name):
    """解除 lineup 项目和 Todoist 的链接（lineup 项目本身保留）。"""
    from lineup.plugins import todoist as td_plugin
    click.echo(td_plugin.unlink_project(lineup_name))


@cli.command()
def ls():
    """List contents. In root: all projects. In a project: sub-projects and objects."""
    cur = store.get_current_project()

    conn = store.get_db()
    try:
        if cur:
            # Inside a project: show sub-projects + objects
            kids = conn.execute(
                "SELECT p.* FROM projects p JOIN project_parents pp ON p.id = pp.project_id WHERE pp.parent_id = ? ORDER BY p.priority DESC, p.name",
                (cur["id"],),
            ).fetchall()
            objs = conn.execute(
                "SELECT * FROM objects WHERE project_id = ? ORDER BY open_count DESC, name",
                (cur["id"],),
            ).fetchall()

            if not kids and not objs:
                click.echo(styled_dim("（空）"))
                return

            if kids:
                click.echo(styled_header("子项目："))
                for i, k in enumerate(kids):
                    is_last = i == len(kids) - 1
                    connector = "└── " if is_last else "├── "
                    pri = click.style(f"[{k['priority']}]", fg=priority_color(k["priority"]))
                    prog = ""
                    if (k["progress"] or 0) > 0:
                        prog = f" {colored_bar(k['progress'], 10)} {k['progress']}%"
                        if k["progress_note"]:
                            prog += f"  {styled_dim(k['progress_note'])}"
                    desc = f" {styled_dim('- ' + k['description'])}" if k["description"] else ""
                    click.echo(f"  {connector}{pri} {styled_header(k['name'])}{desc}{prog}")

            if objs:
                if kids:
                    click.echo()
                click.echo(styled_header("文件/链接："))
                for o in objs:
                    type_label = o['type']
                    if o['default_app']:
                        type_label += f"/{o['default_app']}"
                    type_badge = styled_dim(f"[{type_label}]")
                    count = styled_dim(f"打开 {o['open_count']} 次") if o["open_count"] > 0 else ""
                    click.echo(f"  {o['name']}  {type_badge}  {count}")
                    click.echo(f"  {styled_dim(plugins.display_target(o['target']))}")
        else:
            # Root: show all projects as tree, separated by type
            projects = conn.execute("SELECT * FROM projects ORDER BY priority DESC, name").fetchall()
            if not projects:
                click.echo(styled_dim("暂无项目"))
                return

            relations = conn.execute("SELECT project_id, parent_id FROM project_parents").fetchall()
            children_map: dict[int, list[int]] = {}
            has_parent: set[int] = set()
            for r in relations:
                children_map.setdefault(r["parent_id"], []).append(r["project_id"])
                has_parent.add(r["project_id"])

            project_map = {p["id"]: p for p in projects}

            def print_tree(pid: int, prefix: str = ""):
                p = project_map[pid]
                is_doc = (p["type"] or "project") == "document"
                name = styled_header(p["name"])
                desc = f" {styled_dim('- ' + p['description'])}" if p["description"] else ""
                prog = ""
                if (p["progress"] or 0) > 0:
                    prog = f" {colored_bar(p['progress'], 10)} {p['progress']}%"
                    if p["progress_note"]:
                        prog += f"  {styled_dim(p['progress_note'])}"
                if is_doc:
                    click.echo(f"{prefix}{name}{desc}{prog}")
                else:
                    pri = click.style(f"[{p['priority']}]", fg=priority_color(p["priority"]))
                    click.echo(f"{prefix}{pri} {name}{desc}{prog}")

                kids = children_map.get(pid, [])
                for i, kid_id in enumerate(kids):
                    if kid_id in project_map:
                        is_last = i == len(kids) - 1
                        connector = "└── " if is_last else "├── "
                        child_prefix = prefix + ("    " if is_last else "│   ")
                        click.echo(f"{prefix}{connector}", nl=False)
                        print_tree(kid_id, child_prefix)

            roots = [p for p in projects if p["id"] not in has_parent]
            docs = sorted(
                [p for p in roots if (p["type"] or "project") == "document"],
                key=lambda p: -(p["open_count"] or 0),
            )
            projs = [p for p in roots if (p["type"] or "project") != "document"]

            if docs:
                click.echo(styled_header("📄 文档："))
                for p in docs:
                    print_tree(p["id"], prefix="  ")
            if projs:
                if docs:
                    click.echo()
                click.echo(styled_header("📁 项目："))
                for p in projs:
                    print_tree(p["id"], prefix="  ")
    finally:
        conn.close()


def _navigate(name: str, section: str):
    """Navigate in a section. section is 'project' or 'document'."""
    is_doc = section == "document"
    get_cur = store.get_current_document if is_doc else store.get_current_project
    set_cur = store.set_current_document if is_doc else store.set_current_project
    label = "文档" if is_doc else "项目"

    if name == "..":
        cur = get_cur()
        if not cur:
            click.echo(styled_dim(f"{label}已在根目录"))
            return
        conn = store.get_db()
        try:
            parent = conn.execute(
                "SELECT p.id, p.name FROM projects p JOIN project_parents pp ON p.id = pp.parent_id WHERE pp.project_id = ?",
                (cur["id"],),
            ).fetchone()
            if not parent:
                set_cur(None)
                click.echo(styled_ok(f"{label}已返回根目录"))
            else:
                set_cur(parent["id"])
                click.echo(styled_ok(f"已进入 → {parent['name']}"))
        finally:
            conn.close()
        return

    conn = store.get_db()
    try:
        row = conn.execute("SELECT id, name, type FROM projects WHERE name = ?", (name,)).fetchone()
        if not row:
            click.echo(styled_err(f"找不到 \"{name}\""))
            return
        # Validate type matches section
        row_is_doc = (row["type"] or "project") == "document"
        if row_is_doc != is_doc:
            other = "文档" if row_is_doc else "项目"
            click.echo(styled_err(f"\"{name}\" 是{other}，请用 {'cd' if row_is_doc else 'ab'} 命令导航"))
            return
        # Validate parent relationship
        cur = get_cur()
        if cur:
            child = conn.execute(
                "SELECT 1 FROM project_parents WHERE project_id = ? AND parent_id = ?",
                (row["id"], cur["id"]),
            ).fetchone()
            if not child:
                click.echo(styled_err(f"当前{label}下找不到 \"{name}\""))
                return
        set_cur(row["id"])
        click.echo(styled_ok(f"已进入 → {row['name']}"))
    finally:
        conn.close()


@cli.command()
@click.argument("name", nargs=-1, required=True)
def ab(name):
    """Navigate projects. Use '..' to go to parent project."""
    _navigate(" ".join(name), "project")


@cli.command()
@click.argument("name", nargs=-1, required=True)
def cd(name):
    """Navigate documents. Use '..' to go to parent document."""
    _navigate(" ".join(name), "document")


@cli.command()
def show():
    """Show current project/document overview."""
    cur = store.get_active_context()
    if not cur:
        click.echo(styled_dim("未进入任何项目。使用 lu cd <项目名> 进入"))
        return

    conn = store.get_db()
    try:
        p = conn.execute("SELECT * FROM projects WHERE id = ?", (cur["id"],)).fetchone()

        # Header
        pri = click.style(f"[{p['priority']}]", fg=priority_color(p["priority"]))
        click.echo(f"\n{pri} {styled_header(p['name'])}")
        if p["description"]:
            click.echo(f"  {styled_dim(p['description'])}")
        pct = p['progress'] or 0
        prog_line = f"  {colored_bar(pct)} {pct}%"
        if p['progress_note']:
            prog_line += f"  {styled_dim(p['progress_note'])}"
        click.echo(prog_line)

        # Sub-projects
        kids = conn.execute(
            "SELECT p.* FROM projects p JOIN project_parents pp ON p.id = pp.project_id WHERE pp.parent_id = ? ORDER BY p.priority DESC",
            (p["id"],),
        ).fetchall()
        if kids:
            click.echo(f"\n  {styled_header('子项目')}")
            for k in kids:
                pct = k["progress"] or 0
                bar = colored_bar(pct, 10)
                note = f"  {styled_dim(k['progress_note'])}" if k["progress_note"] else ""
                click.echo(f"    {k['name']}  {bar} {pct}%{note}")

        # Objects
        objs = conn.execute(
            "SELECT * FROM objects WHERE project_id = ? ORDER BY open_count DESC",
            (p["id"],),
        ).fetchall()
        if objs:
            click.echo(f"\n  {styled_header('文件/链接')}")
            for o in objs:
                type_label = o['type']
                if o['default_app']:
                    type_label += f"/{o['default_app']}"
                type_badge = styled_dim(f"[{type_label}]")
                count = styled_dim(f"打开 {o['open_count']} 次") if o["open_count"] > 0 else ""
                click.echo(f"    {o['name']}  {type_badge}  {count}")
                click.echo(f"    {styled_dim(o['target'])}")

        # Todos
        todos = conn.execute(
            "SELECT * FROM todos WHERE project_id = ? AND done = 0 ORDER BY due_date",
            (p["id"],),
        ).fetchall()
        if todos:
            click.echo(f"\n  {styled_header('待办')}")
            for t in todos:
                due = styled_warn(f" 截止 {t['due_date']}") if t["due_date"] else ""
                click.echo(f"    ○ {t['text']}{due}")

        click.echo()
    finally:
        conn.close()


@cli.command("open")
@click.argument("name", nargs=-1, required=True)
@click.option("-a", "--app", default=None, help="指定应用打开")
@click.option("-p", "--project", default=None, help="指定项目（否则用当前活跃项目）")
def open_cmd(name, app, project):
    """Open a linked object."""
    name = " ".join(name)
    result = store.open_object(name, app, project=project)
    if "错误" in result:
        click.echo(styled_err(result))
    else:
        click.echo(styled_ok(result))


@cli.command()
def todo():
    """Show todos for current project/document."""
    cur = store.get_active_context()
    if not cur:
        click.echo(styled_dim("未进入任何项目"))
        return

    conn = store.get_db()
    try:
        def print_todos(pid: int, pname: str, indent: int = 0):
            prefix = "  " * indent
            todos = conn.execute(
                "SELECT * FROM todos WHERE project_id = ? ORDER BY done, due_date",
                (pid,),
            ).fetchall()
            kids = conn.execute(
                "SELECT p.id, p.name FROM projects p JOIN project_parents pp ON p.id = pp.project_id WHERE pp.parent_id = ?",
                (pid,),
            ).fetchall()

            if todos or kids:
                click.echo(f"{prefix}{styled_header(pname)}")
                for t in todos:
                    if t["done"]:
                        check = styled_ok("✓")
                        text = styled_dim(t["text"])
                        click.echo(f"{prefix}  {check} {text}")
                    else:
                        due = ""
                        if t["due_date"]:
                            due = styled_warn(f" 截止 {t['due_date']}")
                        click.echo(f"{prefix}  ○ {t['text']}{due}")
                for k in kids:
                    print_todos(k["id"], k["name"], indent + 1)

        print_todos(cur["id"], cur["name"])
    finally:
        conn.close()


@cli.command()
def cal():
    """Show calendar for current project."""
    click.echo(store.calendar_view())


@cli.command()
def progress():
    """Show progress for current project/document."""
    cur = store.get_active_context()
    if not cur:
        click.echo(styled_dim("未进入任何项目"))
        return

    conn = store.get_db()
    try:
        def print_progress(pid: int, pname: str, indent: int = 0):
            p = conn.execute("SELECT progress, progress_note FROM projects WHERE id = ?", (pid,)).fetchone()
            pct = p["progress"] or 0
            prefix = "  " * indent
            bar = colored_bar(pct)
            note = f"  {styled_dim(p['progress_note'])}" if p["progress_note"] else ""
            click.echo(f"{prefix}{pname}  {bar} {pct}%{note}")
            kids = conn.execute(
                "SELECT p.id, p.name FROM projects p JOIN project_parents pp ON p.id = pp.project_id WHERE pp.parent_id = ? ORDER BY p.name",
                (pid,),
            ).fetchall()
            for k in kids:
                print_progress(k["id"], k["name"], indent + 1)

        print_progress(cur["id"], cur["name"])
    finally:
        conn.close()


@cli.command()
def root():
    """Return to root (deselect current project and document)."""
    store.set_current_project(None)
    store.set_current_document(None)
    click.echo(styled_ok("已返回根目录"))


@cli.command("new")
@click.argument("name", nargs=-1, required=True)
@click.option("-d", "--desc", default="", help="项目描述")
@click.option("-p", "--priority", default=3, type=int, help="优先级 1-5")
@click.option("--parent", default=None, help="父项目名称")
def new_project(name, desc, priority, parent):
    """Create a new project. If inside a project, creates as sub-project by default."""
    name = " ".join(name)
    if parent is None:
        cur = store.get_active_context()
        if cur:
            parent = cur["name"]
    result = store.create_project(name, desc, priority, parent)
    if "错误" in result:
        click.echo(styled_err(result))
    else:
        click.echo(styled_ok(result))


@cli.command("new-doc")
@click.argument("name", nargs=-1, required=True)
@click.option("-d", "--desc", default="", help="文档描述")
@click.option("-p", "--priority", default=3, type=int, help="优先级 1-5")
@click.option("--parent", default=None, help="父项目/文档名称")
def new_document(name, desc, priority, parent):
    """Create a new document."""
    name = " ".join(name)
    if parent is None:
        cur = store.get_active_context()
        if cur:
            parent = cur["name"]
    result = store.create_project(name, desc, priority, parent, type="document")
    if "错误" in result:
        click.echo(styled_err(result))
    else:
        click.echo(styled_ok(result))


@cli.command()
@click.argument("target")
@click.argument("name", nargs=-1, required=True)
@click.option("-t", "--type", "obj_type", default="file", help="类型（file/folder/url/zotero/script）")
@click.option("-a", "--app", "default_app", default=None, help="默认打开应用（如 'Visual Studio Code'）")
def link(target, name, obj_type, default_app):
    """Link an object to the current project."""
    name = " ".join(name)
    result = store.link_object(target, name, obj_type, default_app=default_app)
    if "错误" in result:
        click.echo(styled_err(result))
    else:
        click.echo(styled_ok(result))


@cli.command("rm")
@click.argument("name", nargs=-1, required=True)
@click.option("--project", is_flag=True, help="删除项目而非对象")
def remove(name, project):
    """Remove an object or project. Use --project to delete a project."""
    name = " ".join(name)
    cur = store.get_current_project()
    is_project_delete = False
    if project or not cur:
        is_project_delete = True
    else:
        # Inside a project: try removing object first, fall back to sub-project
        result = store.remove_object(name)
        if "找不到" in result:
            is_project_delete = True
        else:
            if "错误" in result:
                click.echo(styled_err(result))
            else:
                click.echo(styled_ok(result))
            return

    if is_project_delete:
        if not click.confirm(f"确认删除项目 \"{name}\"？此操作不可撤销"):
            click.echo(styled_dim("已取消"))
            return
        result = store.delete_project(name)
        if "错误" in result:
            click.echo(styled_err(result))
        else:
            click.echo(styled_ok(result))


@cli.command("set-progress")
@click.argument("percent", type=int, default=-1)
@click.option("--project", default=None, help="项目名称（默认当前项目）")
@click.option("--clear", is_flag=True, help="清除进度")
@click.option("-n", "--note", default=None, help="进度备注")
def set_progress(percent, project, clear, note):
    """Set progress for a project (0-100), or --clear to remove."""
    if clear:
        percent = -1
    result = store.progress_set(percent, project, note=note)
    if "错误" in result:
        click.echo(styled_err(result))
    else:
        click.echo(styled_ok(result))


@cli.command("set-priority")
@click.argument("priority", type=int)
@click.argument("name", nargs=-1)
def set_priority(priority, name):
    """Set priority for a project (1-5, 5 highest)."""
    project = " ".join(name) if name else None
    result = store.set_priority(priority, project)
    if "错误" in result:
        click.echo(styled_err(result))
    else:
        click.echo(styled_ok(result))


@cli.command("add-todo")
@click.argument("text", nargs=-1, required=True)
@click.option("--due", default=None, help="截止日期 YYYY-MM-DD")
@click.option("--remind", default=None, help="提醒日期 YYYY-MM-DD")
def add_todo(text, due, remind):
    """Add a todo to the current project."""
    text = " ".join(text)
    result = store.todo_add(text, due, remind)
    if "错误" in result:
        click.echo(styled_err(result))
    else:
        click.echo(styled_ok(result))


@cli.command("done")
@click.argument("text", nargs=-1, required=True)
def done_todo(text):
    """Mark a todo as done."""
    text = " ".join(text)
    result = store.todo_done(text)
    if "错误" in result:
        click.echo(styled_err(result))
    else:
        click.echo(styled_ok(result))


@cli.command("mkfile")
@click.argument("path")
@click.option("-a", "--app", default=None, help="用指定应用创建")
@click.option("--internal", is_flag=True, help="创建为 lineup 内部文件")
def make_file(path, app, internal):
    """Create a new file and link it to the current project."""
    result = store.new_file(path, app, internal)
    if "错误" in result:
        click.echo(styled_err(result))
    else:
        click.echo(styled_ok(result))


@cli.command("mv", context_settings={"ignore_unknown_options": True})
@click.argument("args", nargs=-1, required=True)
def move(args):
    """Move a project: mv <name> > <parent> (or just mv <name> to move to root)."""
    args_list = list(args)
    # Split on ">" as separator
    if ">" in args_list:
        idx = args_list.index(">")
        name = " ".join(args_list[:idx])
        new_parent = " ".join(args_list[idx + 1:]) or None
    else:
        # No ">": try to find a valid (source, target) split by matching project names
        conn = store.get_db()
        try:
            all_names = {r["name"] for r in conn.execute("SELECT name FROM projects").fetchall()}
        finally:
            conn.close()

        # Try each split point, collect all valid (source, target) pairs
        valid_splits = []
        for i in range(len(args_list) - 1, 0, -1):
            candidate_name = " ".join(args_list[:i])
            candidate_parent = " ".join(args_list[i:])
            if candidate_name in all_names and candidate_parent in all_names:
                valid_splits.append((candidate_name, candidate_parent))

        if len(valid_splits) > 1:
            click.echo(styled_err("歧义：存在多种匹配方式，请使用 > 分隔"))
            for s, t in valid_splits:
                click.echo(f"  mv {s} > {t}")
            return
        elif len(valid_splits) == 1:
            name, new_parent = valid_splits[0]
        else:
            # No valid split found, treat all as name (move to root)
            name = " ".join(args_list)
            new_parent = None

    if not name:
        click.echo(styled_err("用法: mv <项目名> > <目标父项目>"))
        return
    if not click.confirm(f"确认将 \"{name}\" 移动到 \"{new_parent or '根目录'}\"？"):
        click.echo(styled_dim("已取消"))
        return
    result = store.move_project(name, new_parent)
    if "错误" in result:
        click.echo(styled_err(result))
    else:
        click.echo(styled_ok(result))


@cli.command("shell")
def shell_cmd():
    """Enter interactive mode."""
    interactive_shell()


def _get_prompt() -> str:
    doc = store.get_current_document()
    proj = store.get_current_project()
    parts = []
    if doc:
        parts.append(doc["name"])
    if proj:
        pct = proj.get("progress") or 0
        parts.append(f"{proj['name']}({pct}%)")
    if parts:
        return click.style(f"lineup:{'/'.join(parts)}> ", fg="cyan")
    return click.style("lineup> ", fg="cyan")


def _display_section_contents(conn, cur, is_doc_section=False):
    """Display children, objects, todos for a project/document."""
    kids = conn.execute(
        "SELECT p.* FROM projects p JOIN project_parents pp ON p.id = pp.project_id WHERE pp.parent_id = ? ORDER BY p.priority DESC, p.name",
        (cur["id"],),
    ).fetchall()
    objs = conn.execute(
        "SELECT * FROM objects WHERE project_id = ? ORDER BY open_count DESC, name",
        (cur["id"],),
    ).fetchall()
    todos = conn.execute(
        "SELECT * FROM todos WHERE project_id = ? AND done = 0 ORDER BY due_date",
        (cur["id"],),
    ).fetchall()

    if not kids and not objs and not todos:
        click.echo(styled_dim("  （空）"))
        return

    if kids:
        for i, k in enumerate(kids):
            is_last = (i == len(kids) - 1) and not objs
            connector = "└── " if is_last else "├── "
            is_kid_doc = (k["type"] or "project") == "document"
            prog = ""
            if (k["progress"] or 0) > 0:
                prog = f" {colored_bar(k['progress'], 10)} {k['progress']}%"
                if k["progress_note"]:
                    prog += f"  {styled_dim(k['progress_note'])}"
            if is_kid_doc:
                click.echo(f"  {connector}{styled_header(k['name'])}{prog}")
            else:
                pri = click.style(f"[{k['priority']}]", fg=priority_color(k["priority"]))
                click.echo(f"  {connector}{pri} {styled_header(k['name'])}{prog}")
    if objs:
        for i, o in enumerate(objs):
            is_last = i == len(objs) - 1
            connector = "└── " if is_last else "├── "
            type_label = o['type']
            if o['default_app']:
                type_label += f"/{o['default_app']}"
            type_badge = styled_dim(f"[{type_label}]")
            count = styled_dim(f"打开 {o['open_count']} 次") if o["open_count"] > 0 else ""
            pretty = styled_dim(plugins.display_target(o['target']))
            click.echo(f"  {connector}{o['name']}  {type_badge}  {count}")
            click.echo(f"    {pretty}")
    if todos:
        click.echo(f"  {styled_header('待办')}")
        for t in todos:
            due = styled_warn(f" 截止 {t['due_date']}") if t["due_date"] else ""
            click.echo(f"    ○ {t['text']}{due}")


def _display_root_items(conn, type_filter):
    """Display root-level items of a given type."""
    projects = conn.execute("SELECT * FROM projects ORDER BY priority DESC, name").fetchall()
    relations = conn.execute("SELECT project_id, parent_id FROM project_parents").fetchall()
    has_parent: set[int] = set()
    for r in relations:
        has_parent.add(r["project_id"])
    roots = [p for p in projects if p["id"] not in has_parent]

    if type_filter == "document":
        items = sorted(
            [p for p in roots if (p["type"] or "project") == "document"],
            key=lambda p: -(p["open_count"] or 0),
        )
        for p in items:
            prog = ""
            if (p["progress"] or 0) > 0:
                prog = f" {colored_bar(p['progress'], 10)} {p['progress']}%"
            click.echo(f"  {styled_header(p['name'])}{prog}")
    else:
        items = [p for p in roots if (p["type"] or "project") != "document"]
        for p in items:
            pri = click.style(f"[{p['priority']}]", fg=priority_color(p["priority"]))
            prog = ""
            if (p["progress"] or 0) > 0:
                prog = f" {colored_bar(p['progress'], 10)} {p['progress']}%"
                if p["progress_note"]:
                    prog += f"  {styled_dim(p['progress_note'])}"
            click.echo(f"  {pri} {styled_header(p['name'])}{prog}")
    return len(items) > 0


def _auto_display():
    """Auto-display current directory contents in the shell."""
    cur_doc = store.get_current_document()
    cur_proj = store.get_current_project()
    conn = store.get_db()
    try:
        # Documents section
        if cur_doc:
            click.echo(styled_header(f"  📄 {cur_doc['name']}"))
            _display_section_contents(conn, cur_doc, is_doc_section=True)
        else:
            click.echo(styled_header("  📄 文档"))
            _display_root_items(conn, "document")

        click.echo()

        # Projects section
        if cur_proj:
            pct = cur_proj.get("progress") or 0
            click.echo(styled_header(f"  📁 {cur_proj['name']}({pct}%)"))
            _display_section_contents(conn, cur_proj)
        else:
            click.echo(styled_header("  📁 项目"))
            _display_root_items(conn, "project")
    finally:
        conn.close()


COMMANDS = [
    "ls", "ab", "cd", "show", "open", "todo", "cal", "progress", "root",
    "new", "new-doc", "link", "rm", "set-progress", "set-priority", "add-todo", "done", "mkfile",
    "help", "quit", "exit", "restart",
]


def _get_completions(text: str, line: str) -> list[str]:
    """Get tab completions based on current context."""
    parts = line.lstrip().split(None, 1)  # [command, argument_so_far]
    cmd = parts[0] if parts else ""
    # The full argument typed so far (may contain spaces)
    arg_so_far = parts[1] if len(parts) > 1 else ""

    # Completing a command name
    if len(parts) <= 1 and not line.endswith(" "):
        return [c for c in COMMANDS if c.startswith(text)]

    # Completing an argument - match against the full arg including spaces
    names = _get_candidate_names(cmd)
    matches = [n for n in names if n.startswith(arg_so_far)]

    if not matches:
        return []

    # Return only the part after what readline already has (text is the last token)
    # e.g. line="cd EC2026 " text="" arg_so_far="EC2026 " -> return ["review"]
    # e.g. line="cd EC" text="EC" arg_so_far="EC" -> return ["EC2026 review"]
    # We need to return what replaces `text`
    results = []
    for m in matches:
        # The portion of the match after everything before `text`
        prefix_len = len(arg_so_far) - len(text)
        results.append(m[prefix_len:])
    return results


def _get_candidate_names(cmd: str) -> list[str]:
    """Get candidate names for tab completion based on command."""
    conn = store.get_db()
    try:
        cur = store.get_active_context()

        if cmd in ("ab", "cd"):
            is_doc = cmd == "cd"
            type_filter = "document" if is_doc else "project"
            cur_section = store.get_current_document() if is_doc else cur
            if cur_section:
                rows = conn.execute(
                    "SELECT p.name FROM projects p JOIN project_parents pp ON p.id = pp.project_id WHERE pp.parent_id = ?",
                    (cur_section["id"],),
                ).fetchall()
                return [r["name"] for r in rows]
            else:
                has_parent = {r["project_id"] for r in conn.execute("SELECT project_id FROM project_parents").fetchall()}
                if is_doc:
                    rows = conn.execute("SELECT id, name FROM projects WHERE type = 'document'").fetchall()
                else:
                    rows = conn.execute("SELECT id, name FROM projects WHERE type != 'document' OR type IS NULL").fetchall()
                return [r["name"] for r in rows if r["id"] not in has_parent]

        elif cmd in ("open", "rm"):
            names = []
            if cur:
                rows = conn.execute(
                    "SELECT name FROM objects WHERE project_id = ?", (cur["id"],),
                ).fetchall()
                names += [r["name"] for r in rows]
                if cmd == "rm":
                    kids = conn.execute(
                        "SELECT p.name FROM projects p JOIN project_parents pp ON p.id = pp.project_id WHERE pp.parent_id = ?",
                        (cur["id"],),
                    ).fetchall()
                    names += [k["name"] for k in kids]
            else:
                rows = conn.execute("SELECT name FROM projects").fetchall()
                names += [r["name"] for r in rows]
            return names

        elif cmd == "mv":
            rows = conn.execute("SELECT name FROM projects").fetchall()
            return [r["name"] for r in rows]

        elif cmd == "done":
            if cur:
                rows = conn.execute(
                    "SELECT text FROM todos WHERE project_id = ? AND done = 0",
                    (cur["id"],),
                ).fetchall()
                return [r["text"] for r in rows]

    finally:
        conn.close()

    return []


def interactive_shell():
    """Interactive REPL for lineup."""
    import shlex
    import readline

    _completion_cache: list[str] = []

    def completer(text, state):
        if state == 0:
            line = readline.get_line_buffer()
            _completion_cache.clear()
            _completion_cache.extend(_get_completions(text, line))
        if state < len(_completion_cache):
            return _completion_cache[state]
        return None

    readline.set_completer(completer)
    readline.set_completer_delims(" \t")
    # macOS libedit vs GNU readline
    if "libedit" in (readline.__doc__ or ""):
        readline.parse_and_bind("bind ^I rl_complete")
    else:
        readline.parse_and_bind("tab: complete")

    click.echo(styled_header("lineup interactive shell"))
    click.echo(styled_dim("输入 help 查看所有命令，按 Tab 自动补全\n"))

    _auto_display()

    while True:
        try:
            prompt = _get_prompt()
            line = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            click.echo("\n" + styled_ok("再见"))
            break

        if not line:
            continue

        if line in ("quit", "exit", "q"):
            click.echo(styled_ok("再见"))
            break

        if line in ("restart", "r"):
            import sys
            click.echo(styled_ok("重启中..."))
            os.execv(sys.executable, [sys.executable, "-m", "lineup.cli", "shell"])

        if line == "help":
            click.echo(styled_header("  浏览"))
            click.echo("  ab <名>         进入项目（.. 返回上级）")
            click.echo("  cd <名>         进入文档（.. 返回上级）")
            click.echo("  show            当前项目详情")
            click.echo("  open <名>       打开文件/链接")
            click.echo("  todo            待办事项")
            click.echo("  cal             日历")
            click.echo("  progress        进度")
            click.echo("  root            返回根目录")
            click.echo(styled_header("  操作"))
            click.echo("  new <名>        新建项目（-d 描述 -p 优先级 --parent 父项目）")
            click.echo("  new-doc <名>    新建文档（-d 描述 -p 优先级 --parent 父项目）")
            click.echo("  link <路径> <名> 链接文件/URL 到当前项目（-a 默认应用）")
            click.echo("  rm <名>         移除链接")
            click.echo("  set-progress N  设置进度（0-100，-n 备注）")
            click.echo("  set-priority N  设置优先级（1-5）")
            click.echo("  add-todo <内容> 添加待办（--due 截止日 --remind 提醒日）")
            click.echo("  done <内容>     完成待办")
            click.echo("  mkfile <路径>   新建文件（-a 应用 --internal）")
            click.echo("  mv <名> > <父>  移动项目（不填 > 则移到根目录）")
            click.echo(styled_header("  其他"))
            click.echo("  restart (r)     重启 shell")
            click.echo("  quit            退出")
            continue

        try:
            args = shlex.split(line)
        except ValueError:
            args = line.split()

        try:
            cli(args, standalone_mode=False)
        except click.exceptions.UsageError as e:
            click.echo(styled_err(str(e)))
        except SystemExit:
            pass

        # Auto-display after every command
        click.echo()
        _auto_display()


def main():
    cli()


if __name__ == "__main__":
    main()
