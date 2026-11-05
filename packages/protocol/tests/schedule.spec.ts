import { describe, expect, it } from 'vitest'
import {
  addDays,
  canonicalTimeZone,
  formatZonedClock,
  formatZonedDateTime,
  isQuietAt,
  nextTriggerAt,
  planTrigger,
  quietEndAt,
  resolveLocalInstant,
  weekdayOf,
  zonedParts,
} from '../src/schedule.ts'
import type { InfiniGoalSettings, QuietWindow } from '../src/types.ts'

const SHANGHAI = 'Asia/Shanghai'
const NEW_YORK = 'America/New_York'
const BERLIN = 'Europe/Berlin'
const LORD_HOWE = 'Australia/Lord_Howe'

/** Build settings with the Shanghai zone and one-minute pacing. */
function settings(quietWindows: QuietWindow[] = [], minIntervalMs = 60_000): InfiniGoalSettings {
  return { minIntervalMs, quietWindows, timezone: SHANGHAI }
}

/** Parse one zoned ISO instant into epoch milliseconds. */
function t(iso: string): number {
  return Date.parse(iso)
}

const OFFICE_HOURS: QuietWindow = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }
const OVERNIGHT: QuietWindow = { days: [1], start: '22:00', end: '06:00' }

describe('canonicalTimeZone', () => {
  it('accepts IANA zones and rejects junk', () => {
    expect(canonicalTimeZone('Asia/Shanghai')).toBe(SHANGHAI)
    expect(canonicalTimeZone('UTC')).toBe('UTC')
    expect(canonicalTimeZone('Not/AZone')).toBeUndefined()
    expect(canonicalTimeZone('')).toBeUndefined()
  })

  it('rejects offset-style identifiers that browser Intl cannot format', () => {
    // Node 24 accepts these, but the web bundle targets engines that do not.
    expect(canonicalTimeZone('+08:00')).toBeUndefined()
    expect(canonicalTimeZone('-05:00')).toBeUndefined()
  })

  it('canonicalizes case and aliases', () => {
    expect(canonicalTimeZone('utc')).toBe('UTC')
    expect(canonicalTimeZone('asia/shanghai')).toBe(SHANGHAI)
    expect(canonicalTimeZone(' US/Eastern ')).toBe(NEW_YORK)
  })
})

describe('calendar helpers', () => {
  it('treats years 0-99 literally instead of mapping them to 1900-1999', () => {
    expect(weekdayOf(2026, 3, 2)).toBe(1)
    expect(weekdayOf(1, 1, 1)).toBe(1) // 0001-01-01 is a Monday
    expect(weekdayOf(0, 1, 1)).toBe(6) // 0000-01-01 is a Saturday
    expect(addDays({ year: 0, month: 1, day: 1 }, 0)).toEqual({ year: 0, month: 1, day: 1 })
    expect(addDays({ year: 99, month: 12, day: 31 }, 1)).toEqual({ year: 100, month: 1, day: 1 })
  })

  it('crosses month, year, and leap-day boundaries', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 })
    expect(addDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29 })
    expect(addDays({ year: 2027, month: 3, day: 1 }, -1)).toEqual({ year: 2027, month: 2, day: 28 })
  })
})

describe('zonedParts', () => {
  it('reads Shanghai wall clock', () => {
    const parts = zonedParts(SHANGHAI, t('2026-03-02T10:00:00+08:00'))
    expect(parts).toMatchObject({ year: 2026, month: 3, day: 2, hour: 10, minute: 0, weekday: 1 })
  })
})

describe('resolveLocalInstant', () => {
  it('resolves Shanghai wall clock to the matching instant', () => {
    const instant = resolveLocalInstant(SHANGHAI, { year: 2026, month: 3, day: 2 }, 18 * 60)
    expect(instant).toBe(t('2026-03-02T18:00:00+08:00'))
  })

  it('normalizes nonexistent DST-gap times forward', () => {
    // America/New_York springs forward on 2026-03-08 at 02:00 local.
    const instant = resolveLocalInstant(NEW_YORK, { year: 2026, month: 3, day: 8 }, 2 * 60 + 30)
    expect(formatZonedClock(NEW_YORK, instant)).toBe('03:00')
  })

  it('normalizes a 30-minute DST gap forward', () => {
    // Australia/Lord_Howe springs forward on 2026-10-04 at 02:00 local (to 02:30).
    const instant = resolveLocalInstant(LORD_HOWE, { year: 2026, month: 10, day: 4 }, 2 * 60 + 15)
    expect(formatZonedClock(LORD_HOWE, instant)).toBe('02:30')
  })

  it('resolves ambiguous fall-back times to a documented occurrence', () => {
    // America/New_York falls back on 2026-11-01: 01:30 local exists twice.
    const newYorkDate = { year: 2026, month: 11, day: 1 }
    expect(resolveLocalInstant(NEW_YORK, newYorkDate, 90)).toBe(t('2026-11-01T05:30:00Z'))
    expect(resolveLocalInstant(NEW_YORK, newYorkDate, 90, 'latest')).toBe(t('2026-11-01T06:30:00Z'))
    // Europe/Berlin falls back on 2026-10-25: 02:30 local exists twice. The
    // default must be the first occurrence here too (previously zone-dependent).
    const berlinDate = { year: 2026, month: 10, day: 25 }
    expect(resolveLocalInstant(BERLIN, berlinDate, 150)).toBe(t('2026-10-25T00:30:00Z'))
    expect(resolveLocalInstant(BERLIN, berlinDate, 150, 'latest')).toBe(t('2026-10-25T01:30:00Z'))
  })
})

describe('quietEndAt / isQuietAt', () => {
  it('recognizes office hours on weekdays only', () => {
    const config = settings([OFFICE_HOURS])
    expect(quietEndAt(config, t('2026-03-02T10:00:00+08:00'))).toBe(t('2026-03-02T18:00:00+08:00'))
    expect(quietEndAt(config, t('2026-03-02T08:59:00+08:00'))).toBeUndefined()
    expect(quietEndAt(config, t('2026-03-02T18:00:00+08:00'))).toBeUndefined()
    // 2026-03-07 is a Saturday: the weekday filter excludes it.
    expect(quietEndAt(config, t('2026-03-07T10:00:00+08:00'))).toBeUndefined()
  })

  it('recognizes overnight windows from the previous day', () => {
    const config = settings([OVERNIGHT])
    expect(quietEndAt(config, t('2026-03-02T23:00:00+08:00'))).toBe(t('2026-03-03T06:00:00+08:00'))
    expect(quietEndAt(config, t('2026-03-03T05:00:00+08:00'))).toBe(t('2026-03-03T06:00:00+08:00'))
    // Tuesday 05:00 belongs to the Monday-starting window; Tuesday night does not.
    expect(quietEndAt(config, t('2026-03-04T05:00:00+08:00'))).toBeUndefined()
  })

  it('returns the latest end of overlapping windows', () => {
    const config = settings([
      { days: [], start: '09:00', end: '12:00' },
      { days: [], start: '11:00', end: '14:00' },
    ])
    expect(quietEndAt(config, t('2026-03-02T11:30:00+08:00'))).toBe(t('2026-03-02T14:00:00+08:00'))
  })

  it('treats the start as inclusive and the end as exclusive at midnight', () => {
    const config = settings([{ days: [], start: '00:00', end: '06:00' }])
    expect(quietEndAt(config, t('2026-03-02T00:00:00+08:00'))).toBe(t('2026-03-02T06:00:00+08:00'))
    expect(quietEndAt(config, t('2026-03-02T06:00:00+08:00'))).toBeUndefined()
  })

  it('resolves an overnight window across a year boundary', () => {
    const config = settings([{ days: [], start: '22:00', end: '06:00' }])
    expect(quietEndAt(config, t('2026-12-31T23:00:00+08:00'))).toBe(t('2027-01-01T06:00:00+08:00'))
    expect(quietEndAt(config, t('2027-01-01T05:00:00+08:00'))).toBe(t('2027-01-01T06:00:00+08:00'))
  })

  it('covers both occurrences of a fall-back hour', () => {
    // America/New_York falls back on 2026-11-01 at 02:00 local: 01:00-01:59
    // wall clock occurs twice (05:00-05:59Z and 06:00-06:59Z).
    const newYorkConfig: InfiniGoalSettings = {
      minIntervalMs: 60_000,
      timezone: NEW_YORK,
      quietWindows: [{ days: [], start: '01:00', end: '01:30' }],
    }
    expect(isQuietAt(newYorkConfig, t('2026-11-01T05:10:00Z'))).toBe(true) // 01:10 EDT
    expect(isQuietAt(newYorkConfig, t('2026-11-01T06:10:00Z'))).toBe(true) // 01:10 EST
    expect(quietEndAt(newYorkConfig, t('2026-11-01T05:10:00Z'))).toBe(t('2026-11-01T06:30:00Z'))
    expect(isQuietAt(newYorkConfig, t('2026-11-01T06:30:00Z'))).toBe(false) // end exclusive
    expect(isQuietAt(newYorkConfig, t('2026-11-01T07:10:00Z'))).toBe(false) // 02:10 EST
  })

  it('resolves the fall-back hour of every zone rather than of one iteration direction', () => {
    // Europe/Berlin falls back on 2026-10-25 at 03:00 local: 02:00-02:59 wall
    // clock occurs twice (00:00-00:59Z and 01:00-01:59Z).
    const config: InfiniGoalSettings = {
      minIntervalMs: 60_000,
      timezone: BERLIN,
      quietWindows: [{ days: [], start: '02:00', end: '02:30' }],
    }
    expect(isQuietAt(config, t('2026-10-25T00:10:00Z'))).toBe(true) // 02:10 CEST
    expect(isQuietAt(config, t('2026-10-25T01:10:00Z'))).toBe(true) // 02:10 CET
    expect(quietEndAt(config, t('2026-10-25T00:10:00Z'))).toBe(t('2026-10-25T01:30:00Z'))
    expect(isQuietAt(config, t('2026-10-25T01:30:00Z'))).toBe(false) // end exclusive
  })
})

describe('nextTriggerAt', () => {
  it('has no interval constraint before the first round', () => {
    const now = t('2026-03-02T08:00:00+08:00')
    expect(nextTriggerAt(settings(), null, now)).toBe(now)
  })

  it('enforces the minimum interval between rounds', () => {
    const now = t('2026-03-02T08:00:00+08:00')
    const lastRoundAt = now - 30_000
    expect(nextTriggerAt(settings([], 60_000), lastRoundAt, now)).toBe(now + 30_000)
  })

  it('does not delay once the interval has already elapsed', () => {
    const now = t('2026-03-02T08:00:00+08:00')
    const lastRoundAt = now - 10 * 60_000
    expect(nextTriggerAt(settings([], 60_000), lastRoundAt, now)).toBe(now)
  })

  it('pushes a candidate that lands inside a quiet window past its end', () => {
    const now = t('2026-03-02T10:00:00+08:00')
    expect(nextTriggerAt(settings([OFFICE_HOURS]), null, now)).toBe(t('2026-03-02T18:00:00+08:00'))
  })

  it('keeps an interval target that already falls after the quiet window', () => {
    const now = t('2026-03-02T08:00:00+08:00')
    const lastRoundAt = now - 1_000
    // Interval target 08:01 is before office hours: no quiet push.
    expect(nextTriggerAt(settings([OFFICE_HOURS], 60_000), lastRoundAt, now)).toBe(now + 59_000)
  })

  it('skips a quiet window and then respects the remaining interval', () => {
    const now = t('2026-03-02T17:30:00+08:00')
    const lastRoundAt = now - 30_000
    // Interval target 17:30:30 is quiet, so the trigger moves to 18:00.
    expect(nextTriggerAt(settings([OFFICE_HOURS], 60_000), lastRoundAt, now)).toBe(t('2026-03-02T18:00:00+08:00'))
  })

  it('throws when quiet windows cover every local time', () => {
    const config = settings([
      { days: [], start: '00:00', end: '12:00' },
      { days: [], start: '12:00', end: '00:00' },
    ])
    expect(() => nextTriggerAt(config, null, t('2026-03-02T10:00:00+08:00'))).toThrow(/quiet windows/)
  })

  it('throws when whole-week coverage is expressed through weekday filters', () => {
    const config = settings([
      { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '12:00' },
      { days: [1, 2, 3, 4, 5, 6, 7], start: '12:00', end: '00:00' },
    ])
    expect(() => nextTriggerAt(config, null, t('2026-03-02T10:00:00+08:00'))).toThrow(RangeError)
  })

  it('chains weekday-filtered windows and escapes on the first free local day', () => {
    // Monday 2026-03-02 10:00: Monday-Saturday are fully quiet, so the first
    // eligible instant is Sunday 2026-03-08 00:00 local time.
    const config = settings([
      { days: [1, 2, 3, 4, 5, 6], start: '00:00', end: '12:00' },
      { days: [1, 2, 3, 4, 5, 6], start: '12:00', end: '00:00' },
    ])
    expect(nextTriggerAt(config, null, t('2026-03-02T10:00:00+08:00'))).toBe(t('2026-03-08T00:00:00+08:00'))
  })

  it('defers a candidate that falls in the first pass of a fall-back hour', () => {
    // Europe/Berlin falls back on 2026-10-25: the 02:00-02:30 window occurs
    // twice and both occurrences end at 02:30 CET (01:30Z).
    const config: InfiniGoalSettings = {
      minIntervalMs: 60_000,
      timezone: BERLIN,
      quietWindows: [{ days: [], start: '02:00', end: '02:30' }],
    }
    expect(nextTriggerAt(config, null, t('2026-10-25T00:15:00Z'))).toBe(t('2026-10-25T01:30:00Z'))
    expect(nextTriggerAt(config, null, t('2026-10-25T01:15:00Z'))).toBe(t('2026-10-25T01:30:00Z'))
  })
})

describe('planTrigger', () => {
  it('reports a ready plan when eligible', () => {
    const now = t('2026-03-02T08:00:00+08:00')
    expect(planTrigger(settings(), null, now)).toMatchObject({
      nextAt: now,
      quietUntil: null,
      delayMs: 0,
      reason: 'ready',
    })
  })

  it('reports an interval wait', () => {
    const now = t('2026-03-02T08:00:00+08:00')
    expect(planTrigger(settings([], 60_000), now - 30_000, now)).toMatchObject({
      nextAt: now + 30_000,
      delayMs: 30_000,
      reason: 'interval',
      quietUntil: null,
    })
  })

  it('reports a quiet-window wait', () => {
    const now = t('2026-03-02T10:00:00+08:00')
    const plan = planTrigger(settings([OFFICE_HOURS]), null, now)
    expect(plan.reason).toBe('quiet-window')
    expect(plan.quietUntil).toBe(t('2026-03-02T18:00:00+08:00'))
    expect(plan.nextAt).toBe(t('2026-03-02T18:00:00+08:00'))
    // Consumers render `quietUntil` as the instant automatic rounds resume.
    expect(plan.quietUntil).toBe(plan.nextAt)
  })

  it('classifies an interval candidate deferred by a future quiet window', () => {
    // Regression: `now` is not quiet, but the interval-satisfying candidate
    // (10:00 local) falls inside office hours; the quiet deferral must be
    // reported instead of a plain interval wait.
    const now = t('2026-11-05T08:00:00+08:00')
    const plan = planTrigger(settings([OFFICE_HOURS], 2 * 3_600_000), now, now)
    expect(plan.nextAt).toBe(t('2026-11-05T18:00:00+08:00'))
    expect(plan.quietUntil).toBe(plan.nextAt)
    expect(plan.delayMs).toBe(10 * 3_600_000)
    expect(plan.reason).toBe('quiet-window')
  })

  it('reports the final end of consecutive quiet windows as quietUntil', () => {
    const config = settings([OFFICE_HOURS, { days: [], start: '18:00', end: '20:00' }])
    const now = t('2026-11-05T10:00:00+08:00')
    const plan = planTrigger(config, null, now)
    expect(plan.nextAt).toBe(t('2026-11-05T20:00:00+08:00'))
    expect(plan.quietUntil).toBe(plan.nextAt)
    expect(plan.reason).toBe('quiet-window')
  })

  it('keeps quietUntil null when the minimum interval outlasts the quiet window', () => {
    // Inside office hours, but the interval target (21:00 local) is not quiet:
    // the minimum interval is the binding constraint.
    const now = t('2026-11-05T10:00:00+08:00')
    const plan = planTrigger(settings([OFFICE_HOURS], 12 * 3_600_000), now - 3_600_000, now)
    expect(plan.reason).toBe('interval')
    expect(plan.quietUntil).toBeNull()
    expect(plan.nextAt).toBe(now + 11 * 3_600_000)
  })

  it('keeps quietUntil null when only the interval delays the trigger', () => {
    const now = t('2026-11-05T07:00:00+08:00')
    const plan = planTrigger(settings([OFFICE_HOURS], 3_600_000), now - 1_800_000, now)
    expect(plan).toMatchObject({
      nextAt: now + 1_800_000,
      delayMs: 1_800_000,
      quietUntil: null,
      reason: 'interval',
    })
  })

  it('keeps quietUntil null when the interval target is not quiet', () => {
    // now is not quiet and the interval target is not quiet: `quietUntil` must
    // stay null so the UI shows the interval, not a phantom quiet state.
    const now = t('2026-11-05T07:00:00+08:00')
    const plan = planTrigger(settings([OFFICE_HOURS], 3_600_000), now, now)
    expect(plan.nextAt).toBe(now + 3_600_000)
    expect(plan.quietUntil).toBeNull()
    expect(plan.reason).toBe('interval')
  })

  it('reports quietUntil = nextAt for a candidate inside a fall-back hour', () => {
    // 2026-11-01 06:10Z = 01:10 EST (second pass of the repeated hour).
    const config: InfiniGoalSettings = {
      minIntervalMs: 60_000,
      timezone: NEW_YORK,
      quietWindows: [{ days: [], start: '01:00', end: '01:30' }],
    }
    const now = t('2026-11-01T06:10:00Z')
    const plan = planTrigger(config, null, now)
    expect(plan.reason).toBe('quiet-window')
    expect(plan.quietUntil).toBe(t('2026-11-01T06:30:00Z'))
    expect(plan.nextAt).toBe(plan.quietUntil)
  })
})

describe('formatZonedClock', () => {
  it('renders local clock text', () => {
    expect(formatZonedClock(SHANGHAI, t('2026-03-02T18:05:00+08:00'))).toBe('18:05')
    expect(formatZonedClock(NEW_YORK, t('2026-03-02T18:05:00-05:00'))).toBe('18:05')
  })

  it('renders a zero-padded date across a year boundary', () => {
    expect(formatZonedDateTime(SHANGHAI, t('2027-01-02T03:04:00+08:00'))).toBe('2027-01-02 03:04')
    expect(formatZonedDateTime(SHANGHAI, t('2026-12-31T23:59:00+08:00'))).toBe('2026-12-31 23:59')
  })
})

describe('epoch boundaries', () => {
  it('handles the Unix epoch and pre-1970 instants', () => {
    const config = settings([{ days: [], start: '00:00', end: '06:00' }])
    // 1970-01-01T00:00:00Z is 08:00 in Shanghai, outside the window.
    expect(nextTriggerAt(config, null, 0)).toBe(0)
    // 1969-12-31T17:00:00Z is 1970-01-01 01:00 in Shanghai, inside the window.
    expect(quietEndAt(config, t('1969-12-31T17:00:00Z'))).toBe(t('1969-12-31T22:00:00Z'))
  })
})
