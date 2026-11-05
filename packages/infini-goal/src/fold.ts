/**
 * Pure replay fold and strict decoder for durable infini-goal changes.
 *
 * The fold is the single source of truth for durable goal state: the
 * projection unit replays every committed `infini-goal/change` event and every
 * admitted `user/message` round through it. Every structural or transition
 * violation raises a plain `Error` with a precise message so the projection
 * captures the first failure and the Host refuses subsequent reads.
 *
 * @module @yankeguo/dsh-infini-goal
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  INFINI_GOAL_CHANGE_VERSION,
  INFINI_GOAL_EVENT_TYPE,
  INFINI_GOAL_MESSAGE_KIND,
  canonicalTimeZone,
  validateMinIntervalMs,
  validateQuietWindow,
} from '@yankeguo/dsh-infini-goal-protocol'
import type {
  InfiniGoalBlockReason,
  InfiniGoalOperation,
  InfiniGoalPhase,
  InfiniGoalRef,
  InfiniGoalSnapshot,
  QuietWindow,
} from '@yankeguo/dsh-infini-goal-protocol'
import type {
  FoldedInfiniGoal,
  InfiniGoalChange,
  InfiniGoalClearChange,
  InfiniGoalMessageSource,
  InfiniGoalSnapshotChange,
} from './domain.ts'

const SNAPSHOT_OPERATIONS: ReadonlySet<Exclude<InfiniGoalOperation, 'clear'>> = new Set([
  'create',
  'edit',
  'pause',
  'resume',
  'complete',
  'block',
])
const PHASES: ReadonlySet<InfiniGoalPhase> = new Set(['active', 'paused', 'blocked', 'complete'])

/** Mutable accumulator kept private to the pure fold. */
export interface InfiniGoalFoldState {
  goal: InfiniGoalSnapshot | undefined
  roundsStarted: number
  lastRoundAt: number | null
  createdAt: number | undefined
  updatedAt: number | undefined
  lastRef: InfiniGoalRef | undefined
  seenGoalIds: Set<string>
}

/**
 * Build an empty replay accumulator.
 * @returns mutable state with no current goal or prior ref.
 */
export function emptyInfiniGoalFoldState(): InfiniGoalFoldState {
  return {
    goal: undefined,
    roundsStarted: 0,
    lastRoundAt: null,
    createdAt: undefined,
    updatedAt: undefined,
    lastRef: undefined,
    seenGoalIds: new Set(),
  }
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require one record whose keys are exactly `expected` (sorted). */
function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const expectedKeys = [...expected].sort().join(',')
  if (Object.keys(value).sort().join(',') !== expectedKeys) {
    throw new Error(`${field} must have exactly ${expectedKeys} fields`)
  }
}

/** Require one positive safe integer. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  return value
}

/** Require one non-negative safe integer. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return value
}

/** Decode one canonical blocker explanation. */
function decodeBlockReason(value: unknown, field: string): InfiniGoalBlockReason {
  if (!isRecord(value)) throw new Error(`${field} must be a record`)
  requireExactKeys(value, ['code', 'message'], field)
  if (typeof value['code'] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value['code'])) {
    throw new Error(`${field}.code must be lower-kebab-case`)
  }
  if (typeof value['message'] !== 'string' || value['message'].trim().length === 0
    || value['message'] !== value['message'].trim()) {
    throw new Error(`${field}.message must be non-empty and normalized`)
  }
  return { code: value['code'], message: value['message'] }
}

/** Decode one canonical quiet window. */
function decodeQuietWindow(value: unknown, field: string): QuietWindow {
  if (!isRecord(value)) throw new Error(`${field} must be a record`)
  requireExactKeys(value, ['days', 'start', 'end'], field)
  let normalized: QuietWindow
  try {
    normalized = validateQuietWindow(value)
  } catch (error) {
    throw new Error(`${field} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  const days = value['days']
  if (!Array.isArray(days)
    || days.length !== normalized.days.length
    || days.some((day, index) => day !== normalized.days[index])) {
    throw new Error(`${field}.days must be ascending unique ISO weekday numbers 1-7`)
  }
  if (value['start'] !== normalized.start || value['end'] !== normalized.end) {
    throw new Error(`${field} start and end must be canonical HH:mm clock times`)
  }
  return normalized
}

/** Decode one canonical quiet-window list. */
function decodeQuietWindows(value: unknown, field: string): QuietWindow[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map((entry, index) => decodeQuietWindow(entry, `${field}[${index}]`))
}

/** Decode one canonical minimum trigger interval. */
function decodeMinIntervalMs(value: unknown, field: string): number {
  try {
    return validateMinIntervalMs(value)
  } catch (error) {
    throw new Error(`${field} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Decode one canonical IANA time zone. */
function decodeTimeZone(value: unknown, field: string): string {
  const canonical = typeof value === 'string' ? canonicalTimeZone(value) : undefined
  if (canonical === undefined || canonical !== value) {
    throw new Error(`${field} must be a canonical IANA time zone name`)
  }
  return canonical
}

/** Decode one goal phase. */
function decodePhase(value: unknown): InfiniGoalPhase {
  if (typeof value !== 'string' || !PHASES.has(value as InfiniGoalPhase)) {
    throw new Error('infini-goal change goal.phase is invalid')
  }
  return value as InfiniGoalPhase
}

/** Decode and validate one complete goal snapshot. */
function decodeSnapshot(value: unknown): InfiniGoalSnapshot {
  if (!isRecord(value)) throw new Error('infini-goal change goal must be a record')
  const phase = decodePhase(value['phase'])
  const expected = phase === 'blocked'
    ? 'blockedReason,id,minIntervalMs,objective,phase,quietWindows,revision,timezone'
    : 'id,minIntervalMs,objective,phase,quietWindows,revision,timezone'
  requireExactKeys(value, expected.split(','), 'infini-goal change goal')
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('infini-goal change goal.id must be a non-empty string')
  }
  if (typeof value['objective'] !== 'string' || value['objective'].trim().length === 0
    || value['objective'] !== value['objective'].trim()) {
    throw new Error('infini-goal change goal.objective must be non-empty and normalized')
  }
  return {
    id: value['id'],
    revision: positiveInteger(value['revision'], 'infini-goal change goal.revision'),
    objective: value['objective'],
    phase,
    minIntervalMs: decodeMinIntervalMs(value['minIntervalMs'], 'infini-goal change goal.minIntervalMs'),
    quietWindows: decodeQuietWindows(value['quietWindows'], 'infini-goal change goal.quietWindows'),
    timezone: decodeTimeZone(value['timezone'], 'infini-goal change goal.timezone'),
    ...phase === 'blocked'
      ? { blockedReason: decodeBlockReason(value['blockedReason'], 'infini-goal change goal.blockedReason') }
      : {},
  }
}

/** Decode one canonical goal ref carried by a clear tombstone. */
function decodeRef(value: unknown, field: string): InfiniGoalRef {
  if (!isRecord(value)) throw new Error(`${field} must be a record`)
  requireExactKeys(value, ['id', 'revision'], field)
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error(`${field}.id must be a non-empty string`)
  }
  return {
    id: value['id'],
    revision: positiveInteger(value['revision'], `${field}.revision`),
  }
}

/**
 * Decode a value that declares itself as an infini-goal change.
 *
 * Unrelated values return `undefined`; malformed infini-goal changes fail
 * replay loudly.
 * @param value - candidate source change.
 * @returns validated change or `undefined` for another value kind.
 */
export function decodeInfiniGoalChange(value: unknown): InfiniGoalChange | undefined {
  if (!isRecord(value) || value['kind'] !== INFINI_GOAL_EVENT_TYPE) return undefined
  if (value['version'] !== INFINI_GOAL_CHANGE_VERSION) {
    throw new Error(`unsupported infini-goal change version ${String(value['version'])}`)
  }
  if (value['operation'] === 'clear') {
    requireExactKeys(value, ['cleared', 'clearedAt', 'kind', 'operation', 'version'], 'infini-goal clear change')
    return {
      kind: INFINI_GOAL_EVENT_TYPE,
      version: INFINI_GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: decodeRef(value['cleared'], 'infini-goal clear change cleared'),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'infini-goal clear change clearedAt'),
    } satisfies InfiniGoalClearChange
  }
  if (typeof value['operation'] !== 'string'
    || !SNAPSHOT_OPERATIONS.has(value['operation'] as Exclude<InfiniGoalOperation, 'clear'>)) {
    throw new Error('infini-goal change operation is invalid')
  }
  requireExactKeys(
    value,
    ['createdAt', 'goal', 'kind', 'lastRoundAt', 'operation', 'roundsStarted', 'updatedAt', 'version'],
    'infini-goal snapshot change',
  )
  const createdAt = nonNegativeInteger(value['createdAt'], 'infini-goal change createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'infini-goal change updatedAt')
  if (updatedAt < createdAt) throw new Error('infini-goal change updatedAt cannot precede createdAt')
  const roundsStarted = nonNegativeInteger(value['roundsStarted'], 'infini-goal change roundsStarted')
  const lastRoundAt = value['lastRoundAt'] === null
    ? null
    : nonNegativeInteger(value['lastRoundAt'], 'infini-goal change lastRoundAt')
  if ((roundsStarted === 0) !== (lastRoundAt === null)) {
    throw new Error('infini-goal change lastRoundAt must be null exactly before the first admitted round')
  }
  return {
    kind: INFINI_GOAL_EVENT_TYPE,
    version: INFINI_GOAL_CHANGE_VERSION,
    operation: value['operation'] as Exclude<InfiniGoalOperation, 'clear'>,
    goal: decodeSnapshot(value['goal']),
    roundsStarted,
    lastRoundAt,
    createdAt,
    updatedAt,
  } satisfies InfiniGoalSnapshotChange
}

/**
 * Return the revision identity carried by a snapshot or tombstone.
 * @param change - decoded infini-goal mutation.
 * @returns stable identity used by the live change notification.
 */
export function infiniGoalChangeRef(change: InfiniGoalChange): InfiniGoalRef {
  return change.operation === 'clear'
    ? change.cleared
    : { id: change.goal.id, revision: change.goal.revision }
}

/** Require two snapshots to retain the fields only `edit` may replace. */
function requireSameDefinition(current: InfiniGoalSnapshot, next: InfiniGoalSnapshot, operation: InfiniGoalOperation): void {
  if (next.objective !== current.objective
    || next.minIntervalMs !== current.minIntervalMs
    || next.timezone !== current.timezone
    || JSON.stringify(next.quietWindows) !== JSON.stringify(current.quietWindows)) {
    throw new Error(`infini-goal ${operation} cannot change the goal objective or pacing settings`)
  }
}

/** Validate one non-create snapshot operation against the preceding goal. */
function validateSnapshotTransition(
  state: InfiniGoalFoldState,
  change: InfiniGoalSnapshotChange,
  current: InfiniGoalSnapshot,
): void {
  const next = change.goal
  const operation = change.operation
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(`infini-goal ${operation} must advance the current goal by exactly one revision`)
  }
  /* v8 ignore next -- a current goal established by this fold always has timestamps. */
  if (state.createdAt === undefined || state.updatedAt === undefined) {
    throw new Error('current infini-goal fold lacks timestamps')
  }
  if (change.createdAt !== state.createdAt) {
    throw new Error(`infini-goal ${operation} cannot change createdAt`)
  }
  if (change.updatedAt < state.updatedAt) {
    throw new Error(`infini-goal ${operation} timestamp cannot move backwards`)
  }
  if (change.roundsStarted !== state.roundsStarted || change.lastRoundAt !== state.lastRoundAt) {
    throw new Error(`infini-goal ${operation} cannot change roundsStarted or lastRoundAt`)
  }
  switch (operation) {
    case 'edit':
      if (next.phase !== current.phase) {
        throw new Error('infini-goal edit cannot change the goal phase')
      }
      if (JSON.stringify(next.blockedReason) !== JSON.stringify(current.blockedReason)) {
        throw new Error('infini-goal edit cannot change the blocked reason')
      }
      return
    case 'pause':
      requireSameDefinition(current, next, operation)
      if (current.phase !== 'active' || next.phase !== 'paused') {
        throw new Error('infini-goal pause has an invalid phase transition')
      }
      return
    case 'resume':
      requireSameDefinition(current, next, operation)
      if ((current.phase !== 'paused' && current.phase !== 'blocked') || next.phase !== 'active') {
        throw new Error('infini-goal resume requires a paused or blocked goal and produces an active one')
      }
      return
    case 'complete':
      requireSameDefinition(current, next, operation)
      if (current.phase === 'complete' || next.phase !== 'complete') {
        throw new Error('infini-goal complete has an invalid phase transition')
      }
      return
    case 'block':
      requireSameDefinition(current, next, operation)
      if (current.phase !== 'active' || next.phase !== 'blocked') {
        throw new Error('infini-goal block has an invalid phase transition')
      }
      return
    /* v8 ignore start -- the caller excludes create and the operation union is closed. */
    case 'create':
      throw new Error('infini-goal create cannot be validated as a current-goal transition')
    default:
      operation satisfies never
      throw new Error('unknown infini-goal snapshot operation')
    /* v8 ignore stop */
  }
}

/**
 * Validate and apply one decoded change to a mutable accumulator.
 * @param state - preceding durable infini-goal fold state.
 * @param change - decoded full snapshot or clear tombstone.
 */
export function applyInfiniGoalChange(state: InfiniGoalFoldState, change: InfiniGoalChange): void {
  if (change.operation === 'clear') {
    const current = state.goal
    if (current === undefined) throw new Error('infini-goal clear requires a current goal')
    if (change.cleared.id !== current.id || change.cleared.revision !== current.revision + 1) {
      throw new Error('infini-goal clear must advance the current goal by exactly one revision')
    }
    /* v8 ignore next -- a current goal established by this fold always has an updatedAt. */
    if (state.updatedAt === undefined) throw new Error('current infini-goal fold lacks updatedAt')
    if (change.clearedAt < state.updatedAt) {
      throw new Error('infini-goal clear timestamp cannot precede the current goal update')
    }
    state.goal = undefined
    state.roundsStarted = 0
    state.lastRoundAt = null
    state.createdAt = undefined
    state.updatedAt = undefined
    state.lastRef = { ...change.cleared }
    return
  }
  if (change.operation === 'create') {
    if (change.goal.revision !== 1 || change.goal.phase !== 'active'
      || change.roundsStarted !== 0 || change.lastRoundAt !== null) {
      throw new Error('infini-goal create requires a fresh active revision-one goal with zero rounds')
    }
    if (state.goal !== undefined && state.goal.phase !== 'complete') {
      throw new Error(`infini-goal create requires the current goal "${state.goal.id}" to be complete or absent`)
    }
    if (state.seenGoalIds.has(change.goal.id)) {
      throw new Error(`infini-goal create cannot reuse goal id "${change.goal.id}"`)
    }
    if (state.updatedAt !== undefined && change.createdAt < state.updatedAt) {
      throw new Error('infini-goal create timestamp cannot precede the previous goal update')
    }
    state.seenGoalIds.add(change.goal.id)
  } else {
    const current = state.goal
    if (current === undefined) {
      throw new Error(`infini-goal ${change.operation} requires a current goal`)
    }
    validateSnapshotTransition(state, change, current)
  }
  state.goal = change.goal
  state.roundsStarted = change.roundsStarted
  state.lastRoundAt = change.lastRoundAt
  state.createdAt = change.createdAt
  state.updatedAt = change.updatedAt
  state.lastRef = infiniGoalChangeRef(change)
}

/**
 * Narrow one message source to a valid admitted-round attribution.
 * @param source - the event's message source.
 * @returns the attribution, or `undefined` for another producer.
 * @throws {Error} when the value declares the infini-goal kind but is malformed.
 */
function infiniGoalSource(source: MessageSource): InfiniGoalMessageSource | undefined {
  if (source.kind !== INFINI_GOAL_MESSAGE_KIND) return undefined
  const attribution = source as InfiniGoalMessageSource
  if (typeof attribution.goalId !== 'string' || attribution.goalId.length === 0
    || !Number.isSafeInteger(attribution.revision) || attribution.revision < 1
    || !Number.isSafeInteger(attribution.round) || attribution.round < 1) {
    throw new Error('infini-goal message source is invalid')
  }
  return attribution
}

/**
 * Apply one session event to the strict durable infini-goal fold.
 * @param state - mutable fold accumulator.
 * @param event - next event in sequence order.
 */
export function applyInfiniGoalEvent(state: InfiniGoalFoldState, event: SessionEvent): void {
  if (event.type === INFINI_GOAL_EVENT_TYPE) {
    const change = decodeInfiniGoalChange(event.data)
    /* v8 ignore next -- the event's declared payload always identifies itself as an infini-goal change. */
    if (change === undefined) throw new Error(`infini-goal change at session event ${event.seq} has an invalid kind`)
    applyInfiniGoalChange(state, change)
    return
  }
  if (event.type === 'user/message') {
    const source = infiniGoalSource(event.data.source)
    if (source === undefined) return
    const current = state.goal
    if (current === undefined || current.phase !== 'active'
      || source.goalId !== current.id
      || source.revision !== current.revision
      || source.round !== state.roundsStarted + 1) {
      throw new Error(`infini-goal round at session event ${event.seq} is not the next admitted round of the active goal`)
    }
    if (state.lastRoundAt !== null && event.time < state.lastRoundAt) {
      throw new Error(`infini-goal round at session event ${event.seq} has a non-monotonic timestamp`)
    }
    state.roundsStarted = source.round
    state.lastRoundAt = event.time
  }
}

/**
 * Fold current infini-goal state from a contiguous session event log.
 * @param events - session events in sequence order.
 * @returns a fresh detached durable state.
 */
export function foldInfiniGoal(events: readonly SessionEvent[]): FoldedInfiniGoal {
  const state = emptyInfiniGoalFoldState()
  for (const event of events) applyInfiniGoalEvent(state, event)
  return {
    ...state.goal === undefined ? {} : { goal: { ...state.goal } },
    roundsStarted: state.roundsStarted,
    lastRoundAt: state.lastRoundAt,
    ...state.createdAt === undefined ? {} : { createdAt: state.createdAt },
    ...state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt },
    ...state.lastRef === undefined ? {} : { lastRef: { ...state.lastRef } },
  }
}
