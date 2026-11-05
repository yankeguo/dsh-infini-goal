/**
 * Pacing behaviour of the automatic continuation driver.
 *
 * These cases run a real cordis context, real Session log, real infini-goal
 * service, and a scriptable fake agent loop under deterministic fake timers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  admittedRounds,
  admittedSources,
  boot,
  createGoal,
  currentGoal,
  disposeHarnesses,
  fakeClock,
  humanMessage,
  settle,
  subagentsStub,
} from './helpers/harness.ts'

/** Node saturates setTimeout delays above this value. */
const MAX_TIMER_MS = 2_147_483_647

afterEach(async () => {
  await disposeHarnesses()
  vi.useRealTimers()
})

/** Advance the fake clock and let every scheduled reaction settle. */
async function advance(harness: Awaited<ReturnType<typeof boot>>, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle(harness)
}

describe('automatic round pacing', () => {
  it('admits one round per eligible instant and honours the minimum interval', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness, { minIntervalMs: 60_000 })
    await settle(harness)

    expect(admittedRounds(harness)).toEqual([1])
    expect(currentGoal(harness)?.roundsStarted).toBe(1)

    // Nothing may fire before lastRoundAt + minIntervalMs.
    await advance(harness, 59_999)
    expect(admittedRounds(harness)).toEqual([1])

    await advance(harness, 1)
    expect(admittedRounds(harness)).toEqual([1, 2])
    expect(currentGoal(harness)?.roundsStarted).toBe(2)

    await advance(harness, 60_000)
    expect(admittedRounds(harness)).toEqual([1, 2, 3])
    expect(new Set(harness.agent.admitted.map(message => message.id)).size).toBe(3)
  })

  it('defers an eligible round that falls inside a quiet window until the window ends', async () => {
    fakeClock('2026-01-05T11:59:00.000Z')
    const harness = await boot()
    createGoal(harness, {
      minIntervalMs: 60_000,
      quietWindows: [{ days: [], start: '12:00', end: '13:00' }],
      timezone: 'UTC',
    })
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    // lastRoundAt + 60s lands exactly on the quiet-window start.
    await advance(harness, 60_000)
    expect(admittedRounds(harness)).toEqual([1])
    expect(currentGoal(harness)).toMatchObject({ phase: 'active', roundsStarted: 1 })

    // Still suppressed anywhere inside the window.
    await advance(harness, 30 * 60_000)
    expect(admittedRounds(harness)).toEqual([1])

    // The first eligible instant is the window end, not window end + interval.
    await advance(harness, 30 * 60_000)
    expect(admittedRounds(harness)).toEqual([1, 2])
    const last = harness.session.snapshotEvents().filter(event => event.type === 'user/message').at(-1)
    expect(last?.type === 'user/message' && last.time >= Date.parse('2026-01-05T13:00:00.000Z')).toBe(true)
  })

  it('lets human input run first and paces the next round from the last admission', async () => {
    fakeClock()
    const harness = await boot()
    createGoal(harness, { minIntervalMs: 60_000 })
    await settle(harness)
    expect(admittedSources(harness)).toEqual([{ kind: 'infini-goal', round: 1 }])

    await advance(harness, 30_000)
    harness.agent.followup(humanMessage('human priority'))
    await settle(harness)

    // The human turn is admitted before any new automatic round.
    expect(admittedSources(harness)).toEqual([
      { kind: 'infini-goal', round: 1 },
      { kind: 'user' },
    ])
    expect(admittedRounds(harness)).toEqual([1])

    // The next round still waits for the interval bound by round one.
    await advance(harness, 29_999)
    expect(admittedRounds(harness)).toEqual([1])
    await advance(harness, 1)
    expect(admittedRounds(harness)).toEqual([1, 2])
  })

  it('re-checks pacing after waiting for subagent descendants', async () => {
    fakeClock('2026-01-05T11:59:00.000Z')
    const stub = subagentsStub()
    const harness = await boot({
      subagents: { waitForChildren: () => stub.pending.promise } as never,
    })
    createGoal(harness, {
      quietWindows: [{ days: [], start: '12:00', end: '13:00' }],
      timezone: 'UTC',
    })
    await settle(harness)
    // The driver is parked on the child-agent wait before reserving round one.
    expect(admittedRounds(harness)).toEqual([])

    // The wait resolves after the quiet window opened: the round must not start.
    vi.setSystemTime(new Date('2026-01-05T12:10:00.000Z'))
    stub.pending.resolve(true)
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([])

    await advance(harness, 50 * 60_000)
    expect(admittedRounds(harness)).toEqual([1])
  })

  it('splits waits longer than the maximum timer span', async () => {
    fakeClock()
    const harness = await boot()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    createGoal(harness, { minIntervalMs: 30 * 24 * 60 * 60 * 1_000 })
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    const delays = setTimeoutSpy.mock.calls
      .map(call => call[1])
      .filter((delay): delay is number => typeof delay === 'number')
    expect(delays.length).toBeGreaterThan(0)
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_MS)

    await advance(harness, MAX_TIMER_MS)
    expect(admittedRounds(harness)).toEqual([1])
    await advance(harness, 30 * 24 * 60 * 60 * 1_000 - MAX_TIMER_MS)
    expect(admittedRounds(harness)).toEqual([1, 2])
    setTimeoutSpy.mockRestore()
  })

  it('stops the armed timer on pause and re-arms pacing on resume', async () => {
    fakeClock()
    const harness = await boot()
    const created = createGoal(harness, { minIntervalMs: 60_000 })
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1])

    // Host pause while idle simply clears the armed timer.
    harness.goals.pause(harness.agent.agent, { id: created.id, revision: created.revision })
    await settle(harness)
    expect(currentGoal(harness)?.phase).toBe('paused')

    await advance(harness, 5 * 60_000)
    expect(admittedRounds(harness)).toEqual([1])

    const paused = currentGoal(harness)
    if (paused === undefined) throw new Error('expected a paused goal')
    harness.goals.resume(harness.agent.agent, { id: paused.id, revision: paused.revision })
    await settle(harness)
    expect(admittedRounds(harness)).toEqual([1, 2])
  })
})
