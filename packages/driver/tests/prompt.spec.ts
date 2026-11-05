import { describe, expect, it } from 'vitest'
import { renderInfiniGoalRoundPrompt } from '../src/prompt.ts'
import type { InfiniGoalView } from '@yankeguo/dsh-infini-goal-protocol'

/** Build a minimal active view for prompt rendering. */
function view(overrides: Partial<InfiniGoalView> = {}): InfiniGoalView {
  return {
    id: 'infini-goal-1',
    revision: 1,
    objective: 'Ship the migration',
    phase: 'active',
    minIntervalMs: 90_000,
    quietWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }],
    timezone: 'Asia/Shanghai',
    roundsStarted: 0,
    lastRoundAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('renderInfiniGoalRoundPrompt', () => {
  it('renders objective, round, pacing, and quiet windows', () => {
    const [block] = renderInfiniGoalRoundPrompt(view(), 3)
    expect(block).toMatchObject({ type: 'text' })
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toContain('<infini_goal_round>')
    expect(text).toContain('Objective: "Ship the migration"')
    expect(text).toContain('Round: 3')
    expect(text).toContain('there is no round limit')
    expect(text).toContain('1m30s')
    expect(text).toContain('Mo-Fr 09:00-18:00')
    expect(text).toContain('Asia/Shanghai')
    expect(text).toContain('</infini_goal_round>')
  })

  it('renders a none quiet-window list', () => {
    const [block] = renderInfiniGoalRoundPrompt(view({ quietWindows: [] }), 1)
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toContain('"none"')
  })
})
