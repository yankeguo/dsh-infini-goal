import { describe, expect, it } from 'vitest'
import {
  canonicalTimeZone,
  formatZonedClock,
  nextTriggerAt,
  planTrigger,
  quietEndAt,
  resolveLocalInstant,
  zonedParts,
} from '../src/schedule.ts'
import type { InfiniGoalSettings, QuietWindow } from '../src/types.ts'

const SHANGHAI = 'Asia/Shanghai'
const NEW_YORK = 'America/New_York'

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
    })
  })

  it('reports a quiet-window wait', () => {
    const now = t('2026-03-02T10:00:00+08:00')
    const plan = planTrigger(settings([OFFICE_HOURS]), null, now)
    expect(plan.reason).toBe('quiet-window')
    expect(plan.quietUntil).toBe(t('2026-03-02T18:00:00+08:00'))
    expect(plan.nextAt).toBe(t('2026-03-02T18:00:00+08:00'))
  })
})

describe('formatZonedClock', () => {
  it('renders local clock text', () => {
    expect(formatZonedClock(SHANGHAI, t('2026-03-02T18:05:00+08:00'))).toBe('18:05')
    expect(formatZonedClock(NEW_YORK, t('2026-03-02T18:05:00-05:00'))).toBe('18:05')
  })
})
