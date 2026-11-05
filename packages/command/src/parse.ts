/**
 * Pure grammar and argument validation of the human-facing `/infini-goal`
 * command. Kept free of Cordis and service imports so it is unit-testable
 * without booting the harness.
 *
 * @module @yankeguo/dsh-command-infini-goal/parse
 */

import {
  canonicalTimeZone,
  parseDurationMs,
  parseQuietWindows,
  validateMinIntervalMs,
} from '@yankeguo/dsh-infini-goal-protocol'
import type { QuietWindow } from '@yankeguo/dsh-infini-goal-protocol'

/** One-line usage hint shown by every input error and in the empty state. */
export const USAGE =
  'Usage: /infini-goal [<objective>|edit <objective>|pause|resume|complete|block <message>|clear'
  + '|interval <duration>|quiet <windows|none>|timezone <IANA|system>]'

/** Rejected command input with a human-facing explanation. */
export class CommandInputError extends Error {
  /** Stable failure class local to the command surface. */
  readonly code = 'INFINI_GOAL_COMMAND_INVALID_INPUT'

  /**
   * @param message - actionable explanation of the rejected input.
   */
  constructor(message: string) {
    super(message)
    this.name = 'CommandInputError'
  }
}

/** One parsed `/infini-goal` invocation. */
export type InfiniGoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'create'; readonly objective: string }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'block'; readonly message: string }
  | { readonly kind: 'interval'; readonly duration: string }
  | { readonly kind: 'quiet'; readonly windows: string }
  | { readonly kind: 'timezone'; readonly timezone: string }
  | { readonly kind: 'invalid'; readonly message: string }

/** Build one invalid-grammar command with a specific explanation. */
function invalid(message: string): InfiniGoalCommand {
  return { kind: 'invalid', message }
}

/** Split one non-empty trimmed input into its first token and the remaining text. */
function splitHead(input: string): { readonly head: string; readonly rest: string } {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(input)
  if (match === null) return { head: input.toLowerCase(), rest: '' }
  return { head: (match[1] as string).toLowerCase(), rest: (match[2] ?? '').trim() }
}

/**
 * Parse the `/infini-goal` grammar.
 *
 * A bare keyword selects its control action; `edit`, `block`, `interval`,
 * `quiet`, and `timezone` consume the rest of the line as their argument; any
 * other text is a new objective. In particular, `pause the deployment` is an
 * objective rather than a malformed `pause`, so a human can always create a
 * goal whose text happens to begin with a keyword.
 * @param rawInput - exact text following the command name.
 * @returns the parsed command; malformed known subcommands yield `invalid`.
 */
export function parseInfiniGoalCommand(rawInput: string): InfiniGoalCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'status' }
  switch (input.toLowerCase()) {
    // `status` is accepted as an explicit alias for the bare command so a human
    // who habitually types it still lands on the status view.
    case 'status': return { kind: 'status' }
    case 'pause': return { kind: 'pause' }
    case 'resume': return { kind: 'resume' }
    case 'complete': return { kind: 'complete' }
    case 'clear': return { kind: 'clear' }
    default: break
  }
  const { head, rest } = splitHead(input)
  switch (head) {
    case 'edit':
      return rest.length === 0
        ? invalid('Editing the infini-goal requires a replacement objective.')
        : { kind: 'edit', objective: rest }
    case 'block':
      return rest.length === 0
        ? invalid('Blocking the infini-goal requires a message describing the concrete blocking condition.')
        : { kind: 'block', message: rest }
    case 'interval':
      return rest.length === 0
        ? invalid('Setting the minimum interval requires a duration such as 90s, 5m, or 1h30m.')
        : { kind: 'interval', duration: rest }
    case 'quiet':
      return rest.length === 0
        ? invalid('Setting quiet windows requires text such as "Mo-Fr 09:00-18:00" or "none".')
        : { kind: 'quiet', windows: rest }
    case 'timezone':
      return rest.length === 0
        ? invalid('Setting the time zone requires an IANA name such as Asia/Shanghai, or "system".')
        : { kind: 'timezone', timezone: rest }
    default:
      return { kind: 'create', objective: input }
  }
}

/** Render one caught value as the explanation suffix of a command error. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse a minimum-interval argument such as `90s`, `5m`, or `1h30m`.
 * @param text - caller-supplied duration text.
 * @returns the validated span in milliseconds.
 * @throws {CommandInputError} when the text is not a usable duration or is out of bounds.
 */
export function parseIntervalArgument(text: string): number {
  let intervalMs: number
  try {
    intervalMs = parseDurationMs(text)
  } catch (error) {
    throw new CommandInputError(
      `Invalid interval "${text}": ${reasonOf(error)}. Use a duration such as 90s, 5m, or 1h30m.`,
    )
  }
  try {
    return validateMinIntervalMs(intervalMs)
  } catch (error) {
    throw new CommandInputError(`Invalid interval "${text}": ${reasonOf(error)}.`)
  }
}

/**
 * Parse a quiet-windows argument such as `Mo-Fr 09:00-18:00` or `none`.
 * @param text - caller-supplied quiet-window text.
 * @returns normalized quiet windows; an empty list for `none`.
 * @throws {CommandInputError} when the text is not usable quiet-window grammar.
 */
export function parseQuietArgument(text: string): QuietWindow[] {
  try {
    return parseQuietWindows(text)
  } catch (error) {
    throw new CommandInputError(
      `Invalid quiet windows "${text}": ${reasonOf(error)}. `
      + 'Use "Mo-Fr 09:00-18:00", "09:00-18:00", several entries separated by ";", or "none".',
    )
  }
}

/**
 * Resolve a time-zone argument to a canonical IANA name; `system` selects the
 * host process time zone.
 * @param text - caller-supplied time-zone text.
 * @returns the canonical IANA zone name.
 * @throws {CommandInputError} when the name is not a usable IANA zone.
 */
export function parseTimezoneArgument(text: string): string {
  const input = text.trim()
  if (input.toLowerCase() === 'system') {
    const canonical = canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
    if (canonical === undefined) {
      throw new CommandInputError('Could not resolve the system time zone; use an IANA name such as Asia/Shanghai.')
    }
    return canonical
  }
  const canonical = canonicalTimeZone(input)
  if (canonical === undefined) {
    throw new CommandInputError(`Invalid time zone "${text}": use an IANA name such as Asia/Shanghai, or "system".`)
  }
  return canonical
}
