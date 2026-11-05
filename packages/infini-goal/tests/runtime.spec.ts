import { describe, expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { QuietWindow } from '@yankeguo/dsh-infini-goal-protocol'
import {
  InfiniGoalError,
  resolveBlockReason,
  resolveCreateSettings,
  resolveEditSettings,
  resolveObjective,
  resolveServiceConfig,
  resolveSettings,
  systemTimeZone,
} from '../src/runtime.ts'
import type { Config } from '../src/runtime.ts'
import { InfiniGoalService } from '../src/index.ts'
import { T0 } from './fixtures.ts'

/** Every quiet-window configuration that leaves no triggerable local time. */
function allDayWindows(): QuietWindow[] {
  return [
    { days: [], start: '00:00', end: '12:00' },
    { days: [], start: '12:00', end: '00:00' },
  ]
}

/** Capture the InfiniGoalError thrown by one operation. */
function capture(run: () => unknown): InfiniGoalError {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof InfiniGoalError) return error
    throw error
  }
  throw new Error('expected the operation to throw')
}

/** Assert one operation fails with the expected stable error code. */
function expectCode(run: () => unknown, code: InfiniGoalError['code']): InfiniGoalError {
  const error = capture(run)
  expect(error.code).toBe(code)
  expect(error.name).toBe('InfiniGoalError')
  expect(error).toBeInstanceOf(HarnessError)
  expect(error).toBeInstanceOf(Error)
  return error
}

describe('resolveServiceConfig', () => {
  it('resolves the protocol defaults for an empty deployment config', () => {
    const resolved = resolveServiceConfig({}, T0)
    expect(resolved.defaultMinIntervalMs).toBe(60_000)
    expect(resolved.defaultQuietWindows).toEqual([])
    expect(resolved.timezone).toBe(systemTimeZone())
  })

  it('canonicalizes configured defaults', () => {
    const resolved = resolveServiceConfig({
      defaultMinIntervalMs: 90_000,
      defaultQuietWindows: [{ days: [5, 1], start: '9:00', end: '18:00' }],
      timezone: 'Asia/Shanghai',
    }, T0)
    expect(resolved.defaultMinIntervalMs).toBe(90_000)
    expect(resolved.defaultQuietWindows).toEqual([
      { days: [1, 5], start: '09:00', end: '18:00' },
    ])
    expect(resolved.timezone).toBe('Asia/Shanghai')
  })

  it('accepts an empty deployment config object', () => {
    const config: Config = {}
    expect(resolveServiceConfig(config, T0).defaultQuietWindows).toEqual([])
  })

  it('rejects an invalid default minimum interval', () => {
    expectCode(() => resolveServiceConfig({ defaultMinIntervalMs: 999 }, T0), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(() => resolveServiceConfig({ defaultMinIntervalMs: 1_000.5 }, T0), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(() => resolveServiceConfig({ defaultMinIntervalMs: Number.NaN }, T0), 'INFINI_GOAL_INVALID_SETTINGS')
  })

  it('rejects invalid default quiet windows', () => {
    expectCode(() => resolveServiceConfig({
      defaultQuietWindows: [{ days: [], start: '09:00', end: '09:00' }],
    }, T0), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(() => resolveServiceConfig({
      defaultQuietWindows: [{ days: [0], start: '09:00', end: '18:00' }],
    }, T0), 'INFINI_GOAL_INVALID_SETTINGS')
  })

  it('rejects an invalid default time zone', () => {
    expectCode(() => resolveServiceConfig({ timezone: 'Not/AZone' }, T0), 'INFINI_GOAL_INVALID_SETTINGS')
  })

  it('rejects default quiet windows that cover every local time', () => {
    const error = expectCode(
      () => resolveServiceConfig({ defaultQuietWindows: allDayWindows() }, T0),
      'INFINI_GOAL_INVALID_SETTINGS',
    )
    expect(error.message).toContain('cover every local time')
  })
})

describe('resolveCreateSettings', () => {
  const defaults = resolveServiceConfig({
    defaultMinIntervalMs: 120_000,
    defaultQuietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
    timezone: 'Asia/Shanghai',
  }, T0)

  it('materializes every deployment default when the request omits them', () => {
    expect(resolveCreateSettings({ objective: 'ship' }, defaults, T0)).toEqual({
      minIntervalMs: 120_000,
      quietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
      timezone: 'Asia/Shanghai',
    })
  })

  it('lets each request field override its deployment default', () => {
    expect(resolveCreateSettings({
      objective: 'ship',
      minIntervalMs: 5_000,
      quietWindows: [],
      timezone: 'UTC',
    }, defaults, T0)).toEqual({ minIntervalMs: 5_000, quietWindows: [], timezone: 'UTC' })
    expect(resolveCreateSettings({ objective: 'ship', quietWindows: [] }, defaults, T0))
      .toMatchObject({ minIntervalMs: 120_000, quietWindows: [] })
  })

  it('canonicalizes request quiet windows and time zones', () => {
    expect(resolveCreateSettings({
      objective: 'ship',
      quietWindows: [{ days: [7, 6], start: '22:00', end: '6:00' }],
      timezone: 'Asia/Tokyo',
    }, defaults, T0)).toMatchObject({
      quietWindows: [{ days: [6, 7], start: '22:00', end: '06:00' }],
      timezone: 'Asia/Tokyo',
    })
  })

  it('rejects invalid request settings', () => {
    expectCode(() => resolveCreateSettings({ objective: 'x', minIntervalMs: 1 }, defaults, T0), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(() => resolveCreateSettings({ objective: 'x', timezone: 'Nope/Nope' }, defaults, T0), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(() => resolveCreateSettings({
      objective: 'x',
      quietWindows: [{ days: [], start: '09:00', end: '09:00' }],
    }, defaults, T0), 'INFINI_GOAL_INVALID_SETTINGS')
  })

  it('rejects request quiet windows that cover every local time', () => {
    const error = expectCode(
      () => resolveCreateSettings({ objective: 'x', quietWindows: allDayWindows() }, defaults, T0),
      'INFINI_GOAL_INVALID_SETTINGS',
    )
    expect(error.message).toContain('cover every local time')
  })
})

describe('resolveSettings', () => {
  it('returns detached canonical settings', () => {
    const input = { minIntervalMs: 60_000, quietWindows: [{ days: [3], start: '09:00', end: '18:00' }], timezone: 'UTC' }
    const resolved = resolveSettings(input, T0)
    expect(resolved).toEqual(input)
    expect(resolved.quietWindows).not.toBe(input.quietWindows)
    expect(resolved.quietWindows[0]).not.toBe(input.quietWindows[0])
  })
})

describe('resolveEditSettings', () => {
  const current = {
    minIntervalMs: 60_000,
    quietWindows: [{ days: [1], start: '09:00', end: '18:00' }] as QuietWindow[],
    timezone: 'Asia/Shanghai',
  }

  it('requires at least one editable field', () => {
    expectCode(
      () => resolveEditSettings(current, {}, T0),
      'INFINI_GOAL_INVALID_SETTINGS',
    )
  })

  it('keeps untouched fields and applies replacements', () => {
    expect(resolveEditSettings(current, { objective: 'new objective' }, T0)).toEqual(current)
    expect(resolveEditSettings(current, { minIntervalMs: 5_000 }, T0))
      .toEqual({ ...current, minIntervalMs: 5_000 })
    expect(resolveEditSettings(current, { quietWindows: [] }, T0))
      .toEqual({ ...current, quietWindows: [] })
    expect(resolveEditSettings(current, { timezone: 'UTC' }, T0))
      .toEqual({ ...current, timezone: 'UTC' })
  })

  it('rejects invalid or unschedulable replacements', () => {
    expectCode(() => resolveEditSettings(current, { minIntervalMs: 1 }, T0), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(() => resolveEditSettings(current, { timezone: 'Nope/Nope' }, T0), 'INFINI_GOAL_INVALID_SETTINGS')
    expectCode(
      () => resolveEditSettings(current, { quietWindows: allDayWindows() }, T0),
      'INFINI_GOAL_INVALID_SETTINGS',
    )
  })
})

describe('resolveObjective', () => {
  it('accepts and trims a non-empty objective', () => {
    expect(resolveObjective('  ship the thing  ')).toBe('ship the thing')
    expect(resolveObjective('ship')).toBe('ship')
  })

  it('rejects empty or whitespace-only objectives', () => {
    expectCode(() => resolveObjective(''), 'INFINI_GOAL_INVALID_OBJECTIVE')
    expectCode(() => resolveObjective('   '), 'INFINI_GOAL_INVALID_OBJECTIVE')
    expectCode(() => resolveObjective(42 as unknown as string), 'INFINI_GOAL_INVALID_OBJECTIVE')
  })
})

describe('resolveBlockReason', () => {
  it('accepts a lower-kebab-case code and trims the message', () => {
    expect(resolveBlockReason({ code: 'max-tokens', message: '  token budget exhausted  ' }))
      .toEqual({ code: 'max-tokens', message: 'token budget exhausted' })
    expect(resolveBlockReason({ code: 'agent-error', message: 'agent failed' }))
      .toEqual({ code: 'agent-error', message: 'agent failed' })
  })

  it('rejects malformed codes and messages', () => {
    expectCode(() => resolveBlockReason({ code: 'MaxTokens', message: 'x' }), 'INFINI_GOAL_INVALID_BLOCK_REASON')
    expectCode(() => resolveBlockReason({ code: 'max_tokens', message: 'x' }), 'INFINI_GOAL_INVALID_BLOCK_REASON')
    expectCode(() => resolveBlockReason({ code: '', message: 'x' }), 'INFINI_GOAL_INVALID_BLOCK_REASON')
    expectCode(() => resolveBlockReason({ code: 'max-tokens', message: '' }), 'INFINI_GOAL_INVALID_BLOCK_REASON')
    expectCode(() => resolveBlockReason({ code: 'max-tokens', message: '   ' }), 'INFINI_GOAL_INVALID_BLOCK_REASON')
    expectCode(() => resolveBlockReason(null as unknown as { code: string; message: string }), 'INFINI_GOAL_INVALID_BLOCK_REASON')
    expectCode(() => resolveBlockReason([] as unknown as { code: string; message: string }), 'INFINI_GOAL_INVALID_BLOCK_REASON')
  })
})

describe('InfiniGoalService.Config', () => {
  it('declares schemastery defaults for every deployment field', () => {
    const defaults = InfiniGoalService.Config({}) as Required<Config>
    expect(defaults.defaultMinIntervalMs).toBe(60_000)
    expect(defaults.defaultQuietWindows).toEqual([])
    expect(defaults.timezone).toBe(systemTimeZone())
  })

  it('validates the configured minimum interval bounds', () => {
    expect(InfiniGoalService.Config({ defaultMinIntervalMs: 60_000 })).toMatchObject({ defaultMinIntervalMs: 60_000 })
    expect(() => InfiniGoalService.Config({ defaultMinIntervalMs: 500 })).toThrow()
    expect(() => InfiniGoalService.Config({ defaultMinIntervalMs: 31 * 24 * 60 * 60 * 1_000 })).toThrow()
  })

  it('accepts quiet-window objects and defaults their days', () => {
    const config = InfiniGoalService.Config({
      defaultQuietWindows: [{ start: '09:00', end: '18:00' }],
    }) as Required<Config>
    expect(config.defaultQuietWindows).toEqual([{ days: [], start: '09:00', end: '18:00' }])
  })
})
