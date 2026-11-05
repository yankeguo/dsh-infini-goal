import { describe, expect, it } from 'vitest'
import { planTrigger } from '@yankeguo/dsh-infini-goal-protocol'
import type { InfiniGoalView, TriggerPlan } from '@yankeguo/dsh-infini-goal-protocol'
import {
  goalStatusLines,
  lifecycleHint,
  phaseLabel,
  planLines,
  renderCleared,
  renderMutation,
  renderNoGoal,
  renderStatus,
} from '../src/render.ts'

/** Thursday 2026-11-05 10:00 in Asia/Shanghai (02:00 UTC). */
const NOW = Date.UTC(2026, 10, 5, 2, 0, 0)

/** Build one live goal view with deterministic defaults. */
function goal(overrides: Partial<InfiniGoalView> = {}): InfiniGoalView {
  return {
    id: 'goal-1',
    revision: 3,
    objective: 'Ship the docs',
    phase: 'active',
    roundsStarted: 2,
    lastRoundAt: NOW - 60_000,
    minIntervalMs: 300_000,
    quietWindows: [],
    timezone: 'Asia/Shanghai',
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  }
}

/** Plan one goal exactly as the command reads it from the service. */
function planOf(current: InfiniGoalView, now = NOW): TriggerPlan {
  return planTrigger(current, current.lastRoundAt, now)
}

describe('phaseLabel', () => {
  it('renders every phase', () => {
    expect(phaseLabel('active')).toBe('active')
    expect(phaseLabel('paused')).toBe('paused')
    expect(phaseLabel('blocked')).toBe('blocked')
    expect(phaseLabel('complete')).toBe('complete')
  })
})

describe('planLines', () => {
  it('renders the next trigger in the goal time zone while waiting on the interval', () => {
    const current = goal()
    expect(planLines(current, planOf(current))).toEqual([
      'Next trigger: 2026-11-05 10:04 (in 4m)',
    ])
  })

  it('renders the ready state once the interval has elapsed', () => {
    const current = goal({ lastRoundAt: NOW - 600_000 })
    const plan = planOf(current)
    expect(plan.reason).toBe('ready')
    expect(planLines(current, plan)).toEqual(['Next trigger: 2026-11-05 10:00 (ready now)'])
  })

  it('says the goal is waiting for assigned work inside a quiet window', () => {
    const current = goal({
      lastRoundAt: null,
      quietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }],
    })
    const plan = planOf(current)
    expect(plan.reason).toBe('quiet-window')
    expect(plan.quietUntil).toBe(Date.UTC(2026, 10, 5, 4, 0, 0))
    expect(planLines(current, plan)).toEqual([
      'Next trigger: 2026-11-05 12:00 (in 2h)',
      'Waiting for assigned work until 2026-11-05 12:00 (quiet window; time zone Asia/Shanghai).',
    ])
  })

  it('renders nothing for a non-active goal', () => {
    expect(planLines(goal({ phase: 'paused' }), undefined)).toEqual([])
    expect(planLines(goal({ phase: 'complete' }), undefined)).toEqual([])
  })

  it('explains a missing plan for an active goal', () => {
    expect(planLines(goal(), undefined)).toEqual(['Next trigger: pending the next automatic round'])
  })
})

describe('goalStatusLines', () => {
  it('renders the durable fields of an active goal', () => {
    const current = goal()
    expect(goalStatusLines(current, planOf(current))).toEqual([
      'Status: active',
      'Objective: Ship the docs',
      'Rounds started: 2',
      'Min interval: 5m',
      'Quiet windows: none (Asia/Shanghai)',
      'Next trigger: 2026-11-05 10:04 (in 4m)',
    ])
  })

  it('renders a blocked reason next to the status', () => {
    const current = goal({
      phase: 'blocked',
      blockedReason: { code: 'agent-error', message: 'the model backend failed' },
    })
    expect(goalStatusLines(current, undefined)).toEqual([
      'Status: blocked',
      'Blocker: agent-error: the model backend failed',
      'Objective: Ship the docs',
      'Rounds started: 2',
      'Min interval: 5m',
      'Quiet windows: none (Asia/Shanghai)',
    ])
  })
})

describe('renderStatus', () => {
  it('states the empty case and how to start', () => {
    const result = renderStatus(undefined, undefined)
    expect(result).toEqual(renderNoGoal())
    expect(result.kind).toBe('success')
    expect(result.text).toContain('No infini-goal is currently set.')
    expect(result.text).toContain('/infini-goal <objective>')
  })

  it('renders a full active status with lifecycle and settings hints', () => {
    const current = goal()
    const result = renderStatus(current, planOf(current))
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Infini-goal status')
    expect(result.text).toContain('Status: active')
    expect(result.text).toContain('Objective: Ship the docs')
    expect(result.text).toContain('Rounds started: 2')
    expect(result.text).toContain('Min interval: 5m')
    expect(result.text).toContain('Quiet windows: none (Asia/Shanghai)')
    expect(result.text).toContain('Next trigger: 2026-11-05 10:04 (in 4m)')
    expect(result.text).toContain('Commands: /infini-goal edit <objective>, /infini-goal pause')
    expect(result.text).toContain('Settings: /infini-goal interval <duration>')
  })

  it('offers resume for paused and blocked goals and a replacement for complete goals', () => {
    const paused = renderStatus(goal({ phase: 'paused' }), undefined)
    expect(paused.text).toContain('Status: paused')
    expect(paused.text).toContain('/infini-goal resume')
    const complete = renderStatus(goal({ phase: 'complete' }), undefined)
    expect(complete.text).toContain('Status: complete')
    expect(complete.text).toContain('/infini-goal <objective>')
    expect(complete.text).not.toContain('Settings:')
  })

  it('renders the waiting state for a goal inside a quiet window', () => {
    const current = goal({
      lastRoundAt: null,
      quietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }],
    })
    const result = renderStatus(current, planOf(current))
    expect(result.text).toContain(
      'Waiting for assigned work until 2026-11-05 12:00 (quiet window; time zone Asia/Shanghai).',
    )
  })
})

describe('renderMutation', () => {
  it('renders the outcome followed by the new state', () => {
    const current = goal({ phase: 'paused' })
    const result = renderMutation('Infini-goal paused', current, undefined)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Infini-goal paused')
    expect(result.text).toContain('Status: paused')
    expect(result.text).toContain('Commands: /infini-goal edit <objective>, /infini-goal resume')
  })
})

describe('renderCleared', () => {
  it('renders the clear outcome', () => {
    expect(renderCleared()).toEqual({ kind: 'success', text: 'Infini-goal cleared.' })
  })
})

describe('lifecycleHint', () => {
  it('lists only valid lifecycle commands per phase', () => {
    expect(lifecycleHint(goal({ phase: 'active' }))).toContain('/infini-goal pause')
    expect(lifecycleHint(goal({ phase: 'paused' }))).toContain('/infini-goal resume')
    expect(lifecycleHint(goal({ phase: 'blocked' }))).toContain('/infini-goal resume')
    expect(lifecycleHint(goal({ phase: 'complete' }))).not.toContain('/infini-goal resume')
  })
})
