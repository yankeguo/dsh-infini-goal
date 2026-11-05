/**
 * Re-entrancy and serialization fences around durable goal mutations.
 *
 * `Session.append` refuses to publish a new event from inside a `session/event`
 * observer, so anything the driver wants to persist in reaction to `turn/end`
 * must escape that publish. The serialized driver must also survive triggers
 * that fire while a checkpoint flush is settling.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  admittedRounds,
  boot,
  countFlushes,
  createGoal,
  currentGoal,
  deferred,
  disposeHarnesses,
  fakeClock,
  flushMicrotasks,
  goalOperations,
  settle,
} from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'

afterEach(async () => {
  await disposeHarnesses()
  vi.useRealTimers()
})

/** Durable events in append order. */
function eventTypes(harness: Harness): string[] {
  return harness.session.snapshotEvents().map(event => event.type)
}

describe('durable mutations from session/event observers', () => {
  it('persists a max-tokens block after the turn/end event that caused it', async () => {
    fakeClock()
    const harness = await boot()
    harness.agent.outcomes.push({ kind: 'max-tokens' })
    createGoal(harness)
    await settle(harness)

    expect(currentGoal(harness)?.blockedReason?.code).toBe('max-tokens')
    const types = eventTypes(harness)
    const turnEnd = types.lastIndexOf('turn/end')
    const block = types.lastIndexOf('plugin:infini-goal/change')
    expect(turnEnd).toBeGreaterThanOrEqual(0)
    expect(block).toBeGreaterThan(turnEnd)
    expect(goalOperations(harness, 'block')).toEqual(['block'])
  })

  it('persists an abort pause without a re-entrant append failure', async () => {
    fakeClock()
    const harness = await boot()
    const warnings: string[] = []
    const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger)
    vi.spyOn(harness.ctx.logger, 'warn').mockImplementation((message: string) => {
      warnings.push(message)
      originalWarn(message)
    })
    createGoal(harness)
    await settle(harness)

    const gate = deferred<void>()
    harness.agent.turnGate = gate
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    harness.agent.cancel({ kind: 'user' })
    gate.resolve()
    await settle(harness)

    expect(currentGoal(harness)?.phase).toBe('paused')
    expect(goalOperations(harness, 'pause')).toHaveLength(1)
    expect(warnings.filter(message => message.includes('reenter'))).toEqual([])
  })
})

describe('serialized driver', () => {
  it('does not start a nested drive when a flush observer mutates the goal', async () => {
    fakeClock()
    const harness = await boot()
    let depth = 0
    let maxDepth = 0
    let flushes = 0
    let edited = false
    harness.ctx.on('session/flush', () => {
      depth += 1
      maxDepth = Math.max(maxDepth, depth)
      flushes += 1
      try {
        if (flushes === 2 && !edited) {
          edited = true
          const goal = currentGoal(harness)
          if (goal === undefined) throw new Error('expected an active goal during the checkpoint')
          harness.goals.edit(harness.agent.agent, { id: goal.id, revision: goal.revision }, { objective: 'edited during flush' })
        }
      } finally {
        depth -= 1
      }
    })
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    // The second checkpoint settles round one; the observer edits the goal.
    await vi.advanceTimersByTimeAsync(1_000)
    await settle(harness)

    expect(edited).toBe(true)
    // A nested drive would observe a flush inside the observer's flush.
    expect(maxDepth).toBe(1)
    expect(flushes).toBeGreaterThanOrEqual(3)
    expect(currentGoal(harness)?.objective).toBe('edited during flush')
    expect(admittedRounds(harness)).toEqual([1, 2])

    // The round admitted after the edit carries the edited revision.
    const rounds = harness.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'infini-goal'
        ? [{ round: event.data.source.round, revision: event.data.source.revision }]
        : [])
    expect(rounds.at(-1)).toEqual({ round: 2, revision: 2 })
  })

  it('serializes re-entrant trigger requests into one driver task', async () => {
    fakeClock()
    const harness = await boot()
    const flushes = countFlushes(harness)
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    // A goal resume during a flush observer requests another drive pass; it must
    // coalesce onto the live driver instead of starting a second one.
    let resumed = false
    harness.ctx.on('session/flush', () => {
      if (resumed) return
      resumed = true
      const goal = currentGoal(harness)
      if (goal === undefined) return
      harness.goals.edit(harness.agent.agent, { id: goal.id, revision: goal.revision }, { objective: 'rescheduled' })
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await settle(harness)

    expect(resumed).toBe(true)
    expect(flushes.count()).toBeGreaterThanOrEqual(3)
    expect(admittedRounds(harness)).toEqual([1, 2])
    expect(currentGoal(harness)?.objective).toBe('rescheduled')
  })
})

describe('revision boundary', () => {
  it('withdraws a not-yet-admitted round when the goal is edited mid-admission', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    // Edit exactly after the driver's post-decision validation, before the loop
    // commits the round's user/message: the old-revision round must be withdrawn.
    let editInjected = false
    harness.agent.afterPreStep = () => {
      if (editInjected) return
      const goal = currentGoal(harness)
      if (goal === undefined || goal.roundsStarted !== 1) return
      editInjected = true
      harness.goals.edit(harness.agent.agent, { id: goal.id, revision: goal.revision }, { objective: 'edited mid-admission' })
    }
    await vi.advanceTimersByTimeAsync(1_000)
    await settle(harness)

    expect(editInjected).toBe(true)
    // The projection must still be readable and must carry the new revision.
    expect(currentGoal(harness)).toMatchObject({ revision: 2, objective: 'edited mid-admission', roundsStarted: 2 })
    // The aborted attempt is retried under the new revision as round 2.
    expect(admittedRounds(harness)).toEqual([1, 2])
    const rounds = harness.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'infini-goal'
        ? [{ round: event.data.source.round, revision: event.data.source.revision }]
        : [])
    expect(rounds.at(-1)).toEqual({ round: 2, revision: 2 })
  })

  it('lets a host complete terminate a claimed round without corrupting the projection', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    let completed = false
    harness.agent.afterPreStep = () => {
      if (completed) return
      const goal = currentGoal(harness)
      if (goal === undefined || goal.roundsStarted !== 1) return
      completed = true
      harness.goals.complete(harness.agent.agent, { id: goal.id, revision: goal.revision })
    }
    await vi.advanceTimersByTimeAsync(1_000)
    await settle(harness)

    expect(completed).toBe(true)
    expect(currentGoal(harness)?.phase).toBe('complete')
    expect(admittedRounds(harness)).toEqual([1])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])
  })
})
