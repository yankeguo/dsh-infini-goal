/**
 * Model-visible wrap-up instruction for a terminal autonomous infini-goal update.
 *
 * Mutating the goal to `complete` or `blocked` from inside an automatic round
 * would otherwise end the turn without addressing the user. The deferred
 * context tells the model to write that closing message instead of stopping.
 *
 * @module @yankeguo/dsh-tool-infini-goal/wrapup
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const GROUNDING =
  'Report only what earlier rounds and tool results in this session actually establish; '
  + 'when a detail is not in the session, say so instead of inventing it. '

/**
 * Render the closing-message instruction injected after an autonomous
 * infini-goal round reports `complete` or `blocked`.
 * @param objective - the terminal goal's objective, echoed for grounding.
 * @param blockedReason - the validated report for `blocked`; omitted for `complete`.
 * @returns a fresh one-block context for `ToolRunContext.deferContext()`.
 */
export function renderWrapupContext(objective: string, blockedReason?: string): ContentBlock[] {
  const heading = `Objective: ${JSON.stringify(objective)}\n`
  const text = blockedReason === undefined
    ? '<infini_goal_complete>\n'
      + heading
      + 'The infini-goal is marked complete and this autonomous run is ending. Write the closing '
      + 'message to the user now: state the outcome, summarize what was done and how it was '
      + 'verified, and point to the concrete results (files, commits, or other artifacts). '
      + GROUNDING
      + 'Note anything the user should review or do next. Address the user directly. Do not '
      + "call any more tools in this run; further work waits for the user's next instruction.\n"
      + '</infini_goal_complete>'
    : '<infini_goal_blocked>\n'
      + heading
      + `Blocked: ${JSON.stringify(blockedReason)}\n`
      + 'The infini-goal is marked blocked and this autonomous run is ending. Write the closing '
      + 'message to the user now: state what has been completed so far, describe the concrete '
      + 'blocking condition and what you tried, and say exactly what you need from the user to '
      + 'continue. '
      + GROUNDING
      + 'Address the user directly. Do not call any more tools in this run; further work '
      + "waits for the user's next instruction.\n"
      + '</infini_goal_blocked>'
  return [{ type: 'text', text }]
}
