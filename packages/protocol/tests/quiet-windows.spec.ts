import { describe, expect, it } from 'vitest'
import {
  formatClockTime,
  formatQuietWindows,
  formatWeekdays,
  parseClockTime,
  parseQuietWindows,
  parseWeekdays,
  validateQuietWindows,
} from '../src/quiet-windows.ts'

describe('parseWeekdays', () => {
  it('parses labels, ranges, lists, and daily selectors', () => {
    expect(parseWeekdays('Mo-Fr')).toEqual([1, 2, 3, 4, 5])
    expect(parseWeekdays('Sa,Su')).toEqual([6, 7])
    expect(parseWeekdays('1-3,6')).toEqual([1, 2, 3, 6])
    expect(parseWeekdays('daily')).toEqual([])
    expect(parseWeekdays('*')).toEqual([])
  })

  it('treats only plain decimal digits as numeric weekdays', () => {
    expect(parseWeekdays('01-03')).toEqual([1, 2, 3])
    // `Number()` coercion would otherwise accept these as Monday.
    expect(() => parseWeekdays('1.0')).toThrow()
    expect(() => parseWeekdays('0x1')).toThrow()
    expect(() => parseWeekdays('+1')).toThrow()
  })

  it('rejects invalid selectors', () => {
    expect(() => parseWeekdays('Mo-')).toThrow()
    expect(() => parseWeekdays('Fr-Mo')).toThrow()
    expect(() => parseWeekdays('8')).toThrow()
    expect(() => parseWeekdays('Funday')).toThrow()
  })
})

describe('clock helpers', () => {
  it('round-trips HH:mm', () => {
    expect(parseClockTime('00:00')).toBe(0)
    expect(parseClockTime('09:30')).toBe(570)
    expect(formatClockTime(1_439)).toBe('23:59')
  })

  it('rejects invalid clock text', () => {
    expect(() => parseClockTime('24:00')).toThrow()
    expect(() => parseClockTime('9')).toThrow()
    expect(() => parseClockTime('09:60')).toThrow()
  })

  it('rejects minutes that are not a whole minute inside one day', () => {
    expect(() => formatClockTime(-1)).toThrow()
    expect(() => formatClockTime(1_440)).toThrow()
    expect(() => formatClockTime(1.5)).toThrow()
    expect(() => formatClockTime(Number.NaN)).toThrow()
  })
})

describe('quiet window text form', () => {
  it('round-trips canonical text', () => {
    const text = 'Mo-Fr 09:00-18:00; Sa-Su 10:00-12:00; 22:00-06:00'
    const windows = parseQuietWindows(text)
    expect(windows).toHaveLength(3)
    expect(formatQuietWindows(windows)).toBe(text)
  })

  it('treats empty, none, and off as no windows', () => {
    expect(parseQuietWindows('')).toEqual([])
    expect(parseQuietWindows('none')).toEqual([])
    expect(parseQuietWindows('off')).toEqual([])
  })

  it('accepts overnight windows (end before start) and rejects equal clocks', () => {
    expect(parseQuietWindows('Mo 22:00-06:00')).toEqual([{ days: [1], start: '22:00', end: '06:00' }])
    expect(() => parseQuietWindows('00:01-00:01')).toThrow(/must differ/)
  })

  it('rejects malformed entries and whole-day windows', () => {
    expect(() => parseQuietWindows('09:00')).toThrow()
    expect(() => parseQuietWindows('09:00-09:00')).toThrow()
    expect(() => parseQuietWindows('always')).toThrow()
    expect(() => parseQuietWindows('Xx 09:00-18:00')).toThrow()
  })
})

describe('validateQuietWindows', () => {
  it('normalizes object form', () => {
    expect(validateQuietWindows([{ days: [5, 1, 1], start: '9:00', end: '18:00' }]))
      .toEqual([{ days: [1, 5], start: '09:00', end: '18:00' }])
  })

  it('treats a missing `days` field as every day', () => {
    expect(validateQuietWindows([{ start: '09:00', end: '18:00' }]))
      .toEqual([{ days: [], start: '09:00', end: '18:00' }])
  })

  it('rejects sparse arrays instead of returning holes', () => {
    expect(() => validateQuietWindows(new Array(1))).toThrow()
  })

  it('rejects invalid shapes', () => {
    expect(() => validateQuietWindows([{ start: '09:00', end: '09:00' }])).toThrow()
    expect(() => validateQuietWindows([{ days: [0], start: '09:00', end: '18:00' }])).toThrow()
    expect(() => validateQuietWindows('nope')).toThrow()
  })
})

describe('formatWeekdays', () => {
  it('compresses runs', () => {
    expect(formatWeekdays([1, 2, 3, 4, 5])).toBe('Mo-Fr')
    expect(formatWeekdays([1, 3, 5])).toBe('Mo,We,Fr')
    expect(formatWeekdays([6, 7])).toBe('Sa-Su')
    expect(formatWeekdays([])).toBe('')
  })
})
