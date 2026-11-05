/**
 * Fake agent-loop harness for the infini-goal driver tests.
 *
 * The driver only talks to the public Agent surface (`status`, `session`,
 * `inbox`, `followup`, `cancel`, `whenIdle`) plus the real `agents`,
 * `infiniGoals`, and `sessions` services. This harness boots those real
 * services over a real cordis `Context` and a real `Session` log, then drives a
 * scriptable fake agent loop that mirrors the real loop's observable ordering:
 *
 * 1. `followup()` appends to `next-turn`, emits `agent/inbox/inserted`, and
 *    synchronously flips `agent/status` to `running` when the agent is idle.
 * 2. A turn claims its batch (emitting `agent/inbox/claimed` with the owning
 *    turn), runs the `agent/pre-step` waterfall, appends the claimed
 *    `user/message` events, and closes with `turn/end`.
 * 3. The agent announces `idle` only after the whole activity drains, so
 *    queued non-round input keeps it running across consecutive turns.
 *
 * The fake loop deliberately performs every session append from its own
 * microtask/turn context (never from a `session/event` observer), matching the
 * real Session's reentrancy guard.
 */

import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentRegistry, AgentStatus, ModelSelection, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentCancelCause, Session, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { vi } from 'vitest'
import InfiniGoalService from '@yankeguo/dsh-infini-goal'
import type { InfiniGoalRef, InfiniGoalSettings, InfiniGoalView } from '@yankeguo/dsh-infini-goal-protocol'
import type { Config as DriverConfig } from '../../src/index.ts'
import * as driverModule from '../../src/index.ts'

/** Model selection offered to pre-step listeners. */
const MODEL_SELECTION: ModelSelection = { provider: 'fake', model: 'fake' }

/** One scripted turn outcome; `completed` is the default. */
export type ScriptedOutcome = TurnEndReason

/** A requested fake turn may hang until the test resolves it. */
export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

/** Create an externally resolvable deferred value. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Flush pending microtasks without touching the clock. */
export async function flushMicrotasks(rounds = 32): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

/** Durable settings accepted by a goal create. */
export interface CreateGoalOptions {
  readonly objective?: string
  readonly minIntervalMs?: number
  readonly quietWindows?: InfiniGoalSettings['quietWindows']
  readonly timezone?: string
}

/** Fake inbox: mirrors the observable append/prepend/remove contract. */
export class FakeInbox {
  nextTurn: UserMessage[] = []
  nextStep: UserMessage[] = []

  constructor(private readonly agent: FakeAgent) {}

  /** Whether either boundary holds pending work. */
  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  /** Append one message to a boundary and notify `inserted`. */
  append(target: 'next-turn' | 'next-step', message: UserMessage): void {
    this.list(target).push(message)
    this.agent.emit('agent/inbox/inserted', { message })
  }

  /** Prepend one message to a boundary and notify `inserted`. */
  prepend(target: 'next-turn' | 'next-step', message: UserMessage): void {
    this.list(target).unshift(message)
    this.agent.emit('agent/inbox/inserted', { message })
  }

  /** Remove one pending message and notify `discarded` when it was present. */
  remove(messageId: string): boolean {
    for (const target of ['next-turn', 'next-step'] as const) {
      const list = this.list(target)
      const index = list.findIndex(message => message.id === messageId)
      if (index < 0) continue
      const [message] = list.splice(index, 1)
      if (message !== undefined) this.agent.emit('agent/inbox/discarded', { message })
      return true
    }
    return false
  }

  /** Discard every pending message, announcing each removal. */
  clear(): void {
    for (const target of ['next-turn', 'next-step'] as const) {
      const removed = this.list(target).splice(0)
      for (const message of removed) this.agent.emit('agent/inbox/discarded', { message })
    }
  }

  private list(target: 'next-turn' | 'next-step'): UserMessage[] {
    return target === 'next-turn' ? this.nextTurn : this.nextStep
  }
}

/** Scriptable fake agent lifecycle over a real Session log. */
export class FakeAgent {
  readonly id: SessionId
  readonly inbox: FakeInbox
  status: AgentStatus = 'idle'
  /** Number of durable user/message events admitted by fake turns. */
  readonly admitted: UserMessage[] = []
  /** Scripted outcomes consumed one per turn; default is `completed`. */
  readonly outcomes: ScriptedOutcome[] = []
  /** When true, followup parks the message without waking the loop. */
  wakeHeld = false
  /** Number of upcoming followup calls that throw before queueing. */
  failFollowups = 0
  /** Whether a scripted error outcome also emits `agent/error` (real loop does). */
  emitAgentError = true
  /** When set, the next turn suspends until the returned gate resolves. */
  turnGate: Deferred<void> | undefined
  /** Optional hook invoked after pre-step, before admission. */
  afterPreStep: (() => void | Promise<void>) | undefined

  private readonly abort = new Map<number, AbortController>()
  private activity: Promise<void> = Promise.resolve()
  private turnCounter = 0
  private idleResolvers: Array<() => void> = []
  private started = false

  constructor(
    private readonly ctx: Context,
    readonly session: Session,
  ) {
    this.id = session.id
    this.inbox = new FakeInbox(this)
  }

  /** Agent-shaped value for services that compare identities. */
  get agent(): Agent {
    return this as unknown as Agent
  }

  /** Emit one agent-subject event through the scoped dispatcher. */
  emit(name: string, payload: Record<string, unknown>): void {
    const dispatcher = agentEvents(this.ctx, this.agent)
    ;(dispatcher.emit as (name: string, payload: Record<string, unknown>) => void)(name, payload)
  }

  /** Emit one pre-step waterfall and return its decision. */
  private async preStep(
    messages: UserMessage[],
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<PreStepDecision> {
    const dispatcher = agentEvents(this.ctx, this.agent)
    return dispatcher.waterfall(
      'agent/pre-step',
      { messages, turn, step, signal, modelSelection: MODEL_SELECTION },
      () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages }),
    )
  }

  /** Queue an ordinary follow-up turn and wake the loop. */
  followup(message: UserMessage): void {
    if (this.failFollowups > 0) {
      this.failFollowups -= 1
      throw new Error('fake agent refused the followup')
    }
    this.inbox.append('next-turn', message)
    this.wake()
  }

  /** Park a wake while `wakeHeld` (emulates a running maintenance task). */
  private wake(): void {
    if (this.wakeHeld || this.status === 'running') return
    this.status = 'running'
    this.emit('agent/status', { status: 'running' })
    this.activity = this.run()
  }

  /** Run consecutive turns until the inbox drains. */
  private async run(): Promise<void> {
    try {
      while (this.inbox.hasPending) {
        const more = await this.turn()
        if (!more) break
      }
    } finally {
      this.status = 'idle'
      this.emit('agent/status', { status: 'idle' })
      const resolvers = this.idleResolvers.splice(0)
      for (const resolve of resolvers) resolve()
    }
  }

  /** One turn: claim, pre-step, admit, settle. */
  private async turn(): Promise<boolean> {
    const turn = ++this.turnCounter
    this.emit('agent/status', { status: 'running' })
    const session = this.session
    session.append('turn/start', { turn })
    const claimed = [...this.inbox.nextStep.splice(0), ...this.inbox.nextTurn.splice(0, 1)]
    for (const message of claimed) this.emit('agent/inbox/claimed', { message, turn })
    const controller = new AbortController()
    this.abort.set(turn, controller)
    const { signal } = controller
    /** Close the turn with the cancellation cause. */
    const abortEnd = (): false => {
      session.append('turn/end', { turn, reason: { kind: 'aborted', reason: abortCause(signal) } })
      return false
    }
    try {
      let decision: PreStepDecision
      const gate = this.turnGate
      this.turnGate = undefined
      try {
        if (gate !== undefined) await gate.promise
        decision = await this.preStep(claimed, turn, 1, signal)
      } catch (error: unknown) {
        if (signal.aborted) return abortEnd()
        session.append('turn/end', {
          turn,
          reason: { kind: 'error', error: { message: String(error), code: 'UNKNOWN' } },
        })
        return false
      }
      if (signal.aborted) return abortEnd()
      if (decision.kind === 'reject') {
        session.append('turn/end', { turn, reason: { kind: 'blocked' } })
        return false
      }
      await this.afterPreStep?.()
      // The real loop re-checks the cancellation signal before committing the step.
      if (signal.aborted) return abortEnd()
      session.append('step/start', { turn, step: 1 })
      for (const message of decision.messages) {
        session.append('user/message', message, { surfaceOp: 'append' })
        this.admitted.push(message)
      }
      const outcome: ScriptedOutcome = this.outcomes.shift() ?? { kind: 'completed' }
      session.append('step/end', { turn, step: 1 })
      if (outcome.kind === 'error' && this.emitAgentError) {
        this.emit('agent/error', { turn, step: 1, error: outcome.error })
      }
      session.append('turn/end', { turn, reason: outcome })
      return outcome.kind === 'completed'
    } finally {
      this.abort.delete(turn)
    }
  }

  /** Cancel queued work and abort the active activity. */
  cancel(cause: AgentCancelCause, options: { keepInbox?: boolean } = {}): void {
    if (options.keepInbox !== true) this.inbox.clear()
    for (const controller of this.abort.values()) controller.abort(cause)
  }

  /** Resolve when no activity remains. */
  async whenIdle(): Promise<void> {
    while (this.status === 'running' || this.activityStillRunning()) {
      await new Promise<void>((resolve) => { this.idleResolvers.push(resolve) })
    }
  }

  private activityStillRunning(): boolean {
    return this.started && this.activity !== undefined && this.status === 'running'
  }

  /** Mark the fake loop as started after boot (for activity bookkeeping). */
  markStarted(): void {
    this.started = true
  }
}

/** Read the cancel cause off an aborted signal. */
function abortCause(signal: AbortSignal): AgentCancelCause {
  const reason: unknown = signal.reason
  if (typeof reason === 'object' && reason !== null && 'kind' in reason) return reason as AgentCancelCause
  return { kind: 'user' }
}

/** Monotonic agent counter for deterministic session ids. */
let agentCounter = 0

/** Harness options. */
export interface BootOptions {
  readonly driverConfig?: DriverConfig
  readonly goalServiceConfig?: Record<string, unknown>
  /** Runs after the goal service is booted and before the driver loads. */
  readonly beforeDriver?: (harness: Harness) => Promise<void> | void
  /** Optional fake `subagents` service; tests control its wait resolution. */
  readonly subagents?: SubagentsStub
}

/** Fake `subagents` service with a controllable child wait. */
export interface SubagentsStub {
  waitForChildren(agent: Agent): Promise<boolean>
  /** Resolve the pending wait. */
  readonly pending: Deferred<boolean>
}

/** Build a fake optional subagents service. */
export function subagentsStub(): SubagentsStub {
  const pending = deferred<boolean>()
  return {
    pending,
    waitForChildren: () => pending.promise,
  }
}

/** Mutable fake `agents` registry so tests can script driver-integration failures. */
export interface FakeAgents {
  get(id: string): Agent | undefined
  list(): Agent[]
  withoutInitiator<T>(operation: () => T): T
  currentInitiator(): Agent | undefined
}

/** One booted harness. */
export interface Harness {
  readonly ctx: Context
  readonly session: Session
  readonly agent: FakeAgent
  readonly agents: FakeAgents
  readonly driver: Awaited<ReturnType<Context['plugin']>>
  readonly goals: InfiniGoalService
}

/** Harnesses booted by {@link boot}, disposed by {@link disposeHarnesses}. */
const liveHarnesses: Harness[] = []

/** Dispose every harness booted by {@link boot}. */
export async function disposeHarnesses(): Promise<void> {
  const pending = liveHarnesses.splice(0)
  for (const harness of pending) await harness.ctx.fiber.dispose()
}

/** Fake clock for deterministic pacing tests. */
export function fakeClock(at = '2026-01-05T12:00:00.000Z'): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date(at))
}

/** Boot a real cordis context with real session/goal services and the driver. */
export async function boot(options: BootOptions = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const session = ctx.sessions.create(SessionId(`infini-goal-driver-${String(++agentCounter)}`))
  const agent = new FakeAgent(ctx, session)
  const agents: FakeAgents = {
    get: (id: string) => (id === agent.id ? agent.agent : undefined),
    list: () => [agent.agent],
    withoutInitiator: <T>(operation: () => T): T => operation(),
    currentInitiator: () => undefined,
  }
  ctx.provide('agents', agents as unknown as AgentRegistry)
  if (options.subagents !== undefined) {
    ctx.provide('subagents', options.subagents as never)
  }
  await ctx.plugin(InfiniGoalService, {
    defaultMinIntervalMs: 1_000,
    ...options.goalServiceConfig,
  })
  const base: Harness = {
    ctx,
    session,
    agent,
    agents,
    driver: undefined as never,
    goals: ctx.infiniGoals,
  }
  if (options.beforeDriver !== undefined) await options.beforeDriver(base)
  let driver: Awaited<ReturnType<Context['plugin']>>
  try {
    driver = await ctx.plugin(driverModule, options.driverConfig ?? { pollFloorMs: 100 })
  } catch (error: unknown) {
    await ctx.fiber.dispose()
    throw error
  }
  agent.markStarted()
  const harness: Harness = { ...base, driver }
  liveHarnesses.push(harness)
  return harness
}

/** Create one active goal on the harness agent. */
export function createGoal(harness: Harness, options: CreateGoalOptions = {}): InfiniGoalView {
  return harness.goals.create(harness.agent.agent, {
    objective: options.objective ?? 'ship the audit',
    minIntervalMs: options.minIntervalMs ?? 1_000,
    quietWindows: options.quietWindows ?? [],
    timezone: options.timezone ?? 'UTC',
  })
}

/** Wait until the fake agent reaches idle (flushing microtasks first). */
export async function settle(harness: Harness): Promise<void> {
  await flushMicrotasks()
  await harness.agent.whenIdle()
  await flushMicrotasks()
}

/** Round numbers of every admitted automatic round, in session order. */
export function admittedRounds(harness: Harness): number[] {
  return harness.session.snapshotEvents().flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === 'infini-goal'
      ? [event.data.source.round]
      : [])
}

/** Session sources of every admitted user message, in order. */
export function admittedSources(harness: Harness): Array<{ readonly kind: string; readonly round?: number }> {
  return harness.session.snapshotEvents().flatMap(event => {
    if (event.type !== 'user/message') return []
    const source = event.data.source as { readonly kind: string; readonly round?: number }
    return [{ kind: source.kind, ...source.round === undefined ? {} : { round: source.round } }]
  })
}

/** Count of durable infini-goal change operations, optionally filtered. */
export function goalOperations(harness: Harness, operation?: string): string[] {
  return harness.session.snapshotEvents().flatMap(event => {
    if (!event.type.endsWith('infini-goal/change')) return []
    const data = event.data as { readonly operation: string }
    return operation === undefined || data.operation === operation ? [data.operation] : []
  })
}

/** Build one human user message for inbox insertion. */
export function humanMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' } as MessageSource,
  })
}

/** Emit one `agent/created` lifecycle notification. */
export function emitAgentCreated(harness: Harness, source: 'startup' | 'resume' | 'clear' | 'compact' = 'resume'): void {
  harness.ctx.emit('agent/created', { agent: harness.agent.agent, source })
}

/** Emit one `agent/disposed` lifecycle notification. */
export function emitAgentDisposed(harness: Harness): void {
  harness.ctx.emit('agent/disposed', { agent: harness.agent.agent })
}

/** Count `session/flush` dispatches, with an optional per-call hook. */
export function countFlushes(harness: Harness, onChange?: (count: number) => void): { readonly count: () => number } {
  let count = 0
  harness.ctx.on('session/flush', () => {
    count += 1
    onChange?.(count)
  })
  return { count: () => count }
}

/** Snapshot the current goal for assertions. */
export function currentGoal(harness: Harness): InfiniGoalView | undefined {
  return harness.goals.get(harness.agent.agent)
}

/** Resume the current goal if paused or blocked. */
export function resumeGoal(harness: Harness): InfiniGoalView {
  const goal = currentGoal(harness)
  if (goal === undefined) throw new Error('expected a current infini-goal')
  const ref: InfiniGoalRef = { id: goal.id, revision: goal.revision }
  return harness.goals.resume(harness.agent.agent, ref)
}
