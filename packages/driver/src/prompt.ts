/**
 * Model-visible continuation prompt for one automatic infini-goal round.
 *
 * @module @yankeguo/dsh-infini-goal-driver
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { formatDurationMs, formatQuietWindows } from '@yankeguo/dsh-infini-goal-protocol'
import type { InfiniGoalView } from '@yankeguo/dsh-infini-goal-protocol'

/**
 * Render the complete round instruction retained in Session history.
 * @param goal - exact active goal revision being admitted.
 * @param round - next positive round number.
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export function renderInfiniGoalRoundPrompt(goal: InfiniGoalView, round: number): ContentBlock[] {
  const quiet = formatQuietWindows(goal.quietWindows)
  return [{
    type: 'text',
    text: '<infini_goal_round>\n'
      + `Objective: ${JSON.stringify(goal.objective)}\n`
      + `Round: ${round} (there is no round limit; the goal stays active until it is completed, paused, blocked, or cleared)\n`
      + `Automatic pacing: rounds are spaced by at least ${formatDurationMs(goal.minIntervalMs)}; `
      + `no automatic round starts inside the quiet windows ${JSON.stringify(quiet)} (time zone ${goal.timezone}). `
      + 'A quiet window only suppresses automatic rounds; it is neither a failure nor a blocker.\n\n'
      + 'Continue working toward the objective in this same session. Treat the current workspace, tool results, '
      + 'and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. '
      + 'Make concrete progress and verify the result instead of only restating plans. Human messages that arrived '
      + 'between rounds take priority over this round: address them first, and never invent progress that the '
      + 'session does not show.\n'
      + 'Before claiming completion, gather evidence that the whole objective is achieved, read the current goal '
      + 'with get_infini_goal, and mark it complete with update_infini_goal action "complete" using the current '
      + 'goal id and revision. If work remains, leave the goal active for the next round; do not create a new '
      + 'infini-goal. If the same concrete blocking condition persisted across earlier rounds, follow the '
      + 'configured goal-tool policy before reporting a blocker with update_infini_goal action "blocked"; '
      + 'difficulty, uncertainty, or remaining useful work is not a blocker.\n'
      + '</infini_goal_round>',
  }]
}
