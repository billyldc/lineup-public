import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { ObjectRow } from '../../preload/index'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * The filesystem path for an object, if it has one. Used by "Reveal in Finder"
 * and "Copy path" right-click actions.
 *
 * - file / folder / script / obsidian: the target IS a filesystem path
 * - trilium: the Trilium data dir on this machine (if any).
 *   Returns null if trilium data dir doesn't exist locally (e.g. remote server).
 * - url / zotero: no meaningful filesystem path → null
 */
export function filesystemPathForObject(obj: ObjectRow): string | null {
  if (obj.type === 'file' || obj.type === 'folder' || obj.type === 'script' || obj.type === 'obsidian') {
    return obj.target
  }
  if (obj.type === 'trilium') {
    // Trilium data dir lives at ~/Library/Application Support/trilium-data/
    // when Trilium Desktop is installed. The renderer can't compute homedir
    // itself; the main process resolves this at open-time, so return null
    // here and let the open-target IPC handle path resolution.
    return null
  }
  return null
}
