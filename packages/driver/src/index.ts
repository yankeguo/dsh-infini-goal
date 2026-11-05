/**
 * Automatic continuation driver for the endless infini-goal.
 *
 * The official `dsh-goal-round-driver` drives an armed goal immediately at
 * agent quiescence. This driver instead obeys the pacing policy owned by the
 * protocol package: the next round may start no earlier than
 * `lastRoundAt + minIntervalMs`, and never inside a configured quiet window.
 * While a quiet window is active the goal stays `active` and human turns keep
 * working normally, but no automatic round is injected — the goal waits for
 * assigned work, like an employee on the clock.
 *
 * @module @yankeguo/dsh-infini-goal-driver
 */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type { InfiniGoalMessageSource, InfiniGoalRef, InfiniGoalView } from '@yankeguo/dsh-infini-goal'
import type { TriggerPlan } from '@yankeguo/dsh-infini-goal-protocol'
import { INFINI_GOAL_MESSAGE_KIND } from '@yankeguo/dsh-infini-goal-protocol'
import { renderInfiniGoalRoundPrompt } from './prompt.ts'

export { renderInfiniGoalRoundPrompt } from './prompt.ts'

export const name = 'infini-goal-driver'
export const inject = ['agents', 'infiniGoals', 'sessions']

/** Node timers saturate above this delay; longer waits re-check in slices. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * `FiberState.ACTIVE` without importing the ambient const enum member, which
 * `verbatimModuleSyntax` forbids. Keep in sync with `@deepseek-ai/cordis`.
 */
const FIBER_ACTIVE = 2

/** Whether the hosting fiber is still mounted and active. */
function fiberActive(ctx: Context): boolean {
  return (ctx.fiber.state as number) === FIBER_ACTIVE
}

/** Plugin configuration. */
export interface Config {
  /**
   * Whether an already-active durable goal resumes automatically when the
   * plugin loads or a Session Agent is created. When false the goal stays
   * active but silent until a human runs `/infini-goal resume`.
   */
  autoContinueOnStart?: boolean
  /** Safety poll interval used while the agent is transiently not ready (ms). */
  pollFloorMs?: number
}

/** Normalized plugin configuration. */
export const Config: z<Config> = z.object({
  autoContinueOnStart: z.boolean().default(true),
  pollFloorMs: z.number().min(100).default(1_000),
})

/** Fully materialized driver configuration. */
interface ResolvedConfig {
  readonly autoContinueOnStart: boolean
  readonly pollFloorMs: number
}

/** Identity reserved before one continuation round enters the agent inbox. */
interface RoundIdentity {
  readonly goalId: string
  readonly revision: number
  readonly round: number
}

/** One queued, claimed, or admitted round message retained until quiescence. */
interface RoundAttempt extends RoundIdentity {
  readonly messageId: MessageId
  readonly content: ContentBlock[]
  phase: 'queued' | 'claimed' | 'admitted'
  cancelled: boolean
  stale: boolean
}

/** Per-agent serialized scheduling state. */
interface DriverState {
  readonly agent: Agent
  armed: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  retryTimer: ReturnType<typeof setTimeout> | undefined
  attempt: RoundAttempt | undefined
  competingQueued: boolean
  needsCheckpoint: boolean
  requested: boolean
  run: Promise<void> | undefined
  stopping: boolean
}

/** Whether a message source identifies an automatic infini-goal round. */
function isInfiniGoalRoundSource(source: MessageSource): source is InfiniGoalMessageSource {
  return source.kind === INFINI_GOAL_MESSAGE_KIND && source.round > 0
}

/** Compare a source to one reserved identity. */
function sameRound(source: InfiniGoalMessageSource, round: RoundIdentity): boolean {
  return source.goalId === round.goalId
    && source.revision === round.revision
    && source.round === round.round
}

/** Compare the complete queued record to the driver's reservation. */
function sameQueued(content: readonly ContentBlock[], source: MessageSource, attempt: RoundAttempt): boolean {
  return isInfiniGoalRoundSource(source) && sameRound(source, attempt) && isDeepStrictEqual(content, attempt.content)
}

/** Exact current compare-and-set ref for a view. */
function goalRef(goal: InfiniGoalView): InfiniGoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Materialize and validate plugin configuration. */
function resolveConfig(config: Config): ResolvedConfig {
  const autoContinueOnStart = config.autoContinueOnStart ?? true
  const pollFloorMs = config.pollFloorMs ?? 1_000
  if (typeof autoContinueOnStart !== 'boolean') throw new TypeError('autoContinueOnStart must be a boolean')
  if (!Number.isSafeInteger(pollFloorMs) || pollFloorMs < 100) {
    throw new TypeError('pollFloorMs must be an integer >= 100')
  }
  return { autoContinueOnStart, pollFloorMs }
}

/**
 * Install paced automatic continuation and its race fences.
 * @param ctx - host context carrying agents, the infini-goal service, and sessions.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const states = new Map<Agent, DriverState>()
  // Releases drivers still joining subagents when the plugin unloads.
  const unloading = Promise.withResolvers<void>()

  /** Create state for one exact currently live agent. */
  function stateFor(agent: Agent): DriverState {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: DriverState = {
      agent,
      armed: resolved.autoContinueOnStart,
      timer: undefined,
      retryTimer: undefined,
      attempt: undefined,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      run: undefined,
      stopping: false,
    }
    states.set(agent, state)
    return state
  }

  /** Read the goal only while the exact Agent remains live. */
  function currentGoal(state: DriverState): InfiniGoalView | undefined {
    if (ctx.agents.get(state.agent.id) !== state.agent) return undefined
    try {
      return ctx.infiniGoals.get(state.agent)
    } catch (error: unknown) {
      ctx.logger.warn(`infini-goal-driver: goal read failed for agent "${state.agent.id}": ${renderThrown(error)}`)
      return undefined
    }
  }

  /** Whether a durable goal may receive automatic rounds. */
  function drivable(goal: InfiniGoalView | undefined): goal is InfiniGoalView {
    return goal !== undefined && goal.phase === 'active'
  }

  /** Whether this exact lifecycle is quiescent with no competing prompt. */
  function readyToDrive(state: DriverState): boolean {
    return fiberActive(ctx)
      && !state.stopping
      && ctx.agents.get(state.agent.id) === state.agent
      && state.agent.status === 'idle'
      && !state.competingQueued
  }

  /** Clear both scheduling timers. */
  function clearTimers(state: DriverState): void {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    if (state.retryTimer !== undefined) {
      clearTimeout(state.retryTimer)
      state.retryTimer = undefined
    }
  }

  /** Schedule a safety re-check without disturbing an armed timer. */
  function armRetry(state: DriverState): void {
    if (state.stopping || state.retryTimer !== undefined) return
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      reconsider(state)
    }, resolved.pollFloorMs)
    state.retryTimer.unref?.()
  }

  /** Read the pacing plan for one state without throwing at the caller. */
  function planFor(state: DriverState): TriggerPlan | undefined {
    const goal = currentGoal(state)
    if (!drivable(goal)) return undefined
    try {
      return ctx.infiniGoals.plan(state.agent)
    } catch (error: unknown) {
      ctx.logger.warn(`infini-goal-driver: pacing plan failed for agent "${state.agent.id}": ${renderThrown(error)}`)
      return undefined
    }
  }

  /** Whether one automatic round may be scheduled right now. */
  function scheduleBlocked(state: DriverState): boolean {
    return state.stopping || !state.armed || state.attempt !== undefined
  }

  /**
   * Recompute the next eligible instant and either arm a timer or drive now.
   * This is the only scheduling entry point; it is idempotent.
   */
  function reconsider(state: DriverState): void {
    clearTimers(state)
    if (scheduleBlocked(state)) return
    const plan = planFor(state)
    if (plan === undefined) return
    const wait = plan.nextAt - Date.now()
    if (wait <= 0) {
      requestDrive(state)
      return
    }
    const delay = Math.min(wait, MAX_TIMER_MS)
    state.timer = setTimeout(() => {
      state.timer = undefined
      reconsider(state)
    }, delay)
    state.timer.unref?.()
  }

  /** Block the current goal with one stable policy code, when still active. */
  function reportBlock(state: DriverState, code: string, message: string): void {
    const goal = currentGoal(state)
    if (!drivable(goal)) return
    try {
      ctx.infiniGoals.block(state.agent, goalRef(goal), { code, message })
    } catch (error: unknown) {
      ctx.logger.warn(`infini-goal-driver: could not block goal for agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /** Pause the current goal when a running round was cancelled, when still active. */
  function reportPause(state: DriverState, code: string): void {
    const goal = currentGoal(state)
    if (!drivable(goal)) return
    try {
      ctx.infiniGoals.pause(state.agent, goalRef(goal))
    } catch (error: unknown) {
      ctx.logger.warn(`infini-goal-driver: could not pause goal (${code}) for agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /**
   * Apply the startup policy to one agent. With automatic continuation enabled
   * the driver schedules immediately; otherwise an active durable goal is
   * paused durably so the browser UI shows a resumable state and a human
   * `/infini-goal resume` is the only way back in.
   */
  function startFromPolicy(state: DriverState): void {
    state.armed = resolved.autoContinueOnStart
    if (state.armed) {
      reconsider(state)
      return
    }
    const goal = currentGoal(state)
    if (goal === undefined || goal.phase !== 'active') return
    try {
      ctx.infiniGoals.pause(state.agent, goalRef(goal))
    } catch (error: unknown) {
      ctx.logger.warn(`infini-goal-driver: could not pause goal at startup for agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /** Preserve claimed step context when this driver drops only its own round. */
  function restoreOtherClaimed(agent: Agent, messages: UserMessage[], messageId: MessageId): void {
    const retained = messages.filter(message => message.id !== messageId
      && !(message.source.kind === INFINI_GOAL_MESSAGE_KIND))
    for (const message of retained.toReversed()) {
      if (agent.inbox.nextStep.some(candidate => candidate.id === message.id)
        || agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) continue
      agent.inbox.prepend('next-step', message)
    }
  }

  /** Process admitted work at quiescence, then reserve at most one next round. */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state
    if (!readyToDrive(state)) {
      armRetry(state)
      return
    }

    if (state.needsCheckpoint) {
      try {
        await ctx.sessions.flush(agent.session)
        state.needsCheckpoint = false
      } catch (error: unknown) {
        ctx.logger.warn(`infini-goal-driver: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`)
        armRetry(state)
        return
      }
      if (!readyToDrive(state)) {
        armRetry(state)
        return
      }
    }

    if (state.attempt !== undefined) return

    const goal = currentGoal(state)
    if (!drivable(goal) || !state.armed) return

    const plan = planFor(state)
    if (plan === undefined) return
    if (plan.nextAt > Date.now()) {
      reconsider(state)
      return
    }

    // A round started while descendants progress would only wait for them.
    const subagents = ctx.get('subagents')
    if (subagents !== undefined) {
      await Promise.race([subagents.waitForChildren(agent), unloading.promise])
      if (!readyToDrive(state)) {
        armRetry(state)
        return
      }
    }

    const latest = currentGoal(state)
    if (!drivable(latest) || !state.armed) return
    if (latest.id !== goal.id || latest.revision !== goal.revision) {
      reconsider(state)
      return
    }

    const round = latest.roundsStarted + 1
    const content = renderInfiniGoalRoundPrompt(latest, round)
    const message = createUserMessage({
      content,
      source: {
        kind: INFINI_GOAL_MESSAGE_KIND,
        goalId: latest.id,
        revision: latest.revision,
        round,
      },
    })
    state.attempt = {
      goalId: latest.id,
      revision: latest.revision,
      round,
      messageId: message.id,
      content,
      phase: 'queued',
      cancelled: false,
      stale: false,
    }
    try {
      agent.followup(message)
    } catch (error: unknown) {
      state.attempt = undefined
      ctx.logger.warn(`infini-goal-driver: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`)
      reportBlock(state, 'queue-failed', `Could not queue infini-goal round ${round}: ${renderThrown(error)}`)
      return
    }
    // The round now owns the agent lifecycle; idle admission re-enters reconsider().
  }

  /** Coalesce triggers onto one agent-local serialized driver. */
  function requestDrive(state: DriverState): void {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error: unknown) {
            ctx.logger.warn(`infini-goal-driver: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`)
            reportBlock(state, 'driver-error', `Infini-goal driver failed: ${renderThrown(error)}`)
          }
        }
      })
    } catch (error: unknown) {
      ctx.logger.warn(`infini-goal-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, (error: unknown) => {
      ctx.logger.warn(`infini-goal-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
      retire()
    })
  }

  /** Whether a parked message is still the exact queued reservation. */
  function validReservation(state: DriverState, content: readonly ContentBlock[], source: InfiniGoalMessageSource): boolean {
    const attempt = state.attempt
    const goal = currentGoal(state)
    return fiberActive(ctx)
      && !state.stopping && attempt !== undefined && attempt.phase === 'claimed'
      && !attempt.stale && sameQueued(content, source, attempt)
      && goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
      && goal.phase === 'active'
      && source.round === goal.roundsStarted + 1
  }

  /** Whether the current turn is the exact admitted round of the current goal. */
  function dropAttempt(state: DriverState, messageId: MessageId): void {
    const attempt = state.attempt
    if (attempt !== undefined && attempt.messageId === messageId) {
      attempt.stale = true
      state.attempt = undefined
    }
  }

  // One composite effect keeps every listener and timer owned by this plugin.
  ctx.effect(function* () {
    ctx.on('agent/error', ({ agent }) => {
      const state = stateFor(agent)
      // A failure outside an automatic round belongs to the human turn; keep the
      // goal active and let the next idle quiescence schedule another round.
      if (state.attempt === undefined) return
      reportBlock(state, 'agent-error', 'The agent failed during an automatic infini-goal round.')
    })

    ctx.on('agent/disposed', ({ agent }) => {
      const state = states.get(agent)
      if (state === undefined) return
      state.stopping = true
      clearTimers(state)
      states.delete(agent)
    })

    ctx.on('agent/created', ({ agent }): undefined => {
      const state = stateFor(agent)
      state.attempt = undefined
      state.competingQueued = false
      state.needsCheckpoint = false
      startFromPolicy(state)
      return undefined
    })

    ctx.on('agent/status', ({ agent, status }) => {
      const state = stateFor(agent)
      if (status !== 'idle') return
      state.competingQueued = false
      const attempt = state.attempt
      if (attempt !== undefined) {
        if (attempt.phase === 'queued') {
          try {
            agent.inbox.remove(attempt.messageId)
          } catch (error: unknown) {
            ctx.logger.warn(`infini-goal-driver: could not withdraw unused round for agent "${agent.id}": ${renderThrown(error)}`)
          }
        }
        state.attempt = undefined
      }
      // The next reservation must observe everything the finished turn committed.
      state.needsCheckpoint = true
      reconsider(state)
    })

    ctx.on('infini-goal/changed', ({ agent, change }) => {
      const state = stateFor(agent)
      state.needsCheckpoint = true
      if (change.operation === 'pause'
        || change.operation === 'complete'
        || change.operation === 'block'
        || change.operation === 'clear') {
        state.armed = false
        const attempt = state.attempt
        if (attempt !== undefined) {
          attempt.stale = true
          if (attempt.phase === 'queued') {
            try {
              agent.inbox.remove(attempt.messageId)
            } catch (error: unknown) {
              ctx.logger.warn(`infini-goal-driver: could not withdraw paused round for agent "${agent.id}": ${renderThrown(error)}`)
            }
          }
          state.attempt = undefined
        }
        // A host-initiated pause aborts the live turn so the model cannot keep acting.
        if (change.operation === 'pause' && agent.status === 'running'
          && ctx.agents.currentInitiator() !== agent) {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
        }
        clearTimers(state)
        return
      }
      if (change.operation === 'create' || change.operation === 'resume') state.armed = true
      reconsider(state)
    })

    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) return
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) return
      state.competingQueued = true
      if (attempt?.phase === 'queued') attempt.stale = true
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.phase = 'claimed'
      }
    })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.cancelled = true
      }
    })

    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      const state = stateFor(agent)
      switch (event.type) {
        case 'user/message':
          if (state.attempt !== undefined && event.data.id === state.attempt.messageId) {
            state.attempt.phase = 'admitted'
          }
          return
        case 'turn/end': {
          const reason = event.data.reason
          if (reason.kind === 'max-tokens') {
            if (state.attempt !== undefined) {
              reportBlock(state, 'max-tokens', 'An automatic infini-goal round reached its output-token ceiling.')
            }
            return
          }
          if (reason.kind === 'error') {
            if (state.attempt !== undefined) {
              reportBlock(state, 'turn-error', `An automatic infini-goal round failed: ${reason.error.message}`)
            }
            return
          }
          if (reason.kind !== 'aborted') return
          const cause = reason.reason
          if (cause.kind === 'disposed') {
            state.armed = false
            return
          }
          if (state.attempt !== undefined) {
            state.attempt.cancelled = true
            state.attempt = undefined
            reportPause(state, 'round-aborted')
          }
          return
        }
        default:
          return
      }
    })

    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
      const submitted = messages.find((message): message is UserMessage & { source: InfiniGoalMessageSource } => isInfiniGoalRoundSource(message.source))
      if (submitted === undefined) return next()
      const { content, source } = submitted
      const state = stateFor(agent)
      let valid = false
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`infini-goal-driver: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`)
        state.armed = false
      }
      if (!valid) {
        dropAttempt(state, submitted.id)
        restoreOtherClaimed(agent, messages, submitted.id)
        reconsider(state)
        return { kind: 'reject' }
      }
      let decision: PreStepDecision
      try {
        decision = await next()
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // A throwing downstream hook drops the whole step proposal. Clear the
        // reservation so the next quiescence can reschedule the round.
        state.attempt = undefined
        reconsider(state)
        throw error
      }
      if (signal.aborted) {
        if (decision.kind === 'enter') restoreOtherClaimed(agent, decision.messages, submitted.id)
        return decision
      }
      if (decision.kind === 'reject') {
        state.attempt = undefined
        reportBlock(state, 'prompt-rejected', 'An automatic infini-goal round was rejected before entering its step.')
        return decision
      }
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`infini-goal-driver: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`)
        state.armed = false
        valid = false
      }
      if (!valid) {
        state.attempt = undefined
        restoreOtherClaimed(agent, decision.messages, submitted.id)
        reconsider(state)
        return { kind: 'reject' }
      }
      return { ...decision, startsRequestSeries: true }
    })

    // Loading a driver over existing agents starts from the configured policy.
    for (const agent of ctx.agents.list()) {
      startFromPolicy(stateFor(agent))
    }

    // Yielded after listener registration, so this close runs first.
    yield async () => {
      unloading.resolve()
      const waits: Promise<void>[] = []
      for (const state of states.values()) {
        state.stopping = true
        clearTimers(state)
        const attempt = state.attempt
        if (attempt !== undefined) {
          attempt.stale = true
          if (state.agent.status === 'running') {
            state.agent.cancel({ kind: 'parent' })
            waits.push(state.agent.whenIdle())
          }
        }
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'infini-goal-driver lifecycle')
}
