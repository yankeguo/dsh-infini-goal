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
import SessionStore, { SessionId, SessionLogOffset, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { InfiniGoalOperation, InfiniGoalView } from '@yankeguo/dsh-infini-goal-protocol'
import {
  INFINI_GOAL_RECORD_TYPE,
  InfiniGoalError,
  InfiniGoalService,
  decodeInfiniGoalChange,
  foldInfiniGoal,
} from '../src/index.ts'
import type { InfiniGoalChange } from '../src/domain.ts'

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
async function boot(config: Record<string, unknown> = {}, seed?: readonly SessionEvent[]): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  sessionCounter += 1
  const sessionId = SessionId(`infini-goal-probe-${String(sessionCounter)}`)
  const session = seed === undefined ? ctx.sessions.create(sessionId) : ctx.sessions.create(sessionId, { seed })
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

describe('InfiniGoalService durable representation', () => {
  /** Every committed infini-goal change record in one session log. */
  function changeRecords(session: Session): SessionEvent[] {
    return session.snapshotEvents().filter(event => pluginRecordOf(event)?.type === INFINI_GOAL_RECORD_TYPE)
  }

  it('writes durable changes as ignorable plugin records', async () => {
    const { ctx, agent, session } = await boot()
    const created = ctx.infiniGoals.create(agent, { objective: 'durable' })
    const paused = ctx.infiniGoals.pause(agent, { id: created.id, revision: created.revision })
    ctx.infiniGoals.clear(agent, { id: paused.id, revision: paused.revision })

    const records = changeRecords(session)
    expect(records).toHaveLength(3)
    for (const event of records) {
      // Persistence-compat invariant: the harness's stored-event validation
      // accepts an unknown type only when the envelope carries this marker.
      expect(event.ignorable).toBe(true)
      expect(String(event.type)).toBe(INFINI_GOAL_RECORD_TYPE)
      expect(pluginRecordOf(event)?.type).toBe(INFINI_GOAL_RECORD_TYPE)
    }
    const operations = records.map(event => decodeInfiniGoalChange(pluginRecordOf(event)?.data)?.operation)
    expect(operations).toEqual(['create', 'pause', 'clear'] satisfies InfiniGoalOperation[])
    // The retired required event type is never appended.
    expect(session.snapshotEvents().some(event => String(event.type) === 'infini-goal/change')).toBe(false)
    // The durable stream still folds to the live state.
    expect(foldInfiniGoal(session.snapshotEvents())).toMatchObject({
      roundsStarted: 0,
      lastRoundAt: null,
      lastRef: { id: created.id, revision: 3 },
    })
  })

  it('captures corruption in a plugin record while the client view stays at the last valid goal', async () => {
    const { ctx, agent, session } = await boot()
    ctx.infiniGoals.create(agent, { objective: 'poisoned record' })
    const lastValid = ctx.sessionProjections.snapshot(session, ['infiniGoal']).values['infiniGoal']
    appendPluginRecord(session, INFINI_GOAL_RECORD_TYPE, { kind: 'not-a-change' } as unknown as InfiniGoalChange)
    expect(ctx.sessionProjections.snapshot(session, ['infiniGoal']).values['infiniGoal']).toEqual(lastValid)
    expect(() => ctx.infiniGoals.get(agent)).toThrow(/infini-goal replay failed at session event \d+: infini-goal change at session event \d+ has an invalid kind/)
  })

  it('replays the whole goal from a restored session log', async () => {
    const { ctx, agent, session } = await boot()
    const created = ctx.infiniGoals.create(agent, { objective: 'resume me' })
    appendRound(session, created, 1)
    const afterRound = ctx.infiniGoals.get(agent) as InfiniGoalView
    const edited = ctx.infiniGoals.edit(agent, { id: afterRound.id, revision: afterRound.revision }, {
      objective: 'resumed objective',
      minIntervalMs: 9_000,
    })
    const stored = session.snapshotEvents()

    // A fresh harness over a Session seeded with the stored log is the same
    // replay path a resumed Session takes: the projection folds every record.
    const resumed = await boot({ defaultMinIntervalMs: 1_000 }, stored)
    expect(ctx.infiniGoals.get(agent)).toMatchObject({
      id: edited.id,
      revision: edited.revision,
      phase: 'active',
      objective: 'resumed objective',
      minIntervalMs: 9_000,
      roundsStarted: 1,
      lastRoundAt: afterRound.lastRoundAt,
      createdAt: edited.createdAt,
      updatedAt: edited.updatedAt,
    })
    expect(resumed.ctx.infiniGoals.get(resumed.agent)).toEqual(ctx.infiniGoals.get(agent))
    expect(foldInfiniGoal(resumed.session.snapshotEvents())).toEqual(foldInfiniGoal(stored))
    // A mutation after restore continues from the replayed revision.
    const paused = resumed.ctx.infiniGoals.pause(resumed.agent, { id: edited.id, revision: edited.revision })
    expect(paused).toMatchObject({ phase: 'paused', revision: edited.revision + 1, roundsStarted: 1 })
  })

  it('checkpoints and restores the projection state it produced', async () => {
    const { ctx, agent, session } = await boot()
    const created = ctx.infiniGoals.create(agent, { objective: 'checkpoint me' })
    appendRound(session, created, 1)
    const afterRound = ctx.infiniGoals.get(agent) as InfiniGoalView
    const edited = ctx.infiniGoals.edit(agent, { id: afterRound.id, revision: afterRound.revision }, {
      objective: 'checkpointed',
      quietWindows: [{ days: [1, 2], start: '22:00', end: '06:00' }],
    })
    const blocked = ctx.infiniGoals.block(agent, { id: edited.id, revision: edited.revision }, {
      code: 'max-tokens',
      message: 'budget exhausted',
    })
    ctx.infiniGoals.resume(agent, { id: blocked.id, revision: blocked.revision })
    const live = ctx.sessionProjections.snapshot(session, ['infiniGoal']).values['infiniGoal']
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    // `restore` seeds from the checkpoint row through `stateSchema`, so this also
    // guards that every state the fold produces passes its own persisted schema.
    const restored = ctx.sessionProjections.restore(
      checkpoint,
      [...session.snapshotEvents()],
      SessionLogOffset(0),
      session.header,
      session.inheritedEventCount,
    )
    expect(restored.snapshot.values['infiniGoal']).toEqual(live)
    expect(restored.checkpoint['infiniGoal']?.val).toEqual(checkpoint['infiniGoal']?.val)
  })

  it('replays retired infini-goal/change events from a seeded session', async () => {
    const { ctx, agent, session } = await boot()
    const created = ctx.infiniGoals.create(agent, { objective: 'legacy continuity' })
    const legacyEvents = session.snapshotEvents().map(event => (
      pluginRecordOf(event)?.type === INFINI_GOAL_RECORD_TYPE
        ? { ...event, type: 'infini-goal/change', data: pluginRecordOf(event)?.data } as unknown as SessionEvent
        : event
    ))
    const resumed = await boot({}, legacyEvents)
    expect(resumed.ctx.infiniGoals.get(resumed.agent)).toMatchObject({
      id: created.id,
      revision: created.revision,
      objective: 'legacy continuity',
      phase: 'active',
    })
  })
})

describe('InfiniGoalService mutation coverage', () => {
  /** A quiet-window pair that leaves no triggerable local time. */
  function allDayWindows(): Array<{ days: number[]; start: string; end: string }> {
    return [
      { days: [], start: '00:00', end: '12:00' },
      { days: [], start: '12:00', end: '00:00' },
    ]
  }

  it('edits objective and pacing settings through one revision', async () => {
    const { ctx, agent, events } = await boot()
    const created = ctx.infiniGoals.create(agent, { objective: 'edit me' })
    appendRound(agent.session, created, 1)
    const before = ctx.infiniGoals.get(agent) as InfiniGoalView
    const edited = ctx.infiniGoals.edit(agent, { id: before.id, revision: before.revision }, {
      objective: '  edited objective  ',
      minIntervalMs: 9_000,
      quietWindows: [{ days: [5, 1], start: '9:00', end: '18:00' }],
      timezone: 'Asia/Tokyo',
    })
    expect(edited).toMatchObject({
      id: before.id,
      revision: 2,
      objective: 'edited objective',
      phase: 'active',
      minIntervalMs: 9_000,
      timezone: 'Asia/Tokyo',
      roundsStarted: 1,
      lastRoundAt: before.lastRoundAt,
      createdAt: before.createdAt,
    })
    expect(edited.quietWindows).toEqual([{ days: [1, 5], start: '09:00', end: '18:00' }])
    expect(edited.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
    expect(events.map(change => change.operation)).toEqual(['create', 'edit'])
    expect(ctx.infiniGoals.get(agent)).toEqual(edited)
  })

  it('rejects empty, malformed, stale, and unschedulable edits without changing the goal', async () => {
    const { ctx, agent } = await boot()
    const created = ctx.infiniGoals.create(agent, { objective: 'errors' })
    const ref = { id: created.id, revision: created.revision }
    expectCode(() => ctx.infiniGoals.edit(agent, ref, {}), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(() => ctx.infiniGoals.edit(agent, ref, { objective: '   ' }), 'INFINI_GOAL_INVALID_OBJECTIVE')
    expectCode(() => ctx.infiniGoals.edit(agent, ref, { minIntervalMs: 5 }), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(() => ctx.infiniGoals.edit(agent, ref, { timezone: 'Nope/Nope' }), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(() => ctx.infiniGoals.edit(agent, ref, { quietWindows: allDayWindows() }), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(
      () => ctx.infiniGoals.edit(agent, { id: created.id, revision: created.revision + 1 }, { objective: 'x' }),
      'INFINI_GOAL_STALE_REVISION',
    )
    expect(ctx.infiniGoals.get(agent)).toMatchObject({ revision: 1, objective: 'errors' })
  })

  it('completes from the paused and blocked phases', async () => {
    const paused = await boot()
    const pausedCreated = paused.ctx.infiniGoals.create(paused.agent, { objective: 'paused complete' })
    const pausedGoal = paused.ctx.infiniGoals.pause(paused.agent, {
      id: pausedCreated.id,
      revision: pausedCreated.revision,
    })
    expect(paused.ctx.infiniGoals.complete(paused.agent, {
      id: pausedGoal.id,
      revision: pausedGoal.revision,
    })).toMatchObject({ phase: 'complete', revision: 3 })

    const blocked = await boot()
    const blockedCreated = blocked.ctx.infiniGoals.create(blocked.agent, { objective: 'blocked complete' })
    const blockedGoal = blocked.ctx.infiniGoals.block(blocked.agent, {
      id: blockedCreated.id,
      revision: blockedCreated.revision,
    }, { code: 'max-tokens', message: 'budget exhausted' })
    const completed = blocked.ctx.infiniGoals.complete(blocked.agent, {
      id: blockedGoal.id,
      revision: blockedGoal.revision,
    })
    expect(completed).toMatchObject({ phase: 'complete', revision: 3 })
    // Completion from blocked drops the durable reason.
    expect('blockedReason' in completed).toBe(false)
  })

  it('clears with a tombstone, releases the slot, and starts a fresh goal', async () => {
    const { ctx, agent } = await boot()
    const first = ctx.infiniGoals.create(agent, { objective: 'first' })
    appendRound(agent.session, first, 1)
    const cleared = ctx.infiniGoals.clear(agent, { id: first.id, revision: first.revision })
    expect(cleared).toEqual({ id: first.id, revision: 2 })
    expect(ctx.infiniGoals.get(agent)).toBeUndefined()
    expect(ctx.infiniGoals.plan(agent)).toBeUndefined()
    expectCode(() => ctx.infiniGoals.clear(agent, cleared), 'INFINI_GOAL_NOT_FOUND')
    expectCode(() => ctx.infiniGoals.pause(agent, { id: first.id, revision: 1 }), 'INFINI_GOAL_NOT_FOUND')
    const second = ctx.infiniGoals.create(agent, { objective: 'second' })
    expect(second.id).not.toBe(first.id)
    expect(second).toMatchObject({ phase: 'active', revision: 1, roundsStarted: 0, lastRoundAt: null })
    expectCode(
      () => ctx.infiniGoals.clear(agent, { id: second.id, revision: second.revision + 1 }),
      'INFINI_GOAL_STALE_REVISION',
    )
  })

  it('rejects mutations from a non-live agent instance', async () => {
    const { ctx, agent } = await boot()
    const created = ctx.infiniGoals.create(agent, { objective: 'live' })
    const ref = { id: created.id, revision: created.revision }
    const impostor = { id: agent.id, session: agent.session } as unknown as Agent
    expectCode(() => ctx.infiniGoals.create(impostor, { objective: 'x' }), 'INFINI_GOAL_AGENT_NOT_LIVE')
    expectCode(() => ctx.infiniGoals.edit(impostor, ref, { objective: 'x' }), 'INFINI_GOAL_AGENT_NOT_LIVE')
    expectCode(() => ctx.infiniGoals.pause(impostor, ref), 'INFINI_GOAL_AGENT_NOT_LIVE')
    expectCode(() => ctx.infiniGoals.resume(impostor, ref), 'INFINI_GOAL_AGENT_NOT_LIVE')
    expectCode(() => ctx.infiniGoals.complete(impostor, ref), 'INFINI_GOAL_AGENT_NOT_LIVE')
    expectCode(() => ctx.infiniGoals.block(impostor, ref, { code: 'x', message: 'y' }), 'INFINI_GOAL_AGENT_NOT_LIVE')
    expectCode(() => ctx.infiniGoals.clear(impostor, ref), 'INFINI_GOAL_AGENT_NOT_LIVE')
    expectCode(() => ctx.infiniGoals.plan(impostor), 'INFINI_GOAL_AGENT_NOT_LIVE')
  })

  it('fails plugin construction when the deployment defaults can never trigger', async () => {
    await expect(boot({ defaultQuietWindows: allDayWindows() })).rejects.toThrow(/cover every local time/)
  })
})
