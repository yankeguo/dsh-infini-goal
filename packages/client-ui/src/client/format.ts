/**
 * Pure presentation helpers for the InfiniGoalBar dock. Kept free of React and
 * platform-module imports so the countdown math can be unit-tested in Node.
 *
 * The trigger plan itself comes from the shared protocol package: the browser
 * and the host driver must agree byte-for-byte on when the next automatic round
 * becomes eligible, so the countdown is never re-implemented here.
 */

import {
  formatDurationMs,
  formatZonedClock,
  planTrigger,
} from '@yankeguo/dsh-infini-goal-protocol/client'
import type { InfiniGoalPhase, InfiniGoalProjection } from '@yankeguo/dsh-infini-goal-protocol/client'

/** Dictionary key of the phase label for one durable phase. */
export type PhaseLabelKey = 'phase.active' | 'phase.paused' | 'phase.blocked' | 'phase.complete'

/** Dictionary key of the live schedule label, one per trigger-plan reason. */
export type ScheduleCopyKey = 'nextRoundIn' | 'waitingUntil' | 'minInterval'

/** One rendered schedule label: dictionary key plus its template parameters. */
export interface ScheduleCopy {
  /** Dictionary key of the label. */
  readonly key: ScheduleCopyKey
  /** Template parameters interpolated by the locale runtime. */
  readonly params: Readonly<Record<string, string>>
}

/**
 * Map one durable phase to its localized strip label.
 * @param phase - durable goal phase.
 * @returns the phase's dictionary key.
 */
export function phaseLabelKey(phase: InfiniGoalPhase): PhaseLabelKey {
  switch (phase) {
    case 'active':
      return 'phase.active'
    case 'paused':
      return 'phase.paused'
    case 'blocked':
      return 'phase.blocked'
    case 'complete':
      return 'phase.complete'
  }
}

/**
 * Render a non-negative millisecond delay as a countdown clock.
 *
 * `mm:ss` below one hour and `h:mm:ss` from one hour up, so a countdown pushed
 * past a quiet window stays readable instead of growing minutes into the
 * thousands. Sub-second remainders truncate toward zero; negative input clamps
 * to zero.
 * @param delayMs - remaining milliseconds.
 * @returns the formatted countdown.
 */
export function formatCountdown(delayMs: number): string {
  const totalSeconds = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs / 1_000)) : 0
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/**
 * Describe the live schedule line of an active goal at one instant.
 *
 * Precedence mirrors what the driver would do:
 * 1. inside a quiet window, no automatic round starts until the window ends
 *    (`waitingUntil`, rendered in the goal's own time zone);
 * 2. while the minimum interval has not elapsed, the configured interval is
 *    shown (`minInterval`);
 * 3. otherwise the remaining delay to the next eligible trigger is counted
 *    down (`nextRoundIn`).
 *
 * A misconfigured pacing policy that leaves no eligible instant makes
 * `planTrigger` throw; the dock then renders no schedule line rather than
 * crashing the composer.
 * @param projection - the current projected goal and its round counters.
 * @param now - current instant in epoch milliseconds.
 * @returns the schedule label, or null when none can be computed.
 */
export function describeSchedule(projection: InfiniGoalProjection, now: number): ScheduleCopy | null {
  const goal = projection.goal
  try {
    const plan = planTrigger(goal, projection.lastRoundAt, now)
    if (plan.quietUntil !== null) {
      return {
        key: 'waitingUntil',
        params: { time: formatZonedClock(goal.timezone, plan.quietUntil) },
      }
    }
    if (plan.reason === 'interval') {
      return {
        key: 'minInterval',
        params: { interval: formatDurationMs(goal.minIntervalMs) },
      }
    }
    return { key: 'nextRoundIn', params: { time: formatCountdown(plan.delayMs) } }
  } catch {
    return null
  }
}
