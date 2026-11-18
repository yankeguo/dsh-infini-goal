#!/usr/bin/env node
/**
 * Tools proof for the infini-goal suite: the model-facing tool path.
 *
 * The mock LLM is scripted (by probe-tools.sh) to answer the human prompt with
 * a `create_infini_goal` tool call. This script:
 *
 *   1. creates a Session through the Web API and sends one human prompt,
 *   2. waits for the turn to settle (the scripted tool call executes, the
 *      follow-up model request returns a final text),
 *   3. reads the durable Session log and asserts:
 *      - the `request/header` event advertises `get_infini_goal`,
 *        `create_infini_goal`, `update_infini_goal` to the model,
 *      - a `tool/call` named `create_infini_goal` was recorded,
 *      - its `tool/result` is not an error,
 *      - the final assistant text is the scripted "MODEL TOOL GOAL CREATED",
 *      - the control plugin (if present) reports the created goal with the
 *        scripted objective and phase `active`.
 *
 * After the create assertions, the script replaces the mock-LLM scenario with
 * an `update_infini_goal` (action `edit`) call carrying the created goal's
 * exact id/revision, sends a second human prompt, and asserts the update tool
 * call, its non-error result, the updated objective, and phase `active`.
 *
 * This proves the complete model → tool → domain-service path for both write
 * tools (the direct-human authority check passes because each prompt is a real
 * human user message in its open turn).
 *
 * Usage: node probe-tools.mjs --state-dir <dir> --workspace <dir> [--json]
 */
import { parseArgs } from 'node:util'
import {
  createSession,
  httpRequest,
  login,
  promptSession,
  readEvents,
  readSessionState,
  readState,
  waitSession,
} from './lib/web-client.mjs'

const { values } = parseArgs({
  options: {
    'state-dir': { type: 'string', default: '/tmp/dsh-e2e/state' },
    workspace: { type: 'string', default: '/tmp/dsh-e2e/workspace' },
    objective: { type: 'string', default: 'E2E model tool goal via scripted mock' },
    'timeout-ms': { type: 'string', default: '60000' },
    json: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

const state = readState(values['state-dir'])
const { origin, cookie } = await login(state.url)
const failures = []

/* ------------------------------------------------------------- helpers -- */

async function control(method, path, body) {
  const response = await httpRequest(`${origin}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    timeoutMs: 20_000,
  })
  const parsed = JSON.parse(response.body)
  if (response.status !== 200 || parsed?.ok !== true) {
    throw new Error(`control ${method} ${path} failed HTTP ${response.status}: ${parsed?.message ?? response.body.slice(0, 300)}`)
  }
  return parsed
}

/**
 * Replace the deterministic mock LLM scenario and reset its cursor/log.
 * @param {number} port mock LLM port from state/llm.port
 * @param {readonly object[]} responses scenario steps for the next requests
 * @returns {Promise<void>}
 */
async function setMockScenario(port, responses) {
  const response = await httpRequest(`http://127.0.0.1:${port}/__mock/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ responses }),
    timeoutMs: 10_000,
  })
  if (response.status !== 200) {
    throw new Error(`mock scenario update failed HTTP ${response.status}: ${response.body.slice(0, 300)}`)
  }
}

function requestHeaderToolNames(records) {
  for (const record of records) {
    const event = record?.event
    if (event?.type !== 'request/header') continue
    const tools = event.data?.header?.tools
    if (Array.isArray(tools)) return tools.map(tool => tool?.name).filter(name => typeof name === 'string')
  }
  return []
}

function findToolCall(records, name) {
  for (const record of records) {
    const event = record?.event
    if (event?.type === 'tool/call' && event.data?.name === name) {
      return { callId: event.data.callId, arguments: event.data.arguments }
    }
  }
  return undefined
}

function findToolResult(records, callId) {
  for (const record of records) {
    const event = record?.event
    if (event?.type !== 'tool/result') continue
    // Wire shape (verified): the tool-role message lives under data.message and
    // carries toolCallId / isError; a failed invocation also adds data.error.
    const message = event.data?.message
    const messageCallId = message?.toolCallId ?? message?.source?.callId
    if (messageCallId !== callId) continue
    const content = Array.isArray(message?.content) ? message.content : []
    return {
      callId: messageCallId,
      isError: message?.isError === true || event.data?.isError === true || event.data?.error !== undefined,
      text: content.filter(block => block?.type === 'text').map(block => block.text).join(''),
    }
  }
  return undefined
}

function systemTexts(records) {
  const texts = []
  for (const record of records) {
    const event = record?.event
    if (event?.type !== 'system/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content.filter(block => block?.type === 'text').map(block => block.text).join('')
    if (text !== '') texts.push(text)
  }
  return texts
}

function assistantTexts(records) {
  const texts = []
  for (const record of records) {
    const event = record?.event
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content.filter(block => block?.type === 'text').map(block => block.text).join('')
    if (text !== '') texts.push(text)
  }
  return texts
}

function check(name, ok, detail) {
  if (!ok) failures.push({ name, detail })
  if (!values.json) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

/* ---------------------------------------------------------------- flow -- */

const created = await createSession(origin, cookie, { cwd: values.workspace })
const before = await readSessionState(origin, cookie, created.sessionId)
await promptSession(origin, cookie, {
  sessionId: created.sessionId,
  text: 'This is a long-running objective from the human: please create an infini goal for it. '
    + 'Use the create_infini_goal tool now.',
})
const waited = await waitSession(origin, cookie, {
  sessionId: created.sessionId,
  afterSeq: before.cursor,
  timeoutMs: Number(values['timeout-ms']),
})
if (waited.reason !== 'idle') {
  failures.push({ name: 'turn settles idle', detail: waited.reason })
}
const finalCursor = waited.state?.cursor ?? before.cursor
const page = await readEvents(origin, cookie, created.sessionId, { throughSeq: finalCursor })
const records = page.records

const toolNames = requestHeaderToolNames(records)
const expectedTools = ['get_infini_goal', 'create_infini_goal', 'update_infini_goal']
for (const tool of expectedTools) {
  check(`request/header advertises ${tool}`, toolNames.includes(tool), `advertised: ${toolNames.join(',') || 'none'}`)
}

const promptText = systemTexts(records).join('\n')
check(
  'system prompt carries the infini-goal authority policy',
  promptText.includes('pause, complete, and blocked')
    && promptText.includes('never authorize a goal change'),
  promptText.includes('tool:infini-goal') ? 'policy section text found' : 'guidance text scanned',
)

// Persist the raw page for debugging and post-mortem evidence.
try {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const out = `${values['state-dir']}/../smoke/probe-tools-events.json`
  mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true })
  writeFileSync(out, JSON.stringify({ sessionId: created.sessionId, cursor: finalCursor, eventTypes: records.map(record => record?.event?.type), records }, null, 2))
} catch {
  /* evidence export is best-effort */
}

const call = findToolCall(records, 'create_infini_goal')
check('model emitted tool/call create_infini_goal', call !== undefined, call === undefined ? 'no tool/call event' : JSON.stringify(call.arguments))
const result = call === undefined ? undefined : findToolResult(records, call.callId)
check('tool/result for create_infini_goal is not an error', result !== undefined && result.isError === false, result === undefined
  ? `no tool/result event; records=${records.length} callId=${call?.callId ?? 'n/a'} types=${records.map(record => record?.event?.type).join(',')}`
  : result.text.slice(0, 300))

const texts = assistantTexts(records)
check('final assistant text is the scripted continuation', texts.some(text => text.includes('MODEL TOOL GOAL CREATED')), texts)

// Host-side view through the control plugin (present because probe-tools.sh
// boots the suite composition with the control patch).
let status
try {
  status = await control('GET', `/e2e-infini/status?sessionId=${encodeURIComponent(created.sessionId)}`)
  const objective = status.view?.objective
  check('ctx.infiniGoals reports the goal created by the tool', objective === values.objective, {
    objective,
    phase: status.view?.phase,
    roundsStarted: status.view?.roundsStarted,
  })
  check('created goal is active', status.view?.phase === 'active')
} catch (error) {
  failures.push({ name: 'control status reachable', detail: error instanceof Error ? error.message : String(error) })
}

/* ------------------------------------------------------ update tool path -- */

let update = null
if (status?.view?.id !== undefined && state.llmPort !== undefined) {
  const updateObjective = 'E2E updated objective via scripted mock'
  // The active goal's driver may start an automatic round immediately after
  // creation. Pause it first so the follow-up prompt owns a human turn; the
  // update tool path is about authority and execution, not auto-round state.
  await control('POST', '/e2e-infini/pause', { sessionId: created.sessionId })
  const paused = await waitSession(origin, cookie, {
    sessionId: created.sessionId,
    afterSeq: finalCursor,
    timeoutMs: Number(values['timeout-ms']),
  })
  if (paused.reason !== 'idle') {
    failures.push({ name: 'pause settles idle', detail: paused.reason })
  }
  const updateStart = paused.state?.cursor ?? finalCursor
  const pausedGoal = await control('GET', `/e2e-infini/status?sessionId=${encodeURIComponent(created.sessionId)}`)
  if (pausedGoal.view?.id === undefined) {
    failures.push({ name: 'paused goal readable', detail: JSON.stringify(pausedGoal.view ?? null) })
  }
  await setMockScenario(state.llmPort, [
    {
      kind: 'tool_call',
      tool: 'update_infini_goal',
      arguments: {
        goal_id: pausedGoal.view?.id ?? '',
        revision: pausedGoal.view?.revision ?? 0,
        action: 'edit',
        objective: updateObjective,
      },
    },
    { kind: 'text', text: 'MODEL UPDATE TOOL RAN' },
  ])
  await promptSession(origin, cookie, {
    sessionId: created.sessionId,
    text: 'Human follow-up: update the infini goal objective using update_infini_goal now.',
  })
  const waitedUpdate = await waitSession(origin, cookie, {
    sessionId: created.sessionId,
    afterSeq: updateStart,
    timeoutMs: Number(values['timeout-ms']),
  })
  if (waitedUpdate.reason !== 'idle') {
    failures.push({ name: 'update turn settles idle', detail: waitedUpdate.reason })
  }
  const updateCursor = waitedUpdate.state?.cursor ?? updateStart
  const updatePage = await readEvents(origin, cookie, created.sessionId, { throughSeq: updateCursor })
  const updateRecords = updatePage.records.filter(record => (record?.event?.seq ?? 0) > updateStart)
  const updateCall = findToolCall(updateRecords, 'update_infini_goal')
  check(
    'model emitted tool/call update_infini_goal',
    updateCall !== undefined,
    updateCall === undefined ? 'no tool/call event' : JSON.stringify(updateCall.arguments),
  )
  const updateResult = updateCall === undefined ? undefined : findToolResult(updateRecords, updateCall.callId)
  check(
    'tool/result for update_infini_goal is not an error',
    updateResult !== undefined && updateResult.isError === false,
    updateResult === undefined ? 'no tool/result event' : updateResult.text.slice(0, 300),
  )
  const updateTexts = assistantTexts(updateRecords)
  check(
    'final update text is the scripted continuation',
    updateTexts.some(text => text.includes('MODEL UPDATE TOOL RAN')),
    updateTexts,
  )
  const updated = await control('GET', `/e2e-infini/status?sessionId=${encodeURIComponent(created.sessionId)}`)
  check('ctx.infiniGoals reports the updated objective', updated.view?.objective === updateObjective, {
    objective: updated.view?.objective,
    phase: updated.view?.phase,
  })
  check('updated goal keeps the paused phase', updated.view?.phase === 'paused')
  update = {
    objective: updateObjective,
    call: updateCall,
    result: updateResult,
    assistantTexts: updateTexts,
    goal: updated.view ?? null,
  }
} else {
  failures.push({ name: 'update tool path prerequisites', detail: 'missing created goal or mock LLM port' })
}

const report = {
  ok: failures.length === 0,
  origin,
  sessionId: created.sessionId,
  waitReason: waited.reason,
  cursor: finalCursor,
  advertisedTools: toolNames,
  toolCall: call,
  toolResult: result,
  assistantTexts: texts,
  goal: status?.view ?? null,
  update,
  failures,
}
if (values.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('')
  if (failures.length > 0) {
    console.log('PROBE TOOLS FAIL')
    for (const failure of failures) console.log(`  - ${failure.name}: ${typeof failure.detail === 'string' ? failure.detail : JSON.stringify(failure.detail)}`)
  } else {
    console.log('PROBE TOOLS PASS')
  }
}
process.exit(failures.length === 0 ? 0 : 1)
