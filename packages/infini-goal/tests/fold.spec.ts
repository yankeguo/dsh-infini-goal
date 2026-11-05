import { describe, expect, it } from 'vitest'
import {
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  INFINI_GOAL_CHANGE_VERSION,
  INFINI_GOAL_EVENT_TYPE,
} from '@yankeguo/dsh-infini-goal-protocol'
import {
  applyInfiniGoalEvent,
  decodeInfiniGoalChange,
  emptyInfiniGoalFoldState,
  foldInfiniGoal,
  infiniGoalChangeRef,
} from '../src/fold.ts'
import { applyInfiniGoalProjection, infiniGoalProjectionDefinition } from '../src/index.ts'
import type {
  InfiniGoalProjectionState,
  InfiniGoalSnapshotChange,
} from '../src/domain.ts'
import {
  OFFICE_HOURS,
  T0,
  changeEvent,
  clearChange,
  createChange,
  goal,
  messageEvent,
  roundEvent,
  snapshotChange,
} from './fixtures.ts'

/** Fold an explicit event list through the strict replay fold. */
function fold(events: readonly SessionEvent[]): ReturnType<typeof foldInfiniGoal> {
  return foldInfiniGoal(events)
}

/** Build the events of one paused revision-two goal. */
function pausedGoalEvents(): SessionEvent[] {
  return [
    changeEvent(0, createChange(T0), T0),
    changeEvent(
      1,
      snapshotChange('pause', goal({ revision: 2, phase: 'paused' }), { updatedAt: T0 + 1_000 }),
      T0 + 1_000,
    ),
  ]
}

/** Build the events of one blocked revision-two goal. */
function blockedGoalEvents(): SessionEvent[] {
  return [
    changeEvent(0, createChange(T0), T0),
    changeEvent(
      1,
      snapshotChange(
        'block',
        goal({ revision: 2, phase: 'blocked', blockedReason: { code: 'blocked-by-human', message: 'waiting for input' } }),
        { updatedAt: T0 + 1_000 },
      ),
      T0 + 1_000,
    ),
  ]
}

/** Build the events of one completed revision-two goal. */
function completedGoalEvents(): SessionEvent[] {
  return [
    changeEvent(0, createChange(T0), T0),
    changeEvent(
      1,
      snapshotChange('complete', goal({ revision: 2, phase: 'complete' }), { updatedAt: T0 + 1_000 }),
      T0 + 1_000,
    ),
  ]
}

/** Capture one expected rejection. */
function capture(run: () => unknown): unknown {
  try {
    run()
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected the operation to throw')
}

/** Clone one decoded change as an untyped record for mutation. */
function record(change: unknown): Record<string, unknown> {
  return structuredClone(change) as Record<string, unknown>
}

/** Read the goal record out of one untyped change record. */
function goalRecord(change: Record<string, unknown>): Record<string, unknown> {
  return change['goal'] as Record<string, unknown>
}

describe('foldInfiniGoal: valid lifecycle chains', () => {
  it('folds create, rounds, pause, resume, edit, block, complete, clear, and replacement', () => {
    const events: SessionEvent[] = [
      changeEvent(0, createChange(T0), T0),
      roundEvent(1, T0 + 1_000, { revision: 1, round: 1 }),
      changeEvent(
        2,
        snapshotChange('pause', goal({ revision: 2, phase: 'paused' }), {
          roundsStarted: 1,
          lastRoundAt: T0 + 1_000,
          updatedAt: T0 + 2_000,
        }),
        T0 + 2_000,
      ),
      changeEvent(
        3,
        snapshotChange('resume', goal({ revision: 3, phase: 'active' }), {
          roundsStarted: 1,
          lastRoundAt: T0 + 1_000,
          updatedAt: T0 + 3_000,
        }),
        T0 + 3_000,
      ),
      roundEvent(4, T0 + 4_000, { revision: 3, round: 2 }),
      changeEvent(
        5,
        snapshotChange(
          'edit',
          goal({
            revision: 4,
            phase: 'active',
            objective: 'ship the thing better',
            minIntervalMs: 120_000,
            quietWindows: [OFFICE_HOURS],
            timezone: 'UTC',
          }),
          {
            roundsStarted: 2,
            lastRoundAt: T0 + 4_000,
            updatedAt: T0 + 5_000,
          },
        ),
        T0 + 5_000,
      ),
      roundEvent(6, T0 + 6_000, { revision: 4, round: 3 }),
      changeEvent(
        7,
        snapshotChange(
          'block',
          goal({
            revision: 5,
            phase: 'blocked',
            minIntervalMs: 120_000,
            quietWindows: [OFFICE_HOURS],
            timezone: 'UTC',
            objective: 'ship the thing better',
            blockedReason: { code: 'blocked-by-human', message: 'waiting for approval' },
          }),
          {
            roundsStarted: 3,
            lastRoundAt: T0 + 6_000,
            updatedAt: T0 + 7_000,
          },
        ),
        T0 + 7_000,
      ),
      changeEvent(
        8,
        snapshotChange(
          'resume',
          goal({ revision: 6, phase: 'active', minIntervalMs: 120_000, quietWindows: [OFFICE_HOURS], timezone: 'UTC', objective: 'ship the thing better' }),
          {
            roundsStarted: 3,
            lastRoundAt: T0 + 6_000,
            updatedAt: T0 + 8_000,
          },
        ),
        T0 + 8_000,
      ),
      changeEvent(
        9,
        snapshotChange(
          'complete',
          goal({ revision: 7, phase: 'complete', minIntervalMs: 120_000, quietWindows: [OFFICE_HOURS], timezone: 'UTC', objective: 'ship the thing better' }),
          {
            roundsStarted: 3,
            lastRoundAt: T0 + 6_000,
            updatedAt: T0 + 9_000,
          },
        ),
        T0 + 9_000,
      ),
      changeEvent(10, clearChange('goal-1', 8, T0 + 10_000), T0 + 10_000),
      changeEvent(11, createChange(T0 + 11_000, goal({ id: 'goal-2' })), T0 + 11_000),
      roundEvent(12, T0 + 12_000, { goalId: 'goal-2', revision: 1, round: 1 }),
    ]

    const folded = fold(events)
    expect(folded.goal).toMatchObject({
      id: 'goal-2',
      revision: 1,
      objective: 'ship the thing',
      phase: 'active',
      minIntervalMs: 60_000,
      quietWindows: [],
      timezone: 'Asia/Shanghai',
    })
    expect(folded.roundsStarted).toBe(1)
    expect(folded.lastRoundAt).toBe(T0 + 12_000)
    expect(folded.createdAt).toBe(T0 + 11_000)
    expect(folded.updatedAt).toBe(T0 + 11_000)
    expect(folded.lastRef).toEqual({ id: 'goal-2', revision: 1 })

    const beforeReplacement = fold(events.slice(0, 11))
    expect(beforeReplacement.goal).toBeUndefined()
    expect(beforeReplacement.roundsStarted).toBe(0)
    expect(beforeReplacement.lastRoundAt).toBeNull()
    expect(beforeReplacement.createdAt).toBeUndefined()
    expect(beforeReplacement.updatedAt).toBeUndefined()
    expect(beforeReplacement.lastRef).toEqual({ id: 'goal-1', revision: 8 })
  })

  it('tracks lastRoundAt through every non-round mutation and resets it on clear', () => {
    const steps: Array<{ events: SessionEvent[]; rounds: number; lastRoundAt: number | null }> = []
    const base: SessionEvent[] = [changeEvent(0, createChange(T0), T0)]
    steps.push({ events: base, rounds: 0, lastRoundAt: null })
    steps.push({
      events: [...base, roundEvent(1, T0 + 1_000, { round: 1 })],
      rounds: 1,
      lastRoundAt: T0 + 1_000,
    })
    steps.push({
      events: [
        ...base,
        roundEvent(1, T0 + 1_000, { round: 1 }),
        changeEvent(2, snapshotChange('pause', goal({ revision: 2, phase: 'paused' }), {
          roundsStarted: 1,
          lastRoundAt: T0 + 1_000,
          updatedAt: T0 + 2_000,
        }), T0 + 2_000),
      ],
      rounds: 1,
      lastRoundAt: T0 + 1_000,
    })
    steps.push({
      events: [
        ...base,
        roundEvent(1, T0 + 1_000, { round: 1 }),
        changeEvent(2, clearChange('goal-1', 2, T0 + 2_000), T0 + 2_000),
      ],
      rounds: 0,
      lastRoundAt: null,
    })
    for (const step of steps) {
      const folded = fold(step.events)
      expect(folded.roundsStarted).toBe(step.rounds)
      expect(folded.lastRoundAt).toBe(step.lastRoundAt)
    }
  })

  it('allows editing a blocked goal without changing its phase or blocked reason', () => {
    const folded = fold([
      ...blockedGoalEvents(),
      changeEvent(
        2,
        snapshotChange(
          'edit',
          goal({
            revision: 3,
            phase: 'blocked',
            objective: 'a repaired objective',
            blockedReason: { code: 'blocked-by-human', message: 'waiting for input' },
          }),
          { updatedAt: T0 + 2_000 },
        ),
        T0 + 2_000,
      ),
    ])
    expect(folded.goal).toMatchObject({
      revision: 3,
      phase: 'blocked',
      objective: 'a repaired objective',
      blockedReason: { code: 'blocked-by-human', message: 'waiting for input' },
    })
  })

  it('allows a new goal after a completed goal without leaving a clear tombstone', () => {
    const folded = fold([
      ...completedGoalEvents(),
      changeEvent(2, createChange(T0 + 2_000, goal({ id: 'goal-2' })), T0 + 2_000),
    ])
    expect(folded.goal?.id).toBe('goal-2')
    expect(folded.goal?.phase).toBe('active')
  })
})

describe('foldInfiniGoal: rejected transitions', () => {
  const createOnly: SessionEvent[] = [changeEvent(0, createChange(T0), T0)]

  it('rejects a mutation without a current goal', () => {
    expect(() => fold([changeEvent(0, snapshotChange('pause', goal({ revision: 2, phase: 'paused' })), T0)]))
      .toThrow('pause requires a current goal')
    expect(() => fold([changeEvent(0, snapshotChange('resume', goal({ revision: 2 })), T0)]))
      .toThrow('resume requires a current goal')
    expect(() => fold([changeEvent(0, clearChange('goal-1', 2, T0), T0)]))
      .toThrow('clear requires a current goal')
  })

  it('rejects a create while the current goal is not complete', () => {
    for (const prefix of [createOnly, pausedGoalEvents(), blockedGoalEvents()]) {
      expect(() => fold([
        ...prefix,
        changeEvent(prefix.length, createChange(T0 + 5_000, goal({ id: 'goal-2' })), T0 + 5_000),
      ])).toThrow('create requires the current goal')
    }
  })

  it('rejects a reused goal id after completion', () => {
    expect(() => fold([
      ...completedGoalEvents(),
      changeEvent(2, createChange(T0 + 2_000, goal()), T0 + 2_000),
    ])).toThrow('cannot reuse goal id "goal-1"')
  })

  it('rejects an illegal phase transition', () => {
    expect(() => fold([
      ...pausedGoalEvents(),
      changeEvent(2, snapshotChange('pause', goal({ revision: 3, phase: 'paused' }), { updatedAt: T0 + 2_000 }), T0 + 2_000),
    ])).toThrow('invalid phase transition')
    expect(() => fold([
      ...createOnly,
      changeEvent(1, snapshotChange('resume', goal({ revision: 2, phase: 'active' }), { updatedAt: T0 + 1_000 }), T0 + 1_000),
    ])).toThrow('requires a paused or blocked goal')
    expect(() => fold([
      ...pausedGoalEvents(),
      changeEvent(2, snapshotChange('block', goal({
        revision: 3,
        phase: 'blocked',
        blockedReason: { code: 'blocked-by-human', message: 'nope' },
      }), { updatedAt: T0 + 2_000 }), T0 + 2_000),
    ])).toThrow('invalid phase transition')
    expect(() => fold([
      ...completedGoalEvents(),
      changeEvent(2, snapshotChange('complete', goal({ revision: 3, phase: 'complete' }), { updatedAt: T0 + 2_000 }), T0 + 2_000),
    ])).toThrow('invalid phase transition')
  })

  it('rejects a stale or skipped revision on every snapshot mutation', () => {
    for (const revision of [1, 3]) {
      expect(() => fold([
        ...createOnly,
        changeEvent(1, snapshotChange('pause', goal({ revision, phase: 'paused' }), { updatedAt: T0 + 1_000 }), T0 + 1_000),
      ])).toThrow('must advance the current goal by exactly one revision')
    }
    expect(() => fold([
      ...createOnly,
      changeEvent(1, clearChange('goal-1', 3, T0 + 1_000), T0 + 1_000),
    ])).toThrow('must advance the current goal by exactly one revision')
  })

  it('rejects a mutation changing identity or immutable definition fields', () => {
    expect(() => fold([
      ...createOnly,
      changeEvent(1, snapshotChange('pause', goal({ id: 'goal-2', revision: 2, phase: 'paused' }), { updatedAt: T0 + 1_000 }), T0 + 1_000),
    ])).toThrow('must advance the current goal by exactly one revision')
    expect(() => fold([
      ...createOnly,
      changeEvent(1, snapshotChange('pause', goal({ revision: 2, phase: 'paused', objective: 'changed' }), { updatedAt: T0 + 1_000 }), T0 + 1_000),
    ])).toThrow('cannot change the goal objective or pacing settings')
    expect(() => fold([
      ...createOnly,
      changeEvent(1, snapshotChange('pause', goal({ revision: 2, phase: 'paused', minIntervalMs: 5_000 }), { updatedAt: T0 + 1_000 }), T0 + 1_000),
    ])).toThrow('cannot change the goal objective or pacing settings')
    expect(() => fold([
      ...createOnly,
      changeEvent(1, snapshotChange('pause', goal({ revision: 2, phase: 'paused', quietWindows: [OFFICE_HOURS] }), { updatedAt: T0 + 1_000 }), T0 + 1_000),
    ])).toThrow('cannot change the goal objective or pacing settings')
    expect(() => fold([
      ...createOnly,
      changeEvent(1, snapshotChange('pause', goal({ revision: 2, phase: 'paused', timezone: 'UTC' }), { updatedAt: T0 + 1_000 }), T0 + 1_000),
    ])).toThrow('cannot change the goal objective or pacing settings')
  })

  it('rejects a mutation changing derived counters or timestamps', () => {
    expect(() => fold([
      ...createOnly,
      changeEvent(1, snapshotChange('pause', goal({ revision: 2, phase: 'paused' }), {
        roundsStarted: 1,
        lastRoundAt: T0 + 500,
        updatedAt: T0 + 1_000,
      }), T0 + 1_000),
    ])).toThrow('cannot change roundsStarted or lastRoundAt')
    expect(() => fold([
      changeEvent(0, createChange(T0), T0),
      roundEvent(1, T0 + 1_000),
      changeEvent(2, snapshotChange('pause', goal({ revision: 2, phase: 'paused' }), {
        roundsStarted: 2,
        lastRoundAt: T0 + 2_000,
        updatedAt: T0 + 2_000,
      }), T0 + 2_000),
    ])).toThrow('cannot change roundsStarted or lastRoundAt')
    expect(() => fold([
      ...createOnly,
      changeEvent(1, snapshotChange('pause', goal({ revision: 2, phase: 'paused' }), {
        createdAt: T0 + 1,
        updatedAt: T0 + 1_000,
      }), T0 + 1_000),
    ])).toThrow('cannot change createdAt')
    expect(() => fold([
      ...createOnly,
      changeEvent(1, snapshotChange('pause', goal({ revision: 2, phase: 'paused' }), { updatedAt: T0 + 5_000 }), T0 + 5_000),
      changeEvent(2, snapshotChange('resume', goal({ revision: 3 }), { updatedAt: T0 + 3_000 }), T0 + 3_000),
    ])).toThrow('timestamp cannot move backwards')
  })

  it('rejects an edit changing phase or blocked reason', () => {
    expect(() => fold([
      ...createOnly,
      changeEvent(1, snapshotChange('edit', goal({ revision: 2, phase: 'paused' }), { updatedAt: T0 + 1_000 }), T0 + 1_000),
    ])).toThrow('cannot change the goal phase')
    expect(() => fold([
      ...blockedGoalEvents(),
      changeEvent(2, snapshotChange('edit', goal({
        revision: 3,
        phase: 'blocked',
        blockedReason: { code: 'blocked-by-human', message: 'a different reason' },
      }), { updatedAt: T0 + 2_000 }), T0 + 2_000),
    ])).toThrow('cannot change the blocked reason')
  })

  it('rejects a create with non-fresh revision, phase, or counters', () => {
    for (const invalid of [
      goal({ revision: 2 }),
      goal({ phase: 'paused' }),
      goal({ phase: 'complete' }),
    ]) {
      expect(() => fold([changeEvent(0, createChange(T0, invalid), T0)]))
        .toThrow('create requires a fresh active revision-one goal with zero rounds')
    }
    expect(() => fold([changeEvent(0, createChange(T0, goal(), { roundsStarted: 1, lastRoundAt: T0 }), T0)]))
      .toThrow('create requires a fresh active revision-one goal with zero rounds')
  })

  it('rejects a clear whose timestamp precedes the current goal update', () => {
    expect(() => fold([
      ...createOnly,
      changeEvent(1, clearChange('goal-1', 2, T0 - 1), T0 - 1),
    ])).toThrow('clear timestamp cannot precede the current goal update')
  })

  it('rejects a create whose timestamp precedes the previous goal update', () => {
    expect(() => fold([
      ...completedGoalEvents(),
      changeEvent(2, createChange(T0 - 1, goal({ id: 'goal-2' })), T0 - 1),
    ])).toThrow('create timestamp cannot precede the previous goal update')
  })

  it('rejects an edit with no replacement field in the service-facing request shape', () => {
    // The fold itself accepts an objective-preserving edit snapshot; the
    // "at least one field" rule lives at the service boundary and is covered in
    // runtime.spec.ts. This guards that the decoded payload shape is still
    // accepted, so the rejection cannot come from replay.
    const folded = fold([
      ...createOnly,
      changeEvent(1, snapshotChange('edit', goal({ revision: 2 }), { updatedAt: T0 + 1_000 }), T0 + 1_000),
    ])
    expect(folded.goal?.revision).toBe(2)
  })
})

describe('foldInfiniGoal: round admission', () => {
  it('admits the next automatic round of the active goal and advances lastRoundAt', () => {
    const folded = fold([
      changeEvent(0, createChange(T0), T0),
      roundEvent(1, T0 + 1_000, { round: 1 }),
      roundEvent(2, T0 + 2_000, { round: 2 }),
    ])
    expect(folded.roundsStarted).toBe(2)
    expect(folded.lastRoundAt).toBe(T0 + 2_000)
    expect(folded.goal?.revision).toBe(1)
  })

  it('ignores ordinary user messages', () => {
    const folded = fold([
      changeEvent(0, createChange(T0), T0),
      messageEvent(1, T0 + 1_000, { kind: 'user' }, 'a normal prompt'),
    ])
    expect(folded.roundsStarted).toBe(0)
    expect(folded.lastRoundAt).toBeNull()
  })

  it('rejects an out-of-order round', () => {
    expect(() => fold([
      changeEvent(0, createChange(T0), T0),
      roundEvent(1, T0 + 1_000, { round: 2 }),
    ])).toThrow('is not the next admitted round of the active goal')
    expect(() => fold([
      changeEvent(0, createChange(T0), T0),
      roundEvent(1, T0 + 1_000, { round: 1 }),
      roundEvent(2, T0 + 2_000, { round: 1 }),
    ])).toThrow('is not the next admitted round of the active goal')
    expect(() => fold([
      changeEvent(0, createChange(T0), T0),
      roundEvent(1, T0 + 1_000, { round: 1 }),
      roundEvent(2, T0 + 2_000, { round: 3 }),
    ])).toThrow('is not the next admitted round of the active goal')
  })

  it('rejects a round with a mismatched goal id or revision', () => {
    expect(() => fold([
      changeEvent(0, createChange(T0), T0),
      roundEvent(1, T0 + 1_000, { goalId: 'goal-2' }),
    ])).toThrow('is not the next admitted round of the active goal')
    expect(() => fold([
      changeEvent(0, createChange(T0), T0),
      roundEvent(1, T0 + 1_000, { revision: 2 }),
    ])).toThrow('is not the next admitted round of the active goal')
    expect(() => fold([
      ...pausedGoalEvents(),
      roundEvent(2, T0 + 2_000, { revision: 2 }),
    ])).toThrow('is not the next admitted round of the active goal')
  })

  it('rejects rounds with a malformed attribution', () => {
    for (const source of [
      { goalId: '' },
      { revision: 0 },
      { revision: 1.5 },
      { round: 0 },
      { round: -1 },
    ]) {
      expect(() => fold([
        changeEvent(0, createChange(T0), T0),
        roundEvent(1, T0 + 1_000, source),
      ])).toThrow('message source is invalid')
    }
  })

  it('rejects a round whose timestamp moves backwards', () => {
    expect(() => fold([
      changeEvent(0, createChange(T0), T0),
      roundEvent(1, T0 + 5_000, { round: 1 }),
      roundEvent(2, T0 + 4_000, { round: 2 }),
    ])).toThrow('non-monotonic timestamp')
  })

  it('rejects a round after the goal stops being active', () => {
    const completed = completedGoalEvents()
    expect(() => fold([
      ...completed,
      roundEvent(2, T0 + 2_000, { revision: 2 }),
    ])).toThrow('is not the next admitted round of the active goal')
  })
})

describe('decodeInfiniGoalChange: malformed payloads', () => {
  /** One valid edit change used as the mutation base. */
  function validEdit(): InfiniGoalSnapshotChange {
    return snapshotChange('edit', goal({ revision: 2 }), { updatedAt: T0 + 1_000 })
  }

  /** One valid clear tombstone used as the mutation base. */
  function validClear(): Record<string, unknown> {
    return record(clearChange('goal-1', 2, T0 + 1_000))
  }

  it('returns undefined for values that do not declare the infini-goal change kind', () => {
    expect(decodeInfiniGoalChange(undefined)).toBeUndefined()
    expect(decodeInfiniGoalChange(null)).toBeUndefined()
    expect(decodeInfiniGoalChange([])).toBeUndefined()
    expect(decodeInfiniGoalChange({ kind: 'goal/change' })).toBeUndefined()
  })

  it('accepts a valid full-snapshot change and a valid clear tombstone', () => {
    expect(decodeInfiniGoalChange(validEdit())).toMatchObject({
      operation: 'edit',
      goal: { id: 'goal-1', revision: 2 },
    })
    expect(decodeInfiniGoalChange(validClear())).toMatchObject({
      operation: 'clear',
      cleared: { id: 'goal-1', revision: 2 },
      clearedAt: T0 + 1_000,
    })
  })

  const snapshotRejections: Array<[string, unknown, RegExp]> = (() => {
    const base = (): Record<string, unknown> => record(validEdit())
    const cases: Array<[string, (value: Record<string, unknown>) => void, RegExp]> = [
      ['an unsupported version', value => { value['version'] = 2 }, /unsupported infini-goal change version 2/],
      ['an unknown operation', value => { value['operation'] = 'arm' }, /operation is invalid/],
      ['an extra field', value => { value['extra'] = true }, /must have exactly/],
      ['a missing lastRoundAt', value => { delete value['lastRoundAt'] }, /must have exactly/],
      ['a missing goal field', value => { delete value['goal'] }, /must have exactly/],
      ['a fraction revision', value => { goalRecord(value)['revision'] = 1.5 }, /goal\.revision must be a positive safe integer/],
      ['a zero revision', value => { goalRecord(value)['revision'] = 0 }, /goal\.revision must be a positive safe integer/],
      ['an empty goal id', value => { goalRecord(value)['id'] = '' }, /goal\.id must be a non-empty string/],
      ['a non-normalized objective', value => { goalRecord(value)['objective'] = '  padded  ' }, /goal\.objective must be non-empty and normalized/],
      ['an invalid phase', value => { goalRecord(value)['phase'] = 'armed' }, /goal\.phase is invalid/],
      ['a missing timezone', value => { delete goalRecord(value)['timezone'] }, /must have exactly/],
      ['a non-canonical timezone', value => { goalRecord(value)['timezone'] = 'asia/shanghai' }, /goal\.timezone must be a canonical IANA time zone name/],
      ['an unknown timezone', value => { goalRecord(value)['timezone'] = 'Nope/Nope' }, /goal\.timezone must be a canonical IANA time zone name/],
      ['a too-small minimum interval', value => { goalRecord(value)['minIntervalMs'] = 999 }, /goal\.minIntervalMs is invalid/],
      ['a non-integer minimum interval', value => { goalRecord(value)['minIntervalMs'] = 1_000.5 }, /goal\.minIntervalMs is invalid/],
      ['a non-array quiet window list', value => { goalRecord(value)['quietWindows'] = 'none' }, /goal\.quietWindows must be an array/],
      ['a quiet window with an extra field', value => {
        goalRecord(value)['quietWindows'] = [{ days: [], start: '09:00', end: '18:00', label: 'work' }]
      }, /must have exactly/],
      ['a quiet window missing days', value => {
        goalRecord(value)['quietWindows'] = [{ start: '09:00', end: '18:00' }]
      }, /must have exactly/],
      ['quiet window days out of order', value => {
        goalRecord(value)['quietWindows'] = [{ days: [5, 1], start: '09:00', end: '18:00' }]
      }, /days must be ascending unique ISO weekday numbers/],
      ['quiet window days duplicated', value => {
        goalRecord(value)['quietWindows'] = [{ days: [1, 1], start: '09:00', end: '18:00' }]
      }, /days must be ascending unique ISO weekday numbers/],
      ['quiet window days out of range', value => {
        goalRecord(value)['quietWindows'] = [{ days: [8], start: '09:00', end: '18:00' }]
      }, /is invalid/],
      ['a non-canonical quiet window clock', value => {
        goalRecord(value)['quietWindows'] = [{ days: [], start: '9:00', end: '18:00' }]
      }, /canonical HH:mm/],
      ['an empty quiet window', value => {
        goalRecord(value)['quietWindows'] = [{ days: [], start: '09:00', end: '09:00' }]
      }, /is invalid/],
      ['a negative createdAt', value => { value['createdAt'] = -1 }, /createdAt must be a non-negative safe integer/],
      ['updatedAt before createdAt', value => { value['updatedAt'] = T0 - 1 }, /updatedAt cannot precede createdAt/],
      ['rounds without lastRoundAt', value => { value['roundsStarted'] = 1 }, /lastRoundAt must be null exactly before the first admitted round/],
      ['lastRoundAt without rounds', value => { value['lastRoundAt'] = T0 }, /lastRoundAt must be null exactly before the first admitted round/],
      ['a malformed blocked reason', value => {
        value['operation'] = 'block'
        goalRecord(value)['phase'] = 'blocked'
        goalRecord(value)['blockedReason'] = { code: 'Blocked By Human', message: 'x' }
      }, /blockedReason\.code must be lower-kebab-case/],
      ['a padded blocked reason message', value => {
        value['operation'] = 'block'
        goalRecord(value)['phase'] = 'blocked'
        goalRecord(value)['blockedReason'] = { code: 'blocked-by-human', message: ' padded ' }
      }, /blockedReason\.message must be non-empty and normalized/],
      ['a blocked goal without a reason', value => {
        value['operation'] = 'block'
        goalRecord(value)['phase'] = 'blocked'
      }, /must have exactly/],
      ['an active goal carrying a blocked reason', value => {
        goalRecord(value)['phase'] = 'active'
        goalRecord(value)['blockedReason'] = { code: 'blocked-by-human', message: 'x' }
      }, /must have exactly/],
    ]
    return cases.map(([name, mutate, message]) => {
      const payload = base()
      mutate(payload)
      return [name, payload, message]
    })
  })()

  it.each(snapshotRejections)('rejects %s', (_name, payload, message) => {
    expect(() => decodeInfiniGoalChange(payload)).toThrow(message)
  })

  it('rejects malformed clear tombstones', () => {
    const extra = validClear()
    extra['extra'] = true
    expect(() => decodeInfiniGoalChange(extra)).toThrow(/must have exactly/)
    const missing = validClear()
    delete missing['clearedAt']
    expect(() => decodeInfiniGoalChange(missing)).toThrow(/must have exactly/)
    const badRef = validClear()
    badRef['cleared'] = { id: 'goal-1', revision: 1.5 }
    expect(() => decodeInfiniGoalChange(badRef)).toThrow(/revision must be a positive safe integer/)
    const emptyId = validClear()
    emptyId['cleared'] = { id: '', revision: 2 }
    expect(() => decodeInfiniGoalChange(emptyId)).toThrow(/id must be a non-empty string/)
    const negativeTime = validClear()
    negativeTime['clearedAt'] = -1
    expect(() => decodeInfiniGoalChange(negativeTime)).toThrow(/clearedAt must be a non-negative safe integer/)
    const refExtra = validClear()
    refExtra['cleared'] = { id: 'goal-1', revision: 2, stale: true }
    expect(() => decodeInfiniGoalChange(refExtra)).toThrow(/must have exactly/)
  })

  it('rejects an event whose declared payload has the wrong kind', () => {
    const state = emptyInfiniGoalFoldState()
    const event = {
      type: INFINI_GOAL_EVENT_TYPE,
      seq: SessionSeq(0),
      time: T0,
      data: { kind: 'goal/goal', version: INFINI_GOAL_CHANGE_VERSION },
    } as unknown as SessionEvent
    expect(() => applyInfiniGoalEvent(state, event)).toThrow(/has an invalid kind/)
  })
})

describe('change payload helpers', () => {
  it('derives the revision identity from snapshots and tombstones', () => {
    expect(infiniGoalChangeRef(snapshotChange('edit', goal({ revision: 4 })))).toEqual({ id: 'goal-1', revision: 4 })
    expect(infiniGoalChangeRef(clearChange('goal-1', 5, T0))).toEqual({ id: 'goal-1', revision: 5 })
  })
})

describe('applyInfiniGoalProjection', () => {
  const initialState: InfiniGoalProjectionState = { current: null, seenGoalIds: [], failure: null }

  it('exposes the projection definition with the contract key and wire view', () => {
    expect(infiniGoalProjectionDefinition.key).toBe('infiniGoal')
    expect(infiniGoalProjectionDefinition.init()).toEqual({ current: null, seenGoalIds: [], failure: null })
    const state = applyInfiniGoalProjection(initialState, changeEvent(0, createChange(T0), T0))
    expect(state.current?.goal.id).toBe('goal-1')
    expect(infiniGoalProjectionDefinition.wire.view(state)).toBe(state.current)
    expect(infiniGoalProjectionDefinition.wire.viewSchema.parse(state.current)).toMatchObject({
      goal: { id: 'goal-1', revision: 1 },
      roundsStarted: 0,
      lastRoundAt: null,
    })
    expect(infiniGoalProjectionDefinition.wire.viewSchema.parse(null)).toBeNull()
  })

  it('returns the same reference for unrelated events', () => {
    const state = applyInfiniGoalProjection(initialState, changeEvent(0, createChange(T0), T0))
    const unrelated = messageEvent(1, T0 + 1_000, { kind: 'user' })
    expect(applyInfiniGoalProjection(state, unrelated)).toBe(state)
    expect(applyInfiniGoalProjection(initialState, changeEvent(0, createChange(T0), T0)))
      .not.toBe(initialState)
  })

  it('retains the first replay failure while the client value stays at the last valid goal', () => {
    let state = applyInfiniGoalProjection(initialState, changeEvent(0, createChange(T0), T0))
    state = applyInfiniGoalProjection(state, roundEvent(1, T0 + 1_000, { round: 1 }))
    const lastValidGoal = state.current
    const invalid = changeEvent(
      2,
      snapshotChange('pause', goal({ revision: 5, phase: 'paused' }), { updatedAt: T0 + 2_000, roundsStarted: 1, lastRoundAt: T0 + 1_000 }),
      T0 + 2_000,
    )
    const failed = applyInfiniGoalProjection(state, invalid)
    expect(failed.failure).toContain('infini-goal replay failed at session event 2:')
    expect(failed.failure).toContain('must advance the current goal by exactly one revision')
    expect(failed.current).toBe(lastValidGoal)
    // A failed projection keeps its first failure and stops folding further events.
    const later = applyInfiniGoalProjection(failed, changeEvent(3, clearChange('goal-1', 5, T0 + 3_000), T0 + 3_000))
    expect(later).toBe(failed)
  })

  it('drops the current value on a clear while retaining seen goal ids', () => {
    const created = applyInfiniGoalProjection(initialState, changeEvent(0, createChange(T0), T0))
    const cleared = applyInfiniGoalProjection(created, changeEvent(1, clearChange('goal-1', 2, T0 + 1_000), T0 + 1_000))
    expect(cleared.current).toBeNull()
    expect(cleared.seenGoalIds).toEqual(['goal-1'])
    expect(cleared.failure).toBeNull()
    const recreated = applyInfiniGoalProjection(cleared, changeEvent(2, createChange(T0 + 2_000, goal({ id: 'goal-2' })), T0 + 2_000))
    expect(recreated.current?.goal.id).toBe('goal-2')
    expect(recreated.seenGoalIds).toEqual(['goal-1', 'goal-2'])
  })

  it('validates its persisted state schema', () => {
    const valid: InfiniGoalProjectionState = {
      current: {
        goal: goal(),
        roundsStarted: 0,
        lastRoundAt: null,
        createdAt: T0,
        updatedAt: T0,
      },
      seenGoalIds: ['goal-1'],
      failure: null,
    }
    expect(infiniGoalProjectionDefinition.stateSchema.parse(valid)).toEqual(valid)
    expect(infiniGoalProjectionDefinition.stateSchema.safeParse({
      ...valid,
      seenGoalIds: ['goal-2'],
    }).success).toBe(false)
    expect(infiniGoalProjectionDefinition.stateSchema.safeParse({
      ...valid,
      current: { ...valid.current, lastRoundAt: T0 + 1_000 },
    }).success).toBe(false)
    expect(infiniGoalProjectionDefinition.stateSchema.safeParse({
      ...valid,
      seenGoalIds: ['goal-1', 'goal-1'],
    }).success).toBe(false)
  })
})
