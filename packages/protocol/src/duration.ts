/** Parse and render millisecond spans for the infini-goal pacing configuration. */

import { MAX_MIN_INTERVAL_MS, MIN_MIN_INTERVAL_MS } from './constants.ts'

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const

/**
 * One `<amount><unit>` token, anchored at the current index by the sticky flag.
 * Whitespace is allowed between the amount and the unit (`1 h`), never inside
 * the unit itself, and token boundaries are otherwise exact.
 */
const TOKEN = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/iy

/** Shared guidance appended to malformed-duration errors. */
const DURATION_HINT = 'duration must look like 90s, 5m, 1h30m, or 500ms'

/**
 * Parse a human duration such as `90s`, `5m`, `1h30m`, or `500ms`.
 *
 * Amounts may be decimal (`0.5s`), units are case-insensitive, repeated units
 * are summed (`1h1h` → 2h) and whitespace is allowed between tokens, so
 * `2h 15m` and `1 h` are accepted. The result is rounded to whole milliseconds;
 * this function validates the grammar only, callers that need the pacing
 * bounds must also call {@link validateMinIntervalMs}.
 * @param text - caller-supplied duration text (surrounding whitespace ignored).
 * @returns the span in whole milliseconds.
 * @throws {TypeError} when the text is not one or more `<number><unit>` tokens
 *   or the span overflows the safe-integer range.
 */
export function parseDurationMs(text: string): number {
  if (typeof text !== 'string') throw new TypeError('duration must be a string')
  const input = text.trim()
  if (input.length === 0) throw new TypeError('duration must not be empty')
  let total = 0
  let index = 0
  while (index < input.length) {
    while (index < input.length && /\s/u.test(input[index] as string)) index += 1
    if (index >= input.length) break
    TOKEN.lastIndex = index
    const match = TOKEN.exec(input)
    if (match === null) {
      throw new TypeError(`${DURATION_HINT} (invalid part at "${input.slice(index)}")`)
    }
    const amount = Number(match[1])
    const unit = match[2]?.toLowerCase() as keyof typeof UNIT_MS
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new TypeError(`duration part "${match[0]}" must be positive`)
    }
    total += amount * UNIT_MS[unit]
    index = TOKEN.lastIndex
  }
  const ms = Math.round(total)
  if (!Number.isSafeInteger(ms)) throw new TypeError('duration is too large')
  if (ms < 1) throw new TypeError('duration must resolve to at least 1 ms')
  return ms
}

/**
 * Validate a configured minimum trigger interval.
 * @param value - candidate millisecond span.
 * @returns the value unchanged.
 * @throws {TypeError} when the value is not an integer inside the protocol bounds.
 */
export function validateMinIntervalMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('min interval must be an integer number of milliseconds')
  }
  if (value < MIN_MIN_INTERVAL_MS) {
    throw new TypeError(`min interval must be at least ${MIN_MIN_INTERVAL_MS} ms (1s)`)
  }
  if (value > MAX_MIN_INTERVAL_MS) {
    throw new TypeError(`min interval must be at most ${MAX_MIN_INTERVAL_MS} ms (30d)`)
  }
  return value
}

/**
 * Render a millisecond span in a compact human form (`1h30m`, `5m`, `45s`, `1500ms`).
 * @param ms - non-negative millisecond span.
 * @returns compact duration text.
 * @throws {TypeError} when `ms` is not a non-negative safe integer.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new TypeError('duration must be a non-negative safe integer')
  if (ms === 0) return '0ms'
  if (ms < 1_000) return `${ms}ms`
  const parts: string[] = []
  let rest = ms
  for (const [unit, size] of [['d', UNIT_MS.d], ['h', UNIT_MS.h], ['m', UNIT_MS.m], ['s', UNIT_MS.s]] as const) {
    const amount = Math.floor(rest / size)
    if (amount === 0) continue
    parts.push(`${amount}${unit}`)
    rest -= amount * size
  }
  if (rest > 0) parts.push(`${rest}ms`)
  return parts.join('')
}
