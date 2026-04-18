# research

## Project inventory
The `objects/` directory contains one entry per lineup-linked resource in this project (1 total). Run `ls objects/` to list them.

- **Filesystem-backed** objects (file / folder / obsidian / script) are **symlinks** to the real path. `cat` / `Read` / `ls` them directly.
- **Non-filesystem** objects (zotero / trilium / url) are `.md` **stubs**. Each stub has a YAML frontmatter with `lineup_object_type` and `lineup_object_target`, and a body telling you which MCP tool to use. **Always read the stub first** — don't guess what tool to call from the name alone.

## Skill: Filesystem file

File objects are symlinked under `objects/`. Use `Read` / `Grep` / `cat` directly. Markdown / code / text files all work.
## Drill-down rule
When the user says they *added*, *created*, or *updated* something in this project, **don't stop at `ls objects/`**. The object you're looking for is usually *inside* one of the existing container objects (a Zotero collection, an Obsidian folder, a Trilium parent note, a filesystem folder). For every container-type object in the project:

1. Read its stub (or `ls` the symlinked folder).
2. Use the appropriate browse/list tool from the skills above to enumerate children.
3. Compare against the user's description to find the new/relevant child.

Spending extra tokens on browse calls is cheap; asking the user to re-enter metadata you could've discovered is expensive and annoying.
## lineup 层级和创建纪律（**重要**）

lineup 里只有三种层级：

- **project**：长期工作区（例如 `research`, `work`, `personal`）。可以嵌套 project 和 task。有 main agent 和 objects/。
- **task**：一次具体工作（例如 "review paper X", "apply to company Y"）。*parallel* — 和兄弟 task 互不阻塞。每个 task 可以有自己的 agent 和 objects/。
- **step**：task 内部的顺序 checklist。*sequential* — 前一个没做完后一个就被 lock。只有 agent 能创建。

### 创建任何 project / task / step 之前，按顺序做这三件事：

1. **先调 `lineup_list_children(parent)`** 看现有子项。如果找到同名或语义接近的，**优先复用**，不要新建一个几乎相同的。
2. **确认用户想要的 type**。用户的口头描述经常模糊（"子项目"/"子任务"/"新建一个"可能指任何一种）。如果不确定，**先问用户**：
   > "你是要建一个 project、task 还是 step？project = 长期工作区，task = 一次具体工作，step = 工作流里按顺序执行的一步。"
   不要擅自决定。
3. 选对工具：
   - `lineup_create_project(name, parent=...)` — 只用于 project
   - `lineup_create_task(name, parent=...)` — task（parent 必须是 project）
   - `lineup_create_step(name, parent_task=...)` — step（parent_task 必须是 task）

### 步骤化流程只有 step

用户描述"step-wise 流程 / 分几步 / workflow / 按顺序做" → 用 `lineup_create_step`（先用 `lineup_create_task` 建一个 task 作为 parent）。

**MCP 里没有 `lineup_todo_add`** —— todo 功能已被 task + step 取代。
所有步骤化的需求只用 step；所有独立提醒只用 task 的 `due_at`。

### 常见错误（不要犯）

- ❌ 用户说"放到 project-X 这个新建的子项目下面" → 你直接建 project。应该先 `list_children` 看是不是已经有一个 同名或相似的 task，如果有就问用户是不是指它。
- ❌ 用户说"把 step-wise 的流程也新建进去" → 你用 `lineup_todo_add`。应该用 `lineup_create_task` + 多次 `lineup_create_step`。
- ❌ 用户说"子项目" → 你二话不说建 project。应该问："你是要 project 还是 task？"（多数情况下用户指的是 task）。
- ❌ 用户说"task-X ddl 是下周五" → 你想方设法在项目上加 due。应该用 `lineup_set_task_meta('task-X', due_at='2026-05-14')` 设到对应的 task 上。

### 设置截止日期 / 重要紧急 / 状态：只有 task 有

- **project 不能有 `due_at`** —— 它是长期工作区，概念上没有截止日期。用户说"给 X 项目设截止日为 Y"的时候，真正想要的一定是 X 下面**某个具体 task** 有 Y 截止日。先 `lineup_list_children(X)` 看看，选对 task 再调工具。
- **`lineup_set_task_meta(name, due_at=..., important=..., urgent=..., status=...)`** 是更新 task 属性的唯一正确工具。**不要**用 `lineup_todo_add` 当 due_at 的 workaround —— todo 的 due_date 字段不会进 Today 视图，不会触发提醒，和 task 的 due_at 是两回事。
- 标记 task 完成 → `lineup_set_task_meta(name, status='done')`，不是 `lineup_todo_done`。
