/**
 * Plugin-loading, session-lifecycle, and unload behaviour of the driver.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import {
  admittedRounds,
  boot,
  countFlushes,
  createGoal,
  currentGoal,
  deferred,
  disposeHarnesses,
  emitAgentCreated,
  emitAgentDisposed,
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

/** Advance fake time and settle. */
async function advance(harness: Harness, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle(harness)
}

/** Count goal session events regardless of their record type. */
function goalEventCount(harness: Harness): number {
  return harness.session.snapshotEvents().filter(event => event.type.endsWith('infini-goal/change')).length
}

describe('plugin load policy', () => {
  it('continues an active goal loaded before the driver by default', async () => {
    fakeClock()
    const harness = await boot({
      beforeDriver: base => { createGoal(base) },
    })
    // The initial drive runs while the fiber is still loading; the safety poll
    // re-checks once the plugin is active.
    await advance(harness, 100)
    expect(admittedRounds(harness)).toEqual([1])
  })

  it('persists a pause for an active goal when autoContinueOnStart is false', async () => {
    fakeClock()
    const harness = await boot({
      driverConfig: { autoContinueOnStart: false, pollFloorMs: 100 },
      beforeDriver: base => { createGoal(base) },
    })
    await settle(harness)

    expect(currentGoal(harness)).toMatchObject({ phase: 'paused', roundsStarted: 0 })
    expect(goalOperations(harness, 'pause')).toHaveLength(1)
    expect(admittedRounds(harness)).toEqual([])
    await advance(harness, 5 * 60_000)
    expect(admittedRounds(harness)).toEqual([])

    // Only an explicit human resume restarts automatic continuation.
    const paused = currentGoal(harness)
    if (paused === undefined) throw new Error('expected a paused goal')
    harness.goals.resume(harness.agent.agent, { id: paused.id, revision: paused.revision })
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])
  })

  it('leaves an already-paused goal paused when autoContinueOnStart is true', async () => {
    fakeClock()
    const harness = await boot({
      beforeDriver: base => {
        const goal = createGoal(base)
        base.goals.pause(base.agent.agent, { id: goal.id, revision: goal.revision })
      },
    })
    await settle(harness)

    expect(currentGoal(harness)).toMatchObject({ phase: 'paused', roundsStarted: 0 })
    expect(goalOperations(harness, 'pause')).toHaveLength(1)
    expect(admittedRounds(harness)).toEqual([])

    const paused = currentGoal(harness)
    if (paused === undefined) throw new Error('expected a paused goal')
    harness.goals.resume(harness.agent.agent, { id: paused.id, revision: paused.revision })
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])
  })

  it('still drives a goal created after load when autoContinueOnStart is false', async () => {
    fakeClock()
    const harness = await boot({ driverConfig: { autoContinueOnStart: false, pollFloorMs: 100 } })
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])
  })

  it('applies autoContinueOnStart=false when an agent is (re)created', async () => {
    fakeClock()
    const harness = await boot({ driverConfig: { autoContinueOnStart: false, pollFloorMs: 100 } })
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    emitAgentCreated(harness, 'resume')
    await settle(harness)
    expect(currentGoal(harness)?.phase).toBe('paused')
    await advance(harness, 5 * 60_000)
    expect(admittedRounds(harness)).toEqual([1])
  })

  it('keeps a running goal scheduled when an agent is (re)created with auto continuation on', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    emitAgentCreated(harness, 'resume')
    await settle(harness)
    await advance(harness, 1_000)
    expect(admittedRounds(harness)).toEqual([1, 2])
  })
})

describe('unload and disposal', () => {
  it('clears every timer on unload so no round can start afterwards', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])
    const changesBefore = goalEventCount(harness)

    await harness.ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await flushMicrotasks()

    expect(admittedRounds(harness)).toEqual([1])
    expect(goalEventCount(harness)).toBe(changesBefore)
    expect(goalOperations(harness, 'pause')).toEqual([])
  })

  it('withdraws a round message that was queued but never admitted', async () => {
    fakeClock()
    const harness = await boot()
    harness.agent.wakeHeld = true
    createGoal(harness)
    await settle(harness)
    expect(harness.agent.inbox.nextTurn).toHaveLength(1)

    await harness.ctx.fiber.dispose()
    expect(harness.agent.inbox.nextTurn).toHaveLength(0)
    expect(admittedRounds(harness)).toEqual([])
    expect(goalOperations(harness, 'pause')).toEqual([])
  })

  it('aborts a live automatic round on unload without pausing the durable goal', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    const gate = deferred<void>()
    harness.agent.turnGate = gate
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    const disposing = harness.ctx.fiber.dispose()
    await flushMicrotasks()
    gate.resolve()
    await disposing

    // The durable phase stays active: the round was aborted, not paused.
    expect(goalOperations(harness, 'pause')).toEqual([])
    expect(admittedRounds(harness)).toEqual([1])
    expect(harness.session.snapshotEvents().flatMap(event =>
      event.type === 'turn/end' ? [(event.data.reason as TurnEndReason).kind] : [])).toContain('aborted')
  })

  it('stops scheduling when the agent is disposed', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    emitAgentDisposed(harness)
    await advance(harness, 5 * 60_000)
    expect(admittedRounds(harness)).toEqual([1])
    expect(goalOperations(harness, 'pause')).toEqual([])
  })

  it('re-checks durability once before every new round', async () => {
    fakeClock()
    const harness = await boot()
    const flushes = countFlushes(harness)
    createGoal(harness)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])
    expect(flushes.count()).toBeGreaterThanOrEqual(1)
    expect(goalEventCount(harness)).toBeGreaterThan(0)
  })
})

describe('configuration', () => {
  it('rejects an unsafe poll floor before installing anything', async () => {
    fakeClock()
    await expect(boot({ driverConfig: { pollFloorMs: 10 } })).rejects.toThrow(/pollFloorMs/)
  })
})
