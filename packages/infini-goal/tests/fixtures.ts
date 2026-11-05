/**
 * Deterministic fixtures for the infini-goal strict fold tests.
 *
 * Every timestamp is explicit and every event is built in memory: the fold is
 * pure, so no Session, service, timer, or wall clock is involved.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  INFINI_GOAL_CHANGE_VERSION,
  INFINI_GOAL_EVENT_TYPE,
} from '@yankeguo/dsh-infini-goal-protocol'
import type {
  InfiniGoalOperation,
  InfiniGoalSettings,
  InfiniGoalSnapshot,
  QuietWindow,
} from '@yankeguo/dsh-infini-goal-protocol'
import type {
  InfiniGoalChange,
  InfiniGoalClearChange,
  InfiniGoalMessageSource,
  InfiniGoalSnapshotChange,
} from '../src/domain.ts'

/** Fixed epoch base for every fixture timestamp. */
export const T0 = 1_700_000_000_000

/** Office-hours quiet window used by the scheduling fixtures. */
export const OFFICE_HOURS: QuietWindow = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }

/** Build canonical pacing settings with explicit overrides. */
export function settings(overrides: Partial<InfiniGoalSettings> = {}): InfiniGoalSettings {
  return {
    minIntervalMs: 60_000,
    quietWindows: [],
    timezone: 'Asia/Shanghai',
    ...overrides,
  }
}

/** Build a complete durable goal snapshot. */
export function goal(overrides: Partial<InfiniGoalSnapshot> = {}): InfiniGoalSnapshot {
  return {
    id: 'goal-1',
    revision: 1,
    objective: 'ship the thing',
    phase: 'active',
    ...settings(),
    ...overrides,
  }
}

/** Build a full-snapshot change from complete values. */
export function snapshotChange(
  operation: Exclude<InfiniGoalOperation, 'clear'>,
  goalSnapshot: InfiniGoalSnapshot,
  counters: {
    readonly roundsStarted?: number
    readonly lastRoundAt?: number | null
    readonly createdAt?: number
    readonly updatedAt?: number
  } = {},
): InfiniGoalSnapshotChange {
  return {
    kind: INFINI_GOAL_EVENT_TYPE,
    version: INFINI_GOAL_CHANGE_VERSION,
    operation,
    goal: goalSnapshot,
    roundsStarted: counters.roundsStarted ?? 0,
    lastRoundAt: counters.lastRoundAt ?? null,
    createdAt: counters.createdAt ?? T0,
    updatedAt: counters.updatedAt ?? T0,
  }
}

/** Build one create change with explicit timestamps. */
export function createChange(
  createdAt: number,
  goalSnapshot: InfiniGoalSnapshot = goal(),
  counters: { readonly roundsStarted?: number; readonly lastRoundAt?: number | null } = {},
): InfiniGoalSnapshotChange {
  return snapshotChange('create', goalSnapshot, {
    ...counters,
    createdAt,
    updatedAt: createdAt,
  })
}

/** Build one clear tombstone. */
export function clearChange(id: string, revision: number, clearedAt: number): InfiniGoalClearChange {
  return {
    kind: INFINI_GOAL_EVENT_TYPE,
    version: INFINI_GOAL_CHANGE_VERSION,
    operation: 'clear',
    cleared: { id, revision },
    clearedAt,
  }
}

/** Wrap one change in its committed session event. */
export function changeEvent(seq: number, change: InfiniGoalChange, time: number = T0): SessionEvent {
  return { type: INFINI_GOAL_EVENT_TYPE, seq: SessionSeq(seq), time, data: change }
}

/** Build one admitted automatic-round `user/message` event. */
export function roundEvent(
  seq: number,
  time: number,
  source: Partial<InfiniGoalMessageSource> = {},
): SessionEvent {
  const attribution: InfiniGoalMessageSource = {
    kind: 'infini-goal',
    goalId: 'goal-1',
    revision: 1,
    round: 1,
    ...source,
  }
  return messageEvent(seq, time, attribution)
}

/** Build one `user/message` session event with an explicit source. */
export function messageEvent(seq: number, time: number, source: MessageSource, text = 'hello'): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time,
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source,
    }),
    surfaceOp: 'append',
  }
}
