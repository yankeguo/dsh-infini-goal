/** Parse, validate, and render local-time quiet windows. */

import type { QuietWindow } from './types.ts'

/** Short English weekday labels; index 0 is Monday. */
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const

const ENTRY = /^(?:(\S+)\s+)?(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/u

/** {@link parseWeekdays} accepts English labels, numeric ISO days, and `daily`. */
const DAY_RANGE = /^(\d{1,2})-(\d{1,2})$/u

/** Render one ISO weekday (1 = Monday) as its short English label. */
export function weekdayLabel(day: number): string {
  const label = WEEKDAYS[day - 1]
  if (label === undefined) throw new TypeError(`weekday must be 1-7, received ${String(day)}`)
  return label
}

/** Resolve one numeric or labelled weekday token to an ISO weekday number. */
function resolveWeekdayToken(token: string): number {
  const numeric = Number(token)
  if (Number.isSafeInteger(numeric)) {
    if (numeric < 1 || numeric > 7) throw new TypeError(`invalid weekday "${token}" (expected 1-7)`)
    return numeric
  }
  const index = WEEKDAYS.findIndex(label => label.toLowerCase() === token.toLowerCase())
  if (index < 0) {
    throw new TypeError(`unknown weekday "${token}" (use Mo,Tu,We,Th,Fr,Sa,Su or 1-7)`)
  }
  return index + 1
}

/**
 * Parse one weekday selector such as `Mo-Fr`, `Sa,Su`, `1-5`, `3`, or `daily`.
 * @param token - caller-supplied selector.
 * @returns sorted unique ISO weekday numbers.
 */
export function parseWeekdays(token: string): number[] {
  const input = token.trim()
  if (input.length === 0 || input === '*' || input.toLowerCase() === 'daily' || input.toLowerCase() === 'everyday') {
    return []
  }
  const selected = new Set<number>()
  for (const piece of input.split(',')) {
    const part = piece.trim()
    if (part.length === 0) throw new TypeError(`invalid weekday list "${token}"`)
    const range = DAY_RANGE.exec(part)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from < 1 || from > 7 || to < 1 || to > 7 || from > to) {
        throw new TypeError(`invalid weekday range "${part}" (expected 1-7 ascending)`)
      }
      for (let day = from; day <= to; day += 1) selected.add(day)
      continue
    }
    const labelRange = /^(\S+)-(\S+)$/u.exec(part)
    if (labelRange !== null) {
      const from = resolveWeekdayToken(labelRange[1] as string)
      const to = resolveWeekdayToken(labelRange[2] as string)
      if (from > to) throw new TypeError(`invalid weekday range "${part}" (expected ascending)`)
      for (let day = from; day <= to; day += 1) selected.add(day)
      continue
    }
    selected.add(resolveWeekdayToken(part))
  }
  return [...selected].sort((left, right) => left - right)
}

/** Render a sorted weekday set compactly (`Mo-Fr`, `Sa-Su`, `Mo,We,Fr`). */
export function formatWeekdays(days: readonly number[]): string {
  if (days.length === 0) return ''
  const sorted = [...new Set(days)].sort((left, right) => left - right)
  const runs: string[] = []
  let start = sorted[0] as number
  let previous = start
  const flush = (): void => {
    const from = weekdayLabel(start)
    const to = weekdayLabel(previous)
    runs.push(start === previous ? from : `${from}-${to}`)
  }
  for (const day of sorted.slice(1)) {
    if (day === previous + 1) {
      previous = day
      continue
    }
    flush()
    start = day
    previous = day
  }
  flush()
  return runs.join(',')
}

/** Parse one `HH:mm` clock time into minutes after local midnight. */
export function parseClockTime(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
  if (match === null) throw new TypeError(`invalid clock time "${value}" (expected HH:mm)`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new TypeError(`invalid clock time "${value}" (expected 00:00-23:59)`)
  return hour * 60 + minute
}

/** Render minutes after local midnight as `HH:mm`. */
export function formatClockTime(minutes: number): string {
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Normalize and validate one caller-supplied quiet window. */
export function validateQuietWindow(value: unknown): QuietWindow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('quiet window must be an object with start and end')
  }
  const record = value as Record<string, unknown>
  const start = record['start']
  const end = record['end']
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw new TypeError('quiet window start and end must be HH:mm strings')
  }
  parseClockTime(start)
  parseClockTime(end)
  if (normalizeClock(start) === normalizeClock(end)) {
    throw new TypeError(`quiet window start and end must differ (received ${start}-${end})`)
  }
  const rawDays = record['days']
  let days: number[]
  if (rawDays === undefined || rawDays === null) {
    days = []
  } else if (Array.isArray(rawDays)) {
    const selected = new Set<number>()
    for (const day of rawDays) {
      if (typeof day !== 'number' || !Number.isSafeInteger(day) || day < 1 || day > 7) {
        throw new TypeError('quiet window days must be ISO weekday numbers 1-7')
      }
      selected.add(day)
    }
    days = [...selected].sort((left, right) => left - right)
  } else {
    throw new TypeError('quiet window days must be an array of ISO weekday numbers')
  }
  return { days, start: normalizeClock(start), end: normalizeClock(end) }
}

/** Normalize a validated clock string to two-digit `HH:mm`. */
function normalizeClock(value: string): string {
  return formatClockTime(parseClockTime(value))
}

/**
 * Validate a whole quiet-window list.
 * @param value - candidate list.
 * @returns a normalized detached list.
 */
export function validateQuietWindows(value: unknown): QuietWindow[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new TypeError('quiet windows must be an array')
  return value.map(entry => validateQuietWindow(entry))
}

/**
 * Parse the human/model quiet-window text form.
 *
 * Entries are separated by `;`. Each entry is either `HH:mm-HH:mm` (every day)
 * or `<weekday selector> HH:mm-HH:mm`, for example
 * `Mo-Fr 09:00-18:00; Sa,Su 10:00-12:00`. `none`, `off`, and empty text mean no
 * quiet windows.
 * @param text - caller-supplied window text.
 * @returns normalized quiet windows.
 */
export function parseQuietWindows(text: string): QuietWindow[] {
  if (typeof text !== 'string') throw new TypeError('quiet windows must be a string')
  const input = text.trim()
  if (input.length === 0 || input.toLowerCase() === 'none' || input.toLowerCase() === 'off') return []
  if (input.toLowerCase() === 'always' || input.toLowerCase() === 'all') {
    throw new TypeError('a quiet window covering the whole day would stop every automatic round')
  }
  const windows: QuietWindow[] = []
  for (const rawEntry of input.split(';')) {
    const entry = rawEntry.trim()
    if (entry.length === 0) continue
    const match = ENTRY.exec(entry)
    if (match === null) {
      throw new TypeError(`invalid quiet window "${entry}" (expected [Mo-Fr ]HH:mm-HH:mm)`)
    }
    windows.push(validateQuietWindow({
      days: match[1] === undefined ? [] : parseWeekdays(match[1]),
      start: `${match[2] as string}:${match[3] as string}`,
      end: `${match[4] as string}:${match[5] as string}`,
    }))
  }
  return windows
}

/**
 * Render quiet windows in the canonical text form accepted by
 * {@link parseQuietWindows}.
 * @param windows - normalized windows.
 * @returns canonical text, or `none` when the list is empty.
 */
export function formatQuietWindows(windows: readonly QuietWindow[]): string {
  if (windows.length === 0) return 'none'
  return windows
    .map((window) => {
      const days = formatWeekdays(window.days)
      const clock = `${window.start}-${window.end}`
      return days.length > 0 ? `${days} ${clock}` : clock
    })
    .join('; ')
}
