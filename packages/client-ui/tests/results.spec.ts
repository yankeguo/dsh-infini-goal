/**
 * Unit tests for the command-result helpers of the InfiniGoalBar dock.
 *
 * The dock must surface both failure layers of a `/infini-goal` admission:
 * a failed Remote call and a logical Host rejection (`ok: true` with
 * `CommandResult.kind === 'error'`).
 */

import { describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  commandFailureText,
  commandSucceeded,
  type InfiniGoalCommandResult,
  type InfiniGoalCommandOutcome,
} from '../src/client/results.ts'

/**
 * Build a settled admission result.
 * @param result - host command outcome.
 * @returns the Remote-shaped admission result.
 */
function admitted(result: InfiniGoalCommandOutcome['result']): InfiniGoalCommandResult {
  return { ok: true, value: { result } }
}

describe('commandFailureText', () => {
  it('returns the Host text of a logical command rejection', () => {
    expect(commandFailureText(admitted({ kind: 'error', text: 'No infini-goal is currently set.' })))
      .toBe('No infini-goal is currently set.')
  })

  it('falls back to a generic text for a rejection without text', () => {
    expect(commandFailureText(admitted({ kind: 'error' }))).toBe('command rejected')
  })

  it('returns undefined for a successful command', () => {
    expect(commandFailureText(admitted({ kind: 'success', text: 'Infini-goal created' }))).toBeUndefined()
    expect(commandFailureText(admitted({ kind: 'success' }))).toBeUndefined()
  })

  it('returns undefined for a transport failure (rendered from the Remote error instead)', () => {
    expect(commandFailureText({
      ok: false,
      error: new RemoteError('gateway/internal', 'connection reset', {}),
    })).toBeUndefined()
  })

  it('returns undefined when no command was executed', () => {
    expect(commandFailureText({ ok: true, value: undefined })).toBeUndefined()
  })
})

describe('commandSucceeded', () => {
  it('accepts only a transport-ok, logical-success admission', () => {
    expect(commandSucceeded(admitted({ kind: 'success' }))).toBe(true)
    expect(commandSucceeded(admitted({ kind: 'success', text: 'Infini-goal paused' }))).toBe(true)
  })

  it('rejects logical rejections, transport failures, skipped calls, and empty admissions', () => {
    expect(commandSucceeded(admitted({ kind: 'error', text: 'stale revision' }))).toBe(false)
    expect(commandSucceeded({ ok: false, error: new RemoteError('gateway/internal', 'connection reset', {}) })).toBe(false)
    expect(commandSucceeded({ ok: true, value: undefined })).toBe(false)
    expect(commandSucceeded(undefined)).toBe(false)
  })
})
