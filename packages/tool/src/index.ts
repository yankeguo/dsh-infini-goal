/**
 * Model-facing `get_infini_goal`, `create_infini_goal`, and `update_infini_goal`
 * tools over the persisted same-session endless goal.
 *
 * The tools mirror the official `tool-goal` surface, extended with the pacing
 * configuration the infini-goal domain owns: a minimum trigger interval and
 * local-time quiet windows (automatic-round suppression) instead of a round cap.
 *
 * @module @yankeguo/dsh-tool-infini-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { InfiniGoalError } from '@yankeguo/dsh-infini-goal'
// Type-only: pulls the core service's `ctx.infiniGoals` Context merge.
import type {} from '@yankeguo/dsh-infini-goal'
import type { InfiniGoalView } from '@yankeguo/dsh-infini-goal-protocol'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Closing-message instruction deferred by a terminal infini-goal round update. */
    'tool-infini-goal': { kind: 'tool-infini-goal' } & ContextFormed
  }
}

import {
  InfiniGoalToolInputError,
  UPDATE_ACTIONS,
  blockedReasonFromArgs,
  createRequestFromArgs,
  editRequestFromArgs,
  goalRefFromArgs,
} from './arguments.ts'
import { completionAuthority, infiniGoalToolExecution, requireDirectHuman } from './authority.ts'
import { present, presentUpdateCall } from './presentation.ts'
import { GOAL_OUTPUT, goalValue } from './value.ts'
import type { InfiniGoalToolValue } from './value.ts'
import { renderWrapupContext } from './wrapup.ts'

/** Plugin name reported to the Cordis loader. */
export const name = 'tool-infini-goal'

/** Services this plugin needs. */
export const inject = ['agents', 'infiniGoals', 'tools', 'systemPrompt']

/** Model policy for autonomous goal-state updates. */
export interface Config {
  /** Minimum admitted goal rounds before the model may self-report `blocked`. */
  blockedAfterConsecutiveRounds?: number
}

/** Schemastery config for the infini-goal tool policy. */
export const Config: z<Config> = z.object({
  blockedAfterConsecutiveRounds: z.number().step(1).min(1).default(3),
})

/** Fully materialized tool policy. */
interface ResolvedConfig {
  readonly blockedAfterConsecutiveRounds: number
}

const CREATE_DESCRIPTION =
  'Create a persisted infini-goal that keeps this session working across automatic continuation rounds. '
  + 'Use it when the direct human request is a long-running objective, even if the user did not say "goal"; '
  + 'not for single-turn work. Automatic rounds have no round cap: the goal stays active until it is '
  + 'paused, blocked, completed, or cleared, paced by the minimum interval and suppressed inside the quiet '
  + 'windows. Requires a direct human request.'

const GET_DESCRIPTION =
  'Read the current infini-goal, including the id and revision that update_infini_goal requires, its pacing '
  + 'configuration, and when the next automatic round may start (or whether it is waiting inside a quiet window).'

/** Render policy guidance with its deployment-selected blocked threshold. */
function guidance(blockedAfter: number): string {
  return 'An infini-goal is a persisted, endless continuation target for this session. Unlike a plain goal it has '
    + 'no round cap: while its phase is active the harness keeps starting automatic continuation rounds until it '
    + 'is paused, blocked, completed, or cleared. Two pacing rules shape that autonomy: automatic rounds are spaced '
    + 'by a minimum trigger interval, and no automatic round starts inside the configured local-time quiet windows. '
    + 'A quiet window is a configured local-time period in which the goal stays active, human turns and tools run '
    + 'normally, and the model simply does not self-start another round; never treat that silence as failure or '
    + 'as a blocker. '
    + 'create_infini_goal may infer goal intent from a direct human request in any language. '
    + 'update_infini_goal action edit, pause, resume, and config require a direct human request. '
    + 'complete and blocked are also allowed during an exact automatic round of the current goal. '
    + 'Mark complete only when the objective is actually achieved, and report the evidence you verified. '
    + `Mark blocked only after the same concrete blocking condition persists for at least ${blockedAfter} `
    + 'consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, '
    + 'or useful remaining work is not blocked. After pause, block, or complete the goal stops starting rounds '
    + 'on its own: resume only on a direct human request.'
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const blockedAfter = config.blockedAfterConsecutiveRounds ?? 3
  if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) {
    throw new TypeError('blockedAfterConsecutiveRounds must be a positive safe integer')
  }
  return { blockedAfterConsecutiveRounds: blockedAfter }
}

/**
 * Whether a thrown value is the core service's domain error. Checked
 * structurally as well as by class identity so a duplicated core module
 * instance (for example a deployment that loads the plugin from a second
 * node_modules copy) still maps to the structured tool failure.
 */
function isInfiniGoalError(error: unknown): error is InfiniGoalError {
  if (error instanceof InfiniGoalError) return true
  if (!(error instanceof Error)) return false
  const candidate = error as unknown as { code?: unknown }
  return typeof candidate.code === 'string' && candidate.code.startsWith('INFINI_GOAL_')
}

/** Translate one caught failure into a structured tool error. */
function translateToolError(error: unknown): unknown {
  if (error instanceof HarnessError) return error
  if (error instanceof InfiniGoalToolInputError) return new HarnessError(error.message, error.code)
  if (isInfiniGoalError(error)) return new HarnessError(error.message, error.code)
  return error
}

/** Run one tool body, translating parse and domain failures into structured tool errors. */
function runTool(body: () => InfiniGoalToolValue): Promise<InfiniGoalToolValue> {
  try {
    return Promise.resolve(body())
  } catch (error: unknown) {
    return Promise.reject(translateToolError(error))
  }
}

/**
 * Defer the closing-message instruction after an autonomous round reports
 * `complete` or `blocked`; direct-human updates end the turn normally.
 */
function deferWrapupContext(
  exec: ToolRunContext,
  action: 'complete' | 'blocked',
  goal: InfiniGoalView,
  blockedReason?: string,
): void {
  exec.deferContext(createUserMessage({
    content: renderWrapupContext(goal.objective, blockedReason),
    source: {
      kind: 'tool-infini-goal',
      form: 'notice',
      summary: boundContextSummary(`${action}: ${goal.objective}`),
    },
  }))
}

/** Register the three infini-goal tools and their shared policy section. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:infini-goal',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: guidance(resolved.blockedAfterConsecutiveRounds),
  })

  ctx.tools.register(defineTool({
    name: 'get_infini_goal',
    description: GET_DESCRIPTION,
    parameters: {},
    output: GOAL_OUTPUT,
    execute(_args, exec) {
      return runTool(() => {
        const execution = infiniGoalToolExecution(ctx, exec)
        const goal = ctx.infiniGoals.get(execution.agent)
        return goalValue(goal, goal === undefined ? undefined : ctx.infiniGoals.plan(execution.agent))
      })
    },
    presentCall: () => present('Read current infini-goal', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'create_infini_goal',
    description: CREATE_DESCRIPTION,
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'The concrete completion objective inferred from the direct human request.',
      },
      min_interval: {
        type: 'string',
        description: 'Optional minimum delay between automatic round starts, such as 90s, 5m, or 1h30m (1s to 30d).',
      },
      quiet_windows: {
        type: 'string',
        description: 'Optional local-time windows where no automatic round starts (the goal stays active and human turns continue), '
          + 'such as "Mo-Fr 09:00-18:00" or "Mo-Fr 09:00-18:00; Sa,Su 10:00-12:00"; "none" disables them.',
      },
      timezone: {
        type: 'string',
        description: 'Optional IANA time zone the quiet windows use, such as Asia/Shanghai; "system" means this host time zone.',
      },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      return runTool(() => {
        const execution = infiniGoalToolExecution(ctx, exec)
        requireDirectHuman(ctx, execution)
        const goal = ctx.infiniGoals.create(execution.agent, createRequestFromArgs(args))
        return goalValue(goal, ctx.infiniGoals.plan(execution.agent))
      })
    },
    presentCall: args => present('Create infini-goal', 'other', args.objective),
  }))

  ctx.tools.register(defineTool({
    name: 'update_infini_goal',
    description: 'Update the current infini-goal.',
    parameters: {
      goal_id: {
        type: 'string',
        required: true,
        description: 'Exact id returned by get_infini_goal.',
      },
      revision: {
        type: 'integer',
        required: true,
        description: 'Exact positive revision returned by get_infini_goal.',
      },
      action: {
        type: 'string',
        required: true,
        enum: [...UPDATE_ACTIONS],
        description: 'edit changes the objective and/or pacing settings; config changes only the pacing settings; '
          + 'edit, pause, resume, and config require a direct human request. complete and blocked are also allowed '
          + 'during an automatic round of this goal; a blocked reported from an automatic round is rejected before '
          + 'the configured minimum round count, while a direct human request may block immediately.',
      },
      objective: {
        type: 'string',
        description: 'Replacement objective; valid only with action edit.',
      },
      min_interval: {
        type: 'string',
        description: 'Replacement minimum delay between automatic round starts, such as 90s, 5m, or 1h30m.',
      },
      quiet_windows: {
        type: 'string',
        description: 'Replacement local-time quiet windows such as "Mo-Fr 09:00-18:00"; "none" disables them.',
      },
      timezone: {
        type: 'string',
        description: 'Replacement IANA time zone for the quiet windows; "system" means this host time zone.',
      },
      blocked_reason: {
        type: 'string',
        description: 'Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.',
      },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      return runTool(() => {
        const execution = infiniGoalToolExecution(ctx, exec)
        const ref = goalRefFromArgs(args)
        if (args.action === 'edit' || args.action === 'config') {
          requireDirectHuman(ctx, execution)
          const goal = ctx.infiniGoals.edit(execution.agent, ref, editRequestFromArgs(args, args.action))
          return goalValue(goal, ctx.infiniGoals.plan(execution.agent))
        }
        if (args.action === 'pause' || args.action === 'resume') {
          requireDirectHuman(ctx, execution)
          const goal = args.action === 'pause'
            ? ctx.infiniGoals.pause(execution.agent, ref)
            : ctx.infiniGoals.resume(execution.agent, ref)
          return goalValue(goal, ctx.infiniGoals.plan(execution.agent))
        }
        const authority = completionAuthority(ctx, execution, ctx.infiniGoals.get(execution.agent))
        if (args.action === 'blocked') {
          const reason = blockedReasonFromArgs(args)
          if (authority.kind === 'goal-round'
            && authority.goal.roundsStarted < resolved.blockedAfterConsecutiveRounds) {
            throw new HarnessError(
              `blocked requires at least ${resolved.blockedAfterConsecutiveRounds} consecutive goal rounds; `
              + `the current goal has started ${authority.goal.roundsStarted}`,
              'INFINI_GOAL_TOOL_BLOCK_THRESHOLD',
            )
          }
          const goal = ctx.infiniGoals.block(execution.agent, ref, reason)
          if (authority.kind === 'goal-round') deferWrapupContext(exec, 'blocked', goal, reason.message)
          return goalValue(goal, ctx.infiniGoals.plan(execution.agent))
        }
        const goal = ctx.infiniGoals.complete(execution.agent, ref)
        if (authority.kind === 'goal-round') deferWrapupContext(exec, 'complete', goal)
        return goalValue(goal, ctx.infiniGoals.plan(execution.agent))
      })
    },
    presentCall: presentUpdateCall,
  }))
}
