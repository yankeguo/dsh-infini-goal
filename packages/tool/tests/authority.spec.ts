import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { InfiniGoalView } from '@yankeguo/dsh-infini-goal-protocol'
import {
  completionAuthority,
  infiniGoalToolExecution,
  infiniGoalRoundSourceOf,
  isDirectHumanSource,
  isMatchingInfiniGoalRoundSource,
  openTurnHasDirectHumanInput,
  openTurnHasInfiniGoalRound,
  requireDirectHuman,
} from '../src/authority.ts'
import type { InfiniGoalToolExecution } from '../src/authority.ts'

const NOW = Date.UTC(2026, 10, 5, 2, 0, 0)

/** One live goal revision used by the authority fixtures. */
const GOAL: InfiniGoalView = {
  id: 'goal-1',
  revision: 3,
  objective: 'Ship the docs',
  phase: 'active',
  roundsStarted: 2,
  lastRoundAt: NOW - 60_000,
  minIntervalMs: 300_000,
  quietWindows: [],
  timezone: 'Asia/Shanghai',
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 60_000,
}

/** One admitted automatic round source for {@link GOAL}. */
const ROUND_SOURCE = {
  kind: 'infini-goal',
  goalId: GOAL.id,
  revision: GOAL.revision,
  round: GOAL.roundsStarted,
}

/** Build one fake user-message event carrying the supplied source. */
function userEvent(seq: number, source: unknown): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: NOW,
    data: { id: `message-${seq}`, role: 'user', content: [{ type: 'text', text: 'hello' }], source },
    surfaceOp: 'append',
  } as unknown as SessionEvent
}

/** Build one fake turn boundary event. */
function turnStartEvent(seq: number): SessionEvent {
  return {
    type: 'turn/start',
    seq: SessionSeq(seq),
    time: NOW,
    data: { turn: 1 },
  } as unknown as SessionEvent
}

/** Build one fake tool-execution authority cut. */
function execution(events: readonly SessionEvent[], openTurnStartSeq = 0): InfiniGoalToolExecution {
  return {
    agent: {} as Agent,
    events,
    openTurnStartSeq: SessionSeq(openTurnStartSeq),
  }
}

/** Minimal Context exposing only the root-agent registry read. */
function fakeContext(roots: readonly Agent[]): Context {
  return { agents: { roots: () => [...roots] } } as unknown as Context
}

describe('isDirectHumanSource', () => {
  it('accepts only the direct-human source kind', () => {
    expect(isDirectHumanSource({ kind: 'user' })).toBe(true)
    expect(isDirectHumanSource({ kind: 'model', provider: 'p', model: 'm' })).toBe(false)
    expect(isDirectHumanSource(ROUND_SOURCE as unknown as Parameters<typeof isDirectHumanSource>[0]))
      .toBe(false)
  })
})

describe('infiniGoalRoundSourceOf', () => {
  it('narrows a valid round source', () => {
    expect(infiniGoalRoundSourceOf(ROUND_SOURCE as unknown as Parameters<typeof infiniGoalRoundSourceOf>[0]))
      .toEqual(ROUND_SOURCE)
  })

  it('rejects other sources and structurally malformed round sources', () => {
    expect(infiniGoalRoundSourceOf({ kind: 'user' })).toBeUndefined()
    expect(infiniGoalRoundSourceOf({
      kind: 'infini-goal',
      goalId: 'goal-1',
      revision: 2.5,
      round: 1,
    } as unknown as Parameters<typeof infiniGoalRoundSourceOf>[0])).toBeUndefined()
    expect(infiniGoalRoundSourceOf({
      kind: 'infini-goal',
      revision: 2,
      round: 1,
    } as unknown as Parameters<typeof infiniGoalRoundSourceOf>[0])).toBeUndefined()
  })
})

describe('isMatchingInfiniGoalRoundSource', () => {
  it('accepts the exact current goal round', () => {
    expect(isMatchingInfiniGoalRoundSource(
      ROUND_SOURCE as unknown as Parameters<typeof isMatchingInfiniGoalRoundSource>[0],
      GOAL,
    )).toBe(true)
  })

  it('rejects a different round or revision of the same goal', () => {
    expect(isMatchingInfiniGoalRoundSource(
      { ...ROUND_SOURCE, round: GOAL.roundsStarted - 1 } as unknown as Parameters<typeof isMatchingInfiniGoalRoundSource>[0],
      GOAL,
    )).toBe(false)
    expect(isMatchingInfiniGoalRoundSource(
      { ...ROUND_SOURCE, revision: GOAL.revision - 1 } as unknown as Parameters<typeof isMatchingInfiniGoalRoundSource>[0],
      GOAL,
    )).toBe(false)
  })
})

describe('openTurnHasDirectHumanInput', () => {
  it('finds direct human input after the open turn boundary', () => {
    const exec = execution([turnStartEvent(0), userEvent(1, { kind: 'user' })])
    expect(openTurnHasDirectHumanInput(exec)).toBe(true)
  })

  it('ignores human input from before the open turn', () => {
    const exec = execution([userEvent(0, { kind: 'user' }), turnStartEvent(1)], 1)
    expect(openTurnHasDirectHumanInput(exec)).toBe(false)
  })

  it('does not treat an automatic round as direct human input', () => {
    const exec = execution([turnStartEvent(0), userEvent(1, ROUND_SOURCE)])
    expect(openTurnHasDirectHumanInput(exec)).toBe(false)
  })
})

describe('openTurnHasInfiniGoalRound', () => {
  it('finds the exact admitted round', () => {
    const exec = execution([turnStartEvent(0), userEvent(1, ROUND_SOURCE)])
    expect(openTurnHasInfiniGoalRound(exec, GOAL)).toBe(true)
  })

  it('rejects a stale round number', () => {
    const exec = execution([turnStartEvent(0), userEvent(1, { ...ROUND_SOURCE, round: 1 })])
    expect(openTurnHasInfiniGoalRound(exec, GOAL)).toBe(false)
  })
})

describe('completionAuthority', () => {
  it('grants direct-human authority on a runtime root', () => {
    const agent = {} as Agent
    const exec: InfiniGoalToolExecution = {
      agent,
      events: [turnStartEvent(0), userEvent(1, { kind: 'user' })],
      openTurnStartSeq: SessionSeq(0),
    }
    expect(completionAuthority(fakeContext([agent]), exec, GOAL)).toEqual({ kind: 'direct-human' })
  })

  it('grants goal-round authority without a root human turn', () => {
    const exec = execution([turnStartEvent(0), userEvent(1, ROUND_SOURCE)])
    expect(completionAuthority(fakeContext([]), exec, GOAL)).toEqual({ kind: 'goal-round', goal: GOAL })
  })

  it('rejects a call with neither authority', () => {
    const exec = execution([turnStartEvent(0), userEvent(1, { kind: 'user' })])
    expect(() => completionAuthority(fakeContext([]), exec, GOAL)).toThrow(HarnessError)
    try {
      completionAuthority(fakeContext([]), exec, GOAL)
    } catch (error) {
      expect((error as HarnessError).code).toBe('INFINI_GOAL_TOOL_AUTHORITY_REQUIRED')
    }
  })
})

describe('requireDirectHuman', () => {
  it('accepts a root human turn and rejects an automatic round', () => {
    const agent = {} as Agent
    const human: InfiniGoalToolExecution = {
      agent,
      events: [turnStartEvent(0), userEvent(1, { kind: 'user' })],
      openTurnStartSeq: SessionSeq(0),
    }
    expect(() => requireDirectHuman(fakeContext([agent]), human)).not.toThrow()
    const round = execution([turnStartEvent(0), userEvent(1, ROUND_SOURCE)])
    expect(() => requireDirectHuman(fakeContext([agent]), { ...round, agent })).toThrow(/direct human turn/)
  })
})

/** Running live agent fixture with an event history containing one turn start. */
function runningAgent(status = 'running'): Agent {
  return {
    id: 'agent-1',
    status,
    session: { snapshotEvents: () => [turnStartEvent(0)] },
  } as unknown as Agent
}

/** Minimal Context exposing the agent-registry reads the driver-boundary check uses. */
function driverContext(
  agent: Agent,
  options: { live?: Agent; initiator?: Agent; openTurnStartSeq?: number | null } = {},
): Context {
  const live = 'live' in options ? options.live : agent
  const initiator = 'initiator' in options ? options.initiator : agent
  const openTurnStartSeq = 'openTurnStartSeq' in options ? options.openTurnStartSeq : 0
  return {
    agents: {
      get: () => live,
      currentInitiator: () => initiator,
      roots: () => [agent],
      turnBoundaryOf: () => ({
        openTurnStartSeq,
        lastStepStartSeq: null,
        lastStepBoundary: null,
        lastTurn: 1,
      }),
    },
  } as unknown as Context
}

/** Build the bare tool-execution input the registry hands the tool body. */
function toolRunContext(agent: Agent | undefined): Parameters<typeof infiniGoalToolExecution>[1] {
  return { agent, arguments: {}, signal: new AbortController().signal } as unknown as Parameters<typeof infiniGoalToolExecution>[1]
}

/** Run one expected rejection and return its structured error. */
function rejectionOf(run: () => unknown): HarnessError {
  try {
    run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected the call to be rejected')
}

describe('infiniGoalToolExecution', () => {
  it('rejects a call without a calling agent', () => {
    const error = rejectionOf(() => infiniGoalToolExecution(driverContext(runningAgent()), toolRunContext(undefined)))
    expect(error.code).toBe('INFINI_GOAL_TOOL_AGENT_REQUIRED')
  })

  it('rejects stale, non-running, and foreign-initiator calls', () => {
    const staleAgent = runningAgent()
    const stale = rejectionOf(() => infiniGoalToolExecution(
      driverContext(staleAgent, { live: {} as Agent }),
      toolRunContext(staleAgent),
    ))
    expect(stale.code).toBe('INFINI_GOAL_TOOL_DRIVER_REQUIRED')
    const idleAgent = runningAgent('idle')
    const idle = rejectionOf(() => infiniGoalToolExecution(
      driverContext(idleAgent),
      toolRunContext(idleAgent),
    ))
    expect(idle.code).toBe('INFINI_GOAL_TOOL_DRIVER_REQUIRED')
    const foreignAgent = runningAgent()
    const foreign = rejectionOf(() => infiniGoalToolExecution(
      driverContext(foreignAgent, { initiator: {} as Agent }),
      toolRunContext(foreignAgent),
    ))
    expect(foreign.code).toBe('INFINI_GOAL_TOOL_DRIVER_REQUIRED')
  })

  it('rejects a call outside an open model turn', () => {
    const agent = runningAgent()
    const error = rejectionOf(() => infiniGoalToolExecution(
      driverContext(agent, { openTurnStartSeq: null }),
      toolRunContext(agent),
    ))
    expect(error.code).toBe('INFINI_GOAL_TOOL_DRIVER_REQUIRED')
    expect(error.message).toContain('open model turn')
  })

  it('returns the event cut and open-turn boundary for the exact live agent', () => {
    const agent = runningAgent()
    const executionResult = infiniGoalToolExecution(driverContext(agent), toolRunContext(agent))
    expect(executionResult.agent).toBe(agent)
    expect(executionResult.openTurnStartSeq).toBe(0)
    expect(executionResult.events).toHaveLength(1)
  })
})

describe('requireDirectHuman on a subagent', () => {
  it('rejects human-looking input when the agent is not a runtime root', () => {
    const agent = {} as Agent
    const human: InfiniGoalToolExecution = {
      agent,
      events: [turnStartEvent(0), userEvent(1, { kind: 'user' })],
      openTurnStartSeq: SessionSeq(0),
    }
    const error = rejectionOf(() => requireDirectHuman(fakeContext([]), human))
    expect(error.code).toBe('INFINI_GOAL_TOOL_AUTHORITY_REQUIRED')
  })
})
