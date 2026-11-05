/**
 * Pure argument parsing for the infini-goal model tools.
 *
 * The model supplies human text (`5m`, `Mo-Fr 09:00-18:00`, `Asia/Shanghai`);
 * this module turns it into the validated protocol vocabulary the core service
 * accepts, so a malformed argument fails with one actionable tool error instead
 * of a domain-level settings rejection.
 *
 * @module @yankeguo/dsh-tool-infini-goal/arguments
 */

import {
  canonicalTimeZone,
  parseDurationMs,
  parseQuietWindows,
  validateMinIntervalMs,
} from '@yankeguo/dsh-infini-goal-protocol'
import type {
  InfiniGoalBlockReason,
  InfiniGoalCreateRequest,
  InfiniGoalEditRequest,
  InfiniGoalRef,
  QuietWindow,
} from '@yankeguo/dsh-infini-goal-protocol'

/** Operations the model may request through `update_infini_goal`. */
export const UPDATE_ACTIONS = ['edit', 'pause', 'resume', 'complete', 'blocked', 'config'] as const

/** One valid `update_infini_goal.action` value. */
export type UpdateAction = (typeof UPDATE_ACTIONS)[number]

/** Stable tool error code for model-supplied arguments that cannot be used. */
export const TOOL_INVALID_ARGUMENT_CODE = 'INFINI_GOAL_TOOL_INVALID_ARGUMENT'

/** Rejected model argument with a model-facing explanation. */
export class InfiniGoalToolInputError extends Error {
  /** Stable machine-routable failure class. */
  readonly code = TOOL_INVALID_ARGUMENT_CODE

  /**
   * @param message - actionable explanation of the rejected argument.
   */
  constructor(message: string) {
    super(message)
    this.name = 'InfiniGoalToolInputError'
  }
}

/** Throw one {@link InfiniGoalToolInputError}. */
function reject(message: string): never {
  throw new InfiniGoalToolInputError(message)
}

/** Render one caught value as the explanation suffix of a tool error. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether optional model text is meaningful rather than a strict-schema empty filler. */
export function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

/**
 * Parse a minimum trigger interval such as `90s`, `5m`, or `1h30m`.
 * @param text - model-supplied duration text.
 * @returns the validated span in milliseconds.
 * @throws {InfiniGoalToolInputError} when the text is not a usable duration or is out of bounds.
 */
export function parseMinIntervalArg(text: string): number {
  let ms: number
  try {
    ms = parseDurationMs(text)
  } catch (error) {
    reject(`min_interval "${text}" is not a duration: ${reasonOf(error)}. Use forms like 90s, 5m, or 1h30m.`)
  }
  try {
    return validateMinIntervalMs(ms)
  } catch (error) {
    reject(`min_interval "${text}" is out of bounds: ${reasonOf(error)}`)
  }
}

/**
 * Parse quiet-window text such as `Mo-Fr 09:00-18:00; Sa,Su 10:00-12:00`,
 * `HH:mm-HH:mm`, or `none`.
 *
 * Whitespace-only text is rejected instead of being treated as `none`: the
 * strict tool schema uses `""` as the omitted filler, so a blank value is much
 * more likely a mistake than a deliberate request to clear every quiet window.
 * @param text - model-supplied quiet-window text.
 * @returns normalized quiet windows; an empty list for `none`.
 * @throws {InfiniGoalToolInputError} when the text is blank or is not usable quiet-window grammar.
 */
export function parseQuietWindowsArg(text: string): QuietWindow[] {
  if (text.trim().length === 0) {
    reject('quiet_windows must not be blank; use "none" to disable quiet windows')
  }
  try {
    return parseQuietWindows(text)
  } catch (error) {
    reject(
      `quiet_windows "${text}" is not valid: ${reasonOf(error)}. `
      + 'Use "Mo-Fr 09:00-18:00", "09:00-18:00", several entries separated by ";", or "none".',
    )
  }
}

/** Resolve the current process system time zone to its canonical IANA name. */
function systemTimeZone(): string {
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone
  const canonical = canonicalTimeZone(system)
  if (canonical === undefined) reject('timezone "system" could not resolve a usable time zone')
  return canonical
}

/**
 * Resolve time-zone text to a canonical IANA zone name. `system` selects the
 * host process time zone, mirroring the service default.
 * @param text - model-supplied time-zone text.
 * @returns the canonical IANA zone name.
 * @throws {InfiniGoalToolInputError} when the name is not a usable IANA zone.
 */
export function resolveTimeZoneArg(text: string): string {
  const input = text.trim()
  if (input.toLowerCase() === 'system') return systemTimeZone()
  const canonical = canonicalTimeZone(input)
  if (canonical === undefined) {
    reject(`timezone "${text}" is not a valid IANA time zone name (for example Asia/Shanghai)`)
  }
  return canonical
}

/**
 * Normalize a required objective argument.
 * @param text - model-supplied objective.
 * @returns the trimmed objective.
 * @throws {InfiniGoalToolInputError} when the objective is empty.
 */
export function requiredObjectiveArg(text: string): string {
  const objective = text.trim()
  if (objective.length === 0) reject('objective must not be empty')
  return objective
}

/**
 * Normalize an optional objective argument; empty strings are treated as absent
 * (the strict tool schema's filler for an omitted optional string).
 * @param text - model-supplied objective, if any.
 * @returns the trimmed objective, or undefined when absent.
 * @throws {InfiniGoalToolInputError} when a non-empty-but-blank objective was supplied.
 */
export function optionalObjectiveArg(text: string | undefined): string | undefined {
  if (!hasText(text)) return undefined
  const objective = text.trim()
  if (objective.length === 0) reject('objective must not be blank')
  return objective
}

/** Arguments accepted by `create_infini_goal`. */
export interface CreateInfiniGoalToolArgs {
  readonly objective: string
  readonly min_interval?: string | undefined
  readonly quiet_windows?: string | undefined
  readonly timezone?: string | undefined
}

/**
 * Build the core create request from model arguments.
 * @param args - validated `create_infini_goal` arguments.
 * @returns the create request, omitting unspecified overrides so deployment defaults apply.
 * @throws {InfiniGoalToolInputError} when an argument is unusable.
 */
export function createRequestFromArgs(args: CreateInfiniGoalToolArgs): InfiniGoalCreateRequest {
  return {
    objective: requiredObjectiveArg(args.objective),
    ...hasText(args.min_interval) ? { minIntervalMs: parseMinIntervalArg(args.min_interval) } : {},
    ...hasText(args.quiet_windows) ? { quietWindows: parseQuietWindowsArg(args.quiet_windows) } : {},
    ...hasText(args.timezone) ? { timezone: resolveTimeZoneArg(args.timezone) } : {},
  }
}

/** Arguments accepted by `update_infini_goal`. */
export interface UpdateInfiniGoalToolArgs {
  readonly goal_id: string
  readonly revision: number
  readonly action: UpdateAction
  readonly objective?: string | undefined
  readonly min_interval?: string | undefined
  readonly quiet_windows?: string | undefined
  readonly timezone?: string | undefined
  readonly blocked_reason?: string | undefined
}

/**
 * Build the exact compare-and-set ref from model arguments.
 * @param args - validated `update_infini_goal` arguments.
 * @returns the goal ref the mutation must match.
 * @throws {InfiniGoalToolInputError} when the id is malformed or the revision is not a positive integer.
 */
export function goalRefFromArgs(args: Pick<UpdateInfiniGoalToolArgs, 'goal_id' | 'revision'>): InfiniGoalRef {
  if (args.goal_id.length === 0 || args.goal_id !== args.goal_id.trim()) {
    reject('goal_id must be a non-empty id returned by get_infini_goal, without surrounding whitespace')
  }
  if (!Number.isSafeInteger(args.revision) || args.revision < 1) {
    reject('revision must be the positive integer returned by get_infini_goal')
  }
  return { id: args.goal_id, revision: args.revision }
}

/**
 * Build a settings/objective edit request from model arguments.
 * @param args - validated `update_infini_goal` arguments.
 * @param action - `edit` (objective and/or settings) or `config` (settings only).
 * @returns the edit request; guaranteed to change at least one field.
 * @throws {InfiniGoalToolInputError} when nothing changes or an argument is unusable.
 */
export function editRequestFromArgs(
  args: UpdateInfiniGoalToolArgs,
  action: 'edit' | 'config',
): InfiniGoalEditRequest {
  const objective = optionalObjectiveArg(args.objective)
  if (action === 'config' && objective !== undefined) {
    reject('objective is only valid with action edit; use action edit to change the objective')
  }
  const request: InfiniGoalEditRequest = {
    ...objective === undefined ? {} : { objective },
    ...hasText(args.min_interval) ? { minIntervalMs: parseMinIntervalArg(args.min_interval) } : {},
    ...hasText(args.quiet_windows) ? { quietWindows: parseQuietWindowsArg(args.quiet_windows) } : {},
    ...hasText(args.timezone) ? { timezone: resolveTimeZoneArg(args.timezone) } : {},
  }
  if (Object.keys(request).length === 0) {
    reject(
      action === 'config'
        ? 'config requires at least one of min_interval, quiet_windows, or timezone'
        : 'edit requires at least one of objective, min_interval, quiet_windows, or timezone',
    )
  }
  return request
}

/**
 * Build the durable block reason from model arguments.
 * @param args - validated `update_infini_goal` arguments.
 * @returns the machine code plus the model's concrete explanation.
 * @throws {InfiniGoalToolInputError} when `blocked_reason` is missing or blank.
 */
export function blockedReasonFromArgs(
  args: Pick<UpdateInfiniGoalToolArgs, 'blocked_reason'>,
): InfiniGoalBlockReason {
  if (!hasText(args.blocked_reason)) {
    reject('blocked_reason is required with action blocked: describe the concrete condition that persists across rounds')
  }
  const message = args.blocked_reason.trim()
  if (message.length === 0) reject('blocked_reason must not be blank')
  return { code: 'model-reported', message }
}
