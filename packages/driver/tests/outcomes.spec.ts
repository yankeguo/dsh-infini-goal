/**
 * Failure, cancellation, and pause-outcome policy of the driver.
 *
 * Fake timers keep the pacing deterministic while a scriptable fake agent loop
 * reproduces the real loop's turn/end and cancellation ordering.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import {
  admittedRounds,
  admittedSources,
  boot,
  createGoal,
  currentGoal,
  deferred,
  disposeHarnesses,
  fakeClock,
  flushMicrotasks,
  goalOperations,
  humanMessage,
  settle,
} from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'

afterEach(async () => {
  await disposeHarnesses()
  vi.useRealTimers()
})

/** The fake agent's duplicate activity counter: 1-based turn number of the last end. */
function turnEndReasons(harness: Harness): string[] {
  return harness.session.snapshotEvents().flatMap(event =>
    event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

/** Resolve the fake clock forward and settle the driver. */
async function advance(harness: Harness, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle(harness)
}

/** Park the next fake turn on an external gate. */
function holdNextTurn(harness: Harness): ReturnType<typeof deferred<void>> {
  const gate = deferred<void>()
  harness.agent.turnGate = gate
  return gate
}

describe('outcome policy', () => {
  it('blocks the goal when the automatic round reaches its output-token ceiling', async () => {
    fakeClock()
    const harness = await boot()
    harness.agent.outcomes.push({ kind: 'max-tokens' })
    createGoal(harness)
    await settle(harness)

    expect(currentGoal(harness)).toMatchObject({
      phase: 'blocked',
      roundsStarted: 1,
      blockedReason: { code: 'max-tokens' },
    })
    expect(goalOperations(harness, 'block')).toHaveLength(1)

    // A blocked goal never receives another automatic round.
    await advance(harness, 5 * 60_000)
    expect(admittedRounds(harness)).toEqual([1])
  })

  it('blocks a failed automatic round through the agent error boundary', async () => {
    fakeClock()
    const harness = await boot()
    harness.agent.outcomes.push({ kind: 'error', error: { message: 'provider broke', code: 'UNKNOWN' } })
    createGoal(harness)
    await settle(harness)

    expect(currentGoal(harness)).toMatchObject({
      phase: 'blocked',
      roundsStarted: 1,
      blockedReason: { code: 'agent-error' },
    })
    expect(currentGoal(harness)?.blockedReason?.message).toContain('provider broke')
  })

  it('falls back to the turn-end error reason when no agent error is reported', async () => {
    fakeClock()
    const harness = await boot()
    harness.agent.emitAgentError = false
    harness.agent.outcomes.push({ kind: 'error', error: { message: 'turn exploded', code: 'UNKNOWN' } })
    createGoal(harness)
    await settle(harness)

    expect(currentGoal(harness)).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'turn-error' },
    })
    expect(currentGoal(harness)?.blockedReason?.message).toContain('turn exploded')
  })

  it.each([
    ['max-tokens', { kind: 'max-tokens' }],
    ['error', { kind: 'error', error: { message: 'human turn failed', code: 'UNKNOWN' } }],
  ] as const)('does not block the goal for a %s human turn that runs after a round', async (_label, outcome) => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    harness.agent.outcomes.push(outcome as TurnEndReason)
    harness.agent.followup(humanMessage('human work'))
    await settle(harness)

    expect(currentGoal(harness)).toMatchObject({ phase: 'active', roundsStarted: 1 })
    expect(goalOperations(harness, 'block')).toEqual([])

    // Continuation still resumes on the normal pacing boundary.
    await advance(harness, 1_000)
    expect(admittedRounds(harness)).toEqual([1, 2])
  })

  it('pauses the goal when a human cancels a running automatic round', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    const gate = holdNextTurn(harness)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    harness.agent.cancel({ kind: 'user' })
    gate.resolve()
    await settle(harness)

    expect(currentGoal(harness)).toMatchObject({ phase: 'paused', roundsStarted: 1 })
    expect(admittedRounds(harness)).toEqual([1])
    expect(turnEndReasons(harness)).toContain('aborted')
    expect(goalOperations(harness, 'pause')).toHaveLength(1)

    // A paused goal stays silent regardless of elapsed pacing time.
    await advance(harness, 10 * 60_000)
    expect(admittedRounds(harness)).toEqual([1])
  })

  it('pauses when a reserved round is cancelled before its turn can start', async () => {
    fakeClock()
    const harness = await boot()
    // Emulate a running maintenance task: the followup parks without waking.
    harness.agent.wakeHeld = true
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([])
    expect(harness.agent.inbox.nextTurn).toHaveLength(1)

    harness.agent.cancel({ kind: 'user' })
    harness.agent.wakeHeld = false
    // A human follow-up wakes the loop, whose quiescence settles the cancelled round.
    harness.agent.followup(humanMessage('human work'))
    await settle(harness)

    expect(currentGoal(harness)?.phase).toBe('paused')
    expect(admittedRounds(harness)).toEqual([])
    expect(admittedSources(harness)).toEqual([{ kind: 'user' }])
    expect(goalOperations(harness, 'pause')).toHaveLength(1)
  })

  it('keeps the goal active when a human turn (not a round) is cancelled', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    const gate = holdNextTurn(harness)
    harness.agent.followup(humanMessage('human work'))
    await flushMicrotasks()
    harness.agent.cancel({ kind: 'user' })
    gate.resolve()
    await settle(harness)

    expect(currentGoal(harness)?.phase).toBe('active')
    await advance(harness, 1_000)
    expect(admittedRounds(harness)).toEqual([1, 2])
  })

  it('aborts the live automatic round when a host pause lands mid-turn', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)

    const gate = holdNextTurn(harness)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    const goal = currentGoal(harness)
    if (goal === undefined) throw new Error('expected an active goal')
    // A remote/command pause runs outside the agent's own turn.
    harness.goals.pause(harness.agent.agent, { id: goal.id, revision: goal.revision })
    await flushMicrotasks()
    gate.resolve()
    await settle(harness)

    expect(currentGoal(harness)?.phase).toBe('paused')
    expect(admittedRounds(harness)).toEqual([1])
    expect(turnEndReasons(harness)).toContain('aborted')
    expect(goalOperations(harness, 'pause')).toHaveLength(1)
    await advance(harness, 10 * 60_000)
    expect(admittedRounds(harness)).toEqual([1])
  })

  it('leaves a running human turn alone when the host pauses the goal', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)

    const gate = holdNextTurn(harness)
    harness.agent.followup(humanMessage('human work'))
    await flushMicrotasks()
    const goal = currentGoal(harness)
    if (goal === undefined) throw new Error('expected an active goal')
    harness.goals.pause(harness.agent.agent, { id: goal.id, revision: goal.revision })
    await flushMicrotasks()
    gate.resolve()
    await settle(harness)

    expect(currentGoal(harness)?.phase).toBe('paused')
    expect(turnEndReasons(harness)).not.toContain('aborted')
    expect(admittedSources(harness)).toEqual([
      { kind: 'infini-goal', round: 1 },
      { kind: 'user' },
    ])
  })

  it('blocks with queue-failed when the agent refuses the reserved round', async () => {
    fakeClock()
    const harness = await boot()
    harness.agent.failFollowups = 1
    createGoal(harness)
    await settle(harness)

    expect(currentGoal(harness)).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'queue-failed' },
    })
    expect(admittedRounds(harness)).toEqual([])
  })

  it('blocks with prompt-rejected when a downstream step hook rejects the round', async () => {
    fakeClock()
    const harness = await boot()
    harness.ctx.on('agent/pre-step', ({ messages }, next) => {
      if (messages.some(message => message.source.kind === 'infini-goal')) {
        return Promise.resolve({ kind: 'reject' as const })
      }
      return next()
    })
    createGoal(harness)
    await settle(harness)

    expect(currentGoal(harness)).toMatchObject({
      phase: 'blocked',
      roundsStarted: 0,
      blockedReason: { code: 'prompt-rejected' },
    })
    expect(admittedRounds(harness)).toEqual([])
    expect(turnEndReasons(harness)).toContain('blocked')
  })

  it('blocks with checkpoint-failed instead of reserving an unpersisted round', async () => {
    fakeClock()
    const harness = await boot()
    harness.ctx.on('session/flush', () => Promise.reject(new Error('disk unavailable')))
    createGoal(harness)
    await settle(harness)

    expect(currentGoal(harness)).toMatchObject({
      phase: 'blocked',
      roundsStarted: 0,
      blockedReason: { code: 'checkpoint-failed' },
    })
    expect(admittedRounds(harness)).toEqual([])
  })

  it('blocks with driver-error when the serialized driver cannot start', async () => {
    fakeClock()
    const harness = await boot()
    const original = harness.agents.withoutInitiator
    harness.agents.withoutInitiator = () => { throw new Error('initiator scope unavailable') }
    try {
      createGoal(harness)
      await settle(harness)
      expect(currentGoal(harness)).toMatchObject({
        phase: 'blocked',
        blockedReason: { code: 'driver-error' },
      })
    } finally {
      harness.agents.withoutInitiator = original
    }
  })
})

describe('goal lifecycle races', () => {
  it('does not run a stale timer after the goal is cleared', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)

    const goal = currentGoal(harness)
    if (goal === undefined) throw new Error('expected a current goal')
    harness.goals.clear(harness.agent.agent, { id: goal.id, revision: goal.revision })
    await settle(harness)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])
    expect(currentGoal(harness)).toBeUndefined()
  })

  it('withdraws a queued round when the goal is paused before its turn starts', async () => {
    fakeClock()
    const harness = await boot()
    harness.agent.wakeHeld = true
    createGoal(harness)
    await settle(harness)
    expect(harness.agent.inbox.nextTurn).toHaveLength(1)

    const goal = currentGoal(harness)
    if (goal === undefined) throw new Error('expected an active goal')
    harness.goals.pause(harness.agent.agent, { id: goal.id, revision: goal.revision })
    await settle(harness)

    expect(harness.agent.inbox.nextTurn).toHaveLength(0)
    expect(admittedRounds(harness)).toEqual([])
    harness.agent.wakeHeld = false
    harness.agent.followup(humanMessage('after pause'))
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([])
    expect(admittedSources(harness)).toEqual([{ kind: 'user' }])
  })
})
