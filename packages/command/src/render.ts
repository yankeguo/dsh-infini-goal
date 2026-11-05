/**
 * Pure human-facing rendering for the `/infini-goal` command.
 *
 * The status view always states the pacing facts a human needs to understand
 * why the goal is not visibly running: the next trigger in the goal's own time
 * zone, and — inside a quiet window — that the goal is waiting for assigned
 * work until the window ends.
 *
 * @module @yankeguo/dsh-command-infini-goal/render
 */

import {
  formatDurationMs,
  formatQuietWindows,
  formatZonedDateTime,
} from '@yankeguo/dsh-infini-goal-protocol'
import type { InfiniGoalPhase, InfiniGoalView, TriggerPlan } from '@yankeguo/dsh-infini-goal-protocol'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

/** Human label for one durable goal phase. */
export function phaseLabel(phase: InfiniGoalPhase): string {
  switch (phase) {
    case 'active': return 'active'
    case 'paused': return 'paused'
    case 'blocked': return 'blocked'
    case 'complete': return 'complete'
  }
}

/** Commands that are meaningful from one exact live phase. */
export function lifecycleHint(goal: InfiniGoalView): string {
  switch (goal.phase) {
    case 'active':
      return '/infini-goal edit <objective>, /infini-goal pause, /infini-goal complete, '
        + '/infini-goal block <message>, /infini-goal clear'
    case 'paused':
    case 'blocked':
      return '/infini-goal edit <objective>, /infini-goal resume, /infini-goal complete, /infini-goal clear'
    case 'complete':
      return '/infini-goal <objective>, /infini-goal clear'
  }
}

/** Settings subcommands, meaningful from any non-complete phase. */
export function settingsHint(): string {
  return '/infini-goal interval <duration>, /infini-goal quiet <windows|none>, '
    + '/infini-goal timezone <IANA|system>'
}

/**
 * Whether the plan's next trigger lies past the earliest interval-satisfying
 * instant, which — under the shared pacing policy — can only happen when a
 * quiet window deferred it. This is a defensive fallback for plans that report
 * the interval reason while a quiet window is actually the cause; the current
 * contract already returns `reason === 'quiet-window'` with `quietUntil` set.
 * @param goal - current goal.
 * @param plan - live trigger plan.
 * @returns true when a quiet window, not the interval, pushed the trigger.
 */
function deferredByQuietWindow(goal: InfiniGoalView, plan: TriggerPlan): boolean {
  const intervalEarliest = goal.lastRoundAt === null ? plan.now : goal.lastRoundAt + goal.minIntervalMs
  return plan.nextAt > Math.max(plan.now, intervalEarliest)
}

/**
 * Render the pacing lines of one active goal: the next eligible trigger in the
 * goal's local time zone, and the quiet-window waiting state.
 * @param goal - current goal.
 * @param plan - live trigger plan, when the service returned one.
 * @returns zero or more status lines.
 */
export function planLines(goal: InfiniGoalView, plan: TriggerPlan | undefined): string[] {
  if (goal.phase !== 'active') return []
  if (plan === undefined) return ['Next trigger: pending the next automatic round']
  const nextAt = formatZonedDateTime(goal.timezone, plan.nextAt)
  const lines = [
    plan.reason === 'ready'
      ? `Next trigger: ${nextAt} (ready now)`
      : `Next trigger: ${nextAt} (in ${formatDurationMs(plan.delayMs)})`,
  ]
  const quietEnd = plan.quietUntil
    ?? (deferredByQuietWindow(goal, plan) ? plan.nextAt : null)
  if (quietEnd !== null) {
    lines.push(
      `Automatic rounds are suppressed until ${formatZonedDateTime(goal.timezone, quietEnd)}`
      + ` (quiet window; time zone ${goal.timezone}).`,
    )
  }
  return lines
}

/**
 * Render the shared body of a goal status view.
 * @param goal - current goal.
 * @param plan - live trigger plan, when the service returned one.
 * @returns the status lines without a title.
 */
export function goalStatusLines(goal: InfiniGoalView, plan: TriggerPlan | undefined): string[] {
  const lines = [`Status: ${phaseLabel(goal.phase)}`]
  if (goal.phase === 'blocked' && goal.blockedReason !== undefined) {
    lines.push(`Blocker: ${goal.blockedReason.code}: ${goal.blockedReason.message}`)
  }
  lines.push(
    `Objective: ${goal.objective}`,
    `Rounds started: ${goal.roundsStarted}`,
    `Min interval: ${formatDurationMs(goal.minIntervalMs)}`,
    `Quiet windows: ${formatQuietWindows(goal.quietWindows)} (${goal.timezone})`,
    ...planLines(goal, plan),
  )
  return lines
}

/** Render the command hints that are valid for one phase. */
function hints(goal: InfiniGoalView): string[] {
  return [
    `Commands: ${lifecycleHint(goal)}`,
    ...goal.phase === 'complete' ? [] : [`Settings: ${settingsHint()}`],
  ]
}

/** Rendered result when no infini-goal exists. */
export function renderNoGoal(): CommandResult {
  return {
    kind: 'success',
    text: [
      'No infini-goal is currently set.',
      'Start one with: /infini-goal <objective>',
    ].join('\n'),
  }
}

/**
 * Render the current status.
 * @param goal - current goal, or undefined when none is set.
 * @param plan - live trigger plan, when the service returned one.
 * @returns a successful status result.
 */
export function renderStatus(goal: InfiniGoalView | undefined, plan: TriggerPlan | undefined): CommandResult {
  if (goal === undefined) return renderNoGoal()
  return {
    kind: 'success',
    text: ['Infini-goal status', ...goalStatusLines(goal, plan), '', ...hints(goal)].join('\n'),
  }
}

/**
 * Render a successful mutation followed by the new state.
 * @param title - one-line outcome such as `Infini-goal paused`.
 * @param goal - post-mutation goal.
 * @param plan - post-mutation trigger plan, when the service returned one.
 * @returns a successful result.
 */
export function renderMutation(
  title: string,
  goal: InfiniGoalView,
  plan: TriggerPlan | undefined,
): CommandResult {
  return {
    kind: 'success',
    text: [title, ...goalStatusLines(goal, plan), '', ...hints(goal)].join('\n'),
  }
}

/** Rendered result after a clear tombstone is written. */
export function renderCleared(): CommandResult {
  return { kind: 'success', text: 'Infini-goal cleared.' }
}

/** Render one requested change with no new durable goal state to show. */
export function renderNote(text: string): CommandResult {
  return { kind: 'success', text }
}

/**
 * Render a friendly command error.
 * @param text - explanation shown to the human.
 * @returns an error result rather than a thrown failure.
 */
export function errorResult(text: string): CommandResult {
  return { kind: 'error', text }
}
