/**
 * Time-zone-aware trigger scheduling shared by the Host driver and the browser
 * UI. Both sides must agree byte-for-byte on `nextTriggerAt` so the countdown
 * the user sees is the instant the driver will actually consider a new round.
 *
 * All calendar arithmetic is done with `Intl.DateTimeFormat` parts, so no
 * dependency on Temporal or a time-zone database package is required. Local
 * wall-clock times that do not exist (a DST spring-forward gap) normalize
 * forward to the first later instant, matching calendar-app alarm semantics;
 * wall-clock times that exist twice (a fall-back fold) are resolved per call
 * site: a quiet-window start uses the first occurrence and its end the last
 * one, so every wall-clock minute configured as quiet stays covered.
 */

import type { InfiniGoalSettings, QuietWindow } from './types.ts'
import { parseClockTime } from './quiet-windows.ts'

/** One minute in milliseconds. */
const MINUTE_MS = 60_000

/** One hour in milliseconds. */
const HOUR_MS = 3_600_000

/** One local day in milliseconds (calendar days are added via `Date`, not this). */
const DAY_MS = 86_400_000

/**
 * Search horizon for one contiguous quiet deferral.
 *
 * Quiet windows repeat every local week and a DST gap can skip at most one
 * occurrence of any wall-clock minute, so a quiet stretch longer than three
 * weeks proves that every local time is covered and nothing can ever trigger.
 * The horizon keeps `nextTriggerAt` fast for (invalid) whole-week coverage
 * instead of walking quiet windows forever.
 */
const QUIET_DEFERRAL_HORIZON_MS = 21 * DAY_MS

/** Defensive iteration cap; unreachable for minute-granularity windows inside the horizon. */
const QUIET_DEFERRAL_MAX_STEPS = 65_536

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

/** Which occurrence of an ambiguous local wall clock to resolve to. */
export type LocalOccurrence = 'earliest' | 'latest'

/** The instants of one local wall-clock minute; they differ only across a DST fold. */
interface LocalInstants {
  readonly earliest: number
  readonly latest: number
}

/**
 * What the pacing policy would do for one goal and one `now`.
 *
 * `reason` explains why the next automatic round is not due yet:
 *
 * - `ready`: the goal is eligible right now (`nextAt === now`);
 * - `interval`: the minimum interval is the binding constraint
 *   (`nextAt === max(now, lastRoundAt + minIntervalMs) > now`);
 * - `quiet-window`: quiet windows deferred the trigger past that candidate
 *   (`nextAt > max(now, lastRoundAt + minIntervalMs)`).
 */
export interface TriggerPlan {
  /** The instant this plan was computed for. */
  readonly now: number
  /** Earliest instant at which a new automatic round may start. */
  readonly nextAt: number
  /**
   * Instant the quiet deferral of `nextAt` ends, or `null` when quiet windows do
   * not defer the trigger. When set this always equals {@link nextAt}: quiet
   * windows are walked (including consecutive and overlapping ones) until the
   * first instant that is not quiet, which is exactly `nextAt`.
   */
  readonly quietUntil: number | null
  /** Milliseconds until `nextAt` (0 when already eligible). */
  readonly delayMs: number
  /** Why the next trigger is delayed, or `ready` when it is already eligible. */
  readonly reason: 'ready' | 'interval' | 'quiet-window'
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()
const resolveCache = new Map<string, LocalInstants>()
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
 *
 * Offset-style identifiers (`+08:00`, `-05:00`) are rejected even on runtimes
 * that accept them: the Host (Node) and the browser resolve time zones with
 * different `Intl` implementations, and accepting a zone the browser cannot
 * format would leave the UI without a schedule line. Only named zones are
 * portable across both sides.
 * @param value - caller-supplied zone name.
 * @returns the canonical zone name, or undefined when the name is unusable.
 */
export function canonicalTimeZone(value: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.startsWith('+') || trimmed.startsWith('-')) return undefined
  try {
    const resolved = formatterFor(trimmed).resolvedOptions().timeZone
    return resolved.length > 0 ? resolved : undefined
  } catch {
    return undefined
  }
}

/** One local wall clock as a minute-precision UTC epoch, used only for comparison. */
function wallClockAsUtc(parts: ZonedParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

/** ISO weekday (1 = Monday … 7 = Sunday) of one proleptic Gregorian date. */
export function weekdayOf(year: number, month: number, day: number): number {
  // `setUTCFullYear` (unlike the `Date.UTC` year argument) keeps years 0-99 literal.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  const dayOfWeek = date.getUTCDay()
  return dayOfWeek === 0 ? 7 : dayOfWeek
}

/** Add whole calendar days to one date. */
export function addDays(date: CalendarDate, delta: number): CalendarDate {
  const shifted = new Date(0)
  shifted.setUTCFullYear(date.year, date.month - 1, date.day + delta)
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
 * @throws {RangeError} when `timeZone` is not a usable time zone.
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
 * Every instant whose local wall clock equals `target`, earliest first.
 *
 * The zone offsets active within a day of the target are sampled, then each
 * sampled offset is turned into a candidate instant and verified against the
 * real wall clock. A DST fold therefore yields two candidates and a wall clock
 * that does not exist yields none. Sampling offsets (instead of iterating the
 * wall clock) keeps the result independent of the iteration direction, which
 * previously made the same ambiguous time resolve to the first occurrence in
 * one zone and to the last occurrence in another.
 */
function resolveCandidates(timeZone: string, target: number): number[] {
  const offsets = new Set<number>()
  for (const shiftHours of [-26, -13, 0, 13, 26]) {
    const probe = target + shiftHours * HOUR_MS
    offsets.add(wallClockAsUtc(zonedParts(timeZone, probe)) - probe)
  }
  const candidates: number[] = []
  for (const offset of offsets) {
    const candidate = target - offset
    if (wallClockAsUtc(zonedParts(timeZone, candidate)) === target) candidates.push(candidate)
  }
  return candidates.sort((left, right) => left - right)
}

/**
 * First instant whose local wall clock has reached `target`.
 *
 * Used when a wall-clock time does not exist because of a DST gap: matching how
 * calendar apps normalize nonexistent alarms, it walks forward to the gap end.
 * The ±26h scan window covers every real zone offset (-12h … +14h).
 */
function gapShiftedInstant(timeZone: string, target: number): number {
  for (let candidate = target - 26 * HOUR_MS; candidate <= target + 26 * HOUR_MS; candidate += MINUTE_MS) {
    if (wallClockAsUtc(zonedParts(timeZone, candidate)) >= target) return candidate
  }
  /* v8 ignore next -- unreachable for real zone offsets, which fit in the scan window. */
  return target
}

/** Resolve one local wall-clock minute, memoized per zone, date, and clock. */
function resolveLocalInstants(timeZone: string, date: CalendarDate, minutesAfterMidnight: number): LocalInstants {
  const hour = Math.floor(minutesAfterMidnight / 60)
  const minute = minutesAfterMidnight % 60
  const cacheKey = `${timeZone}|${date.year}-${date.month}-${date.day}|${hour}:${minute}`
  const cached = resolveCache.get(cacheKey)
  if (cached !== undefined) return cached
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  const candidates = resolveCandidates(timeZone, target)
  const instants: LocalInstants = candidates.length > 0
    ? { earliest: candidates[0] as number, latest: candidates[candidates.length - 1] as number }
    : (() => {
        const shifted = gapShiftedInstant(timeZone, target)
        return { earliest: shifted, latest: shifted }
      })()
  if (resolveCache.size >= RESOLVE_CACHE_LIMIT) resolveCache.clear()
  resolveCache.set(cacheKey, instants)
  return instants
}

/**
 * Resolve one local wall-clock date and time to an instant.
 *
 * Inside a DST gap (a wall-clock time that does not exist locally) the earliest
 * later instant is returned, matching how calendar apps normalize nonexistent
 * alarms. Inside a DST fold (a wall-clock time that exists twice) the first
 * (`earliest`, the default) or the last (`latest`) occurrence is returned.
 * @param timeZone - canonical IANA zone name.
 * @param date - local calendar date.
 * @param minutesAfterMidnight - local clock time in minutes (0-1439).
 * @param occurrence - which occurrence of an ambiguous wall clock to return.
 * @returns epoch milliseconds of the resolved instant.
 * @throws {RangeError} when `timeZone` is not a usable time zone.
 */
export function resolveLocalInstant(
  timeZone: string,
  date: CalendarDate,
  minutesAfterMidnight: number,
  occurrence: LocalOccurrence = 'earliest',
): number {
  const instants = resolveLocalInstants(timeZone, date, minutesAfterMidnight)
  return occurrence === 'latest' ? instants.latest : instants.earliest
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
  // A window must cover every wall-clock minute it names, so its start resolves
  // to the first occurrence of an ambiguous clock and its end to the last one.
  const start = resolveLocalInstant(timeZone, startDate, startMinutes, 'earliest')
  const end = resolveLocalInstant(timeZone, endDate, endMinutes, 'latest')
  // A DST gap can collapse a window whose both ends do not exist (e.g. 02:00-02:30
  // on a spring-forward day); such an occurrence covers no instant.
  if (end <= start) return undefined
  return { start, end }
}

/**
 * End of the quiet windows containing `epochMs`, or undefined when the instant
 * is not quiet. Overlapping windows return the latest end. Consecutive windows
 * that start exactly where another ends are not chained here; callers that need
 * the end of the whole quiet stretch walk the result (`nextTriggerAt` does).
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
 * quiet period, walking consecutive and overlapping windows until the first
 * instant that is not quiet.
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
  const candidate = Math.max(now, intervalEarliest)
  const horizon = candidate + QUIET_DEFERRAL_HORIZON_MS
  let triggerAt = candidate
  for (let step = 0; step < QUIET_DEFERRAL_MAX_STEPS; step += 1) {
    const quietEnd = quietEndAt(settings, triggerAt)
    if (quietEnd === undefined) return triggerAt
    if (quietEnd >= horizon) break
    triggerAt = quietEnd
  }
  throw new RangeError(
    'quiet windows cover every local time, so no automatic round can ever trigger',
  )
}

/**
 * Build the full pacing plan used by the driver and the UI countdown.
 *
 * The interval-satisfying candidate is
 * `candidate = max(now, lastRoundAt === null ? now : lastRoundAt + minIntervalMs)`.
 * When `candidate` falls inside a quiet window it is deferred to the first
 * instant that is not quiet (walking consecutive/overlapping windows), which
 * becomes `nextAt`; that deferral is reported through
 * `reason: 'quiet-window'` and `quietUntil: nextAt`. When quiet windows do not
 * defer the trigger, `quietUntil` is null and the plan is either `ready`
 * (`nextAt === now`) or waiting for the minimum interval (`reason: 'interval'`).
 * @param settings - pacing configuration.
 * @param lastRoundAt - instant the previous automatic round was admitted, or null.
 * @param now - current instant.
 * @returns the plan describing when the next round may start and why.
 * @throws {RangeError} when the quiet windows leave no eligible instant.
 */
export function planTrigger(
  settings: InfiniGoalSettings,
  lastRoundAt: number | null,
  now: number,
): TriggerPlan {
  const intervalEarliest = lastRoundAt === null ? now : lastRoundAt + settings.minIntervalMs
  const candidate = Math.max(now, intervalEarliest)
  const nextAt = nextTriggerAt(settings, lastRoundAt, now)
  const deferredByQuietWindow = nextAt > candidate
  const reason: TriggerPlan['reason'] = deferredByQuietWindow
    ? 'quiet-window'
    : nextAt > now
      ? 'interval'
      : 'ready'
  return {
    now,
    nextAt,
    quietUntil: deferredByQuietWindow ? nextAt : null,
    delayMs: Math.max(0, nextAt - now),
    reason,
  }
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
