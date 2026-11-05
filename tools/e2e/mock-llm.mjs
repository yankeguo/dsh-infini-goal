#!/usr/bin/env node
/**
 * Deterministic mock LLM for the isolated DSH E2E harness.
 *
 * Speaks the OpenAI Chat Completions streaming wire protocol that
 * `@deepseek-ai/dsh-llm-pi-ai` reaches through pi-ai's `openai-completions`
 * API (`POST {baseURL}/chat/completions`, SSE `data:` frames, terminated by
 * `data: [DONE]`). No dependencies, no network egress: Node's `node:http` only.
 *
 * Responses are scripted in order from a JSON scenario file so a session can
 * be exercised without real API tokens:
 *
 *   { "responses": [
 *       { "kind": "text",      "text": "Hello!", "chunks": ["Hel", "lo!"] },
 *       { "kind": "tool_call", "tool": "bash",
 *         "arguments": { "command": "printf e2e-tool-ok" } },
 *       { "kind": "error",     "status": 429, "message": "rate limited" }
 *   ] }
 *
 * Every inbound request consumes the next scenario step; when the script is
 * exhausted (or no scenario is supplied) the server answers with a
 * deterministic echo of the last user text so a session always terminates.
 *
 * Extra HTTP surface for harness assertions:
 *   GET  /health                -> { ok, requests, remaining }
 *   GET  /v1/models             -> OpenAI-shaped model list
 *   GET  /__mock/requests       -> JSONL-free array of logged requests
 *   POST /__mock/reset          -> reset the scenario cursor and request log
 *   GET  /__mock/scenario       -> current scenario and cursor
 *
 * Usage:
 *   node mock-llm.mjs --port 34100 --host 127.0.0.1 \
 *     --log /tmp/dsh-e2e/mock-llm-requests.jsonl \
 *     --scenario /tmp/dsh-e2e/scenario.json
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { parseArgs } from 'node:util'

/* ------------------------------------------------------------------ args */

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '34100' },
    host: { type: 'string', default: '127.0.0.1' },
    log: { type: 'string' },
    scenario: { type: 'string' },
    model: { type: 'string', default: 'mock-model' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(0, 5).join('\n'))
  process.exit(0)
}

const PORT = Number(values.port)
const HOST = values.host
const MODEL = values.model
const LOG_PATH = values.log ? resolvePath(values.log) : undefined
const SCENARIO_PATH = values.scenario ? resolvePath(values.scenario) : undefined

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`mock-llm: invalid --port ${values.port}`)
  process.exit(2)
}

/* -------------------------------------------------------------- scenario */

/** @typedef {{ kind: string } & Record<string, unknown>} ScenarioStep */

/** @type {{ responses: ScenarioStep[] }} */
let scenario = { responses: [] }
/** Index of the next step each request consumes. */
let cursor = 0
/** @type {unknown[]} */
let requestLog = []

function loadScenario() {
  if (SCENARIO_PATH === undefined) return
  try {
    scenario = JSON.parse(readFileSync(SCENARIO_PATH, 'utf8'))
  } catch (error) {
    console.error(`mock-llm: cannot read scenario ${SCENARIO_PATH}: ${error.message}`)
    process.exit(2)
  }
  if (!Array.isArray(scenario.responses)) {
    console.error(`mock-llm: scenario ${SCENARIO_PATH} must have a "responses" array`)
    process.exit(2)
  }
}

function logRequest(entry) {
  requestLog.push(entry)
  if (LOG_PATH === undefined) return
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`)
  } catch (error) {
    console.error(`mock-llm: cannot append request log: ${error.message}`)
  }
}

/* ----------------------------------------------------------- wire helpers */

/** Flatten OpenAI/pi-ai message content into plain text. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object' && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  return ''
}

/** Last message of a given role, for deterministic echo/assert helpers. */
function lastMessage(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === role) return messages[i]
  }
  return undefined
}

function sseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function chatChunkBase(id, created) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model: MODEL,
  }
}

function writeUsage(res, id, created, usage) {
  const prompt = usage?.prompt_tokens ?? 111
  const completion = usage?.completion_tokens ?? 22
  sseChunk(res, {
    ...chatChunkBase(id, created),
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  })
}

/** Split text into deterministic streaming chunks. */
function textChunks(text, explicit) {
  if (Array.isArray(explicit) && explicit.length > 0) return explicit.map(String)
  if (text.length <= 12) return [text]
  const size = Math.max(4, Math.ceil(text.length / 3))
  const chunks = []
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size))
  return chunks
}

/** Stream one text response. */
function streamText(res, id, created, text, explicitChunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  sseChunk(res, {
    ...chatChunkBase(id, created),
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  })
  for (const chunk of textChunks(text, explicitChunks)) {
    sseChunk(res, {
      ...chatChunkBase(id, created),
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
    })
  }
  sseChunk(res, {
    ...chatChunkBase(id, created),
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })
  writeUsage(res, id, created)
  res.write('data: [DONE]\n\n')
  res.end()
}

/** Stream one assistant tool call (one call, arguments split in two deltas). */
function streamToolCall(res, id, created, tool, args) {
  const argsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  const cut = Math.max(1, Math.floor(argsJson.length / 2))
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  sseChunk(res, {
    ...chatChunkBase(id, created),
    choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
  })
  sseChunk(res, {
    ...chatChunkBase(id, created),
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_mock_1',
          type: 'function',
          function: { name: tool, arguments: '' },
        }],
      },
      finish_reason: null,
    }],
  })
  sseChunk(res, {
    ...chatChunkBase(id, created),
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(0, cut) } }] },
      finish_reason: null,
    }],
  })
  sseChunk(res, {
    ...chatChunkBase(id, created),
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(cut) } }] },
      finish_reason: null,
    }],
  })
  sseChunk(res, {
    ...chatChunkBase(id, created),
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  })
  writeUsage(res, id, created)
  res.write('data: [DONE]\n\n')
  res.end()
}

/** Answer the request with an HTTP-level provider failure. */
function respondError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message, type: 'mock_llm_error', code: `mock_${status}` } }))
}

/* --------------------------------------------------------------- handler */

function pickStep() {
  if (cursor < scenario.responses.length) {
    const step = scenario.responses[cursor]
    cursor += 1
    return step
  }
  return undefined
}

/** Flatten the most recent tool result message into text, for fallback replies. */
function lastToolResultText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'tool') continue
    return contentText(messages[i].content) || JSON.stringify(messages[i].content ?? '')
  }
  return ''
}

/** Fallback reply: deterministic echo of the last user text. */
function fallbackStep(lastUserText, messages) {
  const toolResult = lastToolResultText(messages)
  if (toolResult !== '') return { kind: 'text', text: `FINAL: mock LLM saw the tool result (${toolResult.slice(0, 200)})` }
  return { kind: 'text', text: `MOCK_REPLY: ${lastUserText.slice(0, 400)}` }
}

async function handleChatCompletions(req, res) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    respondError(res, 400, 'request body is not JSON')
    return
  }

  const messages = Array.isArray(body.messages) ? body.messages : []
  const user = lastMessage(messages, 'user')
  const userText = contentText(user?.content)
  const last = messages[messages.length - 1]
  const hasToolResult = last?.role === 'tool'
    || messages.some(m => m?.role === 'tool')
  const tools = Array.isArray(body.tools) ? body.tools.map(t => t?.function?.name).filter(Boolean) : []
  const id = `chatcmpl-mock-${Date.now()}-${cursor}`
  const created = Math.floor(Date.now() / 1000)

  const step = pickStep() ?? fallbackStep(userText, messages)
  const entry = {
    time: new Date().toISOString(),
    path: '/v1/chat/completions',
    model: body.model,
    stream: body.stream === true,
    messageCount: messages.length,
    lastRole: last?.role,
    lastUserText: userText.slice(0, 2000),
    userTexts: messages
      .filter(message => message?.role === 'user')
      .map(message => contentText(message.content).slice(0, 500)),
    toolNames: tools,
    hasToolResult,
    stepKind: step.kind,
    cursor,
    scenarioSize: scenario.responses.length,
  }
  logRequest(entry)

  switch (step.kind) {
    case 'text':
      streamText(res, id, created, String(step.text ?? ''), step.chunks)
      return
    case 'tool_call':
      streamToolCall(res, id, created, String(step.tool ?? 'bash'), step.arguments ?? {})
      return
    case 'error':
      respondError(res, Number(step.status ?? 500), String(step.message ?? 'mock provider failure'))
      return
    case 'hang':
      // Never answer; the harness uses this to exercise client cancellation paths.
      return
    default:
      streamText(res, id, created, `MOCK_REPLY: ${userText.slice(0, 400)}`)
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://mock-llm.internal')

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, requests: requestLog.length, remaining: Math.max(0, scenario.responses.length - cursor) }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'dsh-e2e-mock' }],
    }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/__mock/requests') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ requests: requestLog }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/__mock/scenario') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ scenarioPath: SCENARIO_PATH ?? null, cursor, responses: scenario.responses }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/__mock/reset') {
    cursor = 0
    requestLog = []
    if (LOG_PATH !== undefined) writeFileSync(LOG_PATH, '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    handleChatCompletions(req, res).catch(error => {
      console.error(`mock-llm: handler failed: ${error.stack ?? error}`)
      if (!res.headersSent) respondError(res, 500, String(error?.message ?? error))
      else res.end()
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `no mock route for ${req.method} ${url.pathname}` } }))
})

server.on('error', error => {
  console.error(`mock-llm: server error: ${error.message}`)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  loadScenario()
  console.log(`mock-llm listening on http://${HOST}:${PORT} (model=${MODEL}${SCENARIO_PATH ? `, scenario=${SCENARIO_PATH}` : ''})`)
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
  process.on('SIGINT', () => server.close(() => process.exit(0)))
})
