/**
 * User-configurable global hotkeys for lineup.
 *
 * Why renderer-only: we need to intercept keys at the DOM level. Global
 * shortcuts (electron-globalShortcut) would steal the key even when
 * lineup isn't focused — bad UX. Settings persist via localStorage.
 *
 * Shape: a hotkey is a normalized string like "Mod+K" / "Mod+Shift+P".
 * "Mod" = Cmd on macOS, Ctrl elsewhere. Build that abstraction so
 * defaults are sensible cross-platform; the renderer matches against
 * actual `metaKey`/`ctrlKey` based on platform.
 */

export interface Hotkey {
  /** Modifier flags. */
  mod: boolean       // platform-primary modifier (Cmd on macOS, Ctrl elsewhere)
  ctrl: boolean      // explicit Ctrl (matters on macOS where Ctrl ≠ Cmd)
  shift: boolean
  alt: boolean
  /** Lowercase letter / "space" / "enter" / etc. */
  key: string
}

const IS_MAC = navigator.platform.toLowerCase().includes('mac')

export function parseHotkey(s: string): Hotkey | null {
  if (!s) return null
  const parts = s.split('+').map(p => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const key = parts.pop()!.toLowerCase()
  const mods = new Set(parts.map(p => p.toLowerCase()))
  return {
    mod: mods.has('mod') || mods.has('cmd') || mods.has('cmd/ctrl'),
    ctrl: mods.has('ctrl') || mods.has('control'),
    shift: mods.has('shift'),
    alt: mods.has('alt') || mods.has('option') || mods.has('opt'),
    key,
  }
}

/** Render a hotkey for display, with platform-appropriate symbols. */
export function formatHotkey(s: string): string {
  const hk = parseHotkey(s)
  if (!hk) return s
  const parts: string[] = []
  if (hk.mod) parts.push(IS_MAC ? '⌘' : 'Ctrl')
  if (hk.ctrl) parts.push(IS_MAC ? '⌃' : 'Ctrl')
  if (hk.alt) parts.push(IS_MAC ? '⌥' : 'Alt')
  if (hk.shift) parts.push(IS_MAC ? '⇧' : 'Shift')
  parts.push(hk.key === 'space' ? 'Space' : hk.key.toUpperCase())
  return parts.join(IS_MAC ? '' : '+')
}

/** Does a KeyboardEvent match this configured hotkey? */
export function matchHotkey(s: string, e: KeyboardEvent): boolean {
  const hk = parseHotkey(s)
  if (!hk) return false
  // "Mod" maps to metaKey on macOS, ctrlKey elsewhere.
  const modPressed = IS_MAC ? e.metaKey : e.ctrlKey
  if (hk.mod !== modPressed) return false
  // Explicit Ctrl: on macOS check ctrlKey (independent of metaKey);
  // on other platforms ctrlKey is already consumed by "mod" so we
  // accept either.
  if (IS_MAC) {
    if (hk.ctrl !== e.ctrlKey) return false
  } else {
    // Non-Mac: ctrlKey IS the mod; explicit "ctrl" without "mod" is rare
    if (hk.ctrl && !e.ctrlKey) return false
  }
  if (hk.shift !== e.shiftKey) return false
  if (hk.alt !== e.altKey) return false
  // Key compare: 'space' matches event.key ' ', otherwise lowercase compare.
  const evKey = e.key.toLowerCase()
  if (hk.key === 'space') return evKey === ' ' || evKey === 'spacebar'
  return evKey === hk.key
}

/** localStorage keys for each known shortcut. */
export const HOTKEY_KEYS = {
  search: 'lineup:hotkey:search',
} as const

const DEFAULTS: Record<keyof typeof HOTKEY_KEYS, string> = {
  // Mod+K = Cmd+K on Mac (industry-standard "command palette / search"),
  // Ctrl+K elsewhere. Ctrl+Space was the user's first ask but it's
  // hard-bound to macOS input source switching at the OS level.
  search: 'Mod+K',
}

export function getHotkey(name: keyof typeof HOTKEY_KEYS): string {
  return localStorage.getItem(HOTKEY_KEYS[name]) || DEFAULTS[name]
}

export function setHotkey(name: keyof typeof HOTKEY_KEYS, value: string): void {
  if (value && value !== DEFAULTS[name]) {
    localStorage.setItem(HOTKEY_KEYS[name], value)
  } else {
    localStorage.removeItem(HOTKEY_KEYS[name])
  }
}

export function getDefaultHotkey(name: keyof typeof HOTKEY_KEYS): string {
  return DEFAULTS[name]
}

/** Build a hotkey string from a raw KeyboardEvent. Used by the
 *  "press a key combo to rebind" widget in Settings. */
export function eventToHotkey(e: KeyboardEvent): string | null {
  const k = e.key
  // Skip raw modifier presses — we want the FINAL key in the combo.
  if (k === 'Shift' || k === 'Control' || k === 'Meta' || k === 'Alt') return null
  const parts: string[] = []
  if ((IS_MAC && e.metaKey) || (!IS_MAC && e.ctrlKey)) parts.push('Mod')
  if (IS_MAC && e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k)
  return parts.join('+')
}
