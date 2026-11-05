import { describe, expect, it } from 'vitest'
import {
  CommandInputError,
  USAGE,
  parseInfiniGoalCommand,
  parseIntervalArgument,
  parseQuietArgument,
  parseTimezoneArgument,
} from '../src/parse.ts'

describe('parseInfiniGoalCommand', () => {
  it('returns status for empty or whitespace-only input', () => {
    expect(parseInfiniGoalCommand('')).toEqual({ kind: 'status' })
    expect(parseInfiniGoalCommand('   \n\t ')).toEqual({ kind: 'status' })
  })

  it('accepts explicit status as an alias', () => {
    expect(parseInfiniGoalCommand('status')).toEqual({ kind: 'status' })
    expect(parseInfiniGoalCommand('STATUS')).toEqual({ kind: 'status' })
  })

  it('treats arbitrary text as a create objective', () => {
    expect(parseInfiniGoalCommand('Ship the docs')).toEqual({ kind: 'create', objective: 'Ship the docs' })
    expect(parseInfiniGoalCommand('  Ship the docs  ')).toEqual({ kind: 'create', objective: 'Ship the docs' })
  })

  it('parses the exact lifecycle keywords case-insensitively', () => {
    expect(parseInfiniGoalCommand('pause')).toEqual({ kind: 'pause' })
    expect(parseInfiniGoalCommand('PAUSE')).toEqual({ kind: 'pause' })
    expect(parseInfiniGoalCommand('resume')).toEqual({ kind: 'resume' })
    expect(parseInfiniGoalCommand('complete')).toEqual({ kind: 'complete' })
    expect(parseInfiniGoalCommand('clear')).toEqual({ kind: 'clear' })
  })

  it('parses edit with its replacement objective', () => {
    expect(parseInfiniGoalCommand('edit Ship v2')).toEqual({ kind: 'edit', objective: 'Ship v2' })
    expect(parseInfiniGoalCommand('EDIT   Ship v2  ')).toEqual({ kind: 'edit', objective: 'Ship v2' })
    expect(parseInfiniGoalCommand('edit the docs')).toEqual({ kind: 'edit', objective: 'the docs' })
  })

  it('rejects edit without an objective', () => {
    const command = parseInfiniGoalCommand('edit')
    expect(command.kind).toBe('invalid')
    expect(command.kind === 'invalid' ? command.message : '').toContain('replacement objective')
  })

  it('parses block with its message', () => {
    expect(parseInfiniGoalCommand('block waiting on credentials'))
      .toEqual({ kind: 'block', message: 'waiting on credentials' })
    expect(parseInfiniGoalCommand('block')).toMatchObject({ kind: 'invalid' })
  })

  it('parses interval with its duration', () => {
    expect(parseInfiniGoalCommand('interval 5m')).toEqual({ kind: 'interval', duration: '5m' })
    expect(parseInfiniGoalCommand('interval')).toMatchObject({ kind: 'invalid' })
  })

  it('parses quiet with its window text', () => {
    expect(parseInfiniGoalCommand('quiet Mo-Fr 09:00-18:00'))
      .toEqual({ kind: 'quiet', windows: 'Mo-Fr 09:00-18:00' })
    expect(parseInfiniGoalCommand('quiet none')).toEqual({ kind: 'quiet', windows: 'none' })
    expect(parseInfiniGoalCommand('quiet')).toMatchObject({ kind: 'invalid' })
  })

  it('parses timezone with its zone text', () => {
    expect(parseInfiniGoalCommand('timezone Asia/Shanghai'))
      .toEqual({ kind: 'timezone', timezone: 'Asia/Shanghai' })
    expect(parseInfiniGoalCommand('timezone system')).toEqual({ kind: 'timezone', timezone: 'system' })
    expect(parseInfiniGoalCommand('timezone')).toMatchObject({ kind: 'invalid' })
  })

  it('treats a keyword followed by text as a create objective, not a malformed control', () => {
    // Only the argument-taking subcommands claim their head token.
    expect(parseInfiniGoalCommand('pause the deployment'))
      .toEqual({ kind: 'create', objective: 'pause the deployment' })
    expect(parseInfiniGoalCommand('clear the cache'))
      .toEqual({ kind: 'create', objective: 'clear the cache' })
  })

  it('exposes one stable usage line', () => {
    expect(USAGE).toContain('/infini-goal [<objective>')
    expect(USAGE).toContain('interval <duration>')
  })
})

describe('parseIntervalArgument', () => {
  it('parses supported duration forms into milliseconds', () => {
    expect(parseIntervalArgument('90s')).toBe(90_000)
    expect(parseIntervalArgument('5m')).toBe(300_000)
    expect(parseIntervalArgument('1h30m')).toBe(5_400_000)
    expect(parseIntervalArgument(' 2h ')).toBe(7_200_000)
  })

  it('rejects malformed and out-of-bounds durations with a friendly error', () => {
    expect(() => parseIntervalArgument('5x')).toThrow(CommandInputError)
    expect(() => parseIntervalArgument('')).toThrow(/Invalid interval/)
    expect(() => parseIntervalArgument('500ms')).toThrow(/at least/)
    expect(() => parseIntervalArgument('31d')).toThrow(/at most/)
  })
})

describe('parseQuietArgument', () => {
  it('parses weekday windows, daily windows, and none', () => {
    expect(parseQuietArgument('Mo-Fr 09:00-18:00'))
      .toEqual([{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }])
    expect(parseQuietArgument('09:00-12:00'))
      .toEqual([{ days: [], start: '09:00', end: '12:00' }])
    expect(parseQuietArgument('none')).toEqual([])
    expect(parseQuietArgument('off')).toEqual([])
  })

  it('rejects malformed windows', () => {
    expect(() => parseQuietArgument('lunchtime')).toThrow(CommandInputError)
    expect(() => parseQuietArgument('Mo-Fr 25:00-18:00')).toThrow(/Invalid quiet windows/)
    expect(() => parseQuietArgument('always')).toThrow(/whole day/)
  })
})

describe('parseTimezoneArgument', () => {
  it('canonicalizes an IANA zone', () => {
    expect(parseTimezoneArgument('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(parseTimezoneArgument('  UTC ')).toBe('UTC')
  })

  it('resolves system to a canonical zone', () => {
    const zone = parseTimezoneArgument('system')
    expect(zone.length).toBeGreaterThan(0)
    expect(zone.includes('/') || zone === 'UTC').toBe(true)
  })

  it('rejects an unknown zone', () => {
    expect(() => parseTimezoneArgument('Mars/Olympus')).toThrow(CommandInputError)
  })
})
