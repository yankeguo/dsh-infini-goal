/**
 * Integration coverage for the core service against a real cordis Context, the
 * real Session log, and the real Session-projection registry.
 *
 * No agent loop, timers, network, or persistent store is involved: a fake
 * in-memory `agents` registry satisfies the service injection and every
 * mutation is driven through the public `ctx.infiniGoals` API.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { InfiniGoalView } from '@yankeguo/dsh-infini-goal-protocol'
import { InfiniGoalError, InfiniGoalService } from '../src/index.ts'

/** One booted harness: registry, session, fake agent, and the loaded service. */
interface Harness {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly events: Array<{ operation: string; ref: { id: string; revision: number }; goal?: InfiniGoalView }>
}

/** Monotonic counter so every booted session has a deterministic unique id. */
let sessionCounter = 0

/** Boot cordis with the real services and load the infini-goal core plugin. */
async function boot(config: Record<string, unknown> = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  sessionCounter += 1
  const session = ctx.sessions.create(SessionId(`infini-goal-probe-${String(sessionCounter)}`))
  const agent = { id: session.id, session }
  const agents = {
    get: (id: typeof session.id) => (id === session.id ? agent : undefined),
  }
  ctx.provide('agents', agents as unknown as AgentRegistry)
  await ctx.plugin(InfiniGoalService, {
    defaultMinIntervalMs: 5_000,
    defaultQuietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
    ...config,
  })
  const events: Harness['events'] = []
  ctx.on('infini-goal/changed', payload => { events.push(payload.change) })
  return { ctx, session, agent: agent as unknown as Agent, events }
}

/** Capture one domain rejection from the service. */
function capture(run: () => unknown): unknown {
  try {
    run()
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected the operation to throw')
}

/** Assert one operation fails with an expected {@link InfiniGoalError} code. */
function expectCode(run: () => unknown, code: InfiniGoalError['code']): InfiniGoalError {
  const error = capture(run)
  expect(error).toBeInstanceOf(InfiniGoalError)
  expect((error as InfiniGoalError).code).toBe(code)
  return error as InfiniGoalError
}

/** Append one admitted automatic round directly to the real session log. */
function appendRound(session: Session, goal: InfiniGoalView, round: number): SessionEvent {
  const data = createUserMessage({
    content: [{ type: 'text', text: `round ${String(round)}` }],
    source: { kind: 'infini-goal', goalId: goal.id, revision: goal.revision, round },
  })
  return session.append('user/message', data, { surfaceOp: 'append' })
}

describe('InfiniGoalService against a real session', () => {
  it('registers the projection and starts with no current goal', async () => {
    const { ctx, agent, session } = await boot()
    expect(ctx.infiniGoals.get(agent)).toBeUndefined()
    expect(ctx.infiniGoals.plan(agent)).toBeUndefined()
    expect(ctx.sessionProjections.snapshot(session, ['infiniGoal']).values['infiniGoal']).toBeNull()
  })

  it('creates a goal that merges deployment defaults and lands in the projection', async () => {
    const { ctx, agent, session } = await boot({ defaultMinIntervalMs: 12_000, timezone: 'UTC' })
    const goal = ctx.infiniGoals.create(agent, { objective: '  integration objective  ' })
    expect(goal).toMatchObject({
      objective: 'integration objective',
      revision: 1,
      phase: 'active',
      minIntervalMs: 12_000,
      quietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
      timezone: 'UTC',
      roundsStarted: 0,
      lastRoundAt: null,
    })
    expect(ctx.sessionProjections.snapshot(session, ['infiniGoal']).values['infiniGoal']).toMatchObject({
      goal: { id: goal.id, revision: 1, objective: 'integration objective' },
      roundsStarted: 0,
      lastRoundAt: null,
    })
    // The default quiet windows are weekdays; the deployment default is in force.
    const plan = ctx.infiniGoals.plan(agent)
    expect(plan?.now).toBeGreaterThan(0)
    expect(plan?.nextAt).toBeGreaterThanOrEqual(plan?.now ?? 0)
    expect(['ready', 'interval', 'quiet-window']).toContain(plan?.reason)
  })

  it('runs the whole CAS lifecycle and records the live change events', async () => {
    const { ctx, agent, session, events } = await boot()
    const created = ctx.infiniGoals.create(agent, { objective: 'lifecycle' })
    appendRound(session, created, 1)
    const afterRound = ctx.infiniGoals.get(agent) as InfiniGoalView
    expect(afterRound.roundsStarted).toBe(1)
    expect(afterRound.lastRoundAt).not.toBeNull()
    expect(afterRound.revision).toBe(1)

    const paused = ctx.infiniGoals.pause(agent, { id: afterRound.id, revision: afterRound.revision })
    expect(paused.phase).toBe('paused')
    expect(paused.roundsStarted).toBe(1)
    expect(paused.lastRoundAt).toBe(afterRound.lastRoundAt)
    const resumed = ctx.infiniGoals.resume(agent, { id: paused.id, revision: paused.revision })
    expect(resumed.phase).toBe('active')
    const blocked = ctx.infiniGoals.block(agent, { id: resumed.id, revision: resumed.revision }, {
      code: 'max-tokens',
      message: '  token budget exhausted  ',
    })
    expect(blocked).toMatchObject({ phase: 'blocked', blockedReason: { code: 'max-tokens', message: 'token budget exhausted' } })
    const resumedAgain = ctx.infiniGoals.resume(agent, { id: blocked.id, revision: blocked.revision })
    expect(resumedAgain.blockedReason).toBeUndefined()
    const completed = ctx.infiniGoals.complete(agent, { id: resumedAgain.id, revision: resumedAgain.revision })
    expect(completed.phase).toBe('complete')
    const cleared = ctx.infiniGoals.clear(agent, { id: completed.id, revision: completed.revision })
    expect(cleared).toEqual({ id: completed.id, revision: completed.revision + 1 })
    expect(ctx.infiniGoals.get(agent)).toBeUndefined()

    expect(events.map(change => change.operation)).toEqual([
      'create',
      'pause',
      'resume',
      'block',
      'resume',
      'complete',
      'clear',
    ])
    expect(events[0]?.ref).toEqual({ id: created.id, revision: 1 })
    expect(events.at(-1)?.goal).toBeUndefined()
    for (const change of events) expect(change.ref.revision).toBeGreaterThan(0)
  })

  it('observes admitted rounds through the real session log fold', async () => {
    const { ctx, agent, session } = await boot()
    const goal = ctx.infiniGoals.create(agent, { objective: 'rounds' })
    expect(ctx.infiniGoals.get(agent)?.roundsStarted).toBe(0)
    appendRound(session, goal, 1)
    const afterFirst = ctx.infiniGoals.get(agent) as InfiniGoalView
    expect(afterFirst.roundsStarted).toBe(1)
    appendRound(session, afterFirst, 2)
    const afterSecond = ctx.infiniGoals.get(agent) as InfiniGoalView
    expect(afterSecond.roundsStarted).toBe(2)
    expect(afterSecond.lastRoundAt).toBeGreaterThanOrEqual(afterFirst.lastRoundAt ?? 0)
    // Mutations preserve the replayed counters.
    const paused = ctx.infiniGoals.pause(agent, { id: afterSecond.id, revision: afterSecond.revision })
    expect(paused.roundsStarted).toBe(2)
    expect(paused.lastRoundAt).toBe(afterSecond.lastRoundAt)
  })

  it('rejects stale refs, illegal transitions, and unknown agents with stable codes', async () => {
    const { ctx, agent, session } = await boot()
    const created = ctx.infiniGoals.create(agent, { objective: 'errors' })
    expectCode(() => ctx.infiniGoals.pause(agent, { id: created.id, revision: 2 }), 'INFINI_GOAL_STALE_REVISION')
    expectCode(() => ctx.infiniGoals.create(agent, { objective: 'again' }), 'INFINI_GOAL_ALREADY_EXISTS')
    expectCode(() => ctx.infiniGoals.get({ id: session.id, session } as unknown as Agent), 'INFINI_GOAL_AGENT_NOT_LIVE')
    const paused = ctx.infiniGoals.pause(agent, { id: created.id, revision: created.revision })
    expectCode(() => ctx.infiniGoals.pause(agent, { id: paused.id, revision: paused.revision }), 'INFINI_GOAL_INVALID_TRANSITION')
    expectCode(() => ctx.infiniGoals.block(agent, { id: paused.id, revision: paused.revision }, {
      code: 'Bad Code',
      message: 'x',
    }), 'INFINI_GOAL_INVALID_BLOCK_REASON')
    ctx.infiniGoals.clear(agent, { id: paused.id, revision: paused.revision })
    expectCode(() => ctx.infiniGoals.pause(agent, { id: paused.id, revision: paused.revision + 1 }), 'INFINI_GOAL_NOT_FOUND')
    expectCode(() => ctx.infiniGoals.create(agent, { objective: '   ' }), 'INFINI_GOAL_INVALID_OBJECTIVE')
    expectCode(() => ctx.infiniGoals.create(agent, {
      objective: 'x',
      quietWindows: [{ days: [], start: '00:00', end: '12:00' }, { days: [], start: '12:00', end: '00:00' }],
    }), 'INFINI_GOAL_INVALID_SETTINGS')
  })

  it('replaces a completed goal and resets the replayed counters', async () => {
    const { ctx, agent } = await boot()
    const first = ctx.infiniGoals.create(agent, { objective: 'first' })
    appendRound(agent.session, first, 1)
    const completed = ctx.infiniGoals.complete(agent, { id: first.id, revision: first.revision })
    const second = ctx.infiniGoals.create(agent, { objective: 'second' })
    expect(second.id).not.toBe(completed.id)
    expect(second).toMatchObject({ phase: 'active', revision: 1, roundsStarted: 0, lastRoundAt: null })
    expect(second.createdAt).toBeGreaterThanOrEqual(completed.updatedAt)
    appendRound(agent.session, second, 1)
    expect(ctx.infiniGoals.get(agent)).toMatchObject({ roundsStarted: 1, revision: 1 })
  })
})
