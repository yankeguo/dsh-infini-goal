/**
 * Pure result helpers for the `/infini-goal` command face of the dock.
 *
 * A command admission has two failure layers:
 * - the Remote call itself can fail (`ok: false`, e.g. connection or Host error);
 * - the Host command can settle with a *logical* failure (`ok: true` but the
 *   embedded `CommandResult.kind === 'error'`, e.g. "no goal", "stale
 *   revision", invalid pacing settings).
 *
 * The dock must surface both instead of silently dropping the second one.
 * These helpers stay free of React and platform-module imports so they are
 * unit-testable; the types are structural copies of the generated Remote face,
 * keeping the client bundle's type-only import erased.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'

/** Host command outcome embedded in one admission result. */
export interface InfiniGoalCommandOutcome {
  readonly result: {
    readonly kind: 'success' | 'error'
    readonly text?: string
  }
}

/** Settled outcome of one `/infini-goal` command admission. */
export type InfiniGoalCommandResult = RemoteResult<InfiniGoalCommandOutcome | undefined>

/**
 * Human-readable text of a logical command failure.
 *
 * Returns `undefined` for a successful command, for a transport failure (the
 * caller renders that through the Remote error), and for an admission with no
 * command execution.
 * @param result - settled admission result.
 * @returns the logical failure text, when the Host rejected the command.
 */
export function commandFailureText(result: InfiniGoalCommandResult): string | undefined {
  if (!result.ok) return undefined
  const outcome = result.value?.result
  if (outcome === undefined || outcome.kind !== 'error') return undefined
  return outcome.text ?? 'command rejected'
}

/**
 * Whether one admission both reached the Host and settled as a success.
 * @param result - settled admission result, or undefined when the dock skipped it.
 * @returns true only for a transport-ok, logical-success admission.
 */
export function commandSucceeded(result: InfiniGoalCommandResult | undefined): boolean {
  if (result === undefined || !result.ok) return false
  return result.value?.result.kind === 'success'
}
