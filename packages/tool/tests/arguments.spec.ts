import { describe, expect, it } from 'vitest'
import {
  InfiniGoalToolInputError,
  blockedReasonFromArgs,
  createRequestFromArgs,
  editRequestFromArgs,
  goalRefFromArgs,
  hasText,
  parseMinIntervalArg,
  parseQuietWindowsArg,
  resolveTimeZoneArg,
} from '../src/arguments.ts'

describe('hasText', () => {
  it('treats only non-empty strings as meaningful model text', () => {
    expect(hasText('x')).toBe(true)
    expect(hasText(' ')).toBe(true)
    expect(hasText('')).toBe(false)
    expect(hasText(undefined)).toBe(false)
  })
})

describe('parseMinIntervalArg', () => {
  it('parses supported duration forms into milliseconds', () => {
    expect(parseMinIntervalArg('90s')).toBe(90_000)
    expect(parseMinIntervalArg('5m')).toBe(300_000)
    expect(parseMinIntervalArg('1h30m')).toBe(5_400_000)
  })

  it('rejects malformed and out-of-bounds durations with the tool input error', () => {
    expect(() => parseMinIntervalArg('5x')).toThrow(InfiniGoalToolInputError)
    expect(() => parseMinIntervalArg('')).toThrow(InfiniGoalToolInputError)
    expect(() => parseMinIntervalArg('500ms')).toThrow(/out of bounds/)
    expect(() => parseMinIntervalArg('31d')).toThrow(/out of bounds/)
    try {
      parseMinIntervalArg('5x')
    } catch (error) {
      expect(error).toBeInstanceOf(InfiniGoalToolInputError)
      expect((error as InfiniGoalToolInputError).code).toBe('INFINI_GOAL_TOOL_INVALID_ARGUMENT')
      expect((error as Error).message).toContain('min_interval')
    }
  })
})

describe('parseQuietWindowsArg', () => {
  it('parses weekday selectors, daily windows, and none', () => {
    expect(parseQuietWindowsArg('Mo-Fr 09:00-18:00'))
      .toEqual([{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }])
    expect(parseQuietWindowsArg('09:00-12:00'))
      .toEqual([{ days: [], start: '09:00', end: '12:00' }])
    expect(parseQuietWindowsArg('none')).toEqual([])
  })

  it('rejects malformed windows', () => {
    expect(() => parseQuietWindowsArg('soon')).toThrow(/quiet_windows/)
    expect(() => parseQuietWindowsArg('Mo-Fr 99:00-18:00')).toThrow(InfiniGoalToolInputError)
  })
})

describe('resolveTimeZoneArg', () => {
  it('canonicalizes IANA names and resolves system', () => {
    expect(resolveTimeZoneArg('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(resolveTimeZoneArg('UTC')).toBe('UTC')
    const system = resolveTimeZoneArg('system')
    expect(system.length).toBeGreaterThan(0)
  })

  it('rejects unknown zones', () => {
    expect(() => resolveTimeZoneArg('Mars/Olympus')).toThrow(/IANA/)
  })
})

describe('createRequestFromArgs', () => {
  it('keeps only the objective when no overrides are supplied', () => {
    const request = createRequestFromArgs({ objective: '  Ship the docs  ' })
    expect(request).toEqual({ objective: 'Ship the docs' })
    expect(Object.keys(request)).toEqual(['objective'])
  })

  it('translates every override into protocol vocabulary', () => {
    const request = createRequestFromArgs({
      objective: 'Ship the docs',
      min_interval: '5m',
      quiet_windows: 'Mo-Fr 09:00-18:00',
      timezone: 'Asia/Shanghai',
    })
    expect(request).toEqual({
      objective: 'Ship the docs',
      minIntervalMs: 300_000,
      quietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
      timezone: 'Asia/Shanghai',
    })
  })

  it('treats empty optional strings as absent', () => {
    const request = createRequestFromArgs({
      objective: 'Ship the docs',
      min_interval: '',
      quiet_windows: '',
      timezone: '',
    })
    expect(request).toEqual({ objective: 'Ship the docs' })
  })

  it('rejects an empty objective', () => {
    expect(() => createRequestFromArgs({ objective: '   ' })).toThrow(/objective/)
  })
})

describe('goalRefFromArgs', () => {
  it('builds the exact ref', () => {
    expect(goalRefFromArgs({ goal_id: 'goal-1', revision: 2 })).toEqual({ id: 'goal-1', revision: 2 })
  })

  it('rejects malformed ids and revisions', () => {
    expect(() => goalRefFromArgs({ goal_id: '', revision: 1 })).toThrow(InfiniGoalToolInputError)
    expect(() => goalRefFromArgs({ goal_id: ' goal-1', revision: 1 })).toThrow(/goal_id/)
    expect(() => goalRefFromArgs({ goal_id: 'goal-1', revision: 0 })).toThrow(/revision/)
    expect(() => goalRefFromArgs({ goal_id: 'goal-1', revision: 1.5 })).toThrow(/revision/)
  })
})

describe('editRequestFromArgs', () => {
  it('builds an objective edit', () => {
    expect(editRequestFromArgs({ goal_id: 'g', revision: 1, action: 'edit', objective: 'Ship v2' }, 'edit'))
      .toEqual({ objective: 'Ship v2' })
  })

  it('builds a settings edit and a config-only edit', () => {
    expect(editRequestFromArgs({
      goal_id: 'g',
      revision: 1,
      action: 'edit',
      min_interval: '90s',
      quiet_windows: 'none',
      timezone: 'UTC',
    }, 'edit')).toEqual({ minIntervalMs: 90_000, quietWindows: [], timezone: 'UTC' })
    expect(editRequestFromArgs({
      goal_id: 'g',
      revision: 1,
      action: 'config',
      min_interval: '2h',
    }, 'config')).toEqual({ minIntervalMs: 7_200_000 })
  })

  it('requires at least one changed field', () => {
    expect(() => editRequestFromArgs({ goal_id: 'g', revision: 1, action: 'edit' }, 'edit'))
      .toThrow(/at least one/)
    expect(() => editRequestFromArgs({
      goal_id: 'g',
      revision: 1,
      action: 'config',
      objective: '',
    }, 'config')).toThrow(/at least one/)
  })

  it('rejects an objective with config', () => {
    expect(() => editRequestFromArgs({
      goal_id: 'g',
      revision: 1,
      action: 'config',
      objective: 'Ship v2',
    }, 'config')).toThrow(/only valid with action edit/)
  })
})

describe('blockedReasonFromArgs', () => {
  it('builds the durable block reason', () => {
    expect(blockedReasonFromArgs({ blocked_reason: '  credentials expired  ' }))
      .toEqual({ code: 'model-reported', message: 'credentials expired' })
  })

  it('requires a non-blank reason', () => {
    expect(() => blockedReasonFromArgs({})).toThrow(/blocked_reason is required/)
    expect(() => blockedReasonFromArgs({ blocked_reason: '   ' })).toThrow(/must not be blank/)
  })
})
