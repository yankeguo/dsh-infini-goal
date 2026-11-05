import { describe, expect, it } from 'vitest'
import type { InfiniGoalView, TriggerPlan } from '@yankeguo/dsh-infini-goal-protocol'
import { GOAL_OUTPUT, goalValue, scheduleValue } from '../src/value.ts'

const NOW = Date.UTC(2026, 10, 5, 2, 0, 0)

/** Build one live goal view. */
function goal(overrides: Partial<InfiniGoalView> = {}): InfiniGoalView {
  return {
    id: 'goal-1',
    revision: 3,
    objective: 'Ship the docs',
    phase: 'active',
    roundsStarted: 2,
    lastRoundAt: NOW - 60_000,
    minIntervalMs: 300_000,
    quietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
    timezone: 'Asia/Shanghai',
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  }
}

/** Build one trigger plan. */
function plan(overrides: Partial<TriggerPlan> = {}): TriggerPlan {
  return {
    now: NOW,
    nextAt: NOW + 240_000,
    quietUntil: null,
    delayMs: 240_000,
    reason: 'interval',
    ...overrides,
  }
}

describe('scheduleValue', () => {
  it('projects a plan onto the compact schedule facts', () => {
    expect(scheduleValue(plan())).toEqual({
      nextTriggerAt: NOW + 240_000,
      nextTriggerInMs: 240_000,
      quietUntil: null,
    })
  })

  it('keeps the quiet-window end', () => {
    expect(scheduleValue(plan({ quietUntil: NOW + 7_200_000 }))?.quietUntil).toBe(NOW + 7_200_000)
  })

  it('returns null without a plan', () => {
    expect(scheduleValue(undefined)).toBeNull()
  })
})

describe('goalValue', () => {
  it('renders the empty value', () => {
    expect(goalValue(undefined, undefined)).toEqual({ goal: null })
  })

  it('renders the durable goal fields and a null schedule without a plan', () => {
    const value = goalValue(goal(), undefined)
    expect(value).toEqual({
      goal: {
        id: 'goal-1',
        revision: 3,
        objective: 'Ship the docs',
        phase: 'active',
        roundsStarted: 2,
        lastRoundAt: NOW - 60_000,
        minIntervalMs: 300_000,
        quietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
        timezone: 'Asia/Shanghai',
      },
      schedule: null,
    })
  })

  it('attaches the schedule facts when a plan exists', () => {
    const value = goalValue(goal(), plan())
    if (value.goal === null) throw new Error('expected a goal')
    expect(value.schedule).toEqual({
      nextTriggerAt: NOW + 240_000,
      nextTriggerInMs: 240_000,
      quietUntil: null,
    })
  })

  it('has no planned trigger outside the active phase', () => {
    const value = goalValue(goal({ phase: 'paused' }), plan())
    if (value.goal === null) throw new Error('expected a goal')
    expect(value.schedule).toBeNull()
  })

  it('carries the blocked reason while blocked', () => {
    const value = goalValue(
      goal({ phase: 'blocked', blockedReason: { code: 'model-reported', message: 'credentials expired' } }),
      undefined,
    )
    expect(value.goal).not.toBeNull()
    expect(value.goal !== null && 'blockedReason' in value.goal ? value.goal.blockedReason : undefined)
      .toEqual({ code: 'model-reported', message: 'credentials expired' })
  })

  it('does not share the quiet-window arrays with the live view', () => {
    const live = goal()
    const value = goalValue(live, undefined)
    expect(value.goal).not.toBeNull()
    if (value.goal === null) throw new Error('unreachable')
    expect(value.goal.quietWindows).not.toBe(live.quietWindows)
    expect(value.goal.quietWindows[0]).not.toBe(live.quietWindows[0])
  })
})

describe('GOAL_OUTPUT', () => {
  it('renders the canonical value as compact JSON text', () => {
    const value = goalValue(goal(), plan())
    expect(GOAL_OUTPUT.render(undefined, value)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
  })

  it('declares the empty and populated result shapes', () => {
    expect(GOAL_OUTPUT.schema.oneOf).toHaveLength(2)
  })
})
