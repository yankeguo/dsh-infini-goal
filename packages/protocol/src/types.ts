/**
 * Pure, runtime-independent vocabulary of the infini-goal domain, shared by the
 * Host plugin packages and the browser UI bundle.
 *
 * The design mirrors the official `dsh-goal` package: one durable goal per
 * Session, event-sourced into the Session log, exposed to the browser through a
 * Session projection. Two deliberate differences:
 *
 * 1. There is no maximum round count. A goal stays `active` until a human or the
 *    model pauses, blocks, completes, or clears it.
 * 2. Automatic continuation is paced by a configurable minimum trigger interval
 *    and suppressed inside configured local-time quiet windows.
 */

// Type-only: pulls the Session-projection type table into the program so the
// `declare module` augmentation below targets a loaded module.
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** Compare-and-set identity of one exact durable goal revision. */
export interface InfiniGoalRef {
  /** Stable goal identity. */
  readonly id: string
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/** Durable continuation phase. */
export type InfiniGoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Machine-routable and human-readable explanation for a blocked goal. */
export interface InfiniGoalBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/**
 * One local-time window in which no automatic round may start.
 *
 * This is the "employee is at work and waits for assigned tasks" period: the
 * durable goal stays active, human turns and tools keep working normally, but
 * the driver never injects a self-started continuation round inside the window.
 */
export interface QuietWindow {
  /** ISO weekday numbers the window starts on (1 = Monday … 7 = Sunday); empty means every day. */
  readonly days: readonly number[]
  /** Local wall-clock start, `HH:mm`, inclusive. */
  readonly start: string
  /** Local wall-clock end, `HH:mm`, exclusive; a value at or before `start` crosses midnight. */
  readonly end: string
}

/** Pacing configuration carried by every goal revision. */
export interface InfiniGoalSettings {
  /** Minimum milliseconds between two automatic round starts. */
  readonly minIntervalMs: number
  /** Local-time windows in which no automatic round starts. */
  readonly quietWindows: readonly QuietWindow[]
  /** IANA time zone name the quiet windows are interpreted in. */
  readonly timezone: string
}

/** Full durable state written by every non-clear goal mutation. */
export interface InfiniGoalSnapshot extends InfiniGoalSettings {
  /** Stable goal identity. */
  readonly id: string
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. `active` means automatic continuation is on. */
  readonly phase: InfiniGoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: InfiniGoalBlockReason
}

/** Live host view: durable snapshot plus replayed counters. */
export interface InfiniGoalView extends InfiniGoalSnapshot {
  /** Highest admitted automatic round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the latest admitted automatic round, or null before round 1. */
  readonly lastRoundAt: number | null
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
}

/**
 * Wire value of the `infiniGoal` Session projection: the current durable goal
 * with the counters the browser needs to render the next eligible trigger.
 */
export interface InfiniGoalProjection {
  /** Current durable goal snapshot (the CAS ref for mutations rides on it). */
  readonly goal: InfiniGoalSnapshot
  /** Highest admitted automatic round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the latest admitted automatic round, or null before round 1. */
  readonly lastRoundAt: number | null
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
}

/** Values a caller may override when creating a goal. */
export interface InfiniGoalCreateRequest {
  /** Non-empty completion objective, inferred from a direct human request. */
  readonly objective: string
  /** Optional override of the deployment default minimum trigger interval. */
  readonly minIntervalMs?: number
  /** Optional override of the deployment default quiet windows. */
  readonly quietWindows?: readonly QuietWindow[]
  /** Optional override of the deployment default quiet-window time zone. */
  readonly timezone?: string
}

/** Fields changed by an edit; at least one must be present. */
export interface InfiniGoalEditRequest {
  /** Replacement objective. */
  readonly objective?: string
  /** Replacement minimum trigger interval in milliseconds. */
  readonly minIntervalMs?: number
  /** Replacement quiet windows. */
  readonly quietWindows?: readonly QuietWindow[]
  /** Replacement quiet-window time zone. */
  readonly timezone?: string
}

/** Operation recorded by one durable `infini-goal/change` event. */
export type InfiniGoalOperation =
  | 'create'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'
  | 'clear'

/**
 * The `infiniGoal` Session projection key. Declared here so the Host service and
 * the browser UI compile against one shape.
 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The Session's current infini-goal and its admitted-round counters, or
     * `null` before the first create and after a clear tombstone.
     */
    infiniGoal: InfiniGoalProjection | null
  }
}
