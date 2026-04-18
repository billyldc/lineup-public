"""lineup MCP server."""

from mcp.server.fastmcp import FastMCP
from lineup import store
from lineup import plugins

mcp = FastMCP("lineup")

# Load all plugins
plugins.load_all()


@mcp.tool()
def lineup_init() -> str:
    """初始化 lineup 项目管理系统，创建数据库。"""
    return store.init_db()


@mcp.tool()
def lineup_create_project(
    name: str,
    description: str = "",
    priority: int = 3,
    parent: str | None = None,
) -> str:
    """创建一个新项目或子项目。

    ⚠️ 调用前必须遵守的规矩（**重要**，agent 请严格照做）：
    1. 先用 `lineup_list_children(parent)` 或 `lineup_list_projects()` 确认
       **没有**同名的 project / task / step 已经存在；如果存在就优先复用它，
       不要新建。
    2. **弄清楚用户要的到底是 project、task 还是 step**。这三个是完全不同的层级：
       - `project` = 长期工作区，可以嵌套 project 和 task（例如 `review`, `research`, `实习`）
       - `task` = 一次具体的工作单元，可以包含 step；task 之间是并行的
       - `step` = task 内的顺序 checklist 步骤，只能由 agent 建
       用户如果说"子项目"/"子任务"/"步骤"模糊不清（例如只说"新建一个"），
       **先问清楚再调工具**，不要擅自决定。
    3. `lineup_create_project` 只负责建 `type='project'` 的行。如果用户想要的
       其实是 task 或 step，请分别用 `lineup_create_task` / `lineup_create_step`。

    name: 项目名称
    description: 项目描述
    priority: 优先级 1-5，5 最高，默认 3
    parent: 父项目名称（可选，用于创建子项目）
    """
    return store.create_project(name, description, priority, parent)


@mcp.tool()
def lineup_create_task(
    name: str,
    parent: str,
    description: str = "",
    important: bool = False,
    urgent: bool = False,
    due_at: str | None = None,
) -> str:
    """在一个 project 下新建一个 task。

    task 是一次具体工作的单元（例如"审稿 FOCS26 paper 42"、"投简历到 XX 公司"）。
    task 之间默认**并行** —— 多个 task 可以同时进行，互不阻塞。如果你要把一次工作
    拆成必须按顺序完成的步骤，把这些步骤建成 **step**（用 `lineup_create_step`），
    不要建成多个 task。

    ⚠️ 调用前必须遵守的规矩：
    1. **先调 `lineup_list_children(parent)` 确认没有同名 task**。如果有同名的
       就复用它，不要新建。
    2. 确认用户要的是 task 而不是 project 或 step。如果不确定就问用户。
    3. `parent` 必须是一个 `type='project'` 的行，不能是 task 或 step。

    name: 任务名称
    parent: 父 project 的名称
    description: 任务描述（可选）
    important: 是否重要（默认继承父 project 的 important）
    urgent: 是否紧急（默认继承父 project 的 urgent）
    due_at: 截止日期 YYYY-MM-DD（可选）
    """
    return store.create_task(name, parent, description, important, urgent, due_at)


@mcp.tool()
def lineup_create_step(
    name: str,
    parent_task: str,
) -> str:
    """在一个 task 下新建一个 step（顺序执行的 checklist 项）。

    step 是 task 内部的**顺序**工作单元：step 1 没做完，step 2 就被 lock。每次
    agent 调用都会自动把新 step 放到现有 step 队列的**最后**（order_index 自动
    递增）。所以要按照 step 需要的执行顺序依次调用 `lineup_create_step`。

    ⚠️ 调用前必须遵守的规矩：
    1. **先调 `lineup_list_children(parent_task)` 确认现有 step 列表**，看是否
       已经有覆盖这一步的 step。有就复用。
    2. `parent_task` 必须是一个 `type='task'` 的行。如果父节点是 project,
       你需要先用 `lineup_create_task` 建一个 task，再把 step 加进去。
    3. todo 功能已被移除。所有步骤化的需求全部用 step，不要调任何
       `todo_*` 工具（MCP 里已经没有了）。

    name: 步骤名称（一行话描述这一步要做什么）
    parent_task: 父 task 的名称
    """
    return store.create_step(name, parent_task)


@mcp.tool()
def lineup_set_task_meta(
    name: str,
    parent: str | None = None,
    due_at: str | None = None,
    important: bool | None = None,
    urgent: bool | None = None,
    status: str | None = None,
    reminder_every_days: int | None = None,
) -> str:
    """更新一个已存在的 task（或 project / step）的属性。

    这是**给 task 设截止日期 / 重要 / 紧急 / 状态的唯一正确方式**。
    每个传入的字段会被写入；没传的字段保持不变。

    ⚠️ 重要区别（不要搞混）：
    - **只有 task 有真正的 `due_at`**。project 是长期工作区，**不能**也**不应该**
      有截止日期。用户说"给 X 项目设截止日"时，应该问清楚是要给这个 project
      下面的某个 task 设，还是给 project 本身设（如果是后者，反问用户：这个项目
      下面是哪个具体 task 有截止日？）。
    - **绝对不要**把 due_at 当 todo 加到 project 上作为 workaround！
      todo 不是 due_at，todo 的 due_date 也不会影响 task 的排期和 Today 视图。
    - `status='done'` 会把这个 task 标记成已完成，对应 UI 里的 ✓ checkbox。

    name: 要修改的条目名称（优先使用 task；project/step 也可以）
    parent: 父项目的名称；只有当 name 不唯一的时候才需要用来消歧
    due_at: 截止日期 YYYY-MM-DD；传空字符串清除
    important: 是否重要
    urgent: 是否紧急
    status: todo / active / done / cancelled 之一
    reminder_every_days: 每 N 天提醒一次；传 0 或 None 关闭
    """
    return store.set_task_meta(
        name, parent, due_at, important, urgent, status, reminder_every_days
    )


@mcp.tool()
def lineup_list_children(parent: str) -> str:
    """列出一个 project/task 的**直接**子项（project / task / step 都会列出来）。

    这是**每次创建新东西之前必调的工具**，用来确认：
    - 用户想要的东西是不是已经存在（如果存在就复用，不要重复创建）
    - 父节点的 type 是什么（project 下面挂 task，task 下面挂 step）
    - 现有的 step 列表和顺序（在加新 step 前看一眼）

    parent: 父 project 或 task 的名称
    """
    return store.list_children(parent)


@mcp.tool()
def lineup_create_document(
    name: str,
    description: str = "",
    priority: int = 3,
    parent: str | None = None,
) -> str:
    """创建一个新文档（知识沉淀，区别于项目）。

    name: 文档名称
    description: 文档描述
    priority: 优先级 1-5，5 最高，默认 3
    parent: 父项目/文档名称（可选）
    """
    return store.create_project(name, description, priority, parent, type="document")


@mcp.tool()
def lineup_list_projects() -> str:
    """列出所有项目和文档，按优先级排序，显示树形结构。"""
    return store.list_projects()


@mcp.tool()
def lineup_open_project(name: str) -> str:
    """进入一个项目，显示其概览信息（描述、子项目、文件、待办等）。

    name: 项目名称
    """
    return store.open_project(name)


@mcp.tool()
def lineup_link(
    target: str,
    name: str,
    type: str = "file",
    project: str | None = None,
    default_app: str | None = None,
) -> str:
    """将一个对象（文件/文件夹/URL/Zotero文献/脚本）链接到项目中。

    target: 目标路径或 URI（如 ~/Documents/thesis/、https://...、zotero://...）
    name: 对象在项目中的显示名称
    type: 对象类型（file/folder/url/zotero/script），可自动检测
    project: 项目名称（可选，默认为当前活跃项目）
    default_app: 默认打开应用（可选，如 "Visual Studio Code"），设置后每次 open 都会用该应用打开
    """
    return store.link_object(target, name, type, project, default_app=default_app)


@mcp.tool()
def lineup_list_objects(project: str | None = None) -> str:
    """列出项目中所有链接的对象，按打开频率排序。

    project: 项目名称（可选，默认为当前活跃项目）
    """
    return store.list_objects(project)


@mcp.tool()
def lineup_open_object(
    name: str,
    app: str | None = None,
    project: str | None = None,
) -> str:
    """打开项目中的一个对象（用系统默认应用或指定应用）。

    name: 对象名称
    app: 指定应用名称（可选，如 "Preview"、"VS Code"）
    project: 项目名称（可选，默认为当前活跃项目）
    """
    return store.open_object(name, app, project)


@mcp.tool()
def lineup_remove_object(
    name: str,
    project: str | None = None,
) -> str:
    """从项目中移除一个对象的链接（不会删除源文件）。

    name: 对象名称
    project: 项目名称（可选，默认为当前活跃项目）
    """
    return store.remove_object(name, project)


@mcp.tool()
def lineup_delete_project(name: str) -> str:
    """删除一个项目及其所有数据（对象、待办、父子关系），不会删除子项目本身。

    name: 项目名称
    """
    return store.delete_project(name)


@mcp.tool()
def lineup_dispatch_agent(
    folder: str,
    prompt: str,
    model: str = "sonnet",
) -> str:
    """调度一个子 agent 在指定文件夹里执行任务并返回结果。

    这是通用 agent 跨文件夹调度的核心工具。用法举例：

        lineup_dispatch_agent(
            folder="~/homepage",
            prompt="请更新 CV 里的 Recent Projects 部分，加入最近一个月的项目"
        )

    执行过程：
    1. 在 folder 下找到已有的 claude session（通过 ~/.claude_sessions/<md5>）
    2. 用 `claude --print --resume <session_id> <prompt>` 运行（非交互式）
    3. 等子 agent 跑完，返回它的 stdout 给你

    ⚠️ 注意：
    - 子 agent 是**非交互式**的（--print 模式），不会弹权限确认。如果子 agent
      需要用到需要权限的工具（写文件等），该文件夹下的 .claude/settings.json
      必须预先配置 allowedTools。
    - 执行是**同步阻塞**的 —— 你会等到子 agent 跑完才拿到结果。大任务可能
      要等一会儿。
    - 如果该文件夹没有已有的 session，会创建一个新 session。

    folder: 目标文件夹的绝对路径
    prompt: 要发给子 agent 的消息
    model: 使用的模型，默认 sonnet
    """
    import subprocess
    import hashlib
    from pathlib import Path

    folder_path = Path(folder).expanduser().resolve()
    if not folder_path.exists():
        return f"错误：文件夹 {folder} 不存在"

    # Find existing session via the user's zshrc wrapper convention:
    # ~/.claude_sessions/<md5(folder)>
    session_store = Path.home() / ".claude_sessions"
    dir_key = hashlib.md5(str(folder_path).encode()).hexdigest()
    session_file = session_store / dir_key
    session_id = None
    if session_file.exists():
        session_id = session_file.read_text().strip()

    # Build the claude command
    cmd = ["claude", "--print", "--output-format", "text", "--model", model]
    if session_id:
        cmd.extend(["--resume", session_id])
    cmd.append(prompt)

    # Ensure claude is findable
    env = {
        **__import__("os").environ,
        "PATH": f"{Path.home()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:{__import__('os').environ.get('PATH', '')}",
    }

    try:
        result = subprocess.run(
            cmd,
            cwd=str(folder_path),
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute max
            env=env,
        )
        if result.returncode != 0:
            return f"子 agent 执行失败 (exit {result.returncode}):\n{result.stderr[:500]}"
        output = result.stdout.strip()
        if not output:
            return "(子 agent 没有返回内容)"
        return f"[子 agent @ {folder}]\n{output}"
    except subprocess.TimeoutExpired:
        return f"错误：子 agent 在 {folder} 执行超时（5 分钟）"
    except FileNotFoundError:
        return "错误：找不到 claude 命令。确认 ~/.local/bin/claude 存在。"
    except Exception as e:
        return f"错误：{e}"


# lineup_todo_done — removed from MCP, kept as plain function for CLI compat
def lineup_todo_done(
    text: str,
    project: str | None = None,
) -> str:
    return store.todo_done(text, project)


# lineup_todo_list — removed from MCP, kept as plain function for CLI compat
def lineup_todo_list(
    project: str | None = None,
    show_done: bool = False,
) -> str:
    return store.todo_list(project, show_done)


@mcp.tool()
def lineup_calendar(
    month: str | None = None,
    project: str | None = None,
) -> str:
    """显示日历视图，标注待办事项的截止日期。

    month: 月份（格式 YYYY-MM，默认当前月）
    project: 项目名称（可选，默认为当前活跃项目）
    """
    return store.calendar_view(month, project)


@mcp.tool()
def lineup_progress_set(
    percent: int = -1,
    project: str | None = None,
    note: str | None = None,
) -> str:
    """设置项目的完成进度。

    percent: 进度百分比(0-100)，传 -1 清除进度
    project: 项目名称(可选,默认为当前活跃项目)
    note: 进度备注（可选，如 "等待审稿意见"、"初稿完成"）
    """
    return store.progress_set(percent, project, note=note)


@mcp.tool()
def lineup_set_priority(
    priority: int,
    project: str | None = None,
) -> str:
    """设置项目的优先级。

    priority: 优先级 1-5，5 最高
    project: 项目名称（可选，默认为当前活跃项目）
    """
    return store.set_priority(priority, project)


@mcp.tool()
def lineup_progress_get(project: str | None = None) -> str:
    """查看项目及其所有子项目的进度。

    project: 项目名称（可选，默认为当前活跃项目）
    """
    return store.progress_get(project)


@mcp.tool()
def lineup_link_project(name: str, parent: str) -> str:
    """将一个已有项目作为另一个项目的子项目（跨项目引用，数据只有一份）。

    name: 要引用的项目名称
    parent: 目标父项目名称
    """
    return store.link_project(name, parent)


@mcp.tool()
def lineup_new_file(
    path: str,
    app: str | None = None,
    internal: bool = False,
    project: str | None = None,
) -> str:
    """新建文件并自动链接到项目。

    三种模式：
    1. 路径以已链接的文件夹名开头（如 "论文文件夹/notes.md"）→ 在该文件夹的源路径下创建
    2. 指定 app（如 "obsidian"）→ 在对应应用的目录中创建
    3. internal=True 或不指定 app → 在 lineup 内部创建

    path: 文件路径或文件名
    app: 外部应用名称（可选）
    internal: 是否创建为 lineup 内部文件（默认 False）
    project: 项目名称（可选，默认为当前活跃项目）
    """
    return store.new_file(path, app, internal, project)


@mcp.tool()
def lineup_move_project(name: str, new_parent: str | None = None) -> str:
    """将一个项目移动到另一个项目下面（会移除原有的所有父项目关系）。

    name: 要移动的项目名称
    new_parent: 目标父项目名称（不填则移动到根目录）
    """
    return store.move_project(name, new_parent)


@mcp.tool()
def lineup_status() -> str:
    """获取当前 lineup 状态：当前所在项目、其子项目、对象、待办事项。如果不在任何项目中，返回所有项目列表。"""
    cur = store.get_active_context()
    if cur:
        return store.open_project(cur["name"])
    else:
        return "当前未进入任何项目。\n\n" + store.list_projects()


@mcp.tool()
def lineup_calendar_all(month: str | None = None) -> str:
    """显示所有项目的日历视图（不限于某个项目）。

    month: 月份（格式 YYYY-MM，默认当前月）
    """
    return store.calendar_view(month, project=None)


# ── Plugin: Obsidian ──────────────────────────────────────────────────────

@mcp.tool()
def lineup_obsidian_search(query: str, limit: int = 10) -> str:
    """在 Obsidian 知识库中搜索笔记（按文件名和内容匹配）。

    query: 搜索关键词
    limit: 最多返回条数（默认 10）
    """
    plugin = plugins.get("obsidian")
    if not plugin:
        return "错误：Obsidian 插件未加载"
    items = plugin.search(query, limit)
    if not items:
        return f"未找到匹配 \"{query}\" 的笔记"
    lines = [f"找到 {len(items)} 条结果："]
    for item in items:
        preview = f"  {item.preview}" if item.preview else ""
        lines.append(f"  {item.name}  [{item.target}]{preview}")
    return "\n".join(lines)


@mcp.tool()
def lineup_obsidian_read(path: str) -> str:
    """读取 Obsidian 笔记的内容。

    path: 笔记的完整路径（从 obsidian_search 结果中获取）
    """
    plugin = plugins.get("obsidian")
    if not plugin:
        return "错误：Obsidian 插件未加载"
    return plugin.read(path)


@mcp.tool()
def lineup_obsidian_browse(path: str = "") -> str:
    """浏览 Obsidian 知识库的目录结构。

    path: 相对于 vault 根目录的路径（默认为根目录）
    """
    plugin = plugins.get("obsidian")
    if not plugin:
        return "错误：Obsidian 插件未加载"
    items = plugin.browse(path)
    if not items:
        return "（空目录）"
    lines = []
    for item in items:
        lines.append(f"  {'📁' if item.type == 'folder' else '📄'} {item.name}")
    return "\n".join(lines)


@mcp.tool()
def lineup_obsidian_link(
    path: str,
    name: str | None = None,
    project: str | None = None,
) -> str:
    """将 Obsidian 笔记链接到 lineup 项目中。

    path: 笔记的完整路径
    name: 在项目中的显示名称（默认用笔记文件名）
    project: 项目名称（可选，默认为当前活跃项目）
    """
    plugin = plugins.get("obsidian")
    if not plugin:
        return "错误：Obsidian 插件未加载"
    from pathlib import Path as P
    p = P(path)
    if not p.exists():
        return f"错误：文件不存在 {path}"
    display_name = name or p.stem
    return store.link_object(
        target=str(p),
        name=display_name,
        type="file",
        project=project,
        default_app="Obsidian",
    )


@mcp.tool()
def lineup_obsidian_vaults() -> str:
    """列出检测到的 Obsidian vault 路径。"""
    plugin = plugins.get("obsidian")
    if not plugin:
        return "错误：Obsidian 插件未加载"
    vaults = plugin.list_vaults()
    if not vaults:
        return "未检测到 Obsidian vault"
    lines = ["检测到的 Obsidian vault："]
    for v in vaults:
        lines.append(f"  {v['name']}  {v['path']}")
    return "\n".join(lines)


# ── Plugin: Trilium ───────────────────────────────────────────────────────

@mcp.tool()
def lineup_trilium_search(query: str, limit: int = 10) -> str:
    """在 Trilium 知识库中搜索笔记（按标题和内容匹配）。

    query: 搜索关键词
    limit: 最多返回条数（默认 10）
    """
    plugin = plugins.get("trilium")
    if not plugin:
        return "错误：Trilium 插件未加载"
    items = plugin.search(query, limit)
    if not items:
        return f"未找到匹配 \"{query}\" 的笔记"
    lines = [f"找到 {len(items)} 条结果："]
    for item in items:
        lines.append(f"  {item.name}  [id: {item.id}]")
        if item.preview:
            lines.append(f"    {item.preview}")
    return "\n".join(lines)


@mcp.tool()
def lineup_trilium_read(note_id: str) -> str:
    """读取 Trilium 笔记的内容（转为纯文本）。

    note_id: 笔记 ID（从 trilium_search 结果中获取）
    """
    plugin = plugins.get("trilium")
    if not plugin:
        return "错误：Trilium 插件未加载"
    return plugin.read(note_id)


@mcp.tool()
def lineup_trilium_browse(note_id: str = "") -> str:
    """浏览 Trilium 笔记树结构。

    note_id: 父笔记 ID（默认为根目录）
    """
    plugin = plugins.get("trilium")
    if not plugin:
        return "错误：Trilium 插件未加载"
    items = plugin.browse(note_id)
    if not items:
        return "（空）"
    lines = []
    for item in items:
        icon = "📁" if item.name.endswith("/") else "📄"
        extra = f"  {item.preview}" if item.preview else ""
        lines.append(f"  {icon} {item.name}  [id: {item.id}]{extra}")
    return "\n".join(lines)


@mcp.tool()
def lineup_trilium_link(
    note_id: str,
    name: str | None = None,
    project: str | None = None,
) -> str:
    """将 Trilium 笔记链接到 lineup 项目中。

    note_id: 笔记 ID
    name: 在项目中的显示名称（默认用笔记标题）
    project: 项目名称（可选，默认为当前活跃项目）
    """
    plugin = plugins.get("trilium")
    if not plugin:
        return "错误：Trilium 插件未加载"
    # Get note title for default name
    if not name:
        content = plugin.read(note_id)
        if content.startswith("错误"):
            return content
        # Extract title from first line
        first_line = content.split("\n")[0]
        name = first_line.replace("# ", "").strip() or note_id
    return store.link_object(
        target=note_id,
        name=name,
        type="trilium",
        project=project,
    )


@mcp.tool()
def lineup_todoist_sync(
    dry_run: bool = True,
    create_missing: bool = False,
    skip: list[str] | None = None,
) -> str:
    """同步 Todoist 项目到 lineup 项目。

    策略：按名称匹配——已存在的 lineup 项目会被自动「链接」到同名的 Todoist 项目；
    没匹配的 Todoist 项目（仅在 create_missing=True 时）会被创建为新的 lineup 项目。
    Todoist 的 Inbox 默认跳过（它是收件箱本身，不应映射成项目）。

    参数：
      dry_run: 默认 True，只返回计划不写库。设为 False 才真正执行。
      create_missing: 默认 False。为 True 时，未匹配的 Todoist 项目会在 lineup 中新建。
      skip: 额外要跳过的 Todoist 项目名列表。

    依赖：本机须安装 @doist/todoist-cli 并已 td auth login。
    """
    from lineup.plugins import todoist as td_plugin

    try:
        projects = td_plugin.fetch_projects()
    except td_plugin.TodoistError as e:
        return f"错误：{e}"

    actions = td_plugin.plan_sync(projects, extra_skip=set(skip or []))

    lines = [f"Todoist → lineup 同步计划（{len(projects)} 个项目）"]
    for a in actions:
        marker = {
            "skip": "·",
            "already-linked": "=",
            "link": "↔",
            "create": "+",
        }.get(a.kind, "?")
        line = f"  {marker} [{a.kind}] {a.todoist.name}"
        if a.lineup_id is not None:
            line += f"  → lineup #{a.lineup_id} ({a.lineup_name})"
        if a.note:
            line += f"  [{a.note}]"
        if a.kind == "create" and not create_missing:
            line += "  — 跳过（需 create_missing=True 才创建）"
        lines.append(line)

    if dry_run:
        lines.append("\n[dry_run=True] 未执行任何修改。如要执行请再调一次并传 dry_run=False")
        return "\n".join(lines)

    summary = td_plugin.apply_sync(actions, create_missing=create_missing)
    lines.append(
        f"\n完成：linked={summary.linked}, created={summary.created}, "
        f"create_skipped={summary.create_skipped}, "
        f"already={summary.already}, skipped={summary.skipped}"
    )
    return "\n".join(lines)


@mcp.tool()
def lineup_todoist_link(todoist_ref: str, lineup_name: str) -> str:
    """手动把一个 lineup 项目链接到 Todoist 项目。

    todoist_ref: Todoist 项目名称，或 "id:xxx"
    lineup_name: lineup 项目名称（必须已存在）

    用于名字不一致但语义对应的情况。例如：
      lineup_todoist_link("科研", "research")
      lineup_todoist_link("自动化", "productivity")
    """
    from lineup.plugins import todoist as td_plugin
    try:
        return td_plugin.link_project(todoist_ref, lineup_name)
    except td_plugin.TodoistError as e:
        return f"错误：{e}"


@mcp.tool()
def lineup_todoist_unlink(lineup_name: str) -> str:
    """解除 lineup 项目和 Todoist 的链接（lineup 项目本身保留）。"""
    from lineup.plugins import todoist as td_plugin
    return td_plugin.unlink_project(lineup_name)


def main():
    mcp.run()


if __name__ == "__main__":
    main()
