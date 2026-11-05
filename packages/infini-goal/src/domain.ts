/**
 * Host-side vocabulary of the infini-goal domain: durable change payloads, the
 * `plugin:` record type that stores them, admitted-round message attribution,
 * the live `infini-goal/changed` event, stable error codes, and the merge
 * declarations that make these shapes part of the Host's own type tables.
 *
 * Kept apart from `@yankeguo/dsh-infini-goal-protocol` (the pure, client-safe
 * vocabulary) because these declarations pull dsh-agent, dsh-llm, dsh-session,
 * and cordis into the program.
 *
 * @module @yankeguo/dsh-infini-goal
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the Session type tables into the program so the
// `declare module` augmentations below target loaded modules.
import type {} from '@deepseek-ai/dsh-session/types'
import type {
  InfiniGoalOperation,
  InfiniGoalProjection,
  InfiniGoalRef,
  InfiniGoalSnapshot,
  InfiniGoalView,
} from '@yankeguo/dsh-infini-goal-protocol'

/**
 * Session event type of the durable plugin record carrying one infini-goal
 * change or clear tombstone.
 *
 * Host state cannot use a declared `SessionEventMap` member: the persisted
 * Session read path refuses event types outside the harness's repository-built
 * vocabulary unless the envelope is marked `ignorable`, and an out-of-tree
 * plugin cannot add to that vocabulary. The documented channel for durable
 * plugin-owned state is therefore a plugin record in the `plugin:` namespace
 * (`appendPluginRecord`), which every reader retains and reloads while never
 * projecting it into the model-visible surface.
 */
export const INFINI_GOAL_RECORD_TYPE = 'plugin:infini-goal/change'

/** Full-snapshot mutation committed by one durable infini-goal change record. */
export interface InfiniGoalSnapshotChange {
  readonly kind: 'infini-goal/change'
  readonly version: 1
  /** Lifecycle verb; `clear` has its own tombstone shape. */
  readonly operation: Exclude<InfiniGoalOperation, 'clear'>
  /** Complete post-mutation goal snapshot. */
  readonly goal: InfiniGoalSnapshot
  /** Highest automatic round admitted for this goal before this mutation. */
  readonly roundsStarted: number
  /** Instant the latest admitted round was logged, or null before round 1. */
  readonly lastRoundAt: number | null
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of this mutation. */
  readonly updatedAt: number
}

/** Tombstone retained when the current goal is cleared. */
export interface InfiniGoalClearChange {
  readonly kind: 'infini-goal/change'
  readonly version: 1
  readonly operation: 'clear'
  /** Cleared goal identity whose revision is one past the cleared snapshot. */
  readonly cleared: InfiniGoalRef
  /** Epoch milliseconds of the clear mutation. */
  readonly clearedAt: number
}

/** Durable change union carried by the `plugin:infini-goal/change` Session record. */
export type InfiniGoalChange = InfiniGoalSnapshotChange | InfiniGoalClearChange

/** Message attribution for an admitted automatic continuation round. */
export interface InfiniGoalMessageSource {
  readonly kind: 'infini-goal'
  /** Goal identity the admitted round belongs to. */
  readonly goalId: string
  /** Exact goal revision the round was scheduled against. */
  readonly revision: number
  /** Positive admitted round number. */
  readonly round: number
}

/** Live notification after one durable infini-goal mutation commits. */
export interface InfiniGoalChanged {
  readonly operation: InfiniGoalOperation
  /** Revision identity carried by the committed change. */
  readonly ref: InfiniGoalRef
  /** Fresh current view; absent for a clear tombstone. */
  readonly goal?: InfiniGoalView
}

/** Detached durable state folded from a contiguous session event log. */
export interface FoldedInfiniGoal {
  /** Current goal, absent after a clear or before the first create. */
  readonly goal?: InfiniGoalSnapshot
  /** Highest automatic round admitted for the current goal. */
  readonly roundsStarted: number
  /** Instant the latest admitted round was logged, or null before round 1. */
  readonly lastRoundAt: number | null
  /** Current goal creation time, absent without a current goal. */
  readonly createdAt?: number
  /** Current goal mutation time, absent without a current goal. */
  readonly updatedAt?: number
  /** Latest mutation ref, including a clear tombstone. */
  readonly lastRef?: InfiniGoalRef
}

/**
 * Strict checkpoint state of the `infiniGoal` projection unit.
 *
 * `current` is the durable goal derived from change records and admitted
 * rounds; `seenGoalIds` retains every created identity so reuse is rejected
 * during replay; `failure` holds the first strict replay failure.
 */
export interface InfiniGoalProjectionState {
  /** Latest valid current goal, or null before creation and after clear. */
  readonly current: InfiniGoalProjection | null
  /** Goal identities already created in this Session, retained to reject reuse. */
  readonly seenGoalIds: string[]
  /** First strict replay failure, or null while the durable stream is valid. */
  readonly failure: string | null
}

/** Stable error codes for rejected infini-goal reads and mutations. */
export type InfiniGoalErrorCode =
  | 'INFINI_GOAL_AGENT_NOT_LIVE'
  | 'INFINI_GOAL_NOT_FOUND'
  | 'INFINI_GOAL_ALREADY_EXISTS'
  | 'INFINI_GOAL_STALE_REVISION'
  | 'INFINI_GOAL_INVALID_OBJECTIVE'
  | 'INFINI_GOAL_INVALID_SETTINGS'
  | 'INFINI_GOAL_INVALID_TRANSITION'
  | 'INFINI_GOAL_INVALID_BLOCK_REASON'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One automatic continuation round admitted by the infini-goal driver. */
    'infini-goal': InfiniGoalMessageSource
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /**
     * Complete post-mutation infini-goal state or clear tombstone, stored as an
     * ignorable plugin record so every harness build can reload the Session.
     */
    'plugin:infini-goal/change': InfiniGoalChange
  }

  /**
   * Retired session event type of the durable change. Declared only so the
   * fold can replay an in-memory log written before a plugin hot-reload; this
   * representation is NOT reloadable from storage because its event type is
   * outside the harness's known vocabulary.
   * @deprecated Never append it; write `plugin:infini-goal/change` records.
   */
  interface SessionEventMap {
    'infini-goal/change': InfiniGoalChange
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Infini-goal mutation accepted by one live agent. The matching durable
     * `plugin:infini-goal/change` record has already committed.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only that agent.
     * @param payload.agent - agent whose session owns the goal.
     * @param payload.change - fresh current view or clear tombstone.
     * @mode emit
     */
    'infini-goal/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: InfiniGoalChanged }): void
  }
}
