import { describe, expect, it } from 'vitest'
import {
  formatDurationMs,
  parseDurationMs,
  validateMinIntervalMs,
} from '../src/duration.ts'
import { MAX_MIN_INTERVAL_MS, MIN_MIN_INTERVAL_MS } from '../src/constants.ts'

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

  it('accepts case-insensitive units and whitespace around tokens', () => {
    expect(parseDurationMs('1H30M')).toBe(5_400_000)
    expect(parseDurationMs(' 1 h ')).toBe(3_600_000)
    expect(parseDurationMs('1ms1ms')).toBe(2)
  })

  it('does not reinterpret junk as a smaller span by stripping whitespace', () => {
    // Stripping whitespace used to turn "1m s" into "1ms".
    expect(() => parseDurationMs('1m s')).toThrow()
    expect(() => parseDurationMs('1h 3 0 m')).toThrow()
    expect(() => parseDurationMs('5m junk')).toThrow(/invalid part/)
  })

  it('rejects malformed spans', () => {
    expect(() => parseDurationMs('')).toThrow()
    expect(() => parseDurationMs('5')).toThrow()
    expect(() => parseDurationMs('5x')).toThrow()
    expect(() => parseDurationMs('0s')).toThrow()
    expect(() => parseDurationMs('1m0s')).toThrow()
    expect(() => parseDurationMs('1e3s')).toThrow()
    expect(() => parseDurationMs('.5s')).toThrow()
    expect(() => parseDurationMs('+5m')).toThrow()
  })

  it('distinguishes overflow from sub-millisecond spans', () => {
    expect(() => parseDurationMs('999999999999999999999999d')).toThrow(/too large/)
    expect(() => parseDurationMs('0.0004s')).toThrow(/at least 1 ms/)
  })

  it('rounds decimals to whole milliseconds', () => {
    expect(parseDurationMs('0.5ms')).toBe(1)
    expect(parseDurationMs('1.0004s')).toBe(1_000)
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
    expect(formatDurationMs(MIN_MIN_INTERVAL_MS)).toBe('1s')
    expect(formatDurationMs(MAX_MIN_INTERVAL_MS)).toBe('30d')
  })

  it('round-trips every bound and tricky span', () => {
    const spans = [1, 999, 1_000, 1_001, 59_999, 60_000, 3_600_000, 86_399_999, MIN_MIN_INTERVAL_MS, MAX_MIN_INTERVAL_MS]
    for (const span of spans) {
      expect(parseDurationMs(formatDurationMs(span))).toBe(span)
    }
  })
})

describe('validateMinIntervalMs', () => {
  it('accepts values inside the bounds', () => {
    expect(validateMinIntervalMs(1_000)).toBe(1_000)
    expect(validateMinIntervalMs(60_000)).toBe(60_000)
    expect(validateMinIntervalMs(MIN_MIN_INTERVAL_MS)).toBe(MIN_MIN_INTERVAL_MS)
    expect(validateMinIntervalMs(MAX_MIN_INTERVAL_MS)).toBe(MAX_MIN_INTERVAL_MS)
  })

  it('rejects non-integers and out-of-bounds values', () => {
    expect(() => validateMinIntervalMs(999)).toThrow()
    expect(() => validateMinIntervalMs(1.5)).toThrow()
    expect(() => validateMinIntervalMs(Number.NaN)).toThrow()
    expect(() => validateMinIntervalMs(31 * 86_400_000)).toThrow()
    expect(() => validateMinIntervalMs(MAX_MIN_INTERVAL_MS + 1)).toThrow()
  })
})
