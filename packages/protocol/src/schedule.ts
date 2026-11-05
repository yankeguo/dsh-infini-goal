/**
 * Time-zone-aware trigger scheduling shared by the Host driver and the browser
 * UI. Both sides must agree byte-for-byte on `nextTriggerAt` so the countdown
 * the user sees is the instant the driver will actually consider a new round.
 *
 * All calendar arithmetic is done with `Intl.DateTimeFormat` parts, so no
 * dependency on Temporal or a time-zone database package is required.
 */

import type { InfiniGoalSettings, QuietWindow } from './types.ts'
import { parseClockTime } from './quiet-windows.ts'

/** A resolved wall-clock date. */
interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** Wall-clock parts of one instant inside a time zone. */
export interface ZonedParts extends CalendarDate {
  readonly hour: number
  readonly minute: number
  readonly second: number
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  readonly weekday: number
}

/** What the pacing policy would do for one goal and one `now`. */
export interface TriggerPlan {
  /** The instant this plan was computed for. */
  readonly now: number
  /** Earliest instant at which a new automatic round may start. */
  readonly nextAt: number
  /** End of the quiet window containing `now`, or null when `now` is not quiet. */
  readonly quietUntil: number | null
  /** Milliseconds until `nextAt` (0 when already eligible). */
  readonly delayMs: number
  /** Why the next trigger is delayed, or `ready` when it is already eligible. */
  readonly reason: 'ready' | 'interval' | 'quiet-window'
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()
const resolveCache = new Map<string, number>()
const RESOLVE_CACHE_LIMIT = 2_048

/** Strict `Intl.DateTimeFormat` for one zone, cached. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Validate and canonicalize one IANA time zone.
 * @param value - caller-supplied zone name.
 * @returns the canonical zone name, or undefined when the name is unusable.
 */
export function canonicalTimeZone(value: string): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  try {
    const resolved = formatterFor(value.trim()).resolvedOptions().timeZone
    return resolved.length > 0 ? resolved : undefined
  } catch {
    return undefined
  }
}

/** ISO weekday (1 = Monday … 7 = Sunday) of one proleptic Gregorian date. */
export function weekdayOf(year: number, month: number, day: number): number {
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return dayOfWeek === 0 ? 7 : dayOfWeek
}

/** Add whole calendar days to one date. */
export function addDays(date: CalendarDate, delta: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + delta))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/**
 * Read the wall-clock parts of one instant in one time zone.
 * @param timeZone - canonical IANA zone name.
 * @param epochMs - instant in epoch milliseconds.
 * @returns the zone-local calendar and clock fields.
 */
export function zonedParts(timeZone: string, epochMs: number): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(epochMs)
  let year = 0
  let month = 0
  let day = 0
  let hour = 0
  let minute = 0
  let second = 0
  for (const part of parts) {
    const value = Number(part.value)
    switch (part.type) {
      case 'year':
        year = value
        break
      case 'month':
        month = value
        break
      case 'day':
        day = value
        break
      case 'hour':
        hour = value % 24
        break
      case 'minute':
        minute = value
        break
      case 'second':
        second = value
        break
      default:
        break
    }
  }
  return { year, month, day, hour, minute, second, weekday: weekdayOf(year, month, day) }
}

/**
 * Resolve one local wall-clock date and time to an instant.
 *
 * Inside a DST gap (a wall-clock time that does not exist locally) the earliest
 * later instant is returned, matching how calendar apps normalize nonexistent
 * alarms.
 * @param timeZone - canonical IANA zone name.
 * @param date - local calendar date.
 * @param minutesAfterMidnight - local clock time in minutes (0-1439).
 * @returns epoch milliseconds of the resolved instant.
 */
export function resolveLocalInstant(
  timeZone: string,
  date: CalendarDate,
  minutesAfterMidnight: number,
): number {
  const hour = Math.floor(minutesAfterMidnight / 60)
  const minute = minutesAfterMidnight % 60
  const cacheKey = `${timeZone}|${date.year}-${date.month}-${date.day}|${hour}:${minute}`
  const cached = resolveCache.get(cacheKey)
  if (cached !== undefined) return cached
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  let guess = target
  let resolved: number | undefined
  for (let pass = 0; pass < 4; pass += 1) {
    const parts = zonedParts(timeZone, guess)
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
    const delta = target - asUtc
    if (delta === 0) {
      resolved = guess
      break
    }
    guess += delta
  }
  if (resolved === undefined) {
    // Nonexistent local time inside a DST gap: walk forward to the first instant
    // whose local wall clock has reached the requested time.
    for (let candidate = target - 26 * 3_600_000; candidate <= target + 26 * 3_600_000; candidate += 60_000) {
      const parts = zonedParts(timeZone, candidate)
      const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
      if (asUtc >= target) {
        resolved = candidate
        break
      }
    }
    resolved ??= guess
  }
  if (resolveCache.size >= RESOLVE_CACHE_LIMIT) resolveCache.clear()
  resolveCache.set(cacheKey, resolved)
  return resolved
}

/** Resolved absolute bounds of one quiet-window occurrence. */
function windowBounds(
  timeZone: string,
  window: QuietWindow,
  local: ZonedParts,
  daysBack: number,
): { readonly start: number; readonly end: number } | undefined {
  const startDate = addDays(local, -daysBack)
  if (window.days.length > 0 && !window.days.includes(weekdayOf(startDate.year, startDate.month, startDate.day))) {
    return undefined
  }
  const startMinutes = parseClockTime(window.start)
  const endMinutes = parseClockTime(window.end)
  const endDate = endMinutes <= startMinutes ? addDays(startDate, 1) : startDate
  return {
    start: resolveLocalInstant(timeZone, startDate, startMinutes),
    end: resolveLocalInstant(timeZone, endDate, endMinutes),
  }
}

/**
 * End of the quiet window containing `epochMs`, or undefined when the instant is
 * not quiet. Overlapping windows return the latest end.
 * @param settings - pacing configuration.
 * @param epochMs - instant to test.
 */
export function quietEndAt(settings: InfiniGoalSettings, epochMs: number): number | undefined {
  if (settings.quietWindows.length === 0) return undefined
  const timeZone = settings.timezone
  const local = zonedParts(timeZone, epochMs)
  let end: number | undefined
  for (const window of settings.quietWindows) {
    // A window may have started on the previous local day (overnight windows).
    for (const daysBack of [0, 1]) {
      const bounds = windowBounds(timeZone, window, local, daysBack)
      if (bounds === undefined) continue
      if (epochMs >= bounds.start && epochMs < bounds.end) {
        end = end === undefined ? bounds.end : Math.max(end, bounds.end)
      }
    }
  }
  return end
}

/** Whether `epochMs` falls inside any configured quiet window. */
export function isQuietAt(settings: InfiniGoalSettings, epochMs: number): boolean {
  return quietEndAt(settings, epochMs) !== undefined
}

/**
 * Compute the earliest instant at which the pacing policy allows a new
 * automatic round.
 *
 * The policy is: a round may start no earlier than `lastRoundAt + minInterval`
 * (no constraint before the first round), and never inside a quiet window; a
 * candidate that lands inside a quiet window is pushed past the end of the
 * quiet period.
 * @param settings - pacing configuration.
 * @param lastRoundAt - instant the previous automatic round was admitted, or null.
 * @param now - current instant.
 * @returns the earliest eligible instant.
 * @throws {RangeError} when the quiet windows leave no eligible instant (a
 *   configuration that covers every local time).
 */
export function nextTriggerAt(
  settings: InfiniGoalSettings,
  lastRoundAt: number | null,
  now: number,
): number {
  const intervalEarliest = lastRoundAt === null ? now : lastRoundAt + settings.minIntervalMs
  let candidate = Math.max(now, intervalEarliest)
  for (let guard = 0; guard < 512; guard += 1) {
    const quietEnd = quietEndAt(settings, candidate)
    if (quietEnd === undefined) return candidate
    candidate = quietEnd
  }
  throw new RangeError(
    'quiet windows cover every local time, so no automatic round can ever trigger',
  )
}

/**
 * Build the full pacing plan used by the driver and the UI countdown.
 * @param settings - pacing configuration.
 * @param lastRoundAt - instant the previous automatic round was admitted, or null.
 * @param now - current instant.
 * @returns the plan describing when the next round may start and why.
 */
export function planTrigger(
  settings: InfiniGoalSettings,
  lastRoundAt: number | null,
  now: number,
): TriggerPlan {
  const quietUntil = quietEndAt(settings, now) ?? null
  const nextAt = nextTriggerAt(settings, lastRoundAt, now)
  const intervalEarliest = lastRoundAt === null ? now : lastRoundAt + settings.minIntervalMs
  const reason: TriggerPlan['reason'] = nextAt <= now
    ? 'ready'
    : quietUntil !== null
      ? 'quiet-window'
      : intervalEarliest > now
        ? 'interval'
        : 'quiet-window'
  return { now, nextAt, quietUntil, delayMs: Math.max(0, nextAt - now), reason }
}

/** Render one instant as `HH:mm` in the configured zone. */
export function formatZonedClock(timeZone: string, epochMs: number): string {
  const parts = zonedParts(timeZone, epochMs)
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

/** Render one instant as `YYYY-MM-DD HH:mm` in the configured zone. */
export function formatZonedDateTime(timeZone: string, epochMs: number): string {
  const parts = zonedParts(timeZone, epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(parts.year).padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}
