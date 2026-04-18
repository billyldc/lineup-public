import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron'
import { join, extname, dirname, basename, relative } from 'path'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, watchFile, unwatchFile } from 'fs'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { getDb } from './db'

// Use ESM imports so Rollup doesn't create renamed local variables inside
// each function, which was causing "Cannot access 'existsSync2' before
// initialization" TDZ errors at runtime.
const nativeRequire = createRequire(import.meta.url || __filename)

// Path to the lineup Python CLI. Uses uv to run in the project's venv.
const LINEUP_ROOT = join(homedir(), 'lineup')  // TODO: make configurable

// Root of the virtual project folders that the per-project "main agent"
// claude sessions run inside. See syncProjectVirtualFolder().
const VIRTUAL_PROJECTS_ROOT = join(homedir(), '.lineup', 'projects')

/**
 * Turn a project name into a filesystem-safe slug for the virtual folder.
 * Keeps CJK characters (which are valid in macOS filenames) but strips
 * path separators and other nasties.
 */
function projectSlug(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/^\.+/, '')
    .trim() || 'project'
}

function virtualProjectDir(projectName: string): string {
  return join(VIRTUAL_PROJECTS_ROOT, projectSlug(projectName))
}

/**
 * Build the .md stub body for a non-symlink object. Machine-parseable
 * frontmatter on top (so the agent can grep it) + human-readable body
 * saying which MCP tool to call.
 */
function buildObjectStub(row: { name: string; target: string; type: string }): string {
  // Extract the zotero key from its URI form so the agent can copy-paste
  // without re-parsing.
  let extraHint = ''
  if (row.type === 'zotero') {
    const itemMatch = row.target.match(/zotero:\/\/select\/library\/items\/([A-Z0-9]+)/)
    const collMatch = row.target.match(/zotero:\/\/select\/library\/collections\/([A-Z0-9]+)/)
    if (itemMatch) {
      extraHint =
        `\nzotero_kind: item\n` +
        `zotero_key: ${itemMatch[1]}\n` +
        `\nThis is a single Zotero **item**. To read metadata:\n` +
        `\`mcp__zotero__zotero_get_item_metadata(item_key="${itemMatch[1]}")\`\n`
    } else if (collMatch) {
      extraHint =
        `\nzotero_kind: collection\n` +
        `zotero_key: ${collMatch[1]}\n` +
        `\nThis is a Zotero **collection** — it has children.\n` +
        `- List items inside: \`mcp__zotero__zotero_get_collection_items(collection_key="${collMatch[1]}")\`\n` +
        `- Drill deeper into a returned item with \`mcp__zotero__zotero_get_item_metadata\`.\n`
    }
  } else if (row.type === 'trilium') {
    extraHint =
      `\ntrilium_noteId: ${row.target}\n` +
      `\nThis is a Trilium note (may or may not have children).\n` +
      `- Read content: \`mcp__lineup__lineup_trilium_read(noteId="${row.target}")\`\n` +
      `- List children if any: \`mcp__lineup__lineup_trilium_browse(parent_id="${row.target}")\`\n`
  } else if (row.type === 'url') {
    extraHint =
      `\nurl: ${row.target}\n\nFetch with the \`WebFetch\` tool.\n`
  }

  return (
    `---\n` +
    `lineup_object_name: ${row.name}\n` +
    `lineup_object_type: ${row.type}\n` +
    `lineup_object_target: ${row.target}\n` +
    `---\n\n` +
    `# ${row.name}\n` +
    extraHint
  )
}

/**
 * Generate the "Inventory & skills" section of CLAUDE.md. This is what
 * teaches the main agent how to actually explore the project — not just
 * stare at the stubs. Only emits sections for types that actually appear
 * in the current project.
 */
function buildInventoryAndSkills(
  rows: Array<{ name: string; target: string; type: string }>,
  typesPresent: Set<string>,
): string {
  const blocks: string[] = []

  blocks.push(`## Project inventory`)
  blocks.push(
    `The \`objects/\` directory contains one entry per lineup-linked resource in this project (${rows.length} total). ` +
    `Run \`ls objects/\` to list them.\n\n` +
    `- **Filesystem-backed** objects (file / folder / obsidian / script) are **symlinks** to the real path. \`cat\` / \`Read\` / \`ls\` them directly.\n` +
    `- **Non-filesystem** objects (zotero / trilium / url) are \`.md\` **stubs**. Each stub has a YAML frontmatter with \`lineup_object_type\` and \`lineup_object_target\`, and a body telling you which MCP tool to use. **Always read the stub first** — don't guess what tool to call from the name alone.`
  )
  blocks.push('')

  // Stable ordering when emitting skill sections
  const ordered = ['zotero', 'trilium', 'obsidian', 'folder', 'file', 'url', 'script']

  for (const t of ordered) {
    if (!typesPresent.has(t)) continue
    const section = TYPE_SKILLS[t]
    if (section) blocks.push(section)
  }

  // Universal drill-down reminder — this is what the review test case
  // exposed as missing: the agent saw containers and stopped there.
  blocks.push(`## Drill-down rule`)
  blocks.push(
    `When the user says they *added*, *created*, or *updated* something in this project, **don't stop at \`ls objects/\`**. ` +
    `The object you're looking for is usually *inside* one of the existing container objects (a Zotero collection, an Obsidian folder, a Trilium parent note, a filesystem folder). ` +
    `For every container-type object in the project:\n\n` +
    `1. Read its stub (or \`ls\` the symlinked folder).\n` +
    `2. Use the appropriate browse/list tool from the skills above to enumerate children.\n` +
    `3. Compare against the user's description to find the new/relevant child.\n\n` +
    `Spending extra tokens on browse calls is cheap; asking the user to re-enter metadata you could've discovered is expensive and annoying.`
  )

  // Hierarchy + creation discipline — the hard rules the agent has to
  // follow when modifying the lineup DB on the user's behalf.
  blocks.push(`## lineup 层级和创建纪律（**重要**）

lineup 里只有三种层级：

- **project**：长期工作区（例如 \`review\`, \`research\`, \`实习\`）。可以嵌套 project 和 task。有 main agent 和 objects/。
- **task**：一次具体工作（例如"审稿 FOCS26 paper 42"）。*parallel* — 和兄弟 task 互不阻塞。每个 task 可以有自己的 agent 和 objects/。
- **step**：task 内部的顺序 checklist。*sequential* — 前一个没做完后一个就被 lock。只有 agent 能创建。

### 创建任何 project / task / step 之前，按顺序做这三件事：

1. **先调 \`lineup_list_children(parent)\`** 看现有子项。如果找到同名或语义接近的，**优先复用**，不要新建一个几乎相同的。
2. **确认用户想要的 type**。用户的口头描述经常模糊（"子项目"/"子任务"/"新建一个"可能指任何一种）。如果不确定，**先问用户**：
   > "你是要建一个 project、task 还是 step？project = 长期工作区，task = 一次具体工作，step = 工作流里按顺序执行的一步。"
   不要擅自决定。
3. 选对工具：
   - \`lineup_create_project(name, parent=...)\` — 只用于 project
   - \`lineup_create_task(name, parent=...)\` — task（parent 必须是 project）
   - \`lineup_create_step(name, parent_task=...)\` — step（parent_task 必须是 task）

### 步骤化流程只有 step

用户描述"step-wise 流程 / 分几步 / workflow / 按顺序做" → 用 \`lineup_create_step\`（先用 \`lineup_create_task\` 建一个 task 作为 parent）。

**MCP 里没有 \`lineup_todo_add\`** —— todo 功能已被 task + step 取代。
所有步骤化的需求只用 step；所有独立提醒只用 task 的 \`due_at\`。

### 常见错误（不要犯）

- ❌ 用户说"放到 FOCS2026review 这个新建的子项目下面" → 你直接建 project。应该先 \`list_children\` 看是不是已经有一个 FOCS 相关的 task，如果有就问用户是不是指它。
- ❌ 用户说"把 step-wise 的流程也新建进去" → 你用 \`lineup_todo_add\`。应该用 \`lineup_create_task\` + 多次 \`lineup_create_step\`。
- ❌ 用户说"子项目" → 你二话不说建 project。应该问："你是要 project 还是 task？"（多数情况下用户指的是 task）。
- ❌ 用户说"FOCS26 ddl 是 5 月 14 日" → 你想方设法在项目上加 due。应该用 \`lineup_set_task_meta('FOCS26review', due_at='2026-05-14')\` 设到对应的 task 上。

### 设置截止日期 / 重要紧急 / 状态：只有 task 有

- **project 不能有 \`due_at\`** —— 它是长期工作区，概念上没有截止日期。用户说"给 X 项目设截止日为 Y"的时候，真正想要的一定是 X 下面**某个具体 task** 有 Y 截止日。先 \`lineup_list_children(X)\` 看看，选对 task 再调工具。
- **\`lineup_set_task_meta(name, due_at=..., important=..., urgent=..., status=...)\`** 是更新 task 属性的唯一正确工具。**不要**用 \`lineup_todo_add\` 当 due_at 的 workaround —— todo 的 due_date 字段不会进 Today 视图，不会触发提醒，和 task 的 due_at 是两回事。
- 标记 task 完成 → \`lineup_set_task_meta(name, status='done')\`，不是 \`lineup_todo_done\`。`)

  return blocks.join('\n')
}

/** Per-type skill documentation — shown only for types actually present. */
const TYPE_SKILLS: Record<string, string> = {
  zotero: `## Skill: Zotero

A Zotero object in this project is either an **item** (single paper/book) or a **collection** (a folder of items). Each stub's frontmatter tells you which one.

**Browse a collection's children:**
\`\`\`
mcp__zotero__zotero_get_collection_items(collection_key="<key>")
\`\`\`

**Read an item's metadata (title, authors, abstract, DOI, tags):**
\`\`\`
mcp__zotero__zotero_get_item_metadata(item_key="<key>")
\`\`\`

**Get an item's notes / attachments:**
\`\`\`
mcp__zotero__zotero_get_item_children(item_key="<key>")
mcp__zotero__zotero_get_notes(item_key="<key>")
mcp__zotero__zotero_get_item_fulltext(item_key="<key>")
\`\`\`

**Search across the whole library (not just this project):**
\`\`\`
mcp__zotero__zotero_search_items(query="...")
\`\`\`

Prefer the scoped collection-items call over library-wide search when the user says "I added it to X collection" — it's faster and more precise.`,

  trilium: `## Skill: Trilium

Trilium objects are identified by a noteId (alphanumeric ~12-char string). Every trilium object in this project can potentially have children.

**Read a note's content (plain text from HTML/code body):**
\`\`\`
mcp__lineup__lineup_trilium_read(noteId="<id>")
\`\`\`

**List a note's immediate children:**
\`\`\`
mcp__lineup__lineup_trilium_browse(parent_id="<id>")
\`\`\`

**Full-text search across the whole Trilium database:**
\`\`\`
mcp__lineup__lineup_trilium_search(query="...")
\`\`\``,

  obsidian: `## Skill: Obsidian

Obsidian objects are real filesystem paths. Each entry in \`objects/\` is a **symlink to the vault directory/file**, not a stub.

### Rule of thumb
**If the obsidian object is a folder and you need to list / read files under it, ALWAYS use plain \`ls objects/<name>/\` and \`Read objects/<name>/<file>\` on the symlink.** Do NOT call \`lineup_obsidian_browse\` with the object's name — that tool expects an absolute filesystem path or an empty string, and passing a bare name returns "空目录" (empty) which will mislead you.

Example: if \`objects/my reviews 审稿\` is a symlink to \`/Users/foo/Desktop/review/\`, then:
- ✅ \`ls "objects/my reviews 审稿/"\`   (lists all .md notes)
- ✅ \`Read objects/my reviews 审稿/focs26.md\`
- ❌ \`lineup_obsidian_browse(path="my reviews 审稿")\` — returns empty, wrong tool for this case

### When to use the MCP helpers
Only when you need cross-vault behavior that transcends what's linked into this project:
\`\`\`
mcp__lineup__lineup_obsidian_browse(path="<ABSOLUTE path>")   # all notes under that absolute dir
mcp__lineup__lineup_obsidian_search(query="...")              # search ALL obsidian vaults
\`\`\`
For both, the path must be an absolute filesystem path, not a lineup object name. You can get the absolute path from any symlinked \`objects/<name>\` by resolving it (e.g. \`Read\` the symlink).`,

  folder: `## Skill: Filesystem folder

Folder objects are symlinked under \`objects/\`. Treat them like any directory: \`ls\`, \`Glob\`, \`Grep\`, \`Read\`. No special tool needed.`,

  file: `## Skill: Filesystem file

File objects are symlinked under \`objects/\`. Use \`Read\` / \`Grep\` / \`cat\` directly. Markdown / code / text files all work.`,

  url: `## Skill: URL

URL objects are \`.md\` stubs with the URL in frontmatter. Use the \`WebFetch\` tool to retrieve the page when needed.`,

  script: `## Skill: Shell script

Script objects are symlinks to executables. You may \`Read\` them to review, but **don't execute** without asking the user first.`,
}

/**
 * Ensure ~/.lineup/projects/<slug>/ exists with:
 *   - CLAUDE.md         — from projects.description + optional hand-written
 *                         CLAUDE.md.manual overlay
 *   - objects/<n>.md    — one file per DB object row. For fs-backed objects
 *                         it's a symlink; for url/zotero/trilium it's a
 *                         small .md stub containing the target URI.
 *   - .mcp.json         — inherited from ~/.lineup/.mcp.json if present
 *
 * Called every time the project is focused in the UI so the virtual folder
 * stays in sync with the DB.
 */
function syncProjectVirtualFolder(project: { id: number; name: string; description: string | null }): string {
  const db = getDb()
  const dir = virtualProjectDir(project.name)
  mkdirSync(dir, { recursive: true })
  const objectsDir = join(dir, 'objects')
  mkdirSync(objectsDir, { recursive: true })

  // ── objects/ ────────────────────────────────────────────────
  // Rebuild from scratch each sync (cheap, DB is small). Keep the
  // directory in sync with the objects table.
  try {
    for (const entry of readdirSync(objectsDir)) {
      try { rmSync(join(objectsDir, entry), { force: true }) } catch { /* ignore */ }
    }
  } catch { /* dir missing, will be created below */ }

  const rows = db.prepare(
    'SELECT name, target, type FROM objects WHERE project_id = ? ORDER BY name'
  ).all(project.id) as Array<{ name: string; target: string; type: string }>

  // Track which types appear in this project so we can emit matching
  // skill instructions in CLAUDE.md below.
  const typesPresent = new Set<string>()

  const usedNames = new Set<string>()
  for (const row of rows) {
    typesPresent.add(row.type)
    // Filesystem-safe name + extension
    let safe = row.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim()
    if (!safe) safe = 'object'
    let file = safe.endsWith('.md') ? safe : `${safe}.md`
    // De-duplicate names
    let n = 2
    while (usedNames.has(file)) {
      const base = safe.replace(/\.md$/, '')
      file = `${base} (${n}).md`
      n++
    }
    usedNames.add(file)
    const dest = join(objectsDir, file)

    const isFsBacked = row.type === 'file' || row.type === 'folder' ||
                       row.type === 'obsidian' || row.type === 'script'

    if (isFsBacked && existsSync(row.target)) {
      // Symlink to the real target. macOS handles broken symlinks fine if
      // the target goes missing later.
      try {
        nativeRequire('fs').symlinkSync(row.target, dest)
        continue
      } catch {
        // Fall through to stub if symlink fails
      }
    }

    // Stub: a .md file the agent can grep/cat to discover what this object
    // actually is. The YAML-ish frontmatter is machine-parseable; the body
    // tells the agent which MCP tool to use to drill in.
    const stub = buildObjectStub(row)
    writeFileSync(dest, stub, 'utf8')
  }

  // ── CLAUDE.md ────────────────────────────────────────────────
  // Stacked: header (name + description) → inventory & skills section
  // (auto-generated, changes with the object set) → manual overlay from
  // CLAUDE.md.manual (never overwritten, workflow-level instructions).
  const manualPath = join(dir, 'CLAUDE.md.manual')
  const manualText = existsSync(manualPath) ? readFileSync(manualPath, 'utf8') : ''
  const header = `# ${project.name}\n\n${project.description || ''}`.trim()
  const inventory = buildInventoryAndSkills(rows, typesPresent)
  const claudeMd = manualText
    ? `${header}\n\n${inventory}\n\n---\n\n${manualText}\n`
    : `${header}\n\n${inventory}\n`
  writeFileSync(join(dir, 'CLAUDE.md'), claudeMd, 'utf8')

  // ── .mcp.json ────────────────────────────────────────────────
  // Inherit from ~/.lineup/.mcp.json if present, otherwise leave alone.
  const sharedMcp = join(homedir(), '.lineup', '.mcp.json')
  if (existsSync(sharedMcp)) {
    try {
      writeFileSync(join(dir, '.mcp.json'), readFileSync(sharedMcp, 'utf8'), 'utf8')
    } catch { /* ignore */ }
  }

  return dir
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      webviewTag: true,  // enables <webview> for URL preview
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// ── Browse helpers ─────────────────────────────────────────────────────

interface BrowseItem {
  id: string
  name: string
  target: string
  type: string
  default_app: string | null
  preview: string
}

function runBrowseCli(subcommand: string, arg: string): Promise<BrowseItem[]> {
  return runJsonCli(['browse', subcommand, ...(arg ? [arg] : [])])
}

function runSearchCli(subcommand: string, query: string): Promise<BrowseItem[]> {
  return runJsonCli(['search', subcommand, query])
}

interface PreviewResult {
  kind: 'text' | 'markdown' | 'html' | 'empty' | 'error' | 'binary' | 'image' | 'pdf'
  content: string
  mime?: string
  error?: string
}

const MAX_PREVIEW_BYTES = 500_000 // 500 KB text cap
const MAX_PREVIEW_SIZE = 20_000_000 // 20 MB absolute cap

/** Preview a filesystem file by path. Dispatches by extension. */
function previewFilesystemFile(target: string, typeHint: string | null): PreviewResult {
  if (!existsSync(target)) {
    return { kind: 'error', content: '', error: '文件不存在' }
  }
  try {
    const stat = statSync(target)
    if (stat.size > MAX_PREVIEW_SIZE) {
      return { kind: 'error', content: '', error: `文件过大 (${(stat.size / 1e6).toFixed(1)} MB)` }
    }
    const ext = extname(target).toLowerCase()

    // Image
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
      const buf = readFileSync(target)
      const b64 = buf.toString('base64')
      const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1).replace('jpg', 'jpeg')}`
      return { kind: 'image', content: `data:${mime};base64,${b64}`, mime }
    }

    // PDF — return as base64 data URL so iframe can load it without
    // tripping Electron's webSecurity file:// restrictions.
    if (ext === '.pdf') {
      if (stat.size > 30_000_000) {
        return { kind: 'error', content: '', error: `PDF 过大 (${(stat.size / 1e6).toFixed(1)} MB)` }
      }
      const buf = readFileSync(target)
      const b64 = buf.toString('base64')
      return {
        kind: 'pdf',
        content: `data:application/pdf;base64,${b64}`,
        mime: 'application/pdf',
      }
    }

    // DOCX — handled by the async path in the IPC handler (see preview:load)
    // If we get here synchronously, the caller should have dispatched to
    // previewFilesystemFileAsync instead.
    if (ext === '.docx') {
      return { kind: 'error', content: '', error: 'DOCX 需要异步路径' }
    }

    // XLSX / XLS — read via sheetjs, render first sheet as HTML table
    if (ext === '.xlsx' || ext === '.xls') {
      try {
        const XLSX = nativeRequire('xlsx')
        const wb = XLSX.readFile(target)
        const sheetNames: string[] = wb.SheetNames
        const parts: string[] = []
        for (const name of sheetNames) {
          const ws = wb.Sheets[name]
          const html = XLSX.utils.sheet_to_html(ws, { header: '' })
          parts.push(`<h2>${name}</h2>${html}`)
        }
        return { kind: 'html', content: parts.join('\n') }
      } catch (e: any) {
        return { kind: 'error', content: '', error: `XLSX 读取失败: ${e.message}` }
      }
    }

    // Try as text (default fallback for any unknown extension)
    const buf = readFileSync(target)
    const slice = buf.length > MAX_PREVIEW_BYTES ? buf.slice(0, MAX_PREVIEW_BYTES) : buf
    if (slice.includes(0)) {
      return { kind: 'binary', content: `二进制文件 (${(stat.size / 1024).toFixed(1)} KB)\n${target}` }
    }
    const text = slice.toString('utf8')
    const truncated = buf.length > MAX_PREVIEW_BYTES
      ? `\n\n[… 已截断, 文件共 ${(buf.length / 1024).toFixed(1)} KB]`
      : ''
    const kind = ext === '.md' || typeHint === 'obsidian' ? 'markdown' : 'text'
    return { kind, content: text + truncated }
  } catch (e: any) {
    return { kind: 'error', content: '', error: e.message || '读取失败' }
  }
}

/** Async wrapper — handles DOCX and delegates to sync previewFilesystemFile for others */
async function previewZoteroItemAsync(target: string): Promise<PreviewResult> {
  return new Promise((resolve) => {
    const py = `
import sys
sys.path.insert(0, '${LINEUP_ROOT}')
from lineup.plugins.zotero import ZoteroPlugin
print(ZoteroPlugin().read(sys.argv[1]))
`
    execFile(PYTHON3, ['-c', py, target], { timeout: 5000, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ kind: 'error', content: '', error: `Zotero 读取失败: ${err.message}` })
          return
        }
        resolve({ kind: 'markdown', content: stdout.trim() })
      })
  })
}

async function previewFilesystemFileAsync(target: string, typeHint: string | null): Promise<PreviewResult> {
  if (!existsSync(target)) {
    return { kind: 'error', content: '', error: '文件不存在' }
  }
  const ext = extname(target).toLowerCase()

  if (ext === '.docx') {
    try {
      const mammoth = nativeRequire('mammoth')
      const buf = readFileSync(target)
      const result = await mammoth.convertToHtml({ buffer: buf })
      return { kind: 'html', content: result.value || '(空文档)' }
    } catch (e: any) {
      return { kind: 'error', content: '', error: `DOCX 读取失败: ${e.message}` }
    }
  }

  return previewFilesystemFile(target, typeHint)
}

function loadPreview(type: string, target: string): PreviewResult {
  if (type === 'file' || type === 'script' || type === 'obsidian') {
    return previewFilesystemFile(target, type)
  }

  if (type === 'trilium') {
    const triliumDbPath = join(
      homedir(), 'Library', 'Application Support', 'trilium-data', 'document.db'
    )
    if (!existsSync(triliumDbPath)) {
      return { kind: 'error', content: '', error: 'Trilium 本地数据库不存在' }
    }
    try {
      const Db = nativeRequire('better-sqlite3')
      const db = new Db(triliumDbPath, { readonly: true })
      try {
        const row = db.prepare(
          "SELECT n.title, n.type, bl.content FROM notes n " +
          "LEFT JOIN blobs bl ON n.blobId = bl.blobId " +
          "WHERE n.noteId = ? AND n.isDeleted = 0"
        ).get(target) as any
        if (!row) return { kind: 'error', content: '', error: '笔记不存在' }
        const content: string = row.content || ''
        if (row.type === 'text') {
          // Return raw HTML — renderer will convert to markdown + render.
          // Prepend title as an H1.
          const html = `<h1>${row.title}</h1>${content}`
          return { kind: 'html', content: html }
        }
        if (row.type === 'code') {
          // Wrap in fenced code block. Guess language from mime if possible.
          const lang = (row as any).mime?.split('/')?.pop()?.replace(/^x-/, '') || ''
          return { kind: 'markdown', content: `# ${row.title}\n\n\`\`\`${lang}\n${content}\n\`\`\`` }
        }
        return { kind: 'empty', content: `（${row.type} 类型，无文本预览）` }
      } finally {
        db.close()
      }
    } catch (e: any) {
      return { kind: 'error', content: '', error: e.message || '读取失败' }
    }
  }

  if (type === 'url') {
    return { kind: 'empty', content: `URL 预览未实现\n${target}` }
  }
  if (type === 'zotero') {
    // Zotero collections have no preview content of their own — the user
    // clicks them to open a BrowseColumn instead.
    if (target.startsWith('zotero://select/library/collections/')) {
      return { kind: 'empty', content: '集合请点击进入浏览' }
    }
    // Zotero item preview is async and lives in previewZoteroItemAsync()
    // because we have to shell out to Python to bypass the write lock.
    // The dispatch in preview:load handles that path.
    return { kind: 'empty', content: target }
  }
  if (type === 'folder') {
    return { kind: 'empty', content: '文件夹请单击进入浏览' }
  }
  // Unknown type — if target looks like a real file path, try to preview it
  if (existsSync(target)) {
    return previewFilesystemFile(target, null)
  }
  return { kind: 'empty', content: `未知类型 ${type}` }
}

interface LoadedMessage {
  role: 'user' | 'assistant'
  text: string
}

/**
 * Parse a claude-code session .jsonl file and return the user-visible
 * conversation (user prompts + assistant text responses).
 * Skips tool_use, thinking blocks, attachments, system events, etc.
 */
function loadSessionMessages(sessionId: string, cwd: string): LoadedMessage[] {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const sessionFile = join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`)
  if (!existsSync(sessionFile)) return []

  let content: string
  try {
    content = readFileSync(sessionFile, 'utf8')
  } catch {
    return []
  }

  const messages: LoadedMessage[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    const type = obj.type
    const msg = obj.message
    if (!msg) continue

    if (type === 'user') {
      // user content is usually a string, occasionally an array of
      // tool_result blocks (which we skip for display purposes).
      if (typeof msg.content === 'string') {
        const t = msg.content.trim()
        if (t) messages.push({ role: 'user', text: t })
      } else if (Array.isArray(msg.content)) {
        // Only extract plain text blocks, skip tool_result
        const parts: string[] = []
        for (const b of msg.content) {
          if (b && b.type === 'text' && typeof b.text === 'string') {
            parts.push(b.text)
          }
        }
        const joined = parts.join('').trim()
        if (joined) messages.push({ role: 'user', text: joined })
      }
    } else if (type === 'assistant') {
      // assistant content is an array of blocks: thinking/text/tool_use/etc
      if (Array.isArray(msg.content)) {
        const parts: string[] = []
        for (const b of msg.content) {
          if (b && b.type === 'text' && typeof b.text === 'string') {
            parts.push(b.text)
          }
        }
        const joined = parts.join('').trim()
        if (joined) messages.push({ role: 'assistant', text: joined })
      } else if (typeof msg.content === 'string') {
        const t = msg.content.trim()
        if (t) messages.push({ role: 'assistant', text: t })
      }
    }
    // Skip system, attachment, permission-mode, file-history-snapshot, etc.
  }
  return messages
}

interface DiscoveredSession {
  name: string           // display name
  session_id: string     // UUID
  last_modified: string  // ISO string
  message_count: number
  folder_path: string
}

/**
 * Discover existing Claude Code sessions for a given folder.
 *
 * The user's claude wrapper (~/.zshrc function) stores session IDs at:
 *   ~/.claude_sessions/<md5(folder_path)>
 * where the file contents is a single session UUID. The actual conversation
 * jsonl lives under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl and we
 * read it for metadata (message count, summary).
 */
function discoverClaudeSessions(folderPath: string): DiscoveredSession[] {
  // 1. md5 the folder path to get the session-store key
  const hash = createHash('md5').update(folderPath).digest('hex')
  const sessionKeyFile = join(homedir(), '.claude_sessions', hash)

  if (!existsSync(sessionKeyFile)) return []

  let sessionId: string
  try {
    sessionId = readFileSync(sessionKeyFile, 'utf8').trim()
  } catch {
    return []
  }
  if (!sessionId) return []

  // 2. Locate the actual session .jsonl under ~/.claude/projects/<encoded>/
  // Claude's encoding replaces any non-alphanumeric character with '-'
  // (so /, _, and non-ASCII all become dashes).
  const encoded = folderPath.replace(/[^a-zA-Z0-9]/g, '-')
  const sessionFile = join(
    homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`
  )

  let name = sessionId.slice(0, 8)
  let messageCount = 0
  let lastModified = new Date().toISOString()

  if (existsSync(sessionFile)) {
    try {
      const stat = statSync(sessionFile)
      lastModified = stat.mtime.toISOString()
      const content = readFileSync(sessionFile, 'utf8')
      const lines = content.split('\n').filter((l: string) => l.trim().length > 0)
      messageCount = lines.length
      // Try to grab the first user message as a label
      for (const line of lines) {
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
            name = obj.message.content.slice(0, 40).replace(/\n/g, ' ')
            break
          }
          if (obj.message && Array.isArray(obj.message.content)) {
            const text = obj.message.content.find((c: any) => c.type === 'text')
            if (text && typeof text.text === 'string') {
              name = text.text.slice(0, 40).replace(/\n/g, ' ')
              break
            }
          }
        } catch { /* skip bad json */ }
      }
    } catch { /* best effort */ }
  }

  return [{
    name,
    session_id: sessionId,
    last_modified: lastModified,
    message_count: messageCount,
    folder_path: folderPath,
  }]
}

interface TerminalWindow {
  window_id: number
  tab: number
  tty: string
  title: string
  cwd: string | null
}

/**
 * Query terminal-mcp for the list of open Terminal.app windows + their cwd.
 * Delegates to the python module at ~/terminal-mcp so the same
 * logic is used by lineup, the MCP server, and any other agent.
 */
function listTerminalWindows(): TerminalWindow[] {
  const { execSync } = require('child_process') as typeof import('child_process')
  const py = `
import sys, json
sys.path.insert(0, '${join(homedir(), "terminal-mcp")}')
from terminal_mcp.server import _get_windows, _get_cwd_by_tty
out = []
for w in _get_windows():
    pid, cwd = _get_cwd_by_tty(w['tty'])
    out.append({**w, 'cwd': cwd})
print(json.dumps(out, ensure_ascii=False))
`
  try {
    const stdout = execSync('/usr/bin/python3 -c ' + JSON.stringify(py), {
      encoding: 'utf8',
      timeout: 5000,
    })
    return JSON.parse(stdout)
  } catch (e) {
    console.error('[listTerminalWindows] failed:', (e as Error).message)
    return []
  }
}

/** Find an existing Terminal window whose cwd matches the target. */
function findTerminalWindowForCwd(targetCwd: string): TerminalWindow | null {
  const wins = listTerminalWindows()
  console.log('[findTerminalWindowForCwd] target=', JSON.stringify(targetCwd))
  for (const w of wins) {
    console.log('  candidate', w.window_id, JSON.stringify(w.cwd), w.cwd === targetCwd ? '← MATCH' : '')
    if (w.cwd === targetCwd) return w
  }
  return null
}

interface OpenTerminalResult {
  ok: boolean
  reused: boolean
  error?: string
}

/**
 * Open Terminal.app with cwd = the given path.
 * - If a Terminal tab already has cwd matching, focus it
 * - Otherwise open a new tab, cd to the path, run `claude`
 */
async function openTerminalAtCwd(cwd: string): Promise<OpenTerminalResult> {
  const existing = findTerminalWindowForCwd(cwd)

  if (existing) {
    // Focus by window id (more reliable than tty matching)
    const script = `
tell application "Terminal"
    reopen
    activate
    repeat with w in windows
        if id of w is ${existing.window_id} then
            set index of w to 1
            exit repeat
        end if
    end repeat
end tell
tell application "System Events"
    set frontmost of (first process whose name is "Terminal") to true
end tell
`
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], (err) => {
        if (err) resolve({ ok: false, reused: false, error: err.message })
        else resolve({ ok: true, reused: true })
      })
    })
  }

  // No existing terminal — open a new tab and run `claude`
  const escapedCwd = cwd.replace(/'/g, "'\\''")
  const script = `
tell application "Terminal"
    reopen
    activate
    do script "cd '${escapedCwd}' && claude"
end tell
tell application "System Events"
    set frontmost of (first process whose name is "Terminal") to true
end tell
`
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], (err) => {
      if (err) resolve({ ok: false, reused: false, error: err.message })
      else resolve({ ok: true, reused: false })
    })
  })
}

function browseFilesystem(dirPath: string): BrowseItem[] {
  try {
    const entries = readdirSync(dirPath)
    const items: BrowseItem[] = []
    for (const name of entries) {
      // Always list hidden files (Finder-like with Cmd+Shift+. always on).
      // Skip only the two nav entries that readdirSync never returns anyway,
      // plus macOS noise.
      if (name === '.DS_Store') continue
      // Baidu Netdisk leaves <filename>.baiduyun.uploading.cfg sidecars everywhere
      if (name.endsWith('.baiduyun.uploading.cfg')) continue
      // Google Drive temp upload/download files AND folders
      if (name.startsWith('.tmp.drive') || name.endsWith('.tmp.driveupload') || name.endsWith('.tmp.drivedownload')) continue
      const full = join(dirPath, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      items.push({
        id: full,
        name: isDir ? `${name}/` : name,
        target: full,
        type: isDir ? 'folder' : 'file',
        default_app: null,
        preview: '',
      })
    }
    items.sort((a, b) => {
      const ad = a.name.endsWith('/') ? 0 : 1
      const bd = b.name.endsWith('/') ? 0 : 1
      if (ad !== bd) return ad - bd
      // Hidden files (starting with .) sort after visible ones
      const ah = a.name.startsWith('.') ? 1 : 0
      const bh = b.name.startsWith('.') ? 1 : 0
      if (ah !== bh) return ah - bh
      return a.name.localeCompare(b.name)
    })
    return items
  } catch {
    return []
  }
}

function runJsonCli(cliArgs: string[]): Promise<BrowseItem[]> {
  return new Promise((resolve) => {
    const args = ['run', '--directory', LINEUP_ROOT, 'lu', ...cliArgs]
    execFile('uv', args, { cwd: LINEUP_ROOT, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.error(`lu ${cliArgs.join(' ')} failed:`, err.message)
          resolve([])
          return
        }
        try {
          const data = JSON.parse(stdout.trim())
          if (Array.isArray(data)) resolve(data)
          else resolve([])
        } catch {
          resolve([])
        }
      }
    )
  })
}

// Detect whether an object can be navigated into (treated as a folder in
// the column view). Leaves (non-folder) get preview columns instead.
function objectHasChildren(obj: { type: string; target: string }): boolean {
  if (obj.type === 'folder') {
    try {
      return statSync(obj.target).isDirectory()
    } catch {
      return false
    }
  }
  if (obj.type === 'obsidian') {
    try {
      return statSync(obj.target).isDirectory()
    } catch {
      return false
    }
  }
  if (obj.type === 'trilium') {
    const triliumDbPath = join(
      homedir(), 'Library', 'Application Support', 'trilium-data', 'document.db'
    )
    if (!existsSync(triliumDbPath)) return false
    try {
      const Db = nativeRequire('better-sqlite3')
      const triliumDb = new Db(triliumDbPath, { readonly: true })
      try {
        const row = triliumDb.prepare(
          "SELECT COUNT(*) as c FROM branches WHERE parentNoteId = ? AND isDeleted = 0"
        ).get(obj.target) as any
        return (row?.c || 0) > 0
      } finally {
        triliumDb.close()
      }
    } catch {
      return false
    }
  }
  if (obj.type === 'zotero') {
    // Zotero collections need has_children info, but better-sqlite3 can't
    // bypass Zotero's write lock (no SQLITE_OPEN_URI support, so the
    // immutable=1 trick is unavailable). The check is delegated to a Python
    // helper via batch resolution in db:getObjects — see
    // resolveZoteroChildrenBatch(). This sync per-row path is only hit
    // outside that batch, so default to false to avoid a per-call subprocess
    // spawn here.
    return false
  }
  return false
}

/**
 * Pick a Python interpreter that supports PEP 604 syntax (`str | None`,
 * required by the lineup plugin code). /usr/bin/python3 is Apple's bundled
 * Python 3.9 which DOESN'T support it, so we look for a homebrew python3.
 */
function findPython3(): string {
  const candidates = [
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3.13',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/usr/bin/python3',  // last resort, will fail on PEP 604 code
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return 'python3'
}

const PYTHON3 = findPython3()

/**
 * Batch-check has_children for a list of Zotero collection keys via Python
 * (which CAN bypass Zotero's write lock via the file:...?immutable=1 URI).
 * Single subprocess spawn per project load — the lock-free path means it
 * works even while the desktop Zotero app is running.
 */
function resolveZoteroChildrenBatch(keys: string[]): Map<string, boolean> {
  const map = new Map<string, boolean>()
  if (keys.length === 0) return map
  const { execFileSync } = require('child_process') as typeof import('child_process')
  const py = `
import sys
sys.path.insert(0, '${LINEUP_ROOT}')
from lineup.plugins.zotero import collection_has_children
print(','.join('1' if collection_has_children(k) else '0' for k in sys.argv[1:]))
`
  try {
    const out = execFileSync(PYTHON3, ['-c', py, ...keys], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const flags = out.trim().split(',')
    keys.forEach((k, i) => map.set(k, flags[i] === '1'))
  } catch (e) {
    console.error('[zotero] batch has_children failed:', (e as Error).message)
    keys.forEach(k => map.set(k, false))
  }
  return map
}

// ── PTY manager: real terminals embedded in renderer tabs ─────────────
//
// node-pty is loaded via createRequire so Rollup leaves it alone.
// Each renderer Terminal owns one ptyId. Lifecycle:
//   pty:create  → spawn shell at cwd, optionally auto-running a command
//   pty:write   → forward keystrokes
//   pty:resize  → notify shell of new tty dimensions
//   pty:kill    → terminate (also auto-killed when renderer disconnects)
// Events back to renderer:
//   pty:data    → stdout/stderr chunk
//   pty:exit    → process exited

interface PtyLike {
  write(data: string): void
  resize(cols: number, rows: number): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  kill(signal?: string): void
  pid: number
}

const ptys = new Map<string, PtyLike>()
let ptyIdCounter = 0

function getPtyModule(): typeof import('node-pty') | null {
  try {
    return nativeRequire('node-pty')
  } catch (e) {
    console.error('[pty] failed to load node-pty:', (e as Error).message)
    return null
  }
}

function spawnPty(opts: {
  cwd: string
  cols: number
  rows: number
  command?: string
}): { id: string; error?: string } {
  const pty = getPtyModule()
  if (!pty) return { id: '', error: 'node-pty unavailable' }

  const shell = process.env.SHELL || '/bin/zsh'
  // Build the env: drop Electron's own VSCODE/ELECTRON noise, ensure PATH
  // includes ~/.local/bin so claude is on $PATH.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE

  // Always spawn a real interactive login shell — same as Terminal.app.
  // -l = login (sources .zprofile), -i = interactive (sources .zshrc, where
  // the user's `claude` wrapper function lives).
  // If an auto-command is specified, we write it into the pty AFTER spawn so
  // the shell stays alive when the command exits (giving the user a normal
  // prompt to recover from errors / type follow-up commands).
  let term: PtyLike
  try {
    term = pty.spawn(shell, ['-il'], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: env as { [key: string]: string },
    }) as unknown as PtyLike
  } catch (e) {
    return { id: '', error: (e as Error).message }
  }

  const id = `pty-${++ptyIdCounter}`
  ptys.set(id, term)

  term.onData((data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('pty:data', { id, data })
    }
  })
  term.onExit(({ exitCode, signal }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('pty:exit', { id, exitCode, signal })
    }
    ptys.delete(id)
  })

  // Auto-run the requested command. Bytes are queued in the pty's stdin
  // buffer until zsh finishes sourcing .zshrc and starts reading stdin —
  // identical to Terminal.app's "execute the following command on launch"
  // setting. Using setImmediate gives node-pty a tick to wire up handles.
  if (opts.command) {
    setImmediate(() => {
      try { term.write(`${opts.command}\n`) } catch { /* terminal already gone */ }
    })
  }

  return { id }
}

function registerPtyIpc(): void {
  ipcMain.handle('pty:create', (_e, opts: {
    cwd: string
    cols: number
    rows: number
    command?: string
  }) => spawnPty(opts))

  ipcMain.handle('pty:write', (_e, args: { id: string; data: string }) => {
    ptys.get(args.id)?.write(args.data)
  })

  ipcMain.handle('pty:resize', (_e, args: { id: string; cols: number; rows: number }) => {
    try { ptys.get(args.id)?.resize(args.cols, args.rows) } catch { /* tab gone */ }
  })

  ipcMain.handle('pty:kill', (_e, id: string) => {
    try { ptys.get(id)?.kill() } catch { /* already dead */ }
    ptys.delete(id)
  })
}

// ── IPC handlers: expose lineup DB to renderer ─────────────────────────

function registerIpc(): void {
  const db = getDb()

  ipcMain.handle('db:listProjects', (_e, opts?: { includeArchived?: boolean }) => {
    // Top-level sidebar: real roots (no parent) + pinned projects.
    // Pinned projects appear even if they have parents (quick-access shortcut).
    // Archived projects hidden unless includeArchived=true.
    // Pinned items sort first (so they sit at the top of the list).
    const includeArchived = opts?.includeArchived === true
    const rows = db.prepare(`
      SELECT p.* FROM projects p
      WHERE (p.type IS NULL OR p.type = 'project')
        AND (
          p.pinned = 1
          OR NOT EXISTS (SELECT 1 FROM project_parents pp WHERE pp.project_id = p.id)
        )
        ${includeArchived ? '' : 'AND (p.archived IS NULL OR p.archived = 0)'}
      ORDER BY p.pinned DESC, p.priority DESC, p.name
    `).all() as any[]
    for (const r of rows) {
      r.progress = computeProgress(r)
      // Resolve inherited colors for pinned sub-projects that don't have
      // their own color set. Root projects use their own color directly.
      if (r.color) {
        r._rootColors = [r.color]
      } else if (r.pinned) {
        const ancestors = db.prepare(`
          WITH RECURSIVE anc(id, depth) AS (
            SELECT parent_id, 1 FROM project_parents WHERE project_id = ?
            UNION ALL
            SELECT pp.parent_id, a.depth + 1 FROM project_parents pp
            JOIN anc a ON pp.project_id = a.id WHERE a.depth < 20
          )
          SELECT DISTINCT p.color FROM projects p
          WHERE p.id IN (SELECT id FROM anc) AND p.color IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM project_parents pp2 WHERE pp2.project_id = p.id)
        `).all(r.id) as { color: string }[]
        r._rootColors = ancestors.map(a => a.color)
      } else {
        r._rootColors = []
      }
    }
    return rows
  })

  /**
   * Compute progress automatically based on type:
   * - step: 100 if done, 0 otherwise
   * - task: (done steps / total steps) * 100
   * - project: weighted average of child task/project progress;
   *   weight = (important ? 2 : 1) * (urgent ? 1.5 : 1)
   *
   * Caches the result in the `progress` column for downstream queries
   * (e.g. a parent project reading its children's progress).
   */
  /**
   * Check if a completed recurring task should be auto-reset. Called from
   * computeProgress. If the task is done + recurring + due_at has passed
   * by recurring_days, reset: status→todo, shift due_at forward, reset
   * all child steps. This gives the Todoist "recurring task" behavior.
   */
  function maybeResetRecurring(row: any): boolean {
    if (row.type !== 'task' || row.status !== 'done') return false
    if (!row.recurring_days || row.recurring_days <= 0) return false
    if (!row.due_at) return false
    const dueMs = Date.parse(row.due_at.slice(0, 10))
    if (!Number.isFinite(dueMs)) return false
    const now = Date.now()
    const elapsedDays = (now - dueMs) / 86_400_000
    if (elapsedDays < row.recurring_days) return false
    // Time to reset
    const newDue = new Date(dueMs + row.recurring_days * 86_400_000)
    const newDueStr = newDue.toISOString().slice(0, 10)
    db.prepare(`UPDATE projects SET status = 'todo', due_at = ? WHERE id = ?`)
      .run(newDueStr, row.id)
    // Reset all child steps
    db.prepare(`
      UPDATE projects SET status = 'todo'
      WHERE type = 'step' AND id IN (
        SELECT project_id FROM project_parents WHERE parent_id = ?
      )
    `).run(row.id)
    row.status = 'todo'
    row.due_at = newDueStr
    return true
  }

  function computeProgress(row: { id: number; type: string; status: string }): number {
    if (row.type === 'step') return row.status === 'done' ? 100 : 0
    // Check recurring reset before treating as "done"
    maybeResetRecurring(row)
    if (row.status === 'done') return 100

    if (row.type === 'task') {
      const stats = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) as done
        FROM projects s
        JOIN project_parents sp ON s.id = sp.project_id
        WHERE sp.parent_id = ? AND s.type = 'step'
      `).get(row.id) as { total: number; done: number }
      const val = stats && stats.total > 0
        ? Math.round((stats.done / stats.total) * 100)
        : 0
      db.prepare('UPDATE projects SET progress = ? WHERE id = ?').run(val, row.id)
      return val
    }

    // project: weighted avg of direct children (tasks + sub-projects)
    const children = db.prepare(`
      SELECT p.progress, p.important, p.urgent, p.status
      FROM projects p
      JOIN project_parents pp ON p.id = pp.project_id
      WHERE pp.parent_id = ? AND p.type IN ('task', 'project')
    `).all(row.id) as Array<{
      progress: number; important: number; urgent: number; status: string
    }>
    if (children.length === 0) return 0
    let totalW = 0
    let sumWP = 0
    for (const c of children) {
      const w = (c.important ? 2 : 1) * (c.urgent ? 1.5 : 1)
      const prog = c.status === 'done' ? 100 : (c.progress || 0)
      totalW += w
      sumWP += prog * w
    }
    const val = totalW > 0 ? Math.round(sumWP / totalW) : 0
    db.prepare('UPDATE projects SET progress = ? WHERE id = ?').run(val, row.id)
    return val
  }

  ipcMain.handle('db:getProject', (_e, id: number) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any
    if (row) row.progress = computeProgress(row)
    return row
  })

  ipcMain.handle('db:getSubProjects', (_e, parentId: number) => {
    const rows = db.prepare(`
      SELECT p.* FROM projects p
      JOIN project_parents pp ON p.id = pp.project_id
      WHERE pp.parent_id = ?
      ORDER BY
        CASE WHEN p.order_index IS NULL THEN 1 ELSE 0 END,
        p.order_index,
        p.open_count DESC,
        p.name
    `).all(parentId) as any[]

    // Get the parent's own color (used as the fast-path for all children)
    const parentRow = db.prepare('SELECT color FROM projects WHERE id = ?').get(parentId) as { color: string | null } | undefined
    const parentColor = parentRow?.color ?? null

    for (const r of rows) {
      r.progress = computeProgress(r)
      // Pre-compute root colors so ProjectColorDot doesn't need its own IPC.
      // Fast path: if parent has a color, children inherit it.
      if (r.type === 'project' || !r.type) {
        if (parentColor) {
          r._rootColors = [parentColor]
        } else if (r.color) {
          r._rootColors = [r.color]
        } else {
          r._rootColors = []  // gray fallback
        }
      }
    }
    return rows
  })

  ipcMain.handle('db:getObjects', (_e, projectId: number) => {
    const rows = db.prepare(`
      SELECT * FROM objects WHERE project_id = ?
      ORDER BY open_count DESC, name
    `).all(projectId) as any[]
    // Batch-resolve has_children for zotero collections in a single Python
    // subprocess (the only path that can bypass Zotero's write lock).
    const COLLECTION_PREFIX = 'zotero://select/library/collections/'
    const zoteroKeys: string[] = []
    for (const row of rows) {
      if (row.type === 'zotero' && row.target?.startsWith(COLLECTION_PREFIX)) {
        zoteroKeys.push(row.target.slice(COLLECTION_PREFIX.length))
      }
    }
    const zoteroMap = resolveZoteroChildrenBatch(zoteroKeys)
    return rows.map(obj => {
      if (obj.type === 'zotero' && obj.target?.startsWith(COLLECTION_PREFIX)) {
        const k = obj.target.slice(COLLECTION_PREFIX.length)
        return { ...obj, has_children: zoteroMap.get(k) ?? false }
      }
      return { ...obj, has_children: objectHasChildren(obj) }
    })
  })

  ipcMain.handle('db:getTodos', (_e, projectId: number) => {
    // Return BOTH pending and done todos — the renderer shows done ones
    // struck-through instead of hiding them. Hiding on click-to-done makes
    // the row "disappear" which looks like a data loss bug.
    return db.prepare(`
      SELECT * FROM todos WHERE project_id = ?
      ORDER BY done ASC,
               CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
               due_date
    `).all(projectId)
  })

  ipcMain.handle('db:createProject', (_e, name: string, description: string, priority: number) => {
    const info = db.prepare(
      'INSERT INTO projects (name, description, priority, type) VALUES (?, ?, ?, ?)'
    ).run(name, description || '', priority || 3, 'project')
    return info.lastInsertRowid
  })

  ipcMain.handle('db:deleteProject', (_e, id: number) => {
    // Cascade: collect all descendants (BFS), then delete everything.
    const collectDescendants = (rootId: number): number[] => {
      const all: number[] = [rootId]
      const queue: number[] = [rootId]
      const seen = new Set<number>([rootId])
      while (queue.length > 0) {
        const cur = queue.shift()!
        const kids = db.prepare(
          'SELECT project_id FROM project_parents WHERE parent_id = ?'
        ).all(cur) as { project_id: number }[]
        for (const k of kids) {
          if (seen.has(k.project_id)) continue
          seen.add(k.project_id)
          all.push(k.project_id)
          queue.push(k.project_id)
        }
      }
      return all
    }

    const allIds = collectDescendants(id)

    const trx = db.transaction(() => {
      for (const pid of allIds) {
        db.prepare('DELETE FROM objects WHERE project_id = ?').run(pid)
        db.prepare('DELETE FROM todos WHERE project_id = ?').run(pid)
        db.prepare('DELETE FROM agents WHERE project_id = ?').run(pid)
        db.prepare('DELETE FROM project_parents WHERE project_id = ? OR parent_id = ?').run(pid, pid)
        db.prepare('DELETE FROM projects WHERE id = ?').run(pid)
      }
    })
    trx()
  })

  // Half-life-decayed open count.
  //
  //   new_score = old_score * 0.5^(days_since_last / HALF_LIFE_DAYS) + 1
  //
  // Properties:
  //   - opening today      → +1
  //   - opening once a day → score asymptotes to ~21 (with 14-day half-life)
  //   - opened once a year → score ≈ 1 + 0.5^26 ≈ 1.00000001 (effectively 1)
  //   - never decays to zero (just gets very small)
  //
  // The raw `open_count` column is also bumped for backwards compatibility,
  // but no longer surfaces in the UI.
  const HALF_LIFE_DAYS = 14
  function bumpScore(objectId: number) {
    const row = db.prepare(
      'SELECT score, last_opened_at FROM objects WHERE id = ?'
    ).get(objectId) as { score: number; last_opened_at: string | null } | undefined
    if (!row) return
    const now = Date.now()
    let decayed = row.score || 0
    if (row.last_opened_at) {
      const last = Date.parse(row.last_opened_at)
      if (Number.isFinite(last)) {
        const days = Math.max(0, (now - last) / 86_400_000)
        decayed = decayed * Math.pow(0.5, days / HALF_LIFE_DAYS)
      }
    }
    const newScore = decayed + 1
    const nowIso = new Date(now).toISOString()
    db.prepare(
      `UPDATE objects
         SET score = ?,
             last_opened_at = ?,
             open_count = open_count + 1
       WHERE id = ?`
    ).run(newScore, nowIso, objectId)
  }

  ipcMain.handle('db:incrementOpenCount', (_e, objectId: number) => {
    bumpScore(objectId)
  })

  ipcMain.handle('db:setTodoDone', (_e, id: number, done: boolean) => {
    db.prepare('UPDATE todos SET done = ? WHERE id = ?').run(done ? 1 : 0, id)
  })

  ipcMain.handle('db:createSubProject', (_e, name: string, parentId: number, priority: number, type?: string) => {
    // type defaults to 'project'. Valid values: 'project' | 'task' | 'step'.
    const safeType = type === 'task' || type === 'step' ? type : 'project'
    const trx = db.transaction(() => {
      // Inheritance / defaults depend on the child type:
      //  - project : no auto-fields; user fills them in later
      //  - task    : inherit important/urgent from parent project,
      //              default due_at to today (user can clear)
      //  - step    : order_index = max(sibling steps' order_index) + 1
      //              so manual and agent-created steps share a stable order
      let important = 0
      let urgent = 0
      let due_at: string | null = null
      let order_index: number | null = null

      if (safeType === 'task') {
        const parent = db.prepare(
          'SELECT important, urgent FROM projects WHERE id = ?'
        ).get(parentId) as { important?: number; urgent?: number } | undefined
        important = parent?.important ? 1 : 0
        urgent = parent?.urgent ? 1 : 0
        // ISO date YYYY-MM-DD of the user's local today
        const d = new Date()
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, '0')
        const day = String(d.getDate()).padStart(2, '0')
        due_at = `${y}-${m}-${day}`
      }
      if (safeType === 'step') {
        const maxRow = db.prepare(`
          SELECT COALESCE(MAX(p.order_index), 0) AS mx
          FROM projects p
          JOIN project_parents pp ON p.id = pp.project_id
          WHERE pp.parent_id = ? AND p.type = 'step'
        `).get(parentId) as { mx: number } | undefined
        order_index = (maxRow?.mx || 0) + 1
      }

      const info = db.prepare(
        `INSERT INTO projects (name, type, priority, important, urgent, due_at, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(name, safeType, priority || 3, important, urgent, due_at, order_index)
      const childId = info.lastInsertRowid
      db.prepare(
        'INSERT INTO project_parents (project_id, parent_id) VALUES (?, ?)'
      ).run(childId, parentId)
      return childId
    })
    return trx()
  })

  ipcMain.handle('db:linkObject', (_e, projectId: number, name: string, target: string, type: string) => {
    // Deduplicate: same (project_id, target, type) = same object, skip
    const existing = db.prepare(
      'SELECT id FROM objects WHERE project_id = ? AND target = ? AND type = ?'
    ).get(projectId, target, type) as { id: number } | undefined
    if (existing) return existing.id
    const info = db.prepare(
      'INSERT INTO objects (project_id, name, target, type) VALUES (?, ?, ?, ?)'
    ).run(projectId, name, target, type)
    return info.lastInsertRowid
  })

  // Project reference/move: add a second parent link (reference) or
  // transfer from one parent to another (move).
  ipcMain.handle('db:addProjectParent', (_e, projectId: number, newParentId: number) => {
    // Prevent linking to self or to an already-linked parent
    if (projectId === newParentId) return
    const existing = db.prepare(
      'SELECT 1 FROM project_parents WHERE project_id = ? AND parent_id = ?'
    ).get(projectId, newParentId)
    if (existing) return
    db.prepare('INSERT INTO project_parents (project_id, parent_id) VALUES (?, ?)').run(projectId, newParentId)
  })

  ipcMain.handle('db:moveProject', (_e, projectId: number, oldParentId: number, newParentId: number) => {
    if (projectId === newParentId) return
    const trx = db.transaction(() => {
      db.prepare('DELETE FROM project_parents WHERE project_id = ? AND parent_id = ?').run(projectId, oldParentId)
      const existing = db.prepare(
        'SELECT 1 FROM project_parents WHERE project_id = ? AND parent_id = ?'
      ).get(projectId, newParentId)
      if (!existing) {
        db.prepare('INSERT INTO project_parents (project_id, parent_id) VALUES (?, ?)').run(projectId, newParentId)
      }
    })
    trx()
  })

  // Get root ancestor colors for a project (for multi-dot color display).
  // Walks up all parent chains to find root-level ancestors with color set.
  ipcMain.handle('db:getRootColors', (_e, projectId: number) => {
    const rows = db.prepare(`
      WITH RECURSIVE ancestors(id, depth) AS (
        SELECT parent_id, 1 FROM project_parents WHERE project_id = ?
        UNION ALL
        SELECT pp.parent_id, a.depth + 1 FROM project_parents pp
        JOIN ancestors a ON pp.project_id = a.id
        WHERE a.depth < 20
      )
      SELECT DISTINCT p.color FROM projects p
      WHERE p.id IN (SELECT id FROM ancestors)
        AND p.color IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM project_parents pp2 WHERE pp2.project_id = p.id)
    `).all(projectId) as { color: string }[]
    return rows.map(r => r.color)
  })

  // How many parent links does this project have? Used by delete
  // confirmation to decide "unlink reference" vs "cascade delete".
  ipcMain.handle('db:getProjectParentCount', (_e, projectId: number) => {
    const row = db.prepare(
      'SELECT COUNT(*) as cnt FROM project_parents WHERE project_id = ?'
    ).get(projectId) as { cnt: number }
    return row.cnt
  })

  // Remove one parent link without deleting the project. For multi-ref.
  ipcMain.handle('db:unlinkFromParent', (_e, projectId: number, parentId: number) => {
    db.prepare(
      'DELETE FROM project_parents WHERE project_id = ? AND parent_id = ?'
    ).run(projectId, parentId)
  })

  ipcMain.handle('db:removeObject', (_e, objectId: number) => {
    db.prepare('DELETE FROM objects WHERE id = ?').run(objectId)
  })

  ipcMain.handle('db:renameProject', (_e, id: number, newName: string) => {
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(newName, id)
  })

  ipcMain.handle('db:setDescription', (_e, id: number, description: string) => {
    db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(description, id)
  })

  // ── Main agent per project ────────────────────────────────────────
  //
  // Each project has an optional "main agent" — a claude session that
  // lives in the project's virtual folder (~/.lineup/projects/<slug>/).
  // The session id, once captured, is stable across app restarts.
  //
  // project:ensureMainAgent(id) syncs the virtual folder from the DB and
  // returns { cwd, sessionId } for the renderer to spawn the pty. If no
  // session id is stored yet, the renderer spawns plain `claude`; the
  // user's zshrc wrapper will save the new session id to
  // ~/.claude_sessions/<md5(cwd)> which we then read back on subsequent
  // loads and store on the project row.

  ipcMain.handle('project:ensureMainAgent', (_e, projectId: number) => {
    const row = db.prepare(
      'SELECT id, name, description, main_agent_session_id FROM projects WHERE id = ?'
    ).get(projectId) as {
      id: number; name: string; description: string | null; main_agent_session_id: string | null
    } | undefined
    if (!row) return null

    const cwd = syncProjectVirtualFolder(row)

    // If we don't yet have a stored session id, try reading the wrapper's
    // cache file (~/.claude_sessions/<md5(cwd)>). If that exists, promote
    // it to projects.main_agent_session_id so future opens resume directly.
    let sessionId = row.main_agent_session_id
    if (!sessionId) {
      const md5 = createHash('md5').update(cwd).digest('hex')
      const cacheFile = join(homedir(), '.claude_sessions', md5)
      if (existsSync(cacheFile)) {
        try {
          const stored = readFileSync(cacheFile, 'utf8').trim()
          if (stored) {
            sessionId = stored
            db.prepare('UPDATE projects SET main_agent_session_id = ? WHERE id = ?')
              .run(sessionId, projectId)
          }
        } catch { /* ignore */ }
      }
    }

    return { cwd, sessionId }
  })

  ipcMain.handle('db:setProgress', (_e, id: number, progress: number, note: string) => {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)))
    db.prepare('UPDATE projects SET progress = ?, progress_note = ? WHERE id = ?')
      .run(clamped, note, id)
  })

  // Generic updater for the P1 metadata fields. Takes a patch object with
  // any subset of fields and writes them in a single UPDATE. Unknown keys
  // are ignored so the renderer can't accidentally write arbitrary columns.
  ipcMain.handle('db:setProjectMeta', (_e, id: number, patch: Record<string, unknown>) => {
    const allowed = new Set([
      'start_at', 'due_at', 'reminder_every_days', 'last_reminded_at',
      'important', 'urgent', 'status', 'order_index',
      'color', 'archived', 'pinned', 'recurring_days',
    ])
    const cols: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k)) continue
      cols.push(`${k} = ?`)
      // Normalize booleans/0-1 for sqlite
      if (k === 'important' || k === 'urgent' || k === 'archived' || k === 'pinned') {
        vals.push(v ? 1 : 0)
      } else {
        vals.push(v as any)
      }
    }
    if (cols.length === 0) return
    vals.push(id)
    db.prepare(`UPDATE projects SET ${cols.join(', ')} WHERE id = ?`).run(...vals)
  })

  // ── P3 views: today / eisenhower / inbox ───────────────────────
  //
  // Shared SELECT fragment: task rows (only task type, active status)
  // joined with their immediate parent project's name + id so the
  // view can show a "in: <project>" breadcrumb. Tasks with no parent
  // are considered "inbox".

  const TASK_VIEW_SELECT = `
    SELECT
      t.*,
      parent.id   AS parent_id,
      parent.name AS parent_name,
      parent.color AS parent_color
    FROM projects t
    LEFT JOIN project_parents pp ON pp.project_id = t.id
    LEFT JOIN projects parent ON parent.id = pp.parent_id
    WHERE t.type = 'task'
  `

  ipcMain.handle('db:getTodayTasks', () => {
    // A task is in "today" if:
    //   - status != done/cancelled, AND
    //   - (due_at <= today OR the reminder window has elapsed)
    //
    // Reminder window: reminder_every_days != NULL AND
    //   (last_reminded_at IS NULL OR date(last_reminded_at)+N days <= today)
    return db.prepare(`
      ${TASK_VIEW_SELECT}
        AND t.status NOT IN ('done', 'cancelled')
        AND (
          (t.due_at IS NOT NULL AND date(t.due_at) <= date('now'))
          OR (
            t.reminder_every_days IS NOT NULL
            AND (
              t.last_reminded_at IS NULL
              OR date(t.last_reminded_at, '+' || t.reminder_every_days || ' days') <= date('now')
            )
          )
        )
      ORDER BY
        CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,
        t.due_at,
        t.important DESC,
        t.urgent DESC
    `).all()
  })

  ipcMain.handle('db:getEisenhowerTasks', () => {
    // All active tasks. The renderer groups them into 4 quadrants.
    // Effective urgency = urgent=1 OR due_at <= today+3 days (auto-urgent).
    return db.prepare(`
      ${TASK_VIEW_SELECT}
        AND t.status NOT IN ('done', 'cancelled')
      ORDER BY
        t.important DESC,
        t.urgent DESC,
        CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,
        t.due_at
    `).all()
  })

  ipcMain.handle('db:getInboxTasks', () => {
    // "Orphan" tasks: task rows with no row in project_parents. These
    // are created via Quick Add (⌘N) and sit here until the user drags
    // them into a real project.
    return db.prepare(`
      SELECT
        t.*,
        NULL as parent_id, NULL as parent_name, NULL as parent_color
      FROM projects t
      WHERE t.type = 'task'
        AND t.status NOT IN ('done', 'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM project_parents pp WHERE pp.project_id = t.id
        )
      ORDER BY t.created_at DESC
    `).all()
  })

  /**
   * Quick-add: create an orphan task that lands in the Inbox view.
   * No project_parents row, no inherited flags — user fills details later
   * or drags the task into a real project.
   */
  ipcMain.handle('db:quickAddTask', (_e, name: string) => {
    const info = db.prepare(
      `INSERT INTO projects (name, type, priority, status) VALUES (?, 'task', 3, 'todo')`
    ).run(name)
    return info.lastInsertRowid
  })

  // Current steps: for each task under this project, get the first
  // incomplete step (the one that's currently "unblocked"). Used by the
  // Inspector's auto-summary section.
  ipcMain.handle('db:getCurrentSteps', (_e, projectId: number) => {
    // CTE: all tasks directly under this project
    return db.prepare(`
      WITH my_tasks AS (
        SELECT t.id, t.name FROM projects t
        JOIN project_parents tp ON t.id = tp.project_id
        WHERE tp.parent_id = ? AND t.type = 'task' AND t.status != 'done'
      )
      SELECT s.id, s.name as step_name, s.status, s.order_index,
             mt.name as task_name, mt.id as task_id
      FROM projects s
      JOIN project_parents sp ON s.id = sp.project_id
      JOIN my_tasks mt ON sp.parent_id = mt.id
      WHERE s.type = 'step' AND s.status != 'done'
        AND s.order_index = (
          SELECT MIN(s2.order_index) FROM projects s2
          JOIN project_parents sp2 ON s2.id = sp2.project_id
          WHERE sp2.parent_id = mt.id AND s2.type = 'step' AND s2.status != 'done'
        )
      ORDER BY mt.name
    `).all(projectId)
  })

  // Deactivate a project and ALL its child projects (cascade).
  // Tasks are not affected — they have their own lifecycle.
  ipcMain.handle('db:deactivateProject', (_e, projectId: number, activate: boolean) => {
    const newStatus = activate ? 'active' : 'inactive'
    const trx = db.transaction(() => {
      // BFS to find all descendant projects
      const queue = [projectId]
      const visited = new Set<number>()
      while (queue.length > 0) {
        const id = queue.shift()!
        if (visited.has(id)) continue
        visited.add(id)
        db.prepare(
          `UPDATE projects SET status = ? WHERE id = ? AND type = 'project'`
        ).run(newStatus, id)
        const children = db.prepare(
          `SELECT p.id FROM projects p
           JOIN project_parents pp ON p.id = pp.project_id
           WHERE pp.parent_id = ? AND p.type = 'project'`
        ).all(id) as { id: number }[]
        for (const c of children) queue.push(c.id)
      }
    })
    trx()
  })

  // Top objects in a project, ranked by the half-life-decayed score.
  // Used by the right inspector panel.
  ipcMain.handle('db:getTopObjects', (_e, projectId: number, limit: number = 10) => {
    return db.prepare(`
      SELECT * FROM objects
      WHERE project_id = ?
      ORDER BY score DESC, last_opened_at DESC, name
      LIMIT ?
    `).all(projectId, limit)
  })

  ipcMain.handle('db:renameObject', (_e, id: number, newName: string) => {
    db.prepare('UPDATE objects SET name = ? WHERE id = ?').run(newName, id)
  })

  ipcMain.handle('db:relinkObject', (_e, id: number, newTarget: string) => {
    db.prepare('UPDATE objects SET target = ? WHERE id = ?').run(newTarget, id)
  })

  ipcMain.handle('db:openObject', async (_e, objectId: number) => {
    // Look up the object name + project name, then delegate to the Python
    // type system via `uv run lu open <name> --project <project>`.
    // This keeps all open logic in one place (lineup/types/).
    const obj = db.prepare(`
      SELECT o.name as obj_name, p.name as project_name
      FROM objects o JOIN projects p ON o.project_id = p.id
      WHERE o.id = ?
    `).get(objectId) as any
    if (!obj) return 'not found'

    // Update the weighted-recency score before launching the external app.
    bumpScore(objectId)

    return new Promise<string>((resolve) => {
      execFile(
        'uv', ['run', '--directory', LINEUP_ROOT, 'lu', 'open', obj.obj_name, '--project', obj.project_name],
        { cwd: LINEUP_ROOT },
        (err, stdout, stderr) => {
          if (err) {
            console.error('open failed:', stderr || err.message)
            resolve(`error: ${stderr || err.message}`)
          } else {
            resolve(stdout.trim())
          }
        }
      )
    })
  })

  ipcMain.handle('db:getRegisteredTypes', () => {
    // Return the object types that the user can create
    return [
      { name: 'file', label: '文件', placeholder: '文件路径 (如 ~/Documents/note.md)' },
      { name: 'folder', label: '文件夹', placeholder: '文件夹路径 (如 ~/Documents/project/)' },
      { name: 'url', label: '链接', placeholder: 'https://...' },
      { name: 'zotero', label: 'zotero文献', placeholder: 'zotero://select/library/items/...' },
      { name: 'obsidian', label: 'Obsidian 笔记', placeholder: 'Obsidian vault 内的文件路径' },
      { name: 'trilium', label: 'Trilium 笔记', placeholder: 'Trilium noteId (如 DPS7i6SnoUwy)' },
      { name: 'script', label: '脚本', placeholder: '脚本路径 (如 ~/scripts/run.sh)' },
    ]
  })

  // ── Browse: native + plugin-based ──────────────────────────────────

  ipcMain.handle('browse:file', async (_e, mode: 'file' | 'folder') => {
    const properties: ('openFile' | 'openDirectory')[] =
      mode === 'folder' ? ['openDirectory'] : ['openFile']
    const result = await dialog.showOpenDialog({
      properties,
      title: mode === 'folder' ? '选择文件夹' : '选择文件',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('browse:obsidian', async (_e, path: string) => {
    return runBrowseCli('obsidian', path)
  })

  ipcMain.handle('browse:trilium', async (_e, parentId: string) => {
    return runBrowseCli('trilium', parentId)
  })

  ipcMain.handle('browse:zotero', async (_e, path: string) => {
    return runBrowseCli('zotero', path)
  })

  ipcMain.handle('browse:fs', async (_e, path: string) => {
    return browseFilesystem(path)
  })

  ipcMain.handle('shell:revealInFinder', async (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('clipboard:writeText', async (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('shell:openInVscode', async (_e, path: string) => {
    // Use the vscode:// URL scheme which doesn't require `code` on PATH
    await shell.openExternal(`vscode://file/${encodeURI(path)}`)
  })

  // Open a (type, target) pair without going through the lineup DB. Used by
  // BrowseColumn double-click for items that aren't yet linked into a project.
  // Mirrors what openObject() does for DB rows, but without the lookup.
  ipcMain.handle('shell:openTarget', async (_e, args: { type: string; target: string }) => {
    const { type, target } = args
    try {
      if (type === 'zotero' || target.startsWith('zotero://')) {
        // zotero://select/library/items/<key> — macOS routes to Zotero
        await shell.openExternal(target)
        return { ok: true }
      }
      if (type === 'trilium') {
        // Use the same TriliumNext server URL the type module emits
        await shell.openExternal(`http://localhost:37840/#root/${target}`)
        return { ok: true }
      }
      if (type === 'url') {
        await shell.openExternal(target)
        return { ok: true }
      }
      // file / folder / script / obsidian → real filesystem path; let macOS
      // pick the default app (Obsidian is registered for .md so obsidian
      // notes open correctly via the file path too).
      const err = await shell.openPath(target)
      if (err) return { ok: false, error: err }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  ipcMain.handle('shell:openTerminalAtCwd', async (_e, cwd: string) => {
    return openTerminalAtCwd(cwd)
  })

  // ── Agents ──────────────────────────────────────────────────────────

  ipcMain.handle('agents:listForProject', (_e, projectId: number) => {
    return db.prepare(
      'SELECT * FROM agents WHERE project_id = ? ORDER BY created_at'
    ).all(projectId)
  })

  ipcMain.handle('agents:listForFolder', (_e, folderPath: string) => {
    // Merge DB-linked agents + discovered claude code sessions for this cwd.
    const dbAgents = db.prepare(
      'SELECT * FROM agents WHERE folder_path = ? ORDER BY created_at'
    ).all(folderPath) as any[]
    const discovered = discoverClaudeSessions(folderPath)
    // Filter out discovered ones whose session_id is already in DB
    const dbSessionIds = new Set(dbAgents.map(a => a.session_id))
    const merged = [
      ...dbAgents.map(a => ({ ...a, is_db: true })),
      ...discovered.filter(d => !dbSessionIds.has(d.session_id)).map(d => ({ ...d, is_db: false })),
    ]
    return merged
  })

  ipcMain.handle('agents:create', (_e, args: {
    name: string
    sessionId: string
    projectId: number | null
    folderPath: string | null
    systemPrompt?: string
  }) => {
    const info = db.prepare(
      'INSERT INTO agents (project_id, folder_path, name, session_id, system_prompt) ' +
      'VALUES (?, ?, ?, ?, ?)'
    ).run(
      args.projectId,
      args.folderPath,
      args.name,
      args.sessionId,
      args.systemPrompt ?? '',
    )
    return info.lastInsertRowid
  })

  ipcMain.handle('agents:delete', (_e, agentId: number) => {
    db.prepare('DELETE FROM agents WHERE id = ?').run(agentId)
  })

  ipcMain.handle('search:obsidian', async (_e, query: string) => {
    return runSearchCli('obsidian', query)
  })

  ipcMain.handle('search:trilium', async (_e, query: string) => {
    return runSearchCli('trilium', query)
  })

  ipcMain.handle('search:zotero', async (_e, query: string) => {
    return runSearchCli('zotero', query)
  })

  // ── Chat with Claude ────────────────────────────────────────────────

  const DEFAULT_CHAT_CWD = join(LINEUP_ROOT, '.chat')

  ipcMain.handle('chat:loadSession', (_e, args: { sessionId: string; cwd: string | null }) => {
    return loadSessionMessages(args.sessionId, args.cwd || DEFAULT_CHAT_CWD)
  })

  ipcMain.handle('preview:load', async (_e, args: { type: string; target: string }) => {
    try {
      // DOCX requires async mammoth — dispatch to async path first
      if ((args.type === 'file' || args.type === 'obsidian') && extname(args.target).toLowerCase() === '.docx') {
        return await previewFilesystemFileAsync(args.target, args.type)
      }
      // Zotero items need Python (immutable=1 URI) to bypass the write lock.
      if (args.type === 'zotero' && args.target.startsWith('zotero://select/library/items/')) {
        return await previewZoteroItemAsync(args.target)
      }
      return loadPreview(args.type, args.target)
    } catch (e: any) {
      return { kind: 'error', content: '', error: `主进程异常: ${e.message || e}` }
    }
  })

  ipcMain.handle('chat:sendMessage', async (_e, args: {
    text: string
    context: string | null
    sessionId: string | null
    cwd: string | null
  }) => {
    const runCwd = args.cwd || DEFAULT_CHAT_CWD
    if (!existsSync(runCwd)) {
      try { mkdirSync(runCwd, { recursive: true }) } catch { /* ignore */ }
    }

    const cmdArgs = ['--print', '--output-format', 'json', '--model', 'sonnet']
    if (args.sessionId) {
      cmdArgs.push('--resume', args.sessionId)
    }
    if (args.context) {
      cmdArgs.push('--append-system-prompt', args.context)
    }
    cmdArgs.push(args.text)

    return new Promise<{ result: string; session_id: string | null; error?: string }>((resolve) => {
      // Ensure ~/.local/bin is in PATH so we find claude when launched
      // from Finder (Electron doesn't load .zshrc).
      const env = {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ''}`,
      }
      execFile('claude', cmdArgs, { cwd: runCwd, maxBuffer: 10 * 1024 * 1024, env },
        (err, stdout, stderr) => {
          if (err) {
            resolve({ result: '', session_id: null, error: stderr || err.message })
            return
          }
          try {
            const payload = JSON.parse(stdout)
            resolve({
              result: payload.result || '',
              session_id: payload.session_id || args.sessionId,
            })
          } catch {
            resolve({ result: stdout, session_id: args.sessionId })
          }
        })
    })
  })
}

// ── App lifecycle ──────────────────────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.lineup')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  registerIpc()
  registerPtyIpc()
  createWindow()

  // Watch ~/.lineup/lineup.db-wal for changes so the UI can refresh when
  // an MCP tool (or any other process) mutates the DB behind our back.
  // WAL file changes on every write; main DB file only changes on
  // checkpoints, so WAL is the signal we want.
  const walPath = join(homedir(), '.lineup', 'lineup.db-wal')
  let lastFireAt = 0
  watchFile(walPath, { interval: 800 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return
    // Debounce: coalesce bursts of writes into a single broadcast
    const now = Date.now()
    if (now - lastFireAt < 400) return
    lastFireAt = now
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('db:externalChange')
    }
  })
  app.on('before-quit', () => {
    try { unwatchFile(walPath) } catch { /* ignore */ }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
