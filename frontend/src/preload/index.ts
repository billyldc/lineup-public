import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'os'
import { join } from 'path'

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
}

const LINEUP_HOME = join(homedir(), '.lineup')

const api = {
  /** The lineup data root (~/.lineup/). Renderer uses this for default agent cwd. */
  LINEUP_HOME,

  listProjects: (opts?: { includeArchived?: boolean }): Promise<Project[]> =>
    ipcRenderer.invoke('db:listProjects', opts ?? {}),
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
  deleteProject: (id: number): Promise<void> =>
    ipcRenderer.invoke('db:deleteProject', id),
  linkObject: (projectId: number, name: string, target: string, type: string): Promise<number> =>
    ipcRenderer.invoke('db:linkObject', projectId, name, target, type),
  addProjectParent: (projectId: number, newParentId: number): Promise<void> =>
    ipcRenderer.invoke('db:addProjectParent', projectId, newParentId),
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
  ensureMainAgent: (projectId: number): Promise<{ cwd: string; sessionId: string | null } | null> =>
    ipcRenderer.invoke('project:ensureMainAgent', projectId),
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
  browseFs: (path: string): Promise<BrowseItem[]> =>
    ipcRenderer.invoke('browse:fs', path),
  revealInFinder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:revealInFinder', path),
  copyToClipboard: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:writeText', text),
  openInVscode: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:openInVscode', path),
  openTarget: (type: string, target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openTarget', { type, target }),
  openTerminalAtCwd: (cwd: string): Promise<{ ok: boolean; reused: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openTerminalAtCwd', cwd),

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

  // Agents
  listAgentsForProject: (projectId: number): Promise<Agent[]> =>
    ipcRenderer.invoke('agents:listForProject', projectId),
  listAgentsForFolder: (folderPath: string): Promise<Agent[]> =>
    ipcRenderer.invoke('agents:listForFolder', folderPath),
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
