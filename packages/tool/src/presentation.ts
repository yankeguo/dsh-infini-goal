/**
 * Pure pending-call presentation for the infini-goal tools.
 *
 * `presentCall` must stay replay-safe: it depends only on the parsed call
 * arguments, never on service state, so a session-log replay renders the same
 * card as the live stream.
 *
 * @module @yankeguo/dsh-tool-infini-goal/presentation
 */

import type { GenericCallView, ToolCallKind } from '@deepseek-ai/dsh-tools'
import { hasText } from './arguments.ts'
import type { UpdateAction, UpdateInfiniGoalToolArgs } from './arguments.ts'

/** Build one generic pending card. */
export function present(title: string, kind: ToolCallKind, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Human label for one update action. */
function actionLabel(action: UpdateAction): string {
  switch (action) {
    case 'edit': return 'Edit infini-goal'
    case 'pause': return 'Pause infini-goal'
    case 'resume': return 'Resume infini-goal'
    case 'complete': return 'Complete infini-goal'
    case 'blocked': return 'Block infini-goal'
    case 'config': return 'Configure infini-goal'
  }
}

/** The most salient input of one update call, for the expanded card. */
function actionRawInput(args: UpdateInfiniGoalToolArgs): unknown {
  if (args.action === 'blocked' && hasText(args.blocked_reason)) return args.blocked_reason
  if ((args.action === 'edit' || args.action === 'config') && hasText(args.objective)) return args.objective
  if ((args.action === 'edit' || args.action === 'config') && hasText(args.min_interval)) return args.min_interval
  if ((args.action === 'edit' || args.action === 'config') && hasText(args.quiet_windows)) return args.quiet_windows
  if ((args.action === 'edit' || args.action === 'config') && hasText(args.timezone)) return args.timezone
  return args.goal_id
}

/**
 * Build the pending card for one `update_infini_goal` call.
 * @param args - validated update arguments.
 * @returns the generic call view.
 */
export function presentUpdateCall(args: UpdateInfiniGoalToolArgs): GenericCallView {
  return present(actionLabel(args.action), 'other', actionRawInput(args))
}
