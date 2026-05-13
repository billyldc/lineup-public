import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface ProcSample {
  pid: number
  type: string
  name?: string
  workingSetMb: number
  privateMb?: number
  cpuPct?: number
}
export interface PtySample {
  pid: number
  cmd?: string
  rssMb: number
}
export interface MemorySample {
  ts: string
  uptime_s: number
  totalMb: number
  main: ProcSample | null
  renderers: ProcSample[]
  utility: ProcSample[]
  others: ProcSample[]
  ptys: PtySample[]
  ptyCount: number
}

export interface Project {
  id: number
  name: string
  /**
   * Three-level hierarchy:
   * - 'project': long-term workspace, user-created, has main agent
   * - 'task': concrete unit under a project, parallel with siblings, has its own agent
   * - 'step': sequential checklist item under a task, AGENT-created only
   */
  type: 'project' | 'task' | 'step' | string
  description: string
  priority: number
  progress: number
  progress_note: string
  open_count: number
  todoist_project_id: string | null

  // P1 additions (2026-04-16) — may be null on old rows
  start_at: string | null
  due_at: string | null
  reminder_every_days: number | null
  last_reminded_at: string | null
  important: 0 | 1
  /** User-pinned urgent flag. Effective urgency also ORs in (due_at <= now+3d). */
  urgent: 0 | 1
  status: 'todo' | 'active' | 'done' | 'cancelled' | string
  /** Position among siblings; only meaningful for step rows. */
  order_index: number | null
  main_agent_session_id: string | null
  /** One of ~8 preset color names, or null for priority-based fallback. */
  color: string | null
  /** When 1, project is hidden from the default sidebar. */
  archived: 0 | 1
  /** When 1, project appears in sidebar root even if it has parents. */
  pinned: 0 | 1
  /** Recurring task: auto-reset after N days when completed. null = not recurring. */
  recurring_days: number | null
  /** Reserved "收件箱" project — cannot be deleted. */
  is_inbox: 0 | 1
  /** YYYY-MM-DD when status flipped to 'done'. Null while pending. Auto
   *  written/cleared by setProjectMeta when status changes to/from done. */
  completed_at: string | null
}

export interface ObjectRow {
  id: number
  project_id: number
  name: string
  target: string
  type: string
  default_app: string | null
  open_count: number
  has_children: boolean
}

export interface Todo {
  id: number
  project_id: number
  text: string
  due_date: string | null
  done: number
}

export interface RegisteredType {
  name: string
  label: string
  placeholder: string
}

/** A task row as returned by the P3 view queries — includes its
 *  immediate parent project so the UI can show a breadcrumb. */
export interface TaskViewRow extends Project {
  parent_id: number | null
  parent_name: string | null
  parent_color: string | null
  // When the row is a type='step' serving as the *frontier* of a parent
  // task, these point at that task so the UI can render a
  // "task ▸ step" breadcrumb. Null for regular (type='task') rows.
  task_id: number | null
  task_name: string | null
}

export interface BrowseItem {
  id: string
  name: string
  target: string
  type: string
  default_app: string | null
  preview: string
}

export interface Agent {
  // Shared fields
  name: string
  session_id: string
  is_db: boolean
  // DB-only
  id?: number
  project_id?: number | null
  folder_path?: string | null
  system_prompt?: string
  created_at?: string
  last_active_at?: string | null
  // Discovered-only
  last_modified?: string
  message_count?: number
  // Which agent toolchain this session belongs to. 'claude' covers Claude
  // Code's local store at ~/.claude/projects (which also catches anything
  // openclaw runs — same store). 'codex' = ~/.codex/sessions, 'hermes' =
  // ~/.hermes/sessions. Lineup can resume claude in the embedded terminal,
  // but the others are read-only; AgentsView gates open-in-lineup on this.
  source?: 'claude' | 'codex' | 'hermes'
  // For source='claude', whether the workspace is openclaw (i.e. the
  // session was recorded by openclaw's Claude Code wrapper). Cosmetic only;
  // lineup-public treats it as a normal Claude session for resume purposes.
  flavor?: 'claude' | 'codex' | 'hermes' | 'openclaw'
  // Internal: external sources stash their jsonl path here so the dispatcher
  // doesn't have to re-walk the filesystem on read.
  external_path?: string
}

export interface TimelineEvent {
  kind: 'user' | 'assistant-text' | 'thinking' | 'tool-use' | 'tool-result' | 'system'
  ts: string
  uuid: string
  parent_uuid?: string
  text?: string
  tool?: {
    name: string
    id: string
    file_path?: string
    command?: string
    description?: string
    added?: number
    removed?: number
    summary: string
  }
  tool_use_id?: string
  is_error?: boolean
}

export interface SessionStats {
  first_ts: string
  last_ts: string
  duration_ms: number
  user_turns: number
  assistant_turns: number
  tool_counts: Record<string, number>
  file_changes: Array<{ path: string; edits: number; added: number; removed: number }>
  bash_commands: string[]
  tokens: {
    input: number
    output: number
    cache_read: number
    cache_creation: number
  }
  models: string[]
  message_count: number
  git_branches: string[]
}

export interface SessionData {
  session_id: string
  folder_path: string | null
  events: TimelineEvent[]
  stats: SessionStats
}

export interface InboxItemRow {
  id: number
  source_id: number
  title: string
  url: string | null
  author: string | null
  summary: string | null
  ai_summary: string | null
  published_at: string | null
  arrived_at: string
  status: 'pending' | 'reviewed' | 'acted' | 'dismissed' | string
  source_kind: string
  source_name: string
}

export interface InboxItemFull extends InboxItemRow {
  content_text: string | null
  content_html: string | null
  raw_json: string | null
  external_id: string
}

export interface FolderTreeNode {
  level: 1 | 2 | 3
  key: string
  parent_key?: string
  title: string
  summary_md: string
  first_ts: string
  last_ts: string
  session_count: number
  cost_usd: number
  model: string
  children?: FolderTreeNode[]
}

export interface FolderTree {
  folder_path: string
  root: FolderTreeNode | null
  clusters: FolderTreeNode[]
  total_sessions_considered: number
  total_sessions_skipped: number
  total_cost_spent: number
}

import { homedir } from 'os'
import { join } from 'path'

const api = {
  /** Resolved lineup root (~/.lineup). Used by the renderer to seed the
   *  default chat tab's cwd. Computed here because the renderer has no
   *  access to `os.homedir()`. */
  LINEUP_HOME: process.env.LINEUP_DATA_DIR || join(homedir(), '.lineup'),

  listProjects: (opts?: { includeArchived?: boolean }): Promise<Project[]> =>
    ipcRenderer.invoke('db:listProjects', opts ?? {}),
  /** All active projects (any type) with their resolved folder — for
   * proposal-display breadcrumbs like "调用 <name> (<folder>) 的 agent". */
  projectMetaForLookup: (): Promise<Array<{
    id: number; name: string; type: string; folder: string | null
  }>> => ipcRenderer.invoke('projects:metaForLookup'),

  /** Reverse-map a cwd to the project whose virtual dir is that path
   *  (only matches ~/.lineup/projects/.../<name>). Renderer uses it
   *  to detect when a folder-agent click is actually a project main
   *  agent in disguise. */
  findProjectByVirtualPath: (cwd: string): Promise<{ id: number; name: string } | null> =>
    ipcRenderer.invoke('projects:findByVirtualPath', cwd),

  /** Global search across projects + objects. Hot path of the search
   *  modal — every keystroke fires this (after a small debounce). */
  search: (q: string): Promise<{
    projects: Array<{
      id: number; name: string; description: string | null
      type: string; archived: number | null
    }>
    objects: Array<{
      id: number; name: string; target: string; type: string
      project_id: number; project_name: string
    }>
  }> => ipcRenderer.invoke('search:query', q),
  getProject: (id: number): Promise<Project | undefined> =>
    ipcRenderer.invoke('db:getProject', id),
  getSubProjects: (parentId: number): Promise<Project[]> =>
    ipcRenderer.invoke('db:getSubProjects', parentId),
  getObjects: (projectId: number): Promise<ObjectRow[]> =>
    ipcRenderer.invoke('db:getObjects', projectId),
  getTodos: (projectId: number): Promise<Todo[]> =>
    ipcRenderer.invoke('db:getTodos', projectId),
  setTodoDone: (id: number, done: boolean): Promise<void> =>
    ipcRenderer.invoke('db:setTodoDone', id, done),
  createProject: (name: string, description: string, priority: number): Promise<number> =>
    ipcRenderer.invoke('db:createProject', name, description, priority),
  createSubProject: (name: string, parentId: number, priority: number, type?: 'project' | 'task' | 'step'): Promise<number> =>
    ipcRenderer.invoke('db:createSubProject', name, parentId, priority, type),
  insertStepRelative: (neighborId: number, position: 'before' | 'after', name: string): Promise<number> =>
    ipcRenderer.invoke('db:insertStepRelative', { neighborId, position, name }),
  countActiveStepsForTask: (taskId: number): Promise<{
    remaining: number
    parentRecurring: boolean
  }> => ipcRenderer.invoke('db:countActiveStepsForTask', taskId),
  /** Bounds for a step's due_at: min (latest earlier sibling's due) and
   *  the parent task's current due (used as soft ceiling — exceeding it
   *  auto-bumps the parent). */
  getStepDueBounds: (stepId: number): Promise<{
    min: string | null; parent_due: string | null
  }> => ipcRenderer.invoke('db:getStepDueBounds', stepId),
  deleteProject: (id: number): Promise<void> =>
    ipcRenderer.invoke('db:deleteProject', id),
  linkObject: (projectId: number, name: string, target: string, type: string): Promise<number> =>
    ipcRenderer.invoke('db:linkObject', projectId, name, target, type),
  addProjectParent: (projectId: number, newParentId: number): Promise<void> =>
    ipcRenderer.invoke('db:addProjectParent', projectId, newParentId),

  /** Pick-a-destination backend for the 📎 引用到… right-click action.
   *  Filters out the source, its descendants, and type-incompatible
   *  parents per containment rules (step→task; object→project|task;
   *  project/task→project). */
  listCopyDestinations: (args: {
    sourceKind: 'project' | 'object'; sourceId: number
  }): Promise<Array<{
    id: number; name: string; type: string; breadcrumb: string
  }>> => ipcRenderer.invoke('db:listCopyDestinations', args),

  /** Materializes the picker's chosen reference. project → adds a
   *  parent edge; object → INSERTs a sibling row in `objects` under
   *  the dest project. */
  createReference: (args: {
    sourceKind: 'project' | 'object'; sourceId: number; destId: number
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('db:createReference', args),
  moveProject: (projectId: number, oldParentId: number, newParentId: number): Promise<void> =>
    ipcRenderer.invoke('db:moveProject', projectId, oldParentId, newParentId),
  getRootColors: (projectId: number): Promise<string[]> =>
    ipcRenderer.invoke('db:getRootColors', projectId),
  getProjectParentCount: (projectId: number): Promise<number> =>
    ipcRenderer.invoke('db:getProjectParentCount', projectId),
  unlinkFromParent: (projectId: number, parentId: number): Promise<void> =>
    ipcRenderer.invoke('db:unlinkFromParent', projectId, parentId),
  removeObject: (objectId: number): Promise<void> =>
    ipcRenderer.invoke('db:removeObject', objectId),
  renameProject: (id: number, newName: string): Promise<void> =>
    ipcRenderer.invoke('db:renameProject', id, newName),
  setDescription: (id: number, description: string): Promise<void> =>
    ipcRenderer.invoke('db:setDescription', id, description),
  setProgress: (id: number, progress: number, note: string): Promise<void> =>
    ipcRenderer.invoke('db:setProgress', id, progress, note),
  setProjectMeta: (id: number, patch: {
    start_at?: string | null
    due_at?: string | null
    reminder_every_days?: number | null
    last_reminded_at?: string | null
    important?: 0 | 1 | boolean
    urgent?: 0 | 1 | boolean
    status?: 'todo' | 'active' | 'done' | 'cancelled'
    order_index?: number | null
    color?: string | null
    archived?: 0 | 1 | boolean
    pinned?: 0 | 1 | boolean
    recurring_days?: number | null
  }): Promise<void> =>
    ipcRenderer.invoke('db:setProjectMeta', id, patch),
  getTopObjects: (projectId: number, limit?: number): Promise<ObjectRow[]> =>
    ipcRenderer.invoke('db:getTopObjects', projectId, limit ?? 10),
  getCurrentSteps: (projectId: number): Promise<Array<{
    id: number; step_name: string; status: string; order_index: number
    task_name: string; task_id: number
  }>> =>
    ipcRenderer.invoke('db:getCurrentSteps', projectId),
  deactivateProject: (projectId: number, activate: boolean): Promise<void> =>
    ipcRenderer.invoke('db:deactivateProject', projectId, activate),

  // ── P3 task views ────────────────────────────────────────────────
  getTodayTasks: (): Promise<TaskViewRow[]> =>
    ipcRenderer.invoke('db:getTodayTasks'),
  getEisenhowerTasks: (): Promise<TaskViewRow[]> =>
    ipcRenderer.invoke('db:getEisenhowerTasks'),
  getInboxTasks: (): Promise<TaskViewRow[]> =>
    ipcRenderer.invoke('db:getInboxTasks'),
  quickAddTask: (name: string): Promise<number> =>
    ipcRenderer.invoke('db:quickAddTask', name),
  getInboxProjectId: (): Promise<number | null> =>
    ipcRenderer.invoke('db:getInboxProjectId'),
  ensureMainAgent: (projectId: number): Promise<{ cwd: string; sessionId: string | null } | null> =>
    ipcRenderer.invoke('project:ensureMainAgent', projectId),
  /** Load a project's CLAUDE.md.manual overlay + the full stacked CLAUDE.md
   *  that the agent actually reads. Both come from
   *  ~/.lineup/projects/<slug>/. */
  projectReadManual: (projectId: number): Promise<{
    ok: boolean
    manual?: string
    stacked?: string
    manualPath?: string
    stackedPath?: string
    error?: string
  }> => ipcRenderer.invoke('project:readManual', projectId),
  /** Save the manual overlay and re-stack CLAUDE.md so the running agent
   *  picks it up on its next turn. */
  projectWriteManual: (projectId: number, content: string): Promise<{
    ok: boolean; error?: string
  }> => ipcRenderer.invoke('project:writeManual', { projectId, content }),
  /** Walk project_parents from pid → root and return ancestors in
   *  root→pid order. Used to drill the Miller column path to a project. */
  projectListAncestors: (projectId: number): Promise<{
    ok: boolean
    ancestors?: Array<{ id: number; name: string }>
    error?: string
  }> => ipcRenderer.invoke('project:listAncestors', projectId),
  renameObject: (id: number, newName: string): Promise<void> =>
    ipcRenderer.invoke('db:renameObject', id, newName),
  relinkObject: (id: number, newTarget: string): Promise<void> =>
    ipcRenderer.invoke('db:relinkObject', id, newTarget),
  incrementOpenCount: (objectId: number): Promise<void> =>
    ipcRenderer.invoke('db:incrementOpenCount', objectId),
  openObject: (objectId: number): Promise<string> =>
    ipcRenderer.invoke('db:openObject', objectId),
  getRegisteredTypes: (): Promise<RegisteredType[]> =>
    ipcRenderer.invoke('db:getRegisteredTypes'),
  sendChatMessage: (args: {
    text: string
    context: string | null
    sessionId: string | null
    cwd: string | null
  }): Promise<{ result: string; session_id: string | null; error?: string }> =>
    ipcRenderer.invoke('chat:sendMessage', args),
  loadChatSession: (args: { sessionId: string; cwd: string | null }): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> =>
    ipcRenderer.invoke('chat:loadSession', args),
  loadPreview: (args: { type: string; target: string }): Promise<{
    kind: 'text' | 'markdown' | 'html' | 'empty' | 'error' | 'binary' | 'image' | 'pdf'
    content: string
    mime?: string
    error?: string
  }> => ipcRenderer.invoke('preview:load', args),
  browseFile: (mode: 'file' | 'folder'): Promise<string | null> =>
    ipcRenderer.invoke('browse:file', mode),
  browseObsidian: (path: string): Promise<BrowseItem[]> =>
    ipcRenderer.invoke('browse:obsidian', path),
  browseTrilium: (parentId: string): Promise<BrowseItem[]> =>
    ipcRenderer.invoke('browse:trilium', parentId),
  browseZotero: (path: string): Promise<BrowseItem[]> =>
    ipcRenderer.invoke('browse:zotero', path),
  browseMail: (path: string): Promise<BrowseItem[]> =>
    ipcRenderer.invoke('browse:mail', path),
  syncMail: (): Promise<{ ok: boolean; error?: string; total?: number; accounts?: Record<string, number> }> =>
    ipcRenderer.invoke('mail:sync'),
  browseFs: (path: string): Promise<BrowseItem[]> =>
    ipcRenderer.invoke('browse:fs', path),
  revealInFinder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:revealInFinder', path),
  copyToClipboard: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:writeText', text),
  readClipboardForTerminal: (): Promise<{ files: string[]; text: string }> =>
    ipcRenderer.invoke('clipboard:readForTerminal'),
  openInVscode: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:openInVscode', path),
  openTarget: (type: string, target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openTarget', { type, target }),
  openTerminalAtCwd: (cwd: string): Promise<{ ok: boolean; reused: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openTerminalAtCwd', cwd),
  /** Electron 32+: resolve a File/DataTransfer File object to its real
   *  filesystem path (replaces the deprecated `file.path` property). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ── Embedded PTY (xterm.js + node-pty) ──────────────────────────────
  createPty: (opts: { cwd: string; cols: number; rows: number; command?: string }):
    Promise<{ id: string; error?: string }> =>
    ipcRenderer.invoke('pty:create', opts),
  writePty: (id: string, data: string): Promise<void> =>
    ipcRenderer.invoke('pty:write', { id, data }),
  resizePty: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('pty:resize', { id, cols, rows }),
  killPty: (id: string): Promise<void> =>
    ipcRenderer.invoke('pty:kill', id),
  onPtyData: (cb: (id: string, data: string) => void): (() => void) => {
    const listener = (_e: unknown, payload: { id: string; data: string }) =>
      cb(payload.id, payload.data)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onPtyExit: (cb: (id: string, exitCode: number) => void): (() => void) => {
    const listener = (_e: unknown, payload: { id: string; exitCode: number }) =>
      cb(payload.id, payload.exitCode)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  },

  /**
   * Fires when the lineup.db WAL file changes — i.e. something wrote to
   * the database behind the renderer's back (typically the MCP server
   * acting on behalf of an agent). Subscribers should refresh any view
   * that reflects DB state.
   */
  onDbExternalChange: (cb: () => void): (() => void) => {
    const listener = () => cb()
    ipcRenderer.on('db:externalChange', listener)
    return () => ipcRenderer.removeListener('db:externalChange', listener)
  },
  searchObsidian: (query: string): Promise<BrowseItem[]> =>
    ipcRenderer.invoke('search:obsidian', query),
  searchTrilium: (query: string): Promise<BrowseItem[]> =>
    ipcRenderer.invoke('search:trilium', query),
  searchZotero: (query: string): Promise<BrowseItem[]> =>
    ipcRenderer.invoke('search:zotero', query),
  searchMail: (query: string): Promise<BrowseItem[]> =>
    ipcRenderer.invoke('search:mail', query),

  // Agents
  listAgentsForProject: (projectId: number): Promise<Agent[]> =>
    ipcRenderer.invoke('agents:listForProject', projectId),
  listAgentsForFolder: (folderPath: string): Promise<Agent[]> =>
    ipcRenderer.invoke('agents:listForFolder', folderPath),
  listAgentsForZotero: (zoteroKey: string): Promise<Agent[]> =>
    ipcRenderer.invoke('agents:listForZotero', zoteroKey),
  createAgentForZotero: (args: {
    zoteroKey: string; name: string; sessionId?: string; systemPrompt?: string
  }): Promise<{ ok: boolean; agentId?: number; folder?: string; error?: string }> =>
    ipcRenderer.invoke('agents:createForZotero', args),
  listAllAgents: (): Promise<Agent[]> =>
    ipcRenderer.invoke('agents:listAll'),
  readSession: (folderPath: string, sessionId: string): Promise<
    { ok: true; data: SessionData } | { ok: false; error: string }
  > => ipcRenderer.invoke('agents:readSession', { folderPath, sessionId }),

  summarizeSession: (folderPath: string, sessionId: string, force = false): Promise<
    | { ok: true; summary: string; cached: boolean; input_tokens: number; output_tokens: number; cost_usd: number; model: string }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('agents:summarizeSession', { folderPath, sessionId, force }),

  getCachedSummary: (sessionId: string): Promise<{
    summary_md: string
    input_tokens: number
    output_tokens: number
    cost_usd: number
    model: string
    jsonl_mtime_ms: number
  } | null> => ipcRenderer.invoke('agents:getCachedSummary', { sessionId }),

  buildFolderTree: (folderPath: string): Promise<
    | { ok: true; tree: FolderTree }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('agents:buildFolderTree', { folderPath }),

  getCachedFolderTree: (folderPath: string): Promise<FolderTree | null> =>
    ipcRenderer.invoke('agents:getCachedFolderTree', { folderPath }),

  summarizeBuckets: (
    sessionId: string, folderPath: string,
    buckets: Array<{ date: string; slot_index: number; event_indices: number[] }>,
  ): Promise<Array<{ date: string; slot_index: number; summary: string | null; error?: string }>> =>
    ipcRenderer.invoke('agents:summarizeBuckets', { sessionId, folderPath, buckets }),

  renameSession: (sessionId: string, title: string): Promise<{ ok: boolean; cleared?: boolean }> =>
    ipcRenderer.invoke('agents:renameSession', { sessionId, title }),

  generateSessionTitle: (sessionId: string, folderPath: string): Promise<
    { ok: true; title: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('agents:generateSessionTitle', { sessionId, folderPath }),

  autoTitleSessions: (sessions: Array<{
    sessionId: string; folderPath: string; lastTs: string
  }>): Promise<Array<{ sessionId: string; title?: string; skipped?: string; error?: string }>> =>
    ipcRenderer.invoke('agents:autoTitleSessions', sessions),

  // ── Inbox item bodies (used by InboxBodyPreview for cached HTML) ──
  inboxGetItem: (itemId: number): Promise<InboxItemFull | null> =>
    ipcRenderer.invoke('inbox:getItem', itemId),

  /** Lazy fetch the article body for an inbox item whose feed shipped
   *  no description/content. Stores cleaned HTML back into
   *  inbox_items.content_html so future loads are instant. */
  inboxFetchArticleBody: (itemId: number): Promise<{
    ok: boolean; content_html?: string; error?: string
  }> => ipcRenderer.invoke('inbox:fetchArticleBody', itemId),

  /** Structured mail preview (cache-first). For inline MailPreview component. */
  mailFullPreview: (args: {
    target: string; inboxItemId?: number
  }): Promise<{
    ok: boolean
    subject?: string; from?: string; to?: string; cc?: string; date?: string
    html?: string; text?: string
    attachments?: Array<{
      index: number; name: string; size: number; content_type: string
      is_inline_image?: boolean; available?: boolean
    }>
    error?: string
  }> => ipcRenderer.invoke('mail:fullPreview', args),

  /** Save attachment #index from email TARGET to ~/Downloads. */
  mailSaveAttachment: (args: {
    target: string; index: number; inboxItemId?: number
  }): Promise<{ ok: boolean; path?: string; name?: string; size?: number; error?: string }> =>
    ipcRenderer.invoke('mail:saveAttachment', args),

  /** Settings page actions — bulk-clear caches + filesystem stats. */
  settingsClearMailPreviewCache: (): Promise<{ ok: boolean; removed?: number; error?: string }> =>
    ipcRenderer.invoke('settings:clearMailPreviewCache'),
  settingsStats: (): Promise<{
    dbSize?: number; dbPath?: string
    memLogSize?: number; memLogPath?: string
    mailPreviewCount?: number
    lineupHome?: string; error?: string
  }> => ipcRenderer.invoke('settings:stats'),

  /** Memory monitor (diagnoses RSS spikes; samples written by main every 30s). */
  memoryCurrent: (): Promise<{
    ok: boolean
    sample?: MemorySample
    logPath?: string
    error?: string
  }> => ipcRenderer.invoke('memory:current'),
  memoryRecent: (limit?: number): Promise<{
    ok: boolean
    samples?: MemorySample[]
    logPath?: string
    error?: string
  }> => ipcRenderer.invoke('memory:recent', limit),

  openExternalTerminalWithCommand: (cwd: string, command: string): Promise<
    { ok: boolean; error?: string }
  > => ipcRenderer.invoke('shell:openExternalTerminalWithCommand', { cwd, command }),

  /** Dev-mode self-restart — opens a new Terminal running `npm run dev`
   *  and quits the current electron. No-op in packaged builds. */
  devRestart: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dev:restart'),

  /** Find the cwd that lets `claude --resume <sessionId>` actually work.
   *  AgentsView's folder_path is the per-line `cwd` recorded in the
   *  jsonl, which can drift from the encoded-dir where the file
   *  physically lives. Use this before opening the external terminal so
   *  the resume command isn't pre-filled with a cwd that fails. */
  resolveResumeCwd: (sessionId: string): Promise<{
    ok: boolean; cwd?: string; jsonl?: string; error?: string
  }> => ipcRenderer.invoke('agents:resolveResumeCwd', sessionId),

  estimateBulkCost: (): Promise<{
    total_sessions: number
    sessions_cached: number
    sessions_needing: number
    est_input_tokens: number
    est_output_tokens: number
    est_cost_usd: number
    model: string
    input_per_mtok: number
    output_per_mtok: number
    per_session: Array<{ session_id: string; folder_path: string; skeleton_chars: number; cached: boolean }>
  }> => ipcRenderer.invoke('agents:estimateBulkCost'),
  createAgent: (args: {
    name: string
    sessionId: string
    projectId: number | null
    folderPath: string | null
    systemPrompt?: string
  }): Promise<number> => ipcRenderer.invoke('agents:create', args),
  deleteAgent: (id: number): Promise<void> =>
    ipcRenderer.invoke('agents:delete', id),
}

contextBridge.exposeInMainWorld('lineup', api)

export type LineupAPI = typeof api
