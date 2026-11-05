/** Unit tests for the pure countdown/schedule helpers of the InfiniGoalBar dock. */

import { describe, expect, it } from 'vitest'
import type { InfiniGoalProjection, InfiniGoalSnapshot } from '@yankeguo/dsh-infini-goal-protocol/client'
import { describeSchedule, formatCountdown, phaseLabelKey } from '../src/client/format.ts'

/** Durable goal used by every fixture; individual tests override fields. */
const BASE_GOAL: InfiniGoalSnapshot = {
  id: 'goal-1',
  revision: 1,
  objective: 'ship the infini-goal plugin',
  phase: 'active',
  minIntervalMs: 60_000,
  quietWindows: [],
  timezone: 'UTC',
}

/**
 * Build one projected goal fixture.
 * @param goal - snapshot field overrides.
 * @param lastRoundAt - instant of the latest admitted round.
 * @returns the projection the dock receives.
 */
function makeProjection(
  goal: Partial<InfiniGoalSnapshot> = {},
  lastRoundAt: number | null = null,
): InfiniGoalProjection {
  return {
    goal: { ...BASE_GOAL, ...goal },
    roundsStarted: lastRoundAt === null ? 0 : 3,
    lastRoundAt,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('formatCountdown', () => {
  it('renders mm:ss below one hour', () => {
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(999)).toBe('00:00')
    expect(formatCountdown(1_000)).toBe('00:01')
    expect(formatCountdown(42_000)).toBe('00:42')
    expect(formatCountdown(61_000)).toBe('01:01')
    expect(formatCountdown(3_599_999)).toBe('59:59')
  })

  it('renders h:mm:ss from one hour up', () => {
    expect(formatCountdown(3_600_000)).toBe('1:00:00')
    expect(formatCountdown(3_661_000)).toBe('1:01:01')
    expect(formatCountdown(90_061_000)).toBe('25:01:01')
  })

  it('clamps non-finite and negative delays to zero', () => {
    expect(formatCountdown(-1)).toBe('00:00')
    expect(formatCountdown(Number.NaN)).toBe('00:00')
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('00:00')
  })
})

describe('phaseLabelKey', () => {
  it('maps every durable phase to its strip label key', () => {
    expect(phaseLabelKey('active')).toBe('phase.active')
    expect(phaseLabelKey('paused')).toBe('phase.paused')
    expect(phaseLabelKey('blocked')).toBe('phase.blocked')
    expect(phaseLabelKey('complete')).toBe('phase.complete')
  })
})

describe('describeSchedule', () => {
  const now = Date.UTC(2026, 0, 5, 12, 0, 0)

  it('counts down to the next eligible trigger once the interval elapsed', () => {
    const copy = describeSchedule(makeProjection({}, now - 120_000), now)
    expect(copy).toEqual({ key: 'nextRoundIn', params: { time: '00:00' } })
  })

  it('shows the configured interval while the last round is still fresh', () => {
    const copy = describeSchedule(makeProjection({}, now - 20_000), now)
    expect(copy).toEqual({ key: 'minInterval', params: { interval: '1m' } })
  })

  it('waits for the quiet window end instead of counting down', () => {
    const goal: Partial<InfiniGoalSnapshot> = {
      quietWindows: [{ days: [], start: '09:00', end: '18:00' }],
    }
    const copy = describeSchedule(makeProjection(goal, now - 120_000), now)
    expect(copy).toEqual({ key: 'waitingUntil', params: { time: '18:00' } })
  })

  it('renders no schedule line when the pacing policy leaves no eligible instant', () => {
    // `00:00-00:00` spans a whole local day: `planTrigger` throws RangeError.
    const goal: Partial<InfiniGoalSnapshot> = {
      quietWindows: [{ days: [], start: '00:00', end: '00:00' }],
    }
    expect(describeSchedule(makeProjection(goal), now)).toBeNull()
  })

  it('counts down past a future quiet window when no window contains now', () => {
    const goal: Partial<InfiniGoalSnapshot> = {
      quietWindows: [{ days: [], start: '13:00', end: '14:00' }],
    }
    const copy = describeSchedule(makeProjection(goal, now - 120_000), now)
    // Candidate 12:00 is eligible: not inside 13:00-14:00, so plain countdown.
    expect(copy).toEqual({ key: 'nextRoundIn', params: { time: '00:00' } })
  })
})

/**
 * Regression coverage for the schedule contract between `planTrigger` and the
 * strip: "a candidate deferred into a quiet window is a quiet-window wait, not
 * an interval wait". `describeSchedule` delegates to `planTrigger`, so these
 * assertions exercise the real shared math with only the rendering on top.
 */
describe('describeSchedule quiet-window precedence (time-zone aware)', () => {
  // Asia/Shanghai is UTC+8 all year, so this anchor is deterministic.
  const SHANGHAI = 'Asia/Shanghai'
  const atShanghai = (hour: number, minute = 0): number => Date.UTC(2026, 0, 5, hour - 8, minute)

  /** Two-hour interval with a daytime quiet window, the reported P1 settings. */
  const P1_SETTINGS: Partial<InfiniGoalSnapshot> = {
    minIntervalMs: 2 * 3_600_000,
    quietWindows: [{ days: [], start: '09:00', end: '18:00' }],
    timezone: SHANGHAI,
  }

  it('waits for a future quiet window that defers an interval-satisfied candidate', () => {
    // 08:00 local, last round now, 2h interval: the 10:00 candidate is quiet,
    // so the next eligible instant is the window end at 18:00 — not "2h".
    const now = atShanghai(8)
    const copy = describeSchedule(makeProjection(P1_SETTINGS, now), now)
    expect(copy).toEqual({ key: 'waitingUntil', params: { time: '18:00' } })
  })

  it('waits out a quiet window that contains the current instant', () => {
    // 12:00 local is inside 09:00-18:00 regardless of the interval.
    const now = atShanghai(12)
    const copy = describeSchedule(makeProjection(P1_SETTINGS, now - 3 * 3_600_000), now)
    expect(copy).toEqual({ key: 'waitingUntil', params: { time: '18:00' } })
  })

  it('shows the minimum interval when the interval is the binding constraint', () => {
    // 07:00 local, last round 30 minutes ago: the next candidate is 08:30,
    // before the quiet window starts, so the interval label is correct.
    const now = atShanghai(7)
    const copy = describeSchedule(makeProjection(P1_SETTINGS, now - 30 * 60_000), now)
    expect(copy).toEqual({ key: 'minInterval', params: { interval: '2h' } })
  })

  it('counts down when the next trigger is already eligible', () => {
    const now = atShanghai(7)
    const copy = describeSchedule(makeProjection(P1_SETTINGS, now - 3 * 3_600_000), now)
    expect(copy).toEqual({ key: 'nextRoundIn', params: { time: '00:00' } })
  })

  it('waits for the final eligible instant across consecutive quiet windows', () => {
    // The 10:00 candidate rolls through 09:00-18:00 and 18:00-20:00, so the
    // strip must name 20:00 (the last window end), not 18:00.
    const now = atShanghai(8)
    const settings: Partial<InfiniGoalSnapshot> = {
      minIntervalMs: 2 * 3_600_000,
      quietWindows: [
        { days: [], start: '09:00', end: '18:00' },
        { days: [], start: '18:00', end: '20:00' },
      ],
      timezone: SHANGHAI,
    }
    const copy = describeSchedule(makeProjection(settings, now), now)
    expect(copy).toEqual({ key: 'waitingUntil', params: { time: '20:00' } })
  })
})
