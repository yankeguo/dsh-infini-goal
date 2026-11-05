/**
 * Canonical model-facing output of the infini-goal tools.
 *
 * Every tool returns the same compact JSON value: the durable goal fields the
 * model needs to continue safely, plus the pacing facts from the core service's
 * trigger plan so the model can tell why the next automatic round is (not) due.
 *
 * @module @yankeguo/dsh-tool-infini-goal/value
 */

import type {
  InfiniGoalPhase,
  InfiniGoalView,
  TriggerPlan,
} from '@yankeguo/dsh-infini-goal-protocol'

/** Pacing facts for the next automatic round of the current goal. */
export interface InfiniGoalToolSchedule {
  /** Earliest instant (epoch milliseconds) at which the next round may start. */
  readonly nextTriggerAt: number
  /** Milliseconds from the plan's reference instant until {@link nextTriggerAt}. */
  readonly nextTriggerInMs: number
  /** End of the quiet window containing "now" (epoch milliseconds), or null when not quiet. */
  readonly quietUntil: number | null
}

/** Blocked explanation carried while the goal phase is `blocked`. */
export interface InfiniGoalToolBlockedReason {
  /** Stable machine classification. */
  readonly code: string
  /** Human-readable explanation. */
  readonly message: string
}

/** Compact durable goal fields returned to the model. */
export interface InfiniGoalToolGoal {
  /** Stable goal identity. */
  readonly id: string
  /** Positive revision; the exact value `update_infini_goal` requires. */
  readonly revision: number
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: InfiniGoalPhase
  /** Highest admitted automatic round number. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the latest admitted automatic round, or null before round 1. */
  readonly lastRoundAt: number | null
  /** Minimum milliseconds between two automatic round starts. */
  readonly minIntervalMs: number
  /** Local-time windows in which no automatic round starts. */
  readonly quietWindows: {
    readonly days: number[]
    readonly start: string
    readonly end: string
  }[]
  /** IANA time zone the quiet windows are interpreted in. */
  readonly timezone: string
  /** Present exactly while {@link phase} is `blocked`. */
  readonly blockedReason?: InfiniGoalToolBlockedReason
}

/** Canonical value returned by all three infini-goal tools. */
export type InfiniGoalToolValue =
  | { readonly goal: null }
  | { readonly goal: InfiniGoalToolGoal; readonly schedule: InfiniGoalToolSchedule | null }

/**
 * Project one trigger plan onto the compact schedule value.
 * @param plan - live plan for the current goal, or undefined when it cannot trigger.
 * @returns the schedule value, or null when no automatic round is planned.
 */
export function scheduleValue(plan: TriggerPlan | undefined): InfiniGoalToolSchedule | null {
  if (plan === undefined) return null
  return {
    nextTriggerAt: plan.nextAt,
    nextTriggerInMs: plan.delayMs,
    quietUntil: plan.quietUntil,
  }
}

/**
 * Project the live goal view and plan onto the canonical tool value.
 *
 * The schedule facts describe the next *automatic* round, so they are only
 * attached while the goal is active; a paused, blocked, or complete goal has no
 * planned trigger even when the pacing math could name one.
 * @param goal - current goal view, or undefined when no goal is set.
 * @param plan - live trigger plan for that goal, when one exists.
 * @returns the canonical JSON value.
 */
export function goalValue(
  goal: InfiniGoalView | undefined,
  plan: TriggerPlan | undefined,
): InfiniGoalToolValue {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      lastRoundAt: goal.lastRoundAt,
      minIntervalMs: goal.minIntervalMs,
      quietWindows: goal.quietWindows.map(window => ({
        days: [...window.days],
        start: window.start,
        end: window.end,
      })),
      timezone: goal.timezone,
      ...goal.blockedReason === undefined ? {} : {
        blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message },
      },
    },
    schedule: goal.phase === 'active' ? scheduleValue(plan) : null,
  }
}

/** Enforced JSON Schema of {@link InfiniGoalToolValue}. */
const SCHEDULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nextTriggerAt: { type: 'integer', required: true },
    nextTriggerInMs: { type: 'integer', required: true },
    quietUntil: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      required: true,
    },
  },
} as const

/** Enforced JSON Schema of one quiet window. */
const QUIET_WINDOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    days: { type: 'array', required: true, items: { type: 'integer' } },
    start: { type: 'string', required: true },
    end: { type: 'string', required: true },
  },
} as const

/** Enforced JSON Schema of one goal. */
const GOAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    objective: { type: 'string', required: true },
    phase: { type: 'string', required: true, enum: ['active', 'paused', 'blocked', 'complete'] },
    roundsStarted: { type: 'integer', required: true },
    lastRoundAt: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      required: true,
    },
    minIntervalMs: { type: 'integer', required: true },
    quietWindows: { type: 'array', required: true, items: QUIET_WINDOW_SCHEMA },
    timezone: { type: 'string', required: true },
    blockedReason: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

/** Enforced JSON Schema of {@link InfiniGoalToolValue}. */
export const GOAL_VALUE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'null', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { ...GOAL_SCHEMA, required: true },
        schedule: {
          oneOf: [{ ...SCHEDULE_SCHEMA }, { type: 'null' }],
          required: true,
        },
      },
    },
  ],
} as const

/** Shared canonical output declaration for all three infini-goal tools. */
export const GOAL_OUTPUT = {
  schema: GOAL_VALUE_SCHEMA,
  render: (_args: unknown, value: InfiniGoalToolValue) =>
    [{ type: 'text' as const, text: JSON.stringify(value) }],
}
