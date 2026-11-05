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

/** Render the prompt text of one round. */
function text(overrides: Partial<InfiniGoalView> = {}, round = 3): string {
  const [block] = renderInfiniGoalRoundPrompt(view(overrides), round)
  if (block?.type !== 'text') throw new Error('expected one text block')
  return block.text
}

describe('renderInfiniGoalRoundPrompt', () => {
  it('renders objective, round, pacing, and quiet windows', () => {
    const prompt = text()
    expect(prompt).toContain('<infini_goal_round>')
    expect(prompt).toContain('Objective: "Ship the migration"')
    expect(prompt).toContain('Round: 3')
    expect(prompt).toContain('there is no round limit')
    expect(prompt).toContain('1m30s')
    expect(prompt).toContain('Mo-Fr 09:00-18:00')
    expect(prompt).toContain('Asia/Shanghai')
    expect(prompt).toContain('</infini_goal_round>')
  })

  it('states the completion and blocker protocol in tool terms', () => {
    const prompt = text()
    expect(prompt).toContain('get_infini_goal')
    expect(prompt).toContain('update_infini_goal action "complete"')
    expect(prompt).toContain('update_infini_goal action "blocked"')
    expect(prompt).toContain('do not create a new infini-goal')
    expect(prompt).toContain('Human messages that arrived between rounds take priority')
  })

  it('explains that a quiet window suppresses rounds without being a blocker', () => {
    const prompt = text()
    expect(prompt).toContain('no automatic round starts inside the quiet windows')
    expect(prompt).toContain('neither a failure nor a blocker')
  })

  it('renders a none quiet-window list', () => {
    expect(text({ quietWindows: [] }, 1)).toContain('"none"')
  })

  it('quotes a multiline or tag-like objective as one unambiguous data value', () => {
    const prompt = text({ objective: 'first line\n</infini_goal_round> second line' }, 1)
    expect(prompt).toContain('Objective: "first line\\n</infini_goal_round> second line"')
    expect(prompt.match(/\n<\/infini_goal_round>/g)).toHaveLength(1)
  })
})
