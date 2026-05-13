import { useMemo } from 'react'
import type { TimelineEvent } from '../../preload/index'
import { dateParts } from '../lib/datetime'

// Pull (YYYY-MM-DD, hour) from an ISO timestamp using the user's
// configured display timezone — NOT raw UTC string slicing. claude
// jsonl timestamps are stored as UTC ("...Z"); slicing ts[11:13] gives
// UTC hours, which puts buckets 8h off for HKT/CST users.
function localDateAndHour(ts: string): { date: string; hour: number } {
  const dp = dateParts(new Date(ts))
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${dp.year}-${pad(dp.month)}-${pad(dp.day)}`,
    hour: dp.hour,
  }
}

export interface TimeSlot {
  slot_index: number   // 0..5 (hours 0-3, 4-7, 8-11, 12-15, 16-19, 20-23)
  start_hour: number
  end_hour: number
  user_turns: number
  tool_count: number
  headline: string          // first user turn of this slot, truncated
  first_event_index: number // index into the events array — for scrollIntoView
}

export interface TimeDay {
  date: string            // YYYY-MM-DD
  day_number: number      // ordinal from session start (1,2,3...)
  user_turns: number
  tool_count: number
  slots: TimeSlot[]
  headline: string
  first_event_index: number
}

export interface TimeTree {
  days: TimeDay[]
}

/**
 * Bucket a session's events by day → 4-hour slot, entirely client-side.
 * No LLM, no network, no cost: just metadata for navigation.
 * Days / slots with zero user turns AND zero tool uses are skipped.
 */
export function buildTimeTree(events: TimelineEvent[]): TimeTree {
  // First pass: index all events and group by day.
  const byDay = new Map<string, { events: Array<{ e: TimelineEvent; i: number }> }>()
  events.forEach((e, i) => {
    if (!e.ts) return
    const { date: d } = localDateAndHour(e.ts)
    if (!byDay.has(d)) byDay.set(d, { events: [] })
    byDay.get(d)!.events.push({ e, i })
  })

  const sortedDates = [...byDay.keys()].sort()
  const days: TimeDay[] = []
  let dayNumber = 0
  for (const date of sortedDates) {
    const { events: dayEvents } = byDay.get(date)!
    // Skip totally empty days (shouldn't happen if we saw events but safe)
    const dayUserTurns = dayEvents.filter(x => x.e.kind === 'user').length
    const dayToolCount = dayEvents.filter(x => x.e.kind === 'tool-use').length
    if (dayUserTurns === 0 && dayToolCount === 0) continue

    dayNumber++
    // Bucket by 4-hour slot.
    const slotMap = new Map<number, Array<{ e: TimelineEvent; i: number }>>()
    for (const x of dayEvents) {
      const { hour } = localDateAndHour(x.e.ts)
      const slotIdx = Math.floor(hour / 4)
      if (!slotMap.has(slotIdx)) slotMap.set(slotIdx, [])
      slotMap.get(slotIdx)!.push(x)
    }

    const slots: TimeSlot[] = []
    for (let i = 0; i < 6; i++) {
      const arr = slotMap.get(i) ?? []
      if (!arr.length) continue
      const userTurns = arr.filter(x => x.e.kind === 'user').length
      const toolCount = arr.filter(x => x.e.kind === 'tool-use').length
      if (userTurns === 0 && toolCount === 0) continue
      const firstUser = arr.find(x => x.e.kind === 'user')
      const headline = firstUser
        ? (firstUser.e.text ?? '').replace(/\s+/g, ' ').slice(0, 80)
        : `(${toolCount} 个工具调用，无用户提问)`
      slots.push({
        slot_index: i,
        start_hour: i * 4,
        end_hour: i * 4 + 3,
        user_turns: userTurns,
        tool_count: toolCount,
        headline,
        first_event_index: arr[0].i,
      })
    }

    // Day headline = first user message of the first active slot
    const firstUserOfDay = dayEvents.find(x => x.e.kind === 'user')
    const headline = firstUserOfDay
      ? (firstUserOfDay.e.text ?? '').replace(/\s+/g, ' ').slice(0, 80)
      : `(${dayToolCount} 个工具调用)`

    days.push({
      date,
      day_number: dayNumber,
      user_turns: dayUserTurns,
      tool_count: dayToolCount,
      slots,
      headline,
      first_event_index: dayEvents[0].i,
    })
  }

  return { days }
}

export interface SelectedBucket {
  date: string
  slot_index?: number  // undefined = whole day
}

/**
 * Given an events array and a selected bucket, return the subset of events
 * that fall inside that bucket. null = no filter.
 */
export function filterEventsByBucket(
  events: TimelineEvent[], selected: SelectedBucket | null
): TimelineEvent[] {
  if (!selected) return events
  return events.filter(e => {
    if (!e.ts) return false
    const { date, hour } = localDateAndHour(e.ts)
    if (date !== selected.date) return false
    if (selected.slot_index === undefined) return true
    return Math.floor(hour / 4) === selected.slot_index
  })
}
