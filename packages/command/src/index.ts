/**
 * Human-facing `/infini-goal` command over the persisted same-session endless
 * goal: inspect status, create/edit, run lifecycle controls, and retune the
 * pacing configuration (minimum trigger interval, quiet windows, time zone).
 *
 * @module @yankeguo/dsh-command-infini-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { InfiniGoalError } from '@yankeguo/dsh-infini-goal'
// Type-only: pulls the core service's `ctx.infiniGoals` Context merge.
import type {} from '@yankeguo/dsh-infini-goal'
import { INFINI_GOAL_COMMAND_NAME } from '@yankeguo/dsh-infini-goal-protocol'
import type { InfiniGoalEditRequest, InfiniGoalRef, InfiniGoalView, TriggerPlan } from '@yankeguo/dsh-infini-goal-protocol'
import {
  COMMAND_GRAMMAR,
  CommandInputError,
  USAGE,
  parseInfiniGoalCommand,
  parseIntervalArgument,
  parseQuietArgument,
  parseTimezoneArgument,
} from './parse.ts'
import {
  errorResult,
  renderCleared,
  renderMutation,
  renderNote,
  renderStatus,
} from './render.ts'

/** Plugin name reported to the Cordis loader. */
export const name = 'command-infini-goal'

/** Services this plugin needs. */
export const inject = ['commands', 'infiniGoals']

const DESCRIPTION =
  'Inspect and control the endless infini-goal: create, edit, pause, resume, complete, block, clear, '
  + 'and set its pacing (minimum interval, quiet windows, time zone).'

const INPUT_HINT = COMMAND_GRAMMAR

/** One pacing-settings subcommand: its `/infini-goal` keyword and its human label. */
interface SettingsCommand {
  /** Exact subcommand keyword, used in hints and missing-goal errors. */
  readonly keyword: 'interval' | 'quiet' | 'timezone'
  /** Human label used in the success title. */
  readonly label: string
}

/**
 * Whether a thrown value is the core service's domain error. Checked
 * structurally as well as by class identity so a duplicated core module
 * instance (for example a deployment that loads the plugin from a second
 * node_modules copy) still maps to the friendly command error.
 */
function isInfiniGoalError(error: unknown): error is InfiniGoalError {
  if (error instanceof InfiniGoalError) return true
  if (!(error instanceof Error)) return false
  const candidate = error as unknown as { code?: unknown }
  return typeof candidate.code === 'string' && candidate.code.startsWith('INFINI_GOAL_')
}

/** Render one core domain failure as a friendly command error instead of a throw. */
function friendlyInfiniGoalError(error: InfiniGoalError): string {
  switch (error.code) {
    case 'INFINI_GOAL_NOT_FOUND':
      return 'No infini-goal is currently set. Start one with /infini-goal <objective>.'
    case 'INFINI_GOAL_ALREADY_EXISTS':
      return 'An infini-goal already exists. Run /infini-goal to inspect it, use /infini-goal edit <objective> '
        + 'to change it, or /infini-goal clear before replacing it.'
    case 'INFINI_GOAL_STALE_REVISION':
      return 'The infini-goal changed while this command was running. Run /infini-goal to view the current state, then retry.'
    case 'INFINI_GOAL_INVALID_TRANSITION':
      return 'The infini-goal cannot make that change from its current phase. Run /infini-goal to view the current state.'
    case 'INFINI_GOAL_INVALID_SETTINGS':
      return `Those pacing settings are not usable: ${error.message}`
    case 'INFINI_GOAL_INVALID_OBJECTIVE':
      return `The objective is not usable: ${error.message}`
    case 'INFINI_GOAL_INVALID_BLOCK_REASON':
      return `The blocking message is not usable: ${error.message}`
    case 'INFINI_GOAL_AGENT_NOT_LIVE':
      return 'This session is no longer live, so the infini-goal cannot be changed.'
    default:
      return `The infini-goal could not be updated: ${error.message}`
  }
}

/** Exact compare-and-set ref of one live goal view. */
function refOf(goal: InfiniGoalView): InfiniGoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** Live pacing plan of the current goal, when the agent still has one. */
function planOf(ctx: Context, invocation: CommandInvocation, goal: InfiniGoalView): TriggerPlan | undefined {
  return goal.phase === 'active' ? ctx.infiniGoals.plan(invocation.agent) : undefined
}

/** Friendly error for a command that needs a goal in the current session. */
function missingGoal(action: string): CommandResult {
  return errorResult(
    `No infini-goal is currently set; /infini-goal ${action} requires one. `
    + 'Start one with /infini-goal <objective>.',
  )
}

/** Execute `/infini-goal <objective>`. */
function executeCreate(ctx: Context, invocation: CommandInvocation, objective: string): CommandResult {
  const current = ctx.infiniGoals.get(invocation.agent)
  if (current !== undefined && current.phase !== 'complete') {
    return errorResult(
      `An infini-goal is already ${current.phase}. Run /infini-goal to inspect it, `
      + 'use /infini-goal edit <objective> to change it, or /infini-goal clear before replacing it.',
    )
  }
  const goal = ctx.infiniGoals.create(invocation.agent, { objective })
  return renderMutation('Infini-goal created', goal, planOf(ctx, invocation, goal))
}

/** Execute `/infini-goal edit <objective>`. */
function executeEdit(ctx: Context, invocation: CommandInvocation, objective: string): CommandResult {
  const current = ctx.infiniGoals.get(invocation.agent)
  if (current === undefined) return missingGoal('edit')
  if (current.phase === 'complete') {
    const created = ctx.infiniGoals.create(invocation.agent, { objective })
    return renderMutation('Infini-goal created', created, planOf(ctx, invocation, created))
  }
  const goal = ctx.infiniGoals.edit(invocation.agent, refOf(current), { objective })
  return renderMutation('Infini-goal updated', goal, planOf(ctx, invocation, goal))
}

/** Execute one lifecycle control. */
function executeLifecycle(
  ctx: Context,
  invocation: CommandInvocation,
  action: 'pause' | 'resume' | 'complete',
): CommandResult {
  const current = ctx.infiniGoals.get(invocation.agent)
  if (current === undefined) return missingGoal(action)
  const ref = refOf(current)
  const goal = action === 'pause'
    ? ctx.infiniGoals.pause(invocation.agent, ref)
    : action === 'resume'
      ? ctx.infiniGoals.resume(invocation.agent, ref)
      : ctx.infiniGoals.complete(invocation.agent, ref)
  const title = action === 'pause'
    ? 'Infini-goal paused'
    : action === 'resume'
      ? 'Infini-goal resumed'
      : 'Infini-goal completed'
  return renderMutation(title, goal, planOf(ctx, invocation, goal))
}

/** Execute `/infini-goal block <message>`. */
function executeBlock(ctx: Context, invocation: CommandInvocation, message: string): CommandResult {
  const current = ctx.infiniGoals.get(invocation.agent)
  if (current === undefined) return missingGoal('block')
  const goal = ctx.infiniGoals.block(invocation.agent, refOf(current), {
    code: 'human-reported',
    message,
  })
  return renderMutation('Infini-goal blocked', goal, planOf(ctx, invocation, goal))
}

/** Execute `/infini-goal clear`. */
function executeClear(ctx: Context, invocation: CommandInvocation): CommandResult {
  const current = ctx.infiniGoals.get(invocation.agent)
  if (current === undefined) return renderNote('No infini-goal to clear.')
  ctx.infiniGoals.clear(invocation.agent, refOf(current))
  return renderCleared()
}

/** Execute one pacing-settings edit. */
function executeSettings(
  ctx: Context,
  invocation: CommandInvocation,
  command: SettingsCommand,
  request: InfiniGoalEditRequest,
): CommandResult {
  const current = ctx.infiniGoals.get(invocation.agent)
  if (current === undefined) return missingGoal(command.keyword)
  if (current.phase === 'complete') {
    return errorResult(
      'The infini-goal is complete, so its pacing can no longer matter. '
      + 'Start a new goal with /infini-goal <objective> and then configure its pacing.',
    )
  }
  const goal = ctx.infiniGoals.edit(invocation.agent, refOf(current), request)
  return renderMutation(`Infini-goal ${command.label} updated`, goal, planOf(ctx, invocation, goal))
}

/** Execute one already-parsed command against the core service. */
function executeInfiniGoalCommand(ctx: Context, invocation: CommandInvocation): CommandResult {
  const command = parseInfiniGoalCommand(invocation.rawInput)
  if (invocation.attachments.length > 0) {
    return errorResult(
      'The /infini-goal command does not accept attachments; describe the objective in the command text instead.',
    )
  }
  if (command.kind === 'invalid') return errorResult(`${command.message}\n${USAGE}`)
  try {
    switch (command.kind) {
      case 'status': {
        const goal = ctx.infiniGoals.get(invocation.agent)
        return renderStatus(
          goal,
          goal === undefined ? undefined : ctx.infiniGoals.plan(invocation.agent),
        )
      }
      case 'create':
        return executeCreate(ctx, invocation, command.objective)
      case 'edit':
        return executeEdit(ctx, invocation, command.objective)
      case 'pause':
      case 'resume':
      case 'complete':
        return executeLifecycle(ctx, invocation, command.kind)
      case 'block':
        return executeBlock(ctx, invocation, command.message)
      case 'clear':
        return executeClear(ctx, invocation)
      case 'interval':
        return executeSettings(ctx, invocation, { keyword: 'interval', label: 'minimum interval' }, {
          minIntervalMs: parseIntervalArgument(command.duration),
        })
      case 'quiet':
        return executeSettings(ctx, invocation, { keyword: 'quiet', label: 'quiet windows' }, {
          quietWindows: parseQuietArgument(command.windows),
        })
      case 'timezone':
        return executeSettings(ctx, invocation, { keyword: 'timezone', label: 'time zone' }, {
          timezone: parseTimezoneArgument(command.timezone),
        })
    }
  } catch (error: unknown) {
    if (error instanceof CommandInputError) return errorResult(`${error.message}\n${USAGE}`)
    if (isInfiniGoalError(error)) return errorResult(friendlyInfiniGoalError(error))
    throw error
  }
}

/** Register the `/infini-goal` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@yankeguo/dsh-command-infini-goal'),
    name: INFINI_GOAL_COMMAND_NAME,
    description: DESCRIPTION,
    input: { hint: INPUT_HINT },
    handler: invocation => executeInfiniGoalCommand(ctx, invocation),
  })
}
