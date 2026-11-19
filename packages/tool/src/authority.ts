/**
 * Execution-time authority checks for the model-facing infini-goal tools.
 *
 * Adapts the official `tool-goal` authority model: a mutating call must be
 * authorized either by direct human input in the current root agent turn, by a
 * shape-validated DevLead relay prompt in that same turn (delegated human
 * authority), or — for the operations that stop or finish the goal (`pause`,
 * `complete`, `blocked`) — by the exact admitted automatic round of the
 * current goal. DevLead notices, scheduled prompts, subagent / agent-message /
 * team-message input, and runtime notices never authorize a change.
 *
 * @module @yankeguo/dsh-tool-infini-goal/authority
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { INFINI_GOAL_MESSAGE_KIND } from '@yankeguo/dsh-infini-goal-protocol'
import type { InfiniGoalView } from '@yankeguo/dsh-infini-goal-protocol'
// Type-only: pulls the core service's `ctx.infiniGoals` Context merge and its
// `infini-goal` MessageSourceMap merge into this program.
import type {} from '@yankeguo/dsh-infini-goal'

/** Stable failure class when a tool is executed outside a live agent driver. */
export const TOOL_DRIVER_REQUIRED_CODE = 'INFINI_GOAL_TOOL_DRIVER_REQUIRED'

/** Stable failure class when the caller lacks authority for an operation. */
export const TOOL_AUTHORITY_REQUIRED_CODE = 'INFINI_GOAL_TOOL_AUTHORITY_REQUIRED'

/** The calling agent plus the immutable event cut and open-turn start used for authority checks. */
export interface InfiniGoalToolExecution {
  /** The exact live agent that invoked the tool. */
  readonly agent: Agent
  /** Immutable session event cut captured when the tool started. */
  readonly events: readonly SessionEvent[]
  /** Seq of the open turn's `turn/start` event. */
  readonly openTurnStartSeq: SessionSeq
}

/** Hard authority granted to one state-changing call. */
export type InfiniGoalToolAuthority =
  | { readonly kind: 'direct-human' }
  | { readonly kind: 'delegated-human' }
  | { readonly kind: 'goal-round'; readonly goal: InfiniGoalView }

/**
 * DevLead's user-message source kind.
 *
 * This literal is duplicated locally on purpose: it is a soft protocol
 * contract with the separately distributed DevLead plugin, not an import or a
 * package dependency. Only the relay shape below is accepted; every other
 * DevLead form (notably `notice`) stays unauthorized.
 */
export const DEVLEAD_MESSAGE_KIND = 'devlead'

/** Structural shape of one DevLead relay prompt source accepted as authority. */
export interface DevLeadRelaySource {
  readonly kind: typeof DEVLEAD_MESSAGE_KIND
  readonly form: 'relay'
  readonly senderSessionId: string
}

/** Structural source shape the core service merges for one automatic round message. */
export interface InfiniGoalRoundSource {
  readonly kind: 'infini-goal'
  readonly goalId: string
  readonly revision: number
  readonly round: number
}

/** Throw one structured tool-policy failure. */
function reject(message: string, code = TOOL_AUTHORITY_REQUIRED_CODE): never {
  throw new HarnessError(message, code)
}

/** Resolve the immutable event cut and open-turn boundary. */
function openTurnEvents(
  ctx: Context,
  agent: Agent,
): Pick<InfiniGoalToolExecution, 'events' | 'openTurnStartSeq'> {
  // Session history read only; the captured prefix is never mutated.
  const events = agent.session.snapshotEvents()
  const boundary = ctx.agents.turnBoundaryOf(agent.session)
  if (boundary.openTurnStartSeq === null) {
    reject('infini-goal tools require an open model turn', TOOL_DRIVER_REQUIRED_CODE)
  }
  return { events, openTurnStartSeq: boundary.openTurnStartSeq }
}

/**
 * Resolve and authenticate the calling agent and its driver boundary.
 * @param ctx - Context carrying the live agent registry.
 * @param exec - Tool execution metadata supplied by the registry.
 * @returns the authenticated agent, immutable event cut, and open-turn boundary.
 */
export function infiniGoalToolExecution(ctx: Context, exec: ToolRunContext): InfiniGoalToolExecution {
  const agent = exec.agent
  if (agent === undefined) {
    return reject('infini-goal tools require a calling agent', 'INFINI_GOAL_TOOL_AGENT_REQUIRED')
  }
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    return reject(
      'infini-goal tools require the exact live calling agent inside its active driver',
      TOOL_DRIVER_REQUIRED_CODE,
    )
  }
  return { agent, ...openTurnEvents(ctx, agent) }
}

/** Whether the captured open turn contains an event accepted by `predicate`. */
function someOpenTurnEvent(
  execution: InfiniGoalToolExecution,
  predicate: (event: SessionEvent) => boolean,
): boolean {
  for (let seq = execution.openTurnStartSeq + 1; seq < execution.events.length; seq += 1) {
    const event = execution.events[seq]
    if (event !== undefined && predicate(event)) return true
  }
  return false
}

/**
 * Whether one user-message source is host-attested direct human input.
 *
 * An omitted `Agent.followup()` / `steer()` source resolves to `user`, so
 * non-human producers must supply their own source rather than inheriting this
 * authority.
 * @param source - user-message source from the session log.
 * @returns true only for the direct-human source kind.
 */
export function isDirectHumanSource(source: MessageSource): boolean {
  return typeof source === 'object' && source !== null && source.kind === 'user'
}

/**
 * Narrow one user-message source to a shape-valid DevLead relay prompt.
 *
 * The source must carry these three fields (soft protocol contract, no DevLead
 * import): `{ kind: 'devlead', form: 'relay', senderSessionId: <non-blank
 * string> }`. Additional fields are ignored for forward compatibility.
 * DevLead notices, other forms, missing or ill-typed sender ids, and unknown
 * source shapes all return undefined, so callers fail closed.
 * @param source - user-message source from the session log.
 * @returns the validated relay source, or undefined for any other source.
 */
export function devLeadRelaySourceOf(source: MessageSource): DevLeadRelaySource | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as unknown as Record<string, unknown>
  if (record['kind'] !== DEVLEAD_MESSAGE_KIND) return undefined
  if (record['form'] !== 'relay') return undefined
  const senderSessionId = record['senderSessionId']
  if (typeof senderSessionId !== 'string' || senderSessionId.trim().length === 0) return undefined
  return record as unknown as DevLeadRelaySource
}

/**
 * Whether one user-message source grants human authority: host-attested direct
 * human input or a shape-valid DevLead relay prompt (delegated human).
 * @param source - user-message source from the session log.
 * @returns true for the direct-human and DevLead relay source shapes.
 */
export function isHumanAuthoritySource(source: MessageSource): boolean {
  return isDirectHumanSource(source) || devLeadRelaySourceOf(source) !== undefined
}

/** Shared explanation for user-message sources that can never grant authority. */
const NON_HUMAN_SOURCE_NOTE =
  '; a DevLead relay prompt (source kind "devlead", form "relay", non-empty senderSessionId) on a '
  + 'top-level agent is allowed, but DevLead notices, scheduled prompts, subagent messages, '
  + 'agent-team messages, other agent messages, and runtime notices never authorize a goal change'

/**
 * Narrow one user-message source to the source of an admitted automatic
 * infini-goal round, revalidating the structural fields at runtime so a
 * cross-bundle source value is never trusted by shape alone.
 * @param source - user-message source from the session log.
 * @returns the round identity, or undefined for any other source.
 */
export function infiniGoalRoundSourceOf(source: MessageSource): InfiniGoalRoundSource | undefined {
  if (source.kind !== INFINI_GOAL_MESSAGE_KIND) return undefined
  const record = source as unknown as Record<string, unknown>
  if (typeof record['goalId'] !== 'string') return undefined
  if (!Number.isSafeInteger(record['revision']) || !Number.isSafeInteger(record['round'])) return undefined
  return record as unknown as InfiniGoalRoundSource
}

/**
 * Whether a captured source is the exact admitted round of one goal revision.
 * @param source - user-message source from the session log.
 * @param goal - the current goal revision.
 * @returns true when the source is this goal's latest admitted round.
 */
export function isMatchingInfiniGoalRoundSource(source: MessageSource, goal: InfiniGoalView): boolean {
  const round = infiniGoalRoundSourceOf(source)
  return round !== undefined
    && round.goalId === goal.id
    && round.revision === goal.revision
    && round.round === goal.roundsStarted
}

/**
 * Whether the captured open turn contains a direct human user message, without
 * checking whether the agent is a runtime root.
 * @param execution - authenticated current tool execution.
 * @returns true when an open-turn user message carries the direct-human source.
 */
export function openTurnHasDirectHumanInput(execution: InfiniGoalToolExecution): boolean {
  return someOpenTurnEvent(execution, (event) =>
    event.type === 'user/message' && isDirectHumanSource(event.data.source))
}

/**
 * Whether the captured open turn contains human authority input — a direct
 * human message or a shape-valid DevLead relay prompt — without checking
 * whether the agent is a runtime root.
 * @param execution - authenticated current tool execution.
 * @returns true when an open-turn user message carries either accepted source.
 */
export function openTurnHasHumanAuthority(execution: InfiniGoalToolExecution): boolean {
  return someOpenTurnEvent(execution, (event) =>
    event.type === 'user/message' && isHumanAuthoritySource(event.data.source))
}

/**
 * Whether the captured open turn contains the exact admitted round of `goal`.
 * @param execution - authenticated current tool execution.
 * @param goal - the current goal revision.
 * @returns true when an open-turn user message is this goal's round `roundsStarted`.
 */
export function openTurnHasInfiniGoalRound(
  execution: InfiniGoalToolExecution,
  goal: InfiniGoalView,
): boolean {
  return someOpenTurnEvent(execution, (event) =>
    event.type === 'user/message' && isMatchingInfiniGoalRoundSource(event.data.source, goal))
}

/**
 * Whether one exact live agent is a runtime root (not a subagent).
 *
 * DSH 0.2.2-rc.1 exposed `AgentRegistry.roots()` (runtime ownership). DSH
 * 0.2.2-rc.2 removed it, and the official `tool-goal` authority now classifies
 * the caller by the durable subagent marker on the Session header instead.
 * Prefer `roots()` while it exists so rc.1 keeps its exact runtime-ownership
 * semantics, and fall back to the header check otherwise.
 * @param ctx - Context carrying the live agent registry.
 * @param agent - the calling agent.
 * @returns true only for a live top-level agent.
 */
export function isRuntimeRoot(ctx: Context, agent: Agent): boolean {
  const registry = ctx.agents as unknown as { roots?: () => Agent[] }
  if (typeof registry.roots === 'function') return registry.roots().includes(agent)
  if (ctx.agents.get(agent.id) !== agent) return false
  return agent.session.header.origin !== 'subagent'
}

/**
 * Human authority kind present in the current root-agent turn, if any.
 *
 * The runtime-root requirement is applied here, so a relay prompt delivered to
 * a subagent never authorizes a goal change. Direct human input wins over a
 * relay prompt when both appear in the same turn.
 * @param ctx - Context carrying the live agent graph.
 * @param execution - authenticated current tool execution.
 * @returns `direct-human`, `delegated-human`, or undefined without authority.
 */
function humanAuthorityKind(
  ctx: Context,
  execution: InfiniGoalToolExecution,
): 'direct-human' | 'delegated-human' | undefined {
  if (!isRuntimeRoot(ctx, execution.agent)) return undefined
  if (openTurnHasDirectHumanInput(execution)) return 'direct-human'
  if (openTurnHasHumanAuthority(execution)) return 'delegated-human'
  return undefined
}

/**
 * Require authority originating in a human message accepted by a runtime root:
 * a direct human turn or a shape-valid DevLead relay prompt.
 * @param ctx - Context carrying the live agent graph.
 * @param execution - authenticated current tool execution.
 * @throws {HarnessError} `INFINI_GOAL_TOOL_AUTHORITY_REQUIRED` without such authority.
 */
export function requireHumanAuthority(ctx: Context, execution: InfiniGoalToolExecution): void {
  if (humanAuthorityKind(ctx, execution) !== undefined) return
  reject(
    'this infini-goal operation requires a direct human turn or a DevLead relay prompt on a top-level agent'
    + NON_HUMAN_SOURCE_NOTE,
  )
}

/**
 * Resolve pause authority from human authority or the exact current goal round.
 * Pausing never increases autonomy, so the goal's own round may stop it.
 * @param ctx - Context carrying the live agent graph.
 * @param execution - authenticated current tool execution.
 * @param goal - the current goal, when one exists.
 * @returns the direct-human, delegated-human, or exact-goal-round authority grant.
 * @throws {HarnessError} `INFINI_GOAL_TOOL_AUTHORITY_REQUIRED` when neither applies.
 */
export function pauseAuthority(
  ctx: Context,
  execution: InfiniGoalToolExecution,
  goal: InfiniGoalView | undefined,
): InfiniGoalToolAuthority {
  const human = humanAuthorityKind(ctx, execution)
  if (human !== undefined) return { kind: human }
  if (goal !== undefined && openTurnHasInfiniGoalRound(execution, goal)) {
    return { kind: 'goal-round', goal }
  }
  return reject(
    'pause requires a direct human turn, a DevLead relay prompt, or the current infini-goal round'
    + NON_HUMAN_SOURCE_NOTE,
  )
}

/**
 * Resolve completion authority from human authority or the exact goal round.
 * @param ctx - Context carrying live agents.
 * @param execution - authenticated current tool execution.
 * @param goal - the current goal, when one exists.
 * @returns the direct-human, delegated-human, or exact-goal-round authority grant.
 * @throws {HarnessError} `INFINI_GOAL_TOOL_AUTHORITY_REQUIRED` when neither applies.
 */
export function completionAuthority(
  ctx: Context,
  execution: InfiniGoalToolExecution,
  goal: InfiniGoalView | undefined,
): InfiniGoalToolAuthority {
  const human = humanAuthorityKind(ctx, execution)
  if (human !== undefined) return { kind: human }
  if (goal !== undefined && openTurnHasInfiniGoalRound(execution, goal)) {
    return { kind: 'goal-round', goal }
  }
  return reject(
    'complete and blocked require a direct human turn, a DevLead relay prompt, or the current infini-goal round'
    + NON_HUMAN_SOURCE_NOTE,
  )
}
