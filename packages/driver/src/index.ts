/**
 * Automatic continuation driver for the endless infini-goal.
 *
 * The official `dsh-goal-round-driver` drives an armed goal immediately at
 * agent quiescence. This driver instead obeys the pacing policy owned by the
 * protocol package: the next round may start no earlier than
 * `lastRoundAt + minIntervalMs`, and never inside a configured quiet window.
 * While a quiet window is active the goal stays `active` and human turns keep
 * working normally, but no automatic round is injected until the window ends.
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
   * plugin loads or a Session Agent is created. When false the driver persists
   * a `pause` for that goal at startup, so it waits for an explicit human
   * `/infini-goal resume` instead of silently continuing.
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
  /** Turn that claimed this round, once the loop's inbox reports it. */
  turn: number | undefined
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
  /** True while the serialized driver is being started (re-entrancy fence). */
  starting: boolean
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

/** Human-readable message for a thrown error or a structured failure record. */
function renderFailure(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = (value as { readonly message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return renderThrown(value)
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
      starting: false,
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

  /**
   * Run one goal mutation outside the current synchronous stack.
   *
   * `Session.append` refuses to re-enter while another append is publishing its
   * `session/event` observers. Blocking or pausing from a `turn/end` observer
   * would therefore throw and be swallowed by the observer containment, leaving
   * the durable goal active. Deferring to a microtask escapes that publish and
   * still settles before the loop announces `idle`.
   */
  function deferGoalMutation(state: DriverState, run: () => void): void {
    queueMicrotask(() => {
      if (state.stopping || !fiberActive(ctx)) return
      try {
        run()
      } catch (error: unknown) {
        ctx.logger.warn(`infini-goal-driver: deferred goal mutation failed for agent "${state.agent.id}": ${renderThrown(error)}`)
      }
    })
  }

  /** Block one exact goal revision, ignoring a ref that moved on. */
  function blockGoalAt(state: DriverState, expected: InfiniGoalRef, code: string, message: string): void {
    const goal = currentGoal(state)
    if (!drivable(goal) || goal.id !== expected.id || goal.revision !== expected.revision) return
    try {
      ctx.infiniGoals.block(state.agent, expected, { code, message })
    } catch (error: unknown) {
      ctx.logger.warn(`infini-goal-driver: could not block goal for agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /** Pause one exact goal revision, ignoring a ref that moved on. */
  function pauseGoalAt(state: DriverState, expected: InfiniGoalRef, code: string): void {
    const goal = currentGoal(state)
    if (!drivable(goal) || goal.id !== expected.id || goal.revision !== expected.revision) return
    try {
      ctx.infiniGoals.pause(state.agent, expected)
    } catch (error: unknown) {
      ctx.logger.warn(`infini-goal-driver: could not pause goal (${code}) for agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /** Block the current goal with one stable policy code, when still active. */
  function reportBlock(state: DriverState, code: string, message: string): void {
    const goal = currentGoal(state)
    if (!drivable(goal)) return
    blockGoalAt(state, goalRef(goal), code, message)
  }

  /** Defer a block fenced to the goal revision observable right now. */
  function deferBlockAtCurrentRevision(state: DriverState, code: string, message: string): void {
    const goal = currentGoal(state)
    if (!drivable(goal)) return
    const expected = goalRef(goal)
    deferGoalMutation(state, () => { blockGoalAt(state, expected, code, message) })
  }

  /** Defer a pause fenced to the goal revision observable right now. */
  function deferPauseAtCurrentRevision(state: DriverState, code: string): void {
    const goal = currentGoal(state)
    if (!drivable(goal)) return
    const expected = goalRef(goal)
    deferGoalMutation(state, () => { pauseGoalAt(state, expected, code) })
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
      // A failed startup pause must not leave the goal active-but-silent: fall
      // back to automatic continuation instead of stalling until a human event.
      state.armed = true
      reconsider(state)
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
      // Consume the flag before awaiting: events that land while the flush is
      // settling must request one more checkpoint instead of being erased.
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        ctx.logger.warn(`infini-goal-driver: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`)
        state.needsCheckpoint = true
        const goal = currentGoal(state)
        if (drivable(goal)) {
          blockGoalAt(state, goalRef(goal), 'checkpoint-failed', `Could not checkpoint the session before the next infini-goal round: ${renderThrown(error)}`)
        }
        return
      }
      if (!readyToDrive(state)) {
        armRetry(state)
        return
      }
      if (state.needsCheckpoint) {
        reconsider(state)
        return
      }
    }

    const pending = state.attempt
    if (pending !== undefined) {
      // A reservation that outlived its turn can never be admitted by this
      // driver: withdraw it so the next quiescence can reserve a fresh round.
      state.attempt = undefined
      pending.stale = true
      if (pending.phase === 'queued') {
        try {
          agent.inbox.remove(pending.messageId)
        } catch (error: unknown) {
          ctx.logger.warn(`infini-goal-driver: could not withdraw stale round for agent "${agent.id}": ${renderThrown(error)}`)
        }
      }
      state.needsCheckpoint = true
      state.requested = true
      return
    }

    const goal = currentGoal(state)
    if (!drivable(goal) || !state.armed) return

    const plan = planFor(state)
    if (plan === undefined) {
      reconsider(state)
      return
    }
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
      // The child wait can cross a pacing boundary: never reserve a round that
      // is now inside a quiet window (or before the minimum interval).
      if (state.needsCheckpoint) {
        reconsider(state)
        return
      }
      const paced = planFor(state)
      if (paced === undefined || paced.nextAt > Date.now()) {
        reconsider(state)
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
      turn: undefined,
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
    // `withoutInitiator` starts the async driver synchronously, and that prefix
    // can dispatch a session flush whose observers mutate the goal and call
    // back into requestDrive before `state.run` is assigned. The `starting`
    // fence keeps exactly one serialized driver alive across that re-entry.
    if (state.run !== undefined || state.starting) return
    state.starting = true
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error: unknown) {
            ctx.logger.warn(`infini-goal-driver: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`)
            deferBlockAtCurrentRevision(state, 'driver-error', `Infini-goal driver failed: ${renderThrown(error)}`)
          }
        }
      })
    } catch (error: unknown) {
      state.starting = false
      state.requested = false
      ctx.logger.warn(`infini-goal-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      deferBlockAtCurrentRevision(state, 'driver-error', `Could not start the infini-goal driver: ${renderThrown(error)}`)
      return
    }
    state.starting = false
    state.run = run
    const retire = (): void => {
      if (state.run !== run) return
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, (error: unknown) => {
      ctx.logger.warn(`infini-goal-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
      deferBlockAtCurrentRevision(state, 'driver-error', `Infini-goal driver task rejected: ${renderThrown(error)}`)
      retire()
    })
  }

  /** Whether a parked message is still the exact queued reservation. */
  function validReservation(state: DriverState, content: readonly ContentBlock[], source: InfiniGoalMessageSource): boolean {
    const attempt = state.attempt
    const goal = currentGoal(state)
    return fiberActive(ctx)
      && !state.stopping && state.armed && attempt !== undefined && attempt.phase === 'claimed'
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
    ctx.on('agent/error', ({ agent, turn, error }) => {
      const state = stateFor(agent)
      // A failure outside the automatic round's own turn belongs to human work;
      // keep the goal active and let the next idle quiescence schedule again.
      const attempt = state.attempt
      if (attempt === undefined || attempt.turn !== turn) return
      reportBlock(state, 'agent-error', `The agent failed during an automatic infini-goal round: ${renderFailure(error)}`)
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
      const attempt = state.attempt
      if (attempt?.phase === 'queued') {
        try {
          agent.inbox.remove(attempt.messageId)
        } catch (error: unknown) {
          ctx.logger.warn(`infini-goal-driver: could not withdraw round on agent creation for agent "${agent.id}": ${renderThrown(error)}`)
        }
      }
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
        // A reservation discarded before its turn could run means the agent was
        // cancelled while a round was pending: pause for an explicit decision
        // instead of silently re-arming another round.
        if (attempt.cancelled && !state.stopping) {
          pauseGoalAt(state, { id: attempt.goalId, revision: attempt.revision }, 'round-cancelled')
        }
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
        const roundInFlight = attempt !== undefined && (attempt.phase === 'claimed' || attempt.phase === 'admitted')
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
        // A host-initiated terminal mutation aborts the live automatic round so
        // the model cannot keep acting (a human turn is left untouched).
        if (roundInFlight && agent.status === 'running'
          && ctx.agents.currentInitiator() !== agent) {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
        }
        clearTimers(state)
        return
      }
      if (change.operation === 'edit') {
        // An edit that lands after the step proposal was validated but before
        // the loop commits its user/message would make the strict fold reject a
        // round carrying the old revision. Withdraw the not-yet-admitted round
        // instead of corrupting the projection; the next round uses the new ref.
        const attempt = state.attempt
        if (attempt !== undefined && attempt.phase === 'claimed' && agent.status === 'running'
          && ctx.agents.currentInitiator() !== agent) {
          agent.cancel({ kind: 'parent' }, { keepInbox: true })
        }
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
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.phase = 'claimed'
        attempt.turn = turn
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
          const { turn, reason } = event.data
          const attempt = state.attempt
          // Only the turn that owns the reservation may settle its outcome; a
          // human turn running after the round must not block or pause the goal.
          const ownsTurn = attempt !== undefined && attempt.turn === turn
          if (reason.kind === 'max-tokens') {
            if (!ownsTurn) return
            state.attempt = undefined
            deferBlockAtCurrentRevision(state, 'max-tokens', 'An automatic infini-goal round reached its output-token ceiling.')
            return
          }
          if (reason.kind === 'error') {
            if (!ownsTurn) return
            state.attempt = undefined
            deferBlockAtCurrentRevision(state, 'turn-error', `An automatic infini-goal round failed: ${reason.error.message}`)
            return
          }
          if (reason.kind !== 'aborted') {
            // The round's own turn closed normally (or was rejected): the
            // reservation cannot be admitted any more.
            if (ownsTurn) state.attempt = undefined
            return
          }
          const cause = reason.reason
          if (cause.kind === 'disposed') {
            // Agent disposal keeps the durable phase untouched for the next owner.
            state.armed = false
            if (ownsTurn) state.attempt = undefined
            return
          }
          if (ownsTurn && attempt !== undefined) {
            attempt.cancelled = true
            state.attempt = undefined
            // A cancelled round means a human (or hook) took the wheel: pause the
            // goal durably, fenced to the revision the round was admitted under.
            // `parent` cancellations are owner/driver-internal (unload, a stale
            // round, a terminal goal mutation) and must not pause the goal.
            if (!state.stopping && cause.kind !== 'parent') {
              deferPauseAtCurrentRevision(state, 'round-aborted')
            }
          }
          return
        }
        default:
          return
      }
    })

    ctx.on('agent/pre-step', async ({ agent, messages, signal, turn }, next): Promise<PreStepDecision> => {
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
      if (state.attempt !== undefined) state.attempt.turn ??= turn
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
        state.armed = false
        clearTimers(state)
        const attempt = state.attempt
        state.attempt = undefined
        if (attempt !== undefined) {
          attempt.stale = true
          if (attempt.phase === 'queued') {
            // A round that never entered its turn would otherwise be admitted as
            // an ordinary user turn by the next owner of this agent.
            try {
              state.agent.inbox.remove(attempt.messageId)
            } catch (error: unknown) {
              ctx.logger.warn(`infini-goal-driver: could not withdraw queued round on unload for agent "${state.agent.id}": ${renderThrown(error)}`)
            }
          } else if (state.agent.status === 'running') {
            // Only an admitted round owns a turn; never abort unrelated human work.
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
