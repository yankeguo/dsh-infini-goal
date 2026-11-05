/**
 * Host-side vocabulary of the infini-goal domain: durable change payloads,
 * admitted-round message attribution, the live `infini-goal/changed` event,
 * stable error codes, and the merge declarations that make these shapes part
 * of the Host's own type tables.
 *
 * Kept apart from `@yankeguo/dsh-infini-goal-protocol` (the pure, client-safe
 * vocabulary) because these declarations pull dsh-agent, dsh-llm, dsh-session,
 * and cordis into the program.
 *
 * @module @yankeguo/dsh-infini-goal
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  InfiniGoalOperation,
  InfiniGoalProjection,
  InfiniGoalRef,
  InfiniGoalSnapshot,
  InfiniGoalView,
} from '@yankeguo/dsh-infini-goal-protocol'

/** Full-snapshot mutation committed by a durable `infini-goal/change` event. */
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

/** Durable change union carried by the `infini-goal/change` session event. */
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
 * `current` is the durable goal derived from `infini-goal/change` events and
 * admitted rounds; `seenGoalIds` retains every created identity so reuse is
 * rejected during replay; `failure` holds the first strict replay failure.
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
  interface SessionEventMap {
    /**
     * Complete post-mutation infini-goal state or clear tombstone.
     */
    'infini-goal/change': InfiniGoalChange
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Infini-goal mutation accepted by one live agent. The matching
     * `infini-goal/change` session event has already committed.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only that agent.
     * @param payload.agent - agent whose session owns the goal.
     * @param payload.change - fresh current view or clear tombstone.
     * @mode emit
     */
    'infini-goal/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: InfiniGoalChanged }): void
  }
}
