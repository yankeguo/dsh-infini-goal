#!/usr/bin/env node
/**
 * Drive a real Session in the isolated DSH Web instance and observe the
 * resulting Turns/Steps/events, entirely through the Web API the browser uses.
 *
 *   node run-session.mjs --state-dir /tmp/dsh-e2e/state \
 *     --prompt "hello e2e" \
 *     --prompt "run the tool" \
 *     --expect-assistant "MOCK E2E first turn" \
 *     --expect "e2e-tool-ok"
 *
 * How it works (verified against DSH 0.2.2-rc.1):
 *   1. POST /api/session/create   {request:{cwd}}         -> {sessionId}
 *   2. POST /api/session/state    {request:{sessionId}}   -> {cursor,...}
 *   3. POST /api/session/prompt   {request:{requestId,sessionId,mode,content}}
 *   4. POST /api/session/wait     {request:{sessionId,afterSeq,timeoutMs}}
 *        -> {reason: idle|input-required|timeout, state:{cursor}, output:{records}}
 *   5. POST /api/session/events   {request:{address,throughSeq:state.cursor}}
 *        -> the full durable log page (turn/step/tool/user/assistant events)
 *
 * Streaming endpoints (`session/follow`, `session/observeState`) are only
 * available over the Gateway WebSocket mux; this script deliberately uses the
 * unary endpoints above, which are enough to observe completed turns.
 *
 * Exit code 0 on success (all prompts idle + all expectations matched).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import {
  createSession,
  fetchMockRequests,
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
    'session-id': { type: 'string' },
    cwd: { type: 'string' },
    prompt: { type: 'string', multiple: true, default: [] },
    'prompt-file': { type: 'string', multiple: true, default: [] },
    'timeout-ms': { type: 'string', default: '120000' },
    expect: { type: 'string', multiple: true, default: [] },
    'expect-assistant': { type: 'string', multiple: true, default: [] },
    'events-out': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log(`run-session.mjs — create a Session and run prompt turns through the isolated DSH Web API

Options:
  --state-dir <dir>        start-web.sh state directory (default /tmp/dsh-e2e/state)
  --session-id <id>        reuse an existing Session instead of creating one
  --cwd <dir>              working directory of a newly created Session
  --prompt <text>          prompt to send; repeat for consecutive turns
  --prompt-file <file>     read a prompt from a file (repeatable)
  --timeout-ms <n>         per-turn wait bound (default 120000)
  --expect <text>          fail unless this substring appears in the turn events (repeatable)
  --expect-assistant <t>   fail unless this substring appears in assistant text (repeatable)
  --events-out <file>      write the collected Session event records as JSON
  --json                   machine-readable report on stdout
`)
  process.exit(0)
}

const state = readState(values['state-dir'])
const { origin, cookie } = await login(state.url)
const timeoutMs = Number(values['timeout-ms'])
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid --timeout-ms ${values['timeout-ms']}`)

const prompts = [...values.prompt]
for (const file of values['prompt-file']) prompts.push(readFileSync(file, 'utf8'))
if (prompts.length === 0 && values['session-id'] === undefined) {
  throw new Error('run-session: pass at least one --prompt/--prompt-file, or --session-id to only observe')
}

/* --------------------------------------------------------------- session */

let sessionId = values['session-id']
let agentPreset
if (sessionId === undefined) {
  const created = await createSession(origin, cookie, values.cwd === undefined ? {} : { cwd: values.cwd })
  sessionId = created.sessionId
  agentPreset = created.agentPreset
}

/** @type {any[]} */
let waitRecords = []
/** @type {number[]} */
const turnStates = []

/* ----------------------------------------------------------------- turns */

for (const [index, prompt] of prompts.entries()) {
  const before = await readSessionState(origin, cookie, sessionId)
  const accepted = await promptSession(origin, cookie, { sessionId, text: prompt })
  if (accepted?.accepted !== true) throw new Error(`run-session: prompt ${index + 1} was not accepted: ${JSON.stringify(accepted)}`)
  const waited = await waitSession(origin, cookie, {
    sessionId,
    afterSeq: before.cursor,
    timeoutMs,
  })
  turnStates.push(waited.state?.cursor ?? -1)
  waitRecords.push(...(waited.output?.records ?? []))
  if (waited.reason !== 'idle') {
    throw new Error(`run-session: turn ${index + 1} ended with reason ${JSON.stringify(waited.reason)} (expected idle): ${JSON.stringify(waited.state)}`)
  }
  if (!values.json) {
    const texts = assistantTexts(waited.output?.records ?? [])
    console.log(`turn ${index + 1}: idle; assistant texts: ${texts.map(text => JSON.stringify(text)).join(', ') || '(none)'}`)
  }
}

/* ---------------------------------------------------- full durable events */

const finalCursor = turnStates.length > 0 ? Math.max(...turnStates) : (await readSessionState(origin, cookie, sessionId)).cursor
const page = await readEvents(origin, cookie, sessionId, { throughSeq: finalCursor })
const records = dedupeBySeq([...page.records, ...waitRecords])
const eventTypes = {}
for (const record of records) {
  const type = record?.event?.type ?? 'unknown'
  eventTypes[type] = (eventTypes[type] ?? 0) + 1
}

const assistant = assistantTexts(records)
const toolCalls = extractToolCalls(records)
const toolResults = extractToolResults(records)

/* ----------------------------------------------------------- assertions */

const failures = []
const eventsJson = JSON.stringify(records)
for (const expected of values.expect) {
  if (!eventsJson.includes(expected)) failures.push(`expected substring not found in Session events: ${JSON.stringify(expected)}`)
}
const assistantJoined = assistant.join('\n')
for (const expected of values['expect-assistant']) {
  if (!assistantJoined.includes(expected)) failures.push(`expected substring not found in assistant text: ${JSON.stringify(expected)}`)
}

let mockRequests
if (state.llmPort !== undefined) {
  mockRequests = (await fetchMockRequests(state.llmPort, new URL(state.url).hostname)).requests
}

if (values['events-out'] !== undefined) {
  mkdirSync(dirname(values['events-out']), { recursive: true })
  writeFileSync(values['events-out'], JSON.stringify({ sessionId, cursor: finalCursor, records }, null, 2))
}

const report = {
  ok: failures.length === 0,
  origin,
  sessionId,
  agentPreset,
  turns: prompts.length,
  cursor: finalCursor,
  reason: 'idle',
  eventCount: records.length,
  eventTypes,
  assistantTexts: assistant,
  toolCalls,
  toolResults,
  mockRequests: mockRequests === undefined ? undefined : {
    count: mockRequests.length,
    entries: mockRequests.map(entry => ({
      stepKind: entry.stepKind,
      lastRole: entry.lastRole,
      hasToolResult: entry.hasToolResult,
      lastUserText: String(entry.lastUserText).slice(0, 120),
    })),
  },
  failures,
}

if (values.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`session ${sessionId}${agentPreset === undefined ? '' : ` (preset ${agentPreset})`}`)
  console.log(`events: ${records.length} — ${Object.entries(eventTypes).map(([type, count]) => `${type}:${count}`).join(' ')}`)
  console.log(`assistant texts: ${assistant.map(text => JSON.stringify(text)).join(', ') || '(none)'}`)
  if (toolCalls.length > 0) console.log(`tool calls: ${toolCalls.map(call => `${call.name}(${call.arguments})`).join(', ')}`)
  if (toolResults.length > 0) console.log(`tool results: ${toolResults.map(result => `${result.name ?? result.callId} isError=${result.isError} text=${JSON.stringify(result.text.slice(0, 120))}`).join(', ')}`)
  if (mockRequests !== undefined) console.log(`mock LLM requests: ${mockRequests.length}`)
  if (failures.length > 0) {
    console.error('FAIL:')
    for (const failure of failures) console.error(`  - ${failure}`)
  } else {
    console.log('PASS: all expectations matched')
  }
}

process.exit(failures.length === 0 ? 0 : 1)

/* ---------------------------------------------------------------- helpers */

function dedupeBySeq(list) {
  const bySeq = new Map()
  for (const record of list) {
    const seq = record?.event?.seq
    if (typeof seq !== 'number') continue
    if (!bySeq.has(seq)) bySeq.set(seq, record)
  }
  return [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq)
}

function assistantTexts(list) {
  const texts = []
  for (const record of list) {
    const event = record?.event
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content.filter(block => block?.type === 'text').map(block => block.text).join('')
    if (text !== '') texts.push(text)
  }
  return texts
}

function extractToolCalls(list) {
  const calls = []
  for (const record of list) {
    const event = record?.event
    if (event?.type !== 'tool/call') continue
    calls.push({
      name: event.data?.name,
      callId: event.data?.callId,
      arguments: typeof event.data?.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data?.arguments),
    })
  }
  return calls
}

function extractToolResults(list) {
  const results = []
  for (const record of list) {
    const event = record?.event
    if (event?.type !== 'tool/result') continue
    const message = event.data?.message
    const content = Array.isArray(message?.content) ? message.content : []
    results.push({
      callId: event.data?.toolCallId ?? message?.toolCallId,
      name: message?.source?.name ?? message?.name,
      isError: event.data?.isError === true || event.data?.error !== undefined,
      text: content.filter(block => block?.type === 'text').map(block => block.text).join(''),
    })
  }
  return results
}
