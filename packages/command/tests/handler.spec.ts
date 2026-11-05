import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
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

/** One registration captured from the stubbed command runtime. */
interface CapturedCommand {
  readonly name: string
  readonly handler: (invocation: CommandInvocation) => { kind: string; text?: string } | Promise<{ kind: string; text?: string }>
}

/** Boot the command plugin against a stub registry and return its handler. */
function boot(): { readonly handler: CapturedCommand['handler']; readonly goals: FakeInfiniGoals } {
  const goals = new FakeInfiniGoals()
  let captured: CapturedCommand | undefined
  const ctx = {
    commands: {
      register: (definition: CapturedCommand) => {
        captured = definition
        return () => {}
      },
    },
    infiniGoals: goals,
  } as unknown as Context
  apply(ctx)
  if (captured === undefined) throw new Error('command was not registered')
  return { handler: captured.handler, goals }
}

/** Invoke the registered command with one raw input. */
async function run(
  handler: CapturedCommand['handler'],
  rawInput: string,
  attachments: readonly unknown[] = [],
): Promise<{ kind: string; text?: string }> {
  return handler({
    commandId: 'command-1',
    agent: { id: 'agent-1' } as unknown as Agent,
    rawInput,
    attachments,
    signal: new AbortController().signal,
  } as unknown as CommandInvocation)
}

/** Render one result's text for assertion. */
function text(result: { kind: string; text?: string }): string {
  return result.text ?? ''
}

describe('infini-goal command handler', () => {
  it('registers the infini-goal command with a hint', () => {
    const goals = new FakeInfiniGoals()
    let captured: CapturedCommand & { definitionId?: string; input?: { hint?: string } } | undefined
    apply({
      commands: {
        register: (definition: never) => {
          captured = definition
          return () => {}
        },
      },
      infiniGoals: goals,
    } as unknown as Context)
    expect(captured?.name).toBe('infini-goal')
    expect(captured?.definitionId).toBe('@yankeguo/dsh-command-infini-goal')
    expect(captured?.input?.hint).toContain('interval <duration>')
  })

  it('shows the empty state before a goal exists', async () => {
    const { handler } = boot()
    const result = await run(handler, '')
    expect(result.kind).toBe('success')
    expect(text(result)).toContain('No infini-goal is currently set.')
    expect(text(result)).toContain('/infini-goal <objective>')
  })

  it('creates, edits, and reports a goal status', async () => {
    const { handler, goals } = boot()
    const created = await run(handler, 'Ship the docs')
    expect(created.kind).toBe('success')
    expect(text(created)).toContain('Infini-goal created')
    expect(goals.goal?.objective).toBe('Ship the docs')

    const status = await run(handler, '')
    expect(text(status)).toContain('Infini-goal status')
    expect(text(status)).toContain('Status: active')
    expect(text(status)).toContain('Objective: Ship the docs')
    expect(text(status)).toContain('Min interval: 1m')

    const edited = await run(handler, 'edit Ship v2')
    expect(text(edited)).toContain('Infini-goal updated')
    expect(goals.goal?.objective).toBe('Ship v2')

    const duplicate = await run(handler, 'Another goal')
    expect(duplicate.kind).toBe('error')
    expect(text(duplicate)).toContain('already active')
  })

  it('applies the pacing subcommands through the core edit', async () => {
    const { handler, goals } = boot()
    await run(handler, 'Ship the docs')
    expect(text(await run(handler, 'interval 5m'))).toContain('minimum interval updated')
    expect(goals.goal?.minIntervalMs).toBe(300_000)
    expect(text(await run(handler, 'quiet Mo-Fr 09:00-18:00'))).toContain('quiet windows updated')
    expect(goals.goal?.quietWindows).toEqual([{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }])
    expect(text(await run(handler, 'timezone UTC'))).toContain('time zone updated')
    expect(goals.goal?.timezone).toBe('UTC')
    expect(text(await run(handler, 'quiet none'))).toContain('quiet windows updated')
    expect(goals.goal?.quietWindows).toEqual([])
  })

  it('drives the lifecycle controls', async () => {
    const { handler, goals } = boot()
    await run(handler, 'Ship the docs')

    expect(text(await run(handler, 'pause'))).toContain('Infini-goal paused')
    expect(goals.goal?.phase).toBe('paused')
    expect(text(await run(handler, 'pause'))).toContain('cannot make that change')

    expect(text(await run(handler, 'resume'))).toContain('Infini-goal resumed')
    expect(goals.goal?.phase).toBe('active')

    expect(text(await run(handler, 'block credentials expired'))).toContain('Infini-goal blocked')
    expect(goals.goal?.phase).toBe('blocked')
    expect(goals.goal?.blockedReason).toEqual({ code: 'human-reported', message: 'credentials expired' })
    expect(text(await run(handler, ''))).toContain('Blocker: human-reported: credentials expired')

    expect(text(await run(handler, 'resume'))).toContain('Infini-goal resumed')
    expect(text(await run(handler, 'complete'))).toContain('Infini-goal completed')
    expect(goals.goal?.phase).toBe('complete')

    expect(text(await run(handler, 'clear'))).toBe('Infini-goal cleared.')
    expect(goals.goal).toBeUndefined()
  })

  it('replaces a completed goal with a new objective', async () => {
    const { handler, goals } = boot()
    await run(handler, 'Ship the docs')
    await run(handler, 'complete')
    const replaced = await run(handler, 'edit Ship v2')
    expect(text(replaced)).toContain('Infini-goal created')
    expect(goals.goal?.phase).toBe('active')
    expect(goals.goal?.objective).toBe('Ship v2')
  })

  it('renders friendly errors for invalid input instead of throwing', async () => {
    const { handler } = boot()
    const invalidEdit = await run(handler, 'edit')
    expect(invalidEdit.kind).toBe('error')
    expect(text(invalidEdit)).toContain('replacement objective')
    expect(text(invalidEdit)).toContain('Usage:')

    const invalidInterval = await run(handler, 'interval 5x')
    expect(invalidInterval.kind).toBe('error')
    expect(text(invalidInterval)).toContain('Invalid interval')

    const invalidQuiet = await run(handler, 'quiet lunchtime')
    expect(invalidQuiet.kind).toBe('error')
    expect(text(invalidQuiet)).toContain('Invalid quiet windows')

    const invalidTimeZone = await run(handler, 'timezone Mars/Olympus')
    expect(invalidTimeZone.kind).toBe('error')
    expect(text(invalidTimeZone)).toContain('Invalid time zone')

    const noGoal = await run(handler, 'pause')
    expect(noGoal.kind).toBe('error')
    expect(text(noGoal)).toContain('No infini-goal is currently set')
  })

  it('rejects attachments with a clear message', async () => {
    const { handler } = boot()
    const result = await run(handler, 'Ship the docs', [{ type: 'text', text: 'attachment' }])
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('does not accept attachments')
  })
})
