/**
 * Same-session endless goal domain: event-sourced durable state, compare-and-set
 * mutations, and a Session projection carrying the live goal to the browser.
 *
 * Unlike the official `dsh-goal`, this service has no round cap and no
 * process-local activation state: `phase === 'active'` means automatic
 * continuation is enabled, and pacing is enforced by the driver through the
 * goal's own `minIntervalMs` / `quietWindows` / `timezone` settings.
 *
 * @module @yankeguo/dsh-infini-goal
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import {
  DEFAULT_MIN_INTERVAL_MS,
  INFINI_GOAL_CHANGE_VERSION,
  MAX_MIN_INTERVAL_MS,
  MIN_MIN_INTERVAL_MS,
  INFINI_GOAL_CHANGED_EVENT,
  INFINI_GOAL_EVENT_TYPE,
  INFINI_GOAL_PROJECTION_KEY,
  planTrigger,
} from '@yankeguo/dsh-infini-goal-protocol'
import type {
  InfiniGoalBlockReason,
  InfiniGoalCreateRequest,
  InfiniGoalEditRequest,
  InfiniGoalOperation,
  InfiniGoalPhase,
  InfiniGoalProjection,
  InfiniGoalRef,
  InfiniGoalSnapshot,
  InfiniGoalView,
  TriggerPlan,
} from '@yankeguo/dsh-infini-goal-protocol'
import { applyInfiniGoalEvent, infiniGoalChangeRef } from './fold.ts'
import type { InfiniGoalFoldState } from './fold.ts'
import {
  InfiniGoalError,
  infiniGoalId,
  resolveBlockReason,
  resolveCreateSettings,
  resolveEditSettings,
  resolveObjective,
  resolveServiceConfig,
  systemTimeZone,
} from './runtime.ts'
import type { Config, ResolvedConfig } from './runtime.ts'
import type {
  InfiniGoalChange,
  InfiniGoalChanged,
  InfiniGoalClearChange,
  InfiniGoalProjectionState,
  InfiniGoalSnapshotChange,
} from './domain.ts'

export type * from './domain.ts'
export type * from '@yankeguo/dsh-infini-goal-protocol'
export { InfiniGoalError } from './runtime.ts'
export type { Config, ResolvedConfig } from './runtime.ts'
export {
  applyInfiniGoalChange,
  applyInfiniGoalEvent,
  decodeInfiniGoalChange,
  emptyInfiniGoalFoldState,
  foldInfiniGoal,
  infiniGoalChangeRef,
} from './fold.ts'
export type { InfiniGoalFoldState } from './fold.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    infiniGoals: InfiniGoalService
  }
}

/** Wire payload schema of the `infiniGoal` projection: the current durable goal
 * with its replayed round counters, or `null` before creation/after clear. */
export const infiniGoalProjectionSchema: ZodType<InfiniGoalProjection | null> = zod.union([
  zod.object({
    goal: zod.object({
      id: zod.string().min(1),
      revision: zod.number().int().positive(),
      objective: zod.string().min(1),
      phase: zod.union([
        zod.literal('active'),
        zod.literal('paused'),
        zod.literal('blocked'),
        zod.literal('complete'),
      ]),
      blockedReason: zod.object({ code: zod.string(), message: zod.string() }).optional(),
      minIntervalMs: zod.number().int().positive(),
      quietWindows: zod.array(zod.object({
        days: zod.array(zod.number().int().min(1).max(7)),
        start: zod.string(),
        end: zod.string(),
      })),
      timezone: zod.string().min(1),
    }),
    roundsStarted: zod.number().int().nonnegative(),
    lastRoundAt: zod.number().int().nonnegative().nullable(),
    createdAt: zod.number(),
    updatedAt: zod.number(),
  }),
  zod.null(),
]) as ZodType<InfiniGoalProjection | null>

/** Persisted-state schema of the `infiniGoal` projection unit. */
const infiniGoalProjectionStateSchema: ZodType<InfiniGoalProjectionState> = zod.object({
  current: infiniGoalProjectionSchema,
  seenGoalIds: zod.array(zod.string().min(1)).refine(
    ids => new Set(ids).size === ids.length,
    { message: 'seen goal ids must be unique' },
  ),
  failure: zod.string().min(1).nullable(),
}).strict().superRefine((state, context) => {
  if (state.current === null) return
  const current = state.current
  if (!state.seenGoalIds.includes(current.goal.id)) {
    context.addIssue({ code: 'custom', message: 'current goal id must be retained among seen goal ids' })
  }
  if (current.updatedAt < current.createdAt) {
    context.addIssue({ code: 'custom', message: 'current goal update cannot precede its creation' })
  }
  if ((current.roundsStarted === 0) !== (current.lastRoundAt === null)) {
    context.addIssue({ code: 'custom', message: 'current goal lastRoundAt must be null exactly before the first admitted round' })
  }
  if (current.lastRoundAt !== null && current.lastRoundAt < current.createdAt) {
    context.addIssue({ code: 'custom', message: 'current goal lastRoundAt cannot precede its creation' })
  }
  if ((current.goal.phase === 'blocked') !== (current.goal.blockedReason !== undefined)) {
    context.addIssue({ code: 'custom', message: 'current goal blocked reason must exist exactly while blocked' })
  }
}) as unknown as ZodType<InfiniGoalProjectionState>

/** Build strict fold state from one checkpoint-safe projection state. */
function foldStateFromProjection(state: InfiniGoalProjectionState): InfiniGoalFoldState {
  return {
    goal: state.current?.goal,
    roundsStarted: state.current?.roundsStarted ?? 0,
    lastRoundAt: state.current?.lastRoundAt ?? null,
    createdAt: state.current?.createdAt,
    updatedAt: state.current?.updatedAt,
    lastRef: undefined,
    seenGoalIds: new Set(state.seenGoalIds),
  }
}

/** Convert strict fold state into checkpoint-safe projection state. */
function projectionFromFoldState(state: InfiniGoalFoldState): InfiniGoalProjectionState {
  let current: InfiniGoalProjection | null = null
  if (state.goal !== undefined) {
    const { createdAt, updatedAt } = state
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error('current infini-goal fold lacks timestamps')
    }
    current = {
      goal: state.goal,
      roundsStarted: state.roundsStarted,
      lastRoundAt: state.lastRoundAt,
      createdAt,
      updatedAt,
    }
  }
  return {
    current,
    seenGoalIds: [...state.seenGoalIds],
    failure: null,
  }
}

/**
 * Fold one committed session event through the strict replay rules without
 * throwing from the projection registry's event drive. The first invalid
 * owned event is retained in `failure`; host service reads then reject the
 * corrupt state while the client view remains at the last valid goal.
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is unrelated).
 */
export function applyInfiniGoalProjection(
  state: InfiniGoalProjectionState,
  event: SessionEvent,
): InfiniGoalProjectionState {
  if (state.failure !== null) return state
  if (event.type !== INFINI_GOAL_EVENT_TYPE
    && (event.type !== 'user/message' || event.data.source.kind !== 'infini-goal')) return state
  const folded = foldStateFromProjection(state)
  try {
    applyInfiniGoalEvent(folded, event)
    return projectionFromFoldState(folded)
  } catch (error: unknown) {
    /* v8 ignore next -- the strict fold throws Error instances. */
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `infini-goal replay failed at session event ${event.seq}: ${message}` }
  }
}

/** Strict host infini-goal state with the client-facing projection value. */
export const infiniGoalProjectionDefinition = {
  key: INFINI_GOAL_PROJECTION_KEY,
  stateSchema: infiniGoalProjectionStateSchema,
  init: (): InfiniGoalProjectionState => ({ current: null, seenGoalIds: [], failure: null }),
  apply: applyInfiniGoalProjection,
  wire: { viewSchema: infiniGoalProjectionSchema, view: (state: InfiniGoalProjectionState) => state.current },
  stateVersion: 1,
} satisfies ProjectionDefinition<'infiniGoal', InfiniGoalProjectionState>

/**
 * Endless goal service (`ctx.infiniGoals`) backed exclusively by the owning
 * session log. Every mutation is a compare-and-set against the current
 * revision; the durable event is appended first and the live notification is
 * emitted only after the commit.
 */
export class InfiniGoalService extends Service {
  static inject = ['agents', 'sessionProjections']

  /** Deployment-default schema; the loader applies these defaults before construction. */
  static Config = z.object({
    defaultMinIntervalMs: z.number()
      .step(1)
      .min(MIN_MIN_INTERVAL_MS)
      .max(MAX_MIN_INTERVAL_MS)
      .default(DEFAULT_MIN_INTERVAL_MS),
    defaultQuietWindows: z.array(z.object({
      days: z.array(z.number().step(1).min(1).max(7)).default([]),
      start: z.string().required(),
      end: z.string().required(),
    })).default([]),
    timezone: z.string().default(systemTimeZone()),
  })

  /** Validated deployment defaults applied to creates that omit a field. */
  private readonly resolved: ResolvedConfig

  /** Awaited registration of the `infiniGoal` projection unit. */
  private projectionHandle!: ProjectionHandle<InfiniGoalProjectionState>

  /**
   * @param ctx - owning cordis context.
   * @param config - deployment defaults for created goals.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'infiniGoals')
    this.resolved = resolveServiceConfig(config)
  }

  protected async [Service.init](): Promise<void> {
    this.projectionHandle = await this.ctx.sessionProjections.register(infiniGoalProjectionDefinition)
  }

  /**
   * Read the current goal for one exact live agent.
   * @param agent - owning live agent.
   * @returns a fresh view or `undefined` when no goal is current.
   * @throws {@link InfiniGoalError} when the agent is not the registry's live instance.
   */
  get(agent: Agent): InfiniGoalView | undefined {
    this.assertLive(agent)
    const current = this.state(agent.session)
    return current === null ? undefined : this.view(current)
  }

  /**
   * Create and activate a goal. A completed (or absent) current goal may be
   * replaced; every other current phase must be cleared or completed instead.
   * @param agent - owning live agent.
   * @param request - objective and optional pacing overrides.
   * @returns the created live view.
   */
  create(agent: Agent, request: InfiniGoalCreateRequest): InfiniGoalView {
    this.assertLive(agent)
    const current = this.state(agent.session)
    if (current !== null && current.goal.phase !== 'complete') {
      throw new InfiniGoalError(
        `infini-goal "${current.goal.id}" already exists with phase "${current.goal.phase}"`,
        'INFINI_GOAL_ALREADY_EXISTS',
      )
    }
    const objective = resolveObjective(request.objective)
    // A replaced completed goal anchors the new goal's timestamps, so a
    // backwards wall-clock step cannot produce a replay-invalid create.
    const now = current === null ? Date.now() : Math.max(Date.now(), current.updatedAt)
    const settings = resolveCreateSettings(request, this.resolved, now)
    const goal: InfiniGoalSnapshot = {
      id: infiniGoalId(),
      revision: 1,
      objective,
      phase: 'active',
      minIntervalMs: settings.minIntervalMs,
      quietWindows: settings.quietWindows,
      timezone: settings.timezone,
    }
    const change: InfiniGoalSnapshotChange = {
      kind: INFINI_GOAL_EVENT_TYPE,
      version: INFINI_GOAL_CHANGE_VERSION,
      operation: 'create',
      goal,
      roundsStarted: 0,
      lastRoundAt: null,
      createdAt: now,
      updatedAt: now,
    }
    return this.commitView(agent, change)
  }

  /**
   * Edit objective and/or pacing settings without changing phase.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param request - at least one replacement field.
   * @returns the edited view.
   */
  edit(agent: Agent, ref: InfiniGoalRef, request: InfiniGoalEditRequest): InfiniGoalView {
    this.assertLive(agent)
    const current = this.expectCurrent(this.state(agent.session), ref)
    const now = Date.now()
    const objective = request.objective === undefined
      ? current.goal.objective
      : resolveObjective(request.objective)
    const settings = resolveEditSettings(current.goal, request, now)
    const goal: InfiniGoalSnapshot = {
      ...current.goal,
      revision: current.goal.revision + 1,
      objective,
      minIntervalMs: settings.minIntervalMs,
      quietWindows: settings.quietWindows,
      timezone: settings.timezone,
    }
    const change: InfiniGoalSnapshotChange = {
      kind: INFINI_GOAL_EVENT_TYPE,
      version: INFINI_GOAL_CHANGE_VERSION,
      operation: 'edit',
      goal,
      roundsStarted: current.roundsStarted,
      lastRoundAt: current.lastRoundAt,
      createdAt: current.createdAt,
      updatedAt: Math.max(now, current.updatedAt),
    }
    return this.commitView(agent, change)
  }

  /**
   * Pause an active goal so automatic continuation stops.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the paused view.
   */
  pause(agent: Agent, ref: InfiniGoalRef): InfiniGoalView {
    return this.transition(agent, ref, 'pause', ['active'], 'paused')
  }

  /**
   * Resume a paused or blocked goal. There is no round cap, so a resume is
   * never rejected for exhaustion; a blocked reason is cleared.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the active view.
   */
  resume(agent: Agent, ref: InfiniGoalRef): InfiniGoalView {
    return this.transition(agent, ref, 'resume', ['paused', 'blocked'], 'active')
  }

  /**
   * Mark a current goal complete. `active` means automatic continuation is on,
   * so completion is final for this goal until a new one is created.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the completed view.
   */
  complete(agent: Agent, ref: InfiniGoalRef): InfiniGoalView {
    return this.transition(agent, ref, 'complete', ['active', 'paused', 'blocked'], 'complete')
  }

  /**
   * Mark an active goal blocked with a policy-owned stable code.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param reason - stable code and human-readable explanation.
   * @returns the blocked view with its durable reason.
   */
  block(agent: Agent, ref: InfiniGoalRef, reason: InfiniGoalBlockReason): InfiniGoalView {
    return this.transition(agent, ref, 'block', ['active'], 'blocked', resolveBlockReason(reason))
  }

  /**
   * Clear the current goal while retaining a durable tombstone and history.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the tombstone ref whose revision is one past the cleared snapshot.
   */
  clear(agent: Agent, ref: InfiniGoalRef): InfiniGoalRef {
    this.assertLive(agent)
    const current = this.expectCurrent(this.state(agent.session), ref)
    const tombstone: InfiniGoalRef = { id: current.goal.id, revision: current.goal.revision + 1 }
    const change: InfiniGoalClearChange = {
      kind: INFINI_GOAL_EVENT_TYPE,
      version: INFINI_GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: Math.max(Date.now(), current.updatedAt),
    }
    this.commit(agent, change)
    return { ...tombstone }
  }

  /**
   * Describe when the next automatic round may start for one live agent.
   * @param agent - owning live agent.
   * @returns the pacing plan, or `undefined` when no goal is current.
   */
  plan(agent: Agent): TriggerPlan | undefined {
    this.assertLive(agent)
    const current = this.state(agent.session)
    return current === null ? undefined : planTrigger(current.goal, current.lastRoundAt, Date.now())
  }

  /** Enforce exact live-agent identity rather than trusting a matching id. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new InfiniGoalError(`agent "${agent.id}" is not live in this registry`, 'INFINI_GOAL_AGENT_NOT_LIVE')
    }
  }

  /** Read the current durable projection maintained by the registry. */
  private state(session: Session): InfiniGoalProjection | null {
    const state = this.projectionHandle.stateOf(session)
    if (state.failure !== null) throw new Error(state.failure)
    return state.current
  }

  /** Reject stale or missing current-state refs. */
  private expectCurrent(projection: InfiniGoalProjection | null, ref: InfiniGoalRef): InfiniGoalProjection {
    if (projection === null) throw new InfiniGoalError('no current infini-goal', 'INFINI_GOAL_NOT_FOUND')
    const current = projection.goal
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new InfiniGoalError(
        `stale infini-goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'INFINI_GOAL_STALE_REVISION',
      )
    }
    return projection
  }

  /** Shared validated phase transition. */
  private transition(
    agent: Agent,
    ref: InfiniGoalRef,
    operation: Exclude<InfiniGoalOperation, 'create' | 'edit' | 'clear'>,
    allowed: readonly InfiniGoalPhase[],
    phase: InfiniGoalPhase,
    blockedReason?: InfiniGoalBlockReason,
  ): InfiniGoalView {
    this.assertLive(agent)
    const current = this.expectCurrent(this.state(agent.session), ref)
    if (!allowed.includes(current.goal.phase)) {
      throw this.transitionError(current.goal, operation, allowed)
    }
    const goal: InfiniGoalSnapshot = {
      id: current.goal.id,
      revision: current.goal.revision + 1,
      objective: current.goal.objective,
      phase,
      minIntervalMs: current.goal.minIntervalMs,
      quietWindows: current.goal.quietWindows,
      timezone: current.goal.timezone,
      ...blockedReason === undefined ? {} : { blockedReason },
    }
    const change: InfiniGoalSnapshotChange = {
      kind: INFINI_GOAL_EVENT_TYPE,
      version: INFINI_GOAL_CHANGE_VERSION,
      operation,
      goal,
      roundsStarted: current.roundsStarted,
      lastRoundAt: current.lastRoundAt,
      createdAt: current.createdAt,
      updatedAt: Math.max(Date.now(), current.updatedAt),
    }
    return this.commitView(agent, change)
  }

  /** Render a stable invalid-transition error. */
  private transitionError(
    current: InfiniGoalSnapshot,
    operation: InfiniGoalOperation,
    allowed: readonly InfiniGoalPhase[],
  ): InfiniGoalError {
    return new InfiniGoalError(
      `cannot ${operation} infini-goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'INFINI_GOAL_INVALID_TRANSITION',
    )
  }

  /** Commit a mutation that must leave a current goal behind. */
  private commitView(agent: Agent, change: InfiniGoalChange): InfiniGoalView {
    const current = this.commit(agent, change)
    /* v8 ignore next -- the strict fold rejects any commit that drops the goal. */
    if (current === null) throw new Error(`infini-goal ${change.operation} did not produce a current goal`)
    return this.view(current)
  }

  /** Append one mutation and publish its live notification after the commit. */
  private commit(agent: Agent, change: InfiniGoalChange): InfiniGoalProjection | null {
    agent.session.append(INFINI_GOAL_EVENT_TYPE, change)
    const current = this.state(agent.session)
    const goal = current === null ? undefined : this.view(current)
    const notification: InfiniGoalChanged = {
      operation: change.operation,
      ref: { ...infiniGoalChangeRef(change) },
      ...goal === undefined ? {} : { goal },
    }
    agentEvents(this.ctx, agent).emit(INFINI_GOAL_CHANGED_EVENT, { change: notification })
    return current
  }

  /** Build a detached current view. */
  private view(projection: InfiniGoalProjection): InfiniGoalView {
    return {
      ...projection.goal,
      roundsStarted: projection.roundsStarted,
      lastRoundAt: projection.lastRoundAt,
      createdAt: projection.createdAt,
      updatedAt: projection.updatedAt,
    }
  }
}

export default InfiniGoalService
