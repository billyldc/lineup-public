/**
 * Drag-and-drop payload for moving/copying objects across projects.
 *
 * Copy (default): create a new link row in the destination project that
 * points at the same underlying target.
 * Move (Ctrl held on drop): copy + remove the original link row.
 *
 * Drop targets are restricted to project representations only — you can't
 * drop an object onto another object.
 */

// Custom MIME type so we can positively identify lineup-object drags and
// don't clash with anything else. Browsers expose the type name (but not
// the content) during dragover, which is enough for filtering.
const MIME = 'application/x-lineup-object'

/**
 * Payload for dragging a PROJECT (or task) to create a reference or move it.
 * Default drop = reference (add a second parent link).
 * Ctrl+drop = move (remove old parent, add new parent).
 */
export interface ProjectDragPayload {
  kind: 'project-ref'
  projectId: number
  sourceParentId: number  // the column/project this was dragged FROM
  name: string
}

export function setProjectDragData(e: React.DragEvent, payload: ProjectDragPayload): void {
  e.dataTransfer.setData(MIME, JSON.stringify(payload))
  e.dataTransfer.setData('text/plain', payload.name)
  e.dataTransfer.effectAllowed = 'copyMove'
}

export interface ObjectDragPayload {
  kind: 'object-link'
  // id + sourceProjectId are present when dragging a row that already exists
  // in the lineup DB (Column object rows). They are ABSENT when dragging a
  // BrowseColumn item — those items aren't in the DB until the drop actually
  // creates them. In that case "move" silently degrades to "copy" (there's
  // nothing to remove).
  id?: number
  sourceProjectId?: number
  name: string
  target: string
  type: string
}

export function setObjectDragData(e: React.DragEvent, payload: ObjectDragPayload): void {
  const json = JSON.stringify(payload)
  e.dataTransfer.setData(MIME, json)
  // Also set text/plain as a fallback so the drag is visible to other
  // surfaces (and so dataTransfer is non-empty in some odd browser modes).
  e.dataTransfer.setData('text/plain', payload.name)
  e.dataTransfer.effectAllowed = 'copyMove'
}

export type AnyDragPayload = ObjectDragPayload | ProjectDragPayload

export function parseDragPayload(e: React.DragEvent): AnyDragPayload | null {
  try {
    const raw = e.dataTransfer.getData(MIME)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (data?.kind === 'object-link' || data?.kind === 'project-ref') return data
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Show copy/move cursor as the user drags over a valid target.
 *
 * IMPORTANT: we ALWAYS call preventDefault here. The HTML5 drag spec
 * requires a dragover handler to preventDefault for the subsequent drop
 * event to fire at all, and dataTransfer.types is unreliable during
 * dragover (Chromium hides custom-type contents until drop). Filtering
 * happens in the drop handler instead.
 */
/**
 * Whether the "move" modifier is held.
 *
 * macOS reality check:
 *   - Ctrl+drag is UNUSABLE on macOS. The OS intercepts Ctrl+mousedown as
 *     right-click before the browser sees it, so HTML5 drag never starts.
 *   - Cmd (meta) and Alt (option) are safe — both pass through cleanly.
 *
 * Modifier state inside DragEvents is also flaky on macOS Chromium — the
 * user can press/release Cmd mid-drag and the dragover/drop events may
 * still carry stale state. So we ALSO maintain a global keydown/keyup
 * tracker; the final `isMoveModifier` trusts whichever source says "yes".
 *
 * Net effect: Cmd+drag or Alt+drag = move, any other = copy. Works
 * reliably on macOS; works on Windows/Linux too (there Alt is probably
 * what users reach for).
 */
const modState = { meta: false, alt: false }
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Meta' || e.key === 'OS' /* Win key on some platforms */) modState.meta = true
    else if (e.key === 'Alt') modState.alt = true
  })
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Meta' || e.key === 'OS') modState.meta = false
    else if (e.key === 'Alt') modState.alt = false
  })
  // Reset when window loses focus (e.g. user released key over a different app).
  window.addEventListener('blur', () => { modState.meta = false; modState.alt = false })
}

export function isMoveModifier(e: React.DragEvent | DragEvent): boolean {
  return e.metaKey || e.altKey || modState.meta || modState.alt
}

export function handleObjectDragOver(e: React.DragEvent): void {
  // Don't interfere with native file drops from Finder (those carry 'Files').
  // For all internal drags, always preventDefault so drop fires — we filter
  // by MIME at drop time. Some browsers hide custom MIME during dragover
  // for security, so a strict type check here silently kills the drop.
  if (e.dataTransfer.types.includes('Files')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = isMoveModifier(e) ? 'move' : 'copy'
}

/**
 * Perform the copy/move operation when the user drops on a project.
 * Caller passes a refresh callback that knows how to reload the affected UI.
 */
/**
 * Handle a drop on a project target. Dispatches by payload kind:
 *
 * - object-link: link the object into the destination project (Ctrl = move)
 * - project-ref: create a reference (add parent link); Ctrl = move (re-parent)
 */
export async function performDrop(
  e: React.DragEvent,
  destProjectId: number,
  refresh: () => void,
): Promise<boolean> {
  const payload = parseDragPayload(e)
  if (!payload) return false

  const isMove = isMoveModifier(e)

  if (payload.kind === 'project-ref') {
    if (payload.projectId === destProjectId) return false
    if (isMove && payload.sourceParentId && payload.sourceParentId > 0) {
      await window.lineup.moveProject(payload.projectId, payload.sourceParentId, destProjectId)
    } else {
      await window.lineup.addProjectParent(payload.projectId, destProjectId)
    }
    refresh()
    return true
  }

  // object-link
  if (payload.sourceProjectId != null && payload.sourceProjectId === destProjectId) {
    return false
  }
  await window.lineup.linkObject(destProjectId, payload.name, payload.target, payload.type)
  if (isMove && payload.id != null) {
    await window.lineup.removeObject(payload.id)
  }
  refresh()
  return true
}
