/**
 * User-configurable display timezone.
 *
 * Why this exists: Electron renderer reads TZ from the OS, which on macOS
 * can drift if "set time zone automatically using current location" is on
 * AND the user is on a VPN — IP-based geolocation puts them in the VPN's
 * region (e.g. UTC) and Date#getHours returns offset-by-N hours.
 *
 * The setting is renderer-only (localStorage) — no need to round-trip
 * through main since all formatting happens in React.
 */

const TZ_KEY = 'lineup:timezone'
const DEFAULT_TZ = 'Asia/Hong_Kong'

export function getTimezone(): string {
  return localStorage.getItem(TZ_KEY) || DEFAULT_TZ
}

export function setTimezone(tz: string): void {
  if (tz) localStorage.setItem(TZ_KEY, tz)
  else localStorage.removeItem(TZ_KEY)
}

/** Pull individual fields out of a date in the configured TZ — for the
 *  cases where we need to construct a custom format string (e.g. "今天
 *  16:02") rather than a single Intl-rendered output. */
export function dateParts(d: Date): {
  year: number; month: number; day: number; hour: number; minute: number
} {
  const tz = getTimezone()
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  // Intl returns parts as strings keyed by type; map back to numbers.
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    // Intl returns "24" for midnight in en-US h23 mode — clamp to 0.
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
  }
}
