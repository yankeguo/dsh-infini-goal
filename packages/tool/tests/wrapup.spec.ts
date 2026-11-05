import { describe, expect, it } from 'vitest'
import { renderWrapupContext } from '../src/wrapup.ts'

/** Join the rendered text blocks for assertion. */
function textOf(blocks: ReturnType<typeof renderWrapupContext>): string {
  return blocks.map(block => block.type === 'text' ? block.text : '').join('')
}

describe('renderWrapupContext', () => {
  it('renders the complete wrap-up with the objective grounded', () => {
    const text = textOf(renderWrapupContext('Ship the docs'))
    expect(text).toContain('<infini_goal_complete>')
    expect(text).toContain('</infini_goal_complete>')
    expect(text).toContain('Objective: "Ship the docs"')
    expect(text).toContain('verified')
    expect(text).not.toContain('<infini_goal_blocked>')
  })

  it('renders the blocked wrap-up with the reason grounded', () => {
    const text = textOf(renderWrapupContext('Ship the docs', 'credentials expired'))
    expect(text).toContain('<infini_goal_blocked>')
    expect(text).toContain('</infini_goal_blocked>')
    expect(text).toContain('Objective: "Ship the docs"')
    expect(text).toContain('Blocked: "credentials expired"')
    expect(text).not.toContain('<infini_goal_complete>')
  })

  it('returns exactly one non-empty text block', () => {
    const blocks = renderWrapupContext('x')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
  })
})
