/**
 * Runtime constructors, deployment-config resolution, boundary validation, and
 * the public error type of the infini-goal domain.
 *
 * Validation here is deliberately strict and reuses the protocol package's
 * canonicalizers (`validateMinIntervalMs`, `validateQuietWindows`,
 * `canonicalTimeZone`, `nextTriggerAt`) so the durable payload the service
 * writes is always replayable by the strict fold and always schedulable.
 *
 * @module @yankeguo/dsh-infini-goal
 */

import { randomUUID } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_MIN_INTERVAL_MS,
  canonicalTimeZone,
  nextTriggerAt,
  validateMinIntervalMs,
  validateQuietWindows,
} from '@yankeguo/dsh-infini-goal-protocol'
import type {
  InfiniGoalBlockReason,
  InfiniGoalCreateRequest,
  InfiniGoalEditRequest,
  InfiniGoalSettings,
  QuietWindow,
} from '@yankeguo/dsh-infini-goal-protocol'
import type { InfiniGoalErrorCode } from './domain.ts'

/** Error returned by the infini-goal domain boundary. */
export class InfiniGoalError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   * @param options - standard error options (cause chaining).
   */
  constructor(message: string, code: InfiniGoalErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}

/** Deployment defaults applied to creates that do not override them. */
export interface Config {
  /** Minimum milliseconds between two automatic round starts. */
  defaultMinIntervalMs?: number
  /** Local-time windows in which no automatic round starts. */
  defaultQuietWindows?: readonly QuietWindow[]
  /** IANA time zone the quiet windows are interpreted in. */
  timezone?: string
}

/** Materialized deployment defaults; every field is validated and canonical. */
export interface ResolvedConfig {
  readonly defaultMinIntervalMs: number
  readonly defaultQuietWindows: readonly QuietWindow[]
  readonly timezone: string
}

/** Resolve the current process's system time zone. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Mint one fresh goal identity.
 * @returns an opaque, collision-safe goal id.
 */
export function infiniGoalId(): string {
  return `infinigoal-${randomUUID()}`
}

/** Render an unknown thrown value as a message. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- boundary validation always throws Error instances. */
  return error instanceof Error ? error.message : String(error)
}

/** Build one invalid-settings rejection. */
function invalidSettings(message: string): InfiniGoalError {
  return new InfiniGoalError(message, 'INFINI_GOAL_INVALID_SETTINGS')
}

/** Validate and normalize one minimum trigger interval. */
function normalizeMinIntervalMs(value: unknown): number {
  try {
    return validateMinIntervalMs(value)
  } catch (error) {
    throw invalidSettings(`minimum trigger interval is invalid: ${messageOf(error)}`)
  }
}

/** Validate, detach, and canonicalize one quiet-window list. */
function normalizeQuietWindows(value: unknown): QuietWindow[] {
  try {
    return validateQuietWindows(value)
  } catch (error) {
    throw invalidSettings(`quiet windows are invalid: ${messageOf(error)}`)
  }
}

/** Validate and canonicalize one IANA time zone. */
function normalizeTimeZone(value: unknown): string {
  const canonical = typeof value === 'string' ? canonicalTimeZone(value) : undefined
  if (canonical === undefined) {
    throw invalidSettings('timezone must be a valid IANA time zone name')
  }
  return canonical
}

/**
 * Reject a quiet-window configuration that covers every local time.
 * @throws {InfiniGoalError} `INFINI_GOAL_INVALID_SETTINGS` when no automatic
 *   round could ever trigger.
 */
function assertSchedulable(settings: InfiniGoalSettings, now: number): void {
  try {
    nextTriggerAt(settings, null, now)
  } catch (error) {
    if (error instanceof RangeError) throw invalidSettings(error.message)
    throw error
  }
}

/**
 * Validate one complete pacing configuration and check that it is schedulable.
 * @param value - candidate settings, possibly holding caller text.
 * @param now - instant the schedulability check is computed for.
 * @returns canonical, detached settings.
 * @throws {InfiniGoalError} `INFINI_GOAL_INVALID_SETTINGS` on any invalid field
 *   or on a quiet-window set that never allows a trigger.
 */
export function resolveSettings(value: InfiniGoalSettings, now: number): InfiniGoalSettings {
  const settings: InfiniGoalSettings = {
    minIntervalMs: normalizeMinIntervalMs(value.minIntervalMs),
    quietWindows: normalizeQuietWindows(value.quietWindows),
    timezone: normalizeTimeZone(value.timezone),
  }
  assertSchedulable(settings, now)
  return settings
}

/**
 * Materialize deployment defaults into one create request.
 *
 * The request overrides the deployment defaults field by field; the merged
 * configuration is validated and canonicalized exactly like stored settings.
 * @param request - caller create input.
 * @param defaults - validated deployment defaults.
 * @param now - instant the schedulability check is computed for.
 * @returns canonical settings for the new goal.
 * @throws {InfiniGoalError} `INFINI_GOAL_INVALID_SETTINGS` when the effective
 *   settings are invalid or never schedulable.
 */
export function resolveCreateSettings(
  request: InfiniGoalCreateRequest,
  defaults: ResolvedConfig,
  now: number,
): InfiniGoalSettings {
  return resolveSettings({
    minIntervalMs: request.minIntervalMs ?? defaults.defaultMinIntervalMs,
    quietWindows: request.quietWindows ?? defaults.defaultQuietWindows,
    timezone: request.timezone ?? defaults.timezone,
  }, now)
}

/**
 * Apply one edit request to the current settings.
 *
 * An edit must name at least one of `objective`, `minIntervalMs`,
 * `quietWindows`, or `timezone`; the resulting configuration is validated and
 * must remain schedulable.
 * @param current - current goal snapshot or settings.
 * @param request - caller edit input.
 * @param now - instant the schedulability check is computed for.
 * @returns canonical settings for the next revision.
 * @throws {InfiniGoalError} `INFINI_GOAL_INVALID_SETTINGS` when the request is
 *   empty or the resulting configuration is invalid/never schedulable.
 */
export function resolveEditSettings(
  current: InfiniGoalSettings,
  request: InfiniGoalEditRequest,
  now: number,
): InfiniGoalSettings {
  if (request.objective === undefined
    && request.minIntervalMs === undefined
    && request.quietWindows === undefined
    && request.timezone === undefined) {
    throw invalidSettings('infini-goal edit requires objective, minIntervalMs, quietWindows, or timezone')
  }
  return resolveSettings({
    minIntervalMs: request.minIntervalMs ?? current.minIntervalMs,
    quietWindows: request.quietWindows ?? current.quietWindows,
    timezone: request.timezone ?? current.timezone,
  }, now)
}

/**
 * Resolve and validate one deployment configuration.
 *
 * Every default is canonicalized once at service construction so create/edit
 * only have to validate explicit overrides. The default configuration must be
 * schedulable as well: an impossible quiet-window set fails plugin startup
 * instead of every create.
 * @param config - deployment configuration (possibly empty).
 * @param now - instant the schedulability check is computed for.
 * @returns validated deployment defaults.
 * @throws {InfiniGoalError} `INFINI_GOAL_INVALID_SETTINGS` on invalid defaults.
 */
export function resolveServiceConfig(config: Config, now: number = Date.now()): ResolvedConfig {
  const settings = resolveSettings({
    minIntervalMs: config.defaultMinIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    quietWindows: config.defaultQuietWindows ?? [],
    timezone: config.timezone ?? systemTimeZone(),
  }, now)
  return {
    defaultMinIntervalMs: settings.minIntervalMs,
    defaultQuietWindows: settings.quietWindows,
    timezone: settings.timezone,
  }
}

/**
 * Validate and normalize an objective at the domain boundary.
 * @param value - caller-supplied objective.
 * @returns the trimmed objective.
 * @throws {InfiniGoalError} `INFINI_GOAL_INVALID_OBJECTIVE` when empty.
 */
export function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InfiniGoalError('infini-goal objective must be a non-empty string', 'INFINI_GOAL_INVALID_OBJECTIVE')
  }
  return value.trim()
}

/**
 * Validate and detach one policy-owned blocker explanation.
 *
 * The code is a stable lower-kebab-case classification chosen by the blocking
 * policy; the message is a normalized human-readable explanation.
 * @param reason - caller-supplied blocker explanation.
 * @returns a detached validated reason.
 * @throws {InfiniGoalError} `INFINI_GOAL_INVALID_BLOCK_REASON` on invalid input.
 */
export function resolveBlockReason(reason: InfiniGoalBlockReason): InfiniGoalBlockReason {
  const record = typeof reason === 'object' && reason !== null && !Array.isArray(reason)
    ? reason as unknown as Record<string, unknown>
    : undefined
  const code = record?.['code']
  const message = record?.['message']
  if (typeof code !== 'string'
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(code)
    || typeof message !== 'string'
    || message.trim().length === 0) {
    throw new InfiniGoalError(
      'infini-goal block reason requires a lower-kebab-case code and a non-empty message',
      'INFINI_GOAL_INVALID_BLOCK_REASON',
    )
  }
  return { code, message: message.trim() }
}
