import { describe, expect, it } from 'vitest'
import {
  formatDurationMs,
  parseDurationMs,
  validateMinIntervalMs,
} from '../src/duration.ts'

describe('parseDurationMs', () => {
  it('parses single and combined units', () => {
    expect(parseDurationMs('500ms')).toBe(500)
    expect(parseDurationMs('90s')).toBe(90_000)
    expect(parseDurationMs('5m')).toBe(300_000)
    expect(parseDurationMs('1h30m')).toBe(5_400_000)
    expect(parseDurationMs('2h 15m')).toBe(8_100_000)
    expect(parseDurationMs('1d')).toBe(86_400_000)
    expect(parseDurationMs('0.5s')).toBe(500)
  })

  it('rejects malformed spans', () => {
    expect(() => parseDurationMs('')).toThrow()
    expect(() => parseDurationMs('5')).toThrow()
    expect(() => parseDurationMs('5x')).toThrow()
    expect(() => parseDurationMs('0s')).toThrow()
    expect(() => parseDurationMs('1m junk')).toThrow()
  })
})

describe('formatDurationMs', () => {
  it('renders compact human spans', () => {
    expect(formatDurationMs(1_500)).toBe('1s500ms')
    expect(formatDurationMs(5_000)).toBe('5s')
    expect(formatDurationMs(90_000)).toBe('1m30s')
    expect(formatDurationMs(5_400_000)).toBe('1h30m')
    expect(formatDurationMs(86_400_000)).toBe('1d')
    expect(formatDurationMs(5_400_000 + 15_000)).toBe('1h30m15s')
  })
})

describe('validateMinIntervalMs', () => {
  it('accepts values inside the bounds', () => {
    expect(validateMinIntervalMs(1_000)).toBe(1_000)
    expect(validateMinIntervalMs(60_000)).toBe(60_000)
  })

  it('rejects non-integers and out-of-bounds values', () => {
    expect(() => validateMinIntervalMs(999)).toThrow()
    expect(() => validateMinIntervalMs(1.5)).toThrow()
    expect(() => validateMinIntervalMs(31 * 86_400_000)).toThrow()
  })
})
