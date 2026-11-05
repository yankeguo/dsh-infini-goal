import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { InfiniGoalError } from '@yankeguo/dsh-infini-goal'
import { planTrigger } from '@yankeguo/dsh-infini-goal-protocol'
import type {
  InfiniGoalBlockReason,
  InfiniGoalCreateRequest,
  InfiniGoalEditRequest,
  InfiniGoalPhase,
  InfiniGoalRef,
  InfiniGoalView,
  TriggerPlan,
} from '@yankeguo/dsh-infini-goal-protocol'
import { apply } from '../src/index.ts'

const NOW = Date.now()

/** Captured tool definition with just the surface these tests call. */
interface CapturedTool {
  readonly name: string
  readonly parameters: unknown
  readonly presentCall?: (args: unknown) => unknown
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** Minimal in-memory stand-in for `ctx.infiniGoals`, matching the core's semantics. */
class FakeInfiniGoals {
  goal: InfiniGoalView | undefined

  get(_agent: Agent): InfiniGoalView | undefined {
    return this.goal
  }

  plan(_agent: Agent): TriggerPlan | undefined {
    return this.goal === undefined ? undefined : planTrigger(this.goal, this.goal.lastRoundAt, Date.now())
  }

  create(_agent: Agent, request: InfiniGoalCreateRequest): InfiniGoalView {
    if (this.goal !== undefined && this.goal.phase !== 'complete') {
      throw new InfiniGoalError('already exists', 'INFINI_GOAL_ALREADY_EXISTS')
    }
    this.goal = {
      id: 'goal-1',
      revision: 1,
      objective: request.objective,
      phase: 'active',
      roundsStarted: 0,
      lastRoundAt: null,
      minIntervalMs: request.minIntervalMs ?? 60_000,
      quietWindows: request.quietWindows ?? [],
      timezone: request.timezone ?? 'Asia/Shanghai',
      createdAt: NOW,
      updatedAt: NOW,
    }
    return this.goal
  }

  edit(_agent: Agent, ref: InfiniGoalRef, request: InfiniGoalEditRequest): InfiniGoalView {
    const current = this.require(ref)
    this.goal = {
      ...current,
      revision: current.revision + 1,
      objective: request.objective ?? current.objective,
      minIntervalMs: request.minIntervalMs ?? current.minIntervalMs,
      quietWindows: request.quietWindows ?? current.quietWindows,
      timezone: request.timezone ?? current.timezone,
      updatedAt: NOW,
    }
    return this.goal
  }

  pause(_agent: Agent, ref: InfiniGoalRef): InfiniGoalView {
    return this.transition(ref, ['active'], 'paused')
  }

  resume(_agent: Agent, ref: InfiniGoalRef): InfiniGoalView {
    return this.transition(ref, ['paused', 'blocked'], 'active')
  }

  complete(_agent: Agent, ref: InfiniGoalRef): InfiniGoalView {
    return this.transition(ref, ['active', 'paused', 'blocked'], 'complete')
  }

  block(_agent: Agent, ref: InfiniGoalRef, reason: InfiniGoalBlockReason): InfiniGoalView {
    const goal = this.transition(ref, ['active'], 'blocked')
    this.goal = { ...goal, blockedReason: reason }
    return this.goal
  }

  clear(_agent: Agent, ref: InfiniGoalRef): InfiniGoalRef {
    const current = this.require(ref)
    this.goal = undefined
    return { id: current.id, revision: current.revision + 1 }
  }

  private require(ref: InfiniGoalRef): InfiniGoalView {
    if (this.goal === undefined) throw new InfiniGoalError('no current infini-goal', 'INFINI_GOAL_NOT_FOUND')
    if (this.goal.id !== ref.id || this.goal.revision !== ref.revision) {
      throw new InfiniGoalError('stale', 'INFINI_GOAL_STALE_REVISION')
    }
    return this.goal
  }

  private transition(
    ref: InfiniGoalRef,
    allowed: readonly InfiniGoalPhase[],
    phase: InfiniGoalPhase,
  ): InfiniGoalView {
    const current = this.require(ref)
    if (!allowed.includes(current.phase)) {
      throw new InfiniGoalError('invalid transition', 'INFINI_GOAL_INVALID_TRANSITION')
    }
    this.goal = { ...current, revision: current.revision + 1, phase, updatedAt: NOW }
    return this.goal
  }
}

/** Build one fake user-message session event carrying the supplied source. */
function userMessageEvent(seq: number, source: unknown): unknown {
  return {
    type: 'user/message',
    seq,
    time: NOW,
    data: { id: `message-${seq}`, role: 'user', content: [{ type: 'text', text: 'hello' }], source },
    surfaceOp: 'append',
  }
}

/** Host turn opening event. */
function turnStartEvent(seq: number): unknown {
  return { type: 'turn/start', seq, time: NOW, data: { turn: 1 } }
}

/** Shared boot harness for one tool-policy scenario. */
interface Harness {
  readonly goals: FakeInfiniGoals
  readonly definitions: Map<string, CapturedTool>
  readonly deferred: { source?: { kind: string; form?: string; summary?: string } }[]
  setEvents(events: readonly unknown[]): void
  call(name: string, args: unknown): Promise<unknown>
}

/** Boot the tool plugin against stub services with an empty session history. */
function boot(): Harness {
  const goals = new FakeInfiniGoals()
  const definitions = new Map<string, CapturedTool>()
  const deferred: { source?: { kind: string; form?: string; summary?: string } }[] = []
  let events: readonly unknown[] = [turnStartEvent(0)]
  const agent = {
    id: 'agent-1',
    status: 'running',
    session: { snapshotEvents: () => events },
  } as unknown as Agent
  const ctx = {
    agents: {
      get: () => agent,
      currentInitiator: () => agent,
      roots: () => [agent],
      turnBoundaryOf: () => ({ openTurnStartSeq: 0, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 1 }),
    },
    infiniGoals: goals,
    systemPrompt: {
      section: () => () => {},
      getSectionOrder: () => 2400,
    },
    tools: {
      register: (definition: CapturedTool) => {
        definitions.set(definition.name, definition)
        return () => {}
      },
    },
  } as unknown as Context
  apply(ctx, {})
  const exec = {
    agent,
    deferContext: (message: { source?: { kind: string; form?: string; summary?: string } }) => {
      deferred.push(message)
    },
  }
  return {
    goals,
    definitions,
    deferred,
    setEvents: (next) => { events = next },
    call: (name, args) => {
      const definition = definitions.get(name)
      if (definition === undefined) throw new Error(`tool ${name} was not registered`)
      return definition.execute(args, exec)
    },
  }
}

/** Grant direct-human authority for the next call. */
function humanTurn(harness: Harness): void {
  harness.setEvents([turnStartEvent(0), userMessageEvent(1, { kind: 'user' })])
}

/** Grant exact-goal-round authority for the next call. */
function goalRoundTurn(harness: Harness): void {
  const goal = harness.goals.goal
  if (goal === undefined) throw new Error('a goal round needs a current goal')
  harness.setEvents([
    turnStartEvent(0),
    userMessageEvent(1, {
      kind: 'infini-goal',
      goalId: goal.id,
      revision: goal.revision,
      round: goal.roundsStarted,
    }),
  ])
}

/** The value returned by the tools, narrowed for assertions. */
interface ToolValue {
  readonly goal: null | {
    readonly id: string
    readonly revision: number
    readonly objective: string
    readonly phase: string
    readonly roundsStarted: number
    readonly minIntervalMs: number
    readonly timezone: string
    readonly blockedReason?: { code: string; message: string }
  }
  readonly schedule: null | {
    readonly nextTriggerAt: number
    readonly nextTriggerInMs: number
    readonly quietUntil: number | null
  }
}

/** Narrow one tool result to its canonical value. */
function valueOf(result: unknown): ToolValue {
  return result as ToolValue
}

describe('infini-goal tool registration', () => {
  it('registers the three tools and the policy prompt section', () => {
    const harness = boot()
    expect([...harness.definitions.keys()].sort())
      .toEqual(['create_infini_goal', 'get_infini_goal', 'update_infini_goal'])
    expect(Object.keys((harness.definitions.get('get_infini_goal')?.parameters ?? {}) as object))
      .toContain('properties')
    expect(harness.definitions.get('update_infini_goal')?.presentCall?.(
      { goal_id: 'goal-1', revision: 1, action: 'pause' },
    )).toMatchObject({ card: 'generic', title: 'Pause infini-goal' })
  })
})

describe('get_infini_goal', () => {
  it('returns the empty value without a goal', async () => {
    const harness = boot()
    const value = valueOf(await harness.call('get_infini_goal', {}))
    expect(value).toEqual({ goal: null })
  })

  it('returns the goal fields and schedule facts', async () => {
    const harness = boot()
    humanTurn(harness)
    await harness.call('create_infini_goal', { objective: 'Ship the docs' })
    const value = valueOf(await harness.call('get_infini_goal', {}))
    expect(value.goal?.objective).toBe('Ship the docs')
    expect(value.goal?.phase).toBe('active')
    expect(value.goal?.minIntervalMs).toBe(60_000)
    expect(value.schedule).not.toBeNull()
    expect(value.schedule?.nextTriggerInMs).toBe(0)
    expect(value.schedule?.quietUntil).toBeNull()
  })
})

describe('create_infini_goal', () => {
  it('requires direct human authority', async () => {
    const harness = boot()
    await expect(harness.call('create_infini_goal', { objective: 'Ship the docs' }))
      .rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_AUTHORITY_REQUIRED' })
  })

  it('creates the goal with parsed pacing overrides', async () => {
    const harness = boot()
    humanTurn(harness)
    const value = valueOf(await harness.call('create_infini_goal', {
      objective: 'Ship the docs',
      min_interval: '5m',
      quiet_windows: 'Mo-Fr 09:00-18:00',
      timezone: 'UTC',
    }))
    expect(value.goal?.objective).toBe('Ship the docs')
    expect(harness.goals.goal).toMatchObject({
      minIntervalMs: 300_000,
      quietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
      timezone: 'UTC',
    })
  })

  it('rejects malformed pacing text as an actionable tool error', async () => {
    const harness = boot()
    humanTurn(harness)
    await expect(harness.call('create_infini_goal', { objective: 'x', min_interval: '5x' }))
      .rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_INVALID_ARGUMENT' })
    await expect(harness.call('create_infini_goal', { objective: 'x', quiet_windows: 'soon' }))
      .rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_INVALID_ARGUMENT' })
    await expect(harness.call('create_infini_goal', { objective: 'x', timezone: 'Mars/Olympus' }))
      .rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_INVALID_ARGUMENT' })
  })
})

describe('update_infini_goal', () => {
  it('requires direct human authority for edit, pause, resume, and config', async () => {
    const harness = boot()
    humanTurn(harness)
    const created = valueOf(await harness.call('create_infini_goal', { objective: 'Ship the docs' }))
    const goal = created.goal
    if (goal === null) throw new Error('expected a goal')
    harness.setEvents([turnStartEvent(0)])
    const ref = { goal_id: goal.id, revision: goal.revision }
    await expect(harness.call('update_infini_goal', { ...ref, action: 'edit', objective: 'Ship v2' }))
      .rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_AUTHORITY_REQUIRED' })
    await expect(harness.call('update_infini_goal', { ...ref, action: 'pause' }))
      .rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_AUTHORITY_REQUIRED' })
    await expect(harness.call('update_infini_goal', { ...ref, action: 'resume' }))
      .rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_AUTHORITY_REQUIRED' })
    await expect(harness.call('update_infini_goal', { ...ref, action: 'config', min_interval: '2m' }))
      .rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_AUTHORITY_REQUIRED' })
  })

  it('edits the objective and pacing settings with direct human authority', async () => {
    const harness = boot()
    humanTurn(harness)
    const created = valueOf(await harness.call('create_infini_goal', { objective: 'Ship the docs' }))
    const goal = created.goal
    if (goal === null) throw new Error('expected a goal')
    humanTurn(harness)
    const edited = valueOf(await harness.call('update_infini_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'edit',
      objective: 'Ship v2',
      min_interval: '90s',
    }))
    expect(edited.goal?.objective).toBe('Ship v2')
    expect(edited.goal?.minIntervalMs).toBe(90_000)
    if (edited.goal === null) throw new Error('expected a goal')
    humanTurn(harness)
    const configured = valueOf(await harness.call('update_infini_goal', {
      goal_id: edited.goal.id,
      revision: edited.goal.revision,
      action: 'config',
      quiet_windows: 'none',
      timezone: 'UTC',
    }))
    expect(harness.goals.goal?.quietWindows).toEqual([])
    expect(configured.goal?.timezone).toBe('UTC')
  })

  it('rejects config with an objective and empty edits', async () => {
    const harness = boot()
    humanTurn(harness)
    const created = valueOf(await harness.call('create_infini_goal', { objective: 'Ship the docs' }))
    const goal = created.goal
    if (goal === null) throw new Error('expected a goal')
    humanTurn(harness)
    const ref = { goal_id: goal.id, revision: goal.revision }
    await expect(harness.call('update_infini_goal', { ...ref, action: 'config', objective: 'Ship v2' }))
      .rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_INVALID_ARGUMENT' })
    await expect(harness.call('update_infini_goal', { ...ref, action: 'edit' }))
      .rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_INVALID_ARGUMENT' })
  })

  it('pauses and resumes with direct human authority', async () => {
    const harness = boot()
    humanTurn(harness)
    const created = valueOf(await harness.call('create_infini_goal', { objective: 'Ship the docs' }))
    const goal = created.goal
    if (goal === null) throw new Error('expected a goal')
    humanTurn(harness)
    const paused = valueOf(await harness.call('update_infini_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'pause',
    }))
    expect(paused.goal?.phase).toBe('paused')
    expect(paused.schedule).toBeNull()
    if (paused.goal === null) throw new Error('expected a goal')
    humanTurn(harness)
    const resumed = valueOf(await harness.call('update_infini_goal', {
      goal_id: paused.goal.id,
      revision: paused.goal.revision,
      action: 'resume',
    }))
    expect(resumed.goal?.phase).toBe('active')
    expect(resumed.schedule).not.toBeNull()
  })

  it('completes from the exact current goal round and defers the wrap-up', async () => {
    const harness = boot()
    humanTurn(harness)
    const created = valueOf(await harness.call('create_infini_goal', { objective: 'Ship the docs' }))
    const goal = created.goal
    if (goal === null) throw new Error('expected a goal')
    goalRoundTurn(harness)
    const completed = valueOf(await harness.call('update_infini_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
    }))
    expect(completed.goal?.phase).toBe('complete')
    expect(harness.deferred).toHaveLength(1)
    expect(harness.deferred[0]?.source).toMatchObject({ kind: 'tool-infini-goal', form: 'notice' })
    expect(harness.deferred[0]?.source?.summary).toContain('complete: Ship the docs')
  })

  it('rejects completion outside a direct human turn or the exact goal round', async () => {
    const harness = boot()
    humanTurn(harness)
    const created = valueOf(await harness.call('create_infini_goal', { objective: 'Ship the docs' }))
    const goal = created.goal
    if (goal === null) throw new Error('expected a goal')
    harness.setEvents([
      turnStartEvent(0),
      userMessageEvent(1, { kind: 'infini-goal', goalId: goal.id, revision: goal.revision, round: 99 }),
    ])
    await expect(harness.call('update_infini_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
    })).rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_AUTHORITY_REQUIRED' })
  })

  it('enforces the blocked round threshold and the required reason', async () => {
    const harness = boot()
    humanTurn(harness)
    const created = valueOf(await harness.call('create_infini_goal', { objective: 'Ship the docs' }))
    const goal = created.goal
    if (goal === null) throw new Error('expected a goal')
    // Round 0 is below the default threshold of 3.
    goalRoundTurn(harness)
    await expect(harness.call('update_infini_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'blocked',
      blocked_reason: 'credentials expired',
    })).rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_BLOCK_THRESHOLD' })
    await expect(harness.call('update_infini_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'blocked',
    })).rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_INVALID_ARGUMENT' })
    // Simulate three admitted rounds, then block from the exact current round.
    if (harness.goals.goal === undefined) throw new Error('expected a goal')
    harness.goals.goal = { ...harness.goals.goal, roundsStarted: 3 }
    goalRoundTurn(harness)
    const blocked = valueOf(await harness.call('update_infini_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'blocked',
      blocked_reason: '  credentials expired  ',
    }))
    expect(blocked.goal?.phase).toBe('blocked')
    expect(blocked.goal?.blockedReason).toEqual({ code: 'model-reported', message: 'credentials expired' })
    expect(harness.deferred).toHaveLength(1)
    expect(harness.deferred[0]?.source?.summary).toContain('blocked: Ship the docs')
  })

  it('allows a direct human to block without the round threshold', async () => {
    const harness = boot()
    humanTurn(harness)
    const created = valueOf(await harness.call('create_infini_goal', { objective: 'Ship the docs' }))
    const goal = created.goal
    if (goal === null) throw new Error('expected a goal')
    humanTurn(harness)
    const blocked = valueOf(await harness.call('update_infini_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'blocked',
      blocked_reason: 'credentials expired',
    }))
    expect(blocked.goal?.phase).toBe('blocked')
    expect(harness.deferred).toHaveLength(0)
  })

  it('translates a stale revision into a structured tool error', async () => {
    const harness = boot()
    humanTurn(harness)
    await harness.call('create_infini_goal', { objective: 'Ship the docs' })
    humanTurn(harness)
    await expect(harness.call('update_infini_goal', {
      goal_id: 'goal-1',
      revision: 99,
      action: 'pause',
    })).rejects.toMatchObject({ code: 'INFINI_GOAL_STALE_REVISION' })
  })

  it('rejects malformed refs before touching the service', async () => {
    const harness = boot()
    humanTurn(harness)
    await expect(harness.call('update_infini_goal', {
      goal_id: '',
      revision: 1,
      action: 'pause',
    })).rejects.toMatchObject({ code: 'INFINI_GOAL_TOOL_INVALID_ARGUMENT' })
  })
})

describe('tool error translation', () => {
  it('never escapes as a bare Error for a domain failure', async () => {
    const harness = boot()
    humanTurn(harness)
    try {
      await harness.call('update_infini_goal', {
        goal_id: 'missing',
        revision: 1,
        action: 'pause',
      })
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError)
    }
  })
})
