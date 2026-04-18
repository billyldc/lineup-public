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
    // Local Trilium data dir (document.db is the database)
    const trilliumPath = require('os').homedir() + '/Library/Application Support/trilium-data/document.db'
    // Note: we can't easily check existence from renderer; caller should handle failures
    return trilliumPath
  }
  return null
}
