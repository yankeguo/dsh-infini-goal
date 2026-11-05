#!/usr/bin/env node
/**
 * Minimal, dependency-free client for the isolated DSH Web instance.
 *
 * Used by the tools/e2e probes and scenario drivers. Only Node.js built-ins are
 * used (`fetch`, `node:fs`, `node:path`); no repo or DSH package is imported.
 *
 * What it implements (verified against DeepSeek Harness 0.2.2-rc.1):
 *   - `login(url)`: exchange the launch token printed in the readiness line
 *     (`GET /?token=...`) for the signed browser cookie. The exchange answers
 *     `303 See Other` with `Location: ./` and one `Set-Cookie:
 *     dsh-auth-<hash>=v1.<payload>.<sig>; ...`; subsequent requests need that
 *     cookie in the `Cookie` header (without the attributes).
 *   - `fetchBootGraph(origin, cookie)`: read `GET /` and parse the injected
 *     `globalThis["__DSH_BOOT__"] = {...}` boot graph from the index HTML.
 *   - `rpc(origin, cookie, method, args)`: the browser-facing unary Remote
 *     bridge. `POST /api/<namespace>/<method>` with a Connection envelope
 *     `{type:"client-request",rpcId,method,payload:{args}}`; the reply is
 *     `{type:"server-response",rpcId,result:{ok:true,value}}` (or `ok:false`
 *     with an error object). `args` is the Remote parameter object and must
 *     have exactly one plain-object field per parameter (`request` for the
 *     session controller methods).
 *   - Small session helpers built on `rpc`: create/prompt/state/wait/events.
 *   - `fetchMockRequests(port, host)`: read the deterministic mock LLM request
 *     log (`GET /__mock/requests`) used for model-call accounting.
 *
 * Streaming methods (`session/follow`, `session/observeState`) need the
 * `/api/remote.mux` WebSocket and are intentionally not implemented here.
 *
 * `readState(stateDir)` reads the paths `start-web.sh` records under
 * `${DSH_E2E_ROOT}/state`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Default per-request timeout for plain HTTP/RPC calls. */
const DEFAULT_TIMEOUT_MS = 30_000
/** Monotonic suffix so every RPC envelope has a unique rpcId. */
let rpcSequence = 0

/**
 * Build a unique id for one RPC envelope / prompt request.
 * @param {string} prefix id prefix
 * @returns {string} unique id
 */
function nextRpcId(prefix) {
  rpcSequence += 1
  return `e2e-${prefix}-${process.pid}-${Date.now().toString(36)}-${rpcSequence}`
}

/**
 * Read the state files written by `tools/e2e/start-web.sh`.
 * @param {string} stateDir state directory (default `/tmp/dsh-e2e/state`)
 * @returns {{ url: string, stateDir: string, llmPort?: number }}
 *   tokenized Web URL, the state directory itself, and the mock LLM port when
 *   the harness recorded one
 */
export function readState(stateDir) {
  const read = name => {
    try {
      return readFileSync(join(stateDir, name), 'utf8').trim()
    } catch {
      return undefined
    }
  }
  const url = read('web.url')
  if (url === undefined || url === '') {
    throw new Error(`readState: ${join(stateDir, 'web.url')} not found; run tools/e2e/start-web.sh first`)
  }
  let llmPort
  const portText = read('llm.port')
  if (portText !== undefined && portText !== '') {
    llmPort = Number(portText)
    if (!Number.isInteger(llmPort) || llmPort <= 0 || llmPort > 65535) {
      throw new Error(`readState: invalid ${join(stateDir, 'llm.port')}: ${JSON.stringify(portText)}`)
    }
  }
  return { url, stateDir, llmPort }
}

/**
 * Exchange the launch token for the authenticated browser cookie.
 * @param {string} url tokenized readiness URL (`http://127.0.0.1:<port>/?token=...`)
 * @returns {Promise<{ origin: string, cookie: string }>} instance origin and the
 *   `name=value` cookie to send in the `Cookie` header
 */
export async function login(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  await response.text().catch(() => undefined)
  if (response.status !== 303 && response.status !== 302) {
    throw new Error(`login: expected the token exchange to redirect (303), got HTTP ${response.status} from ${url}`)
  }
  const setCookie = setCookies.find(value => typeof value === 'string' && value.includes('='))
  if (setCookie === undefined) {
    throw new Error(`login: the token exchange response has no usable Set-Cookie header (${url})`)
  }
  const cookie = setCookie.split(';')[0].trim()
  return { origin: new URL(url).origin, cookie }
}

/**
 * One plain HTTP request with a timeout.
 * @param {string} url absolute URL
 * @param {{ method?: string, headers?: Record<string, string>, body?: string,
 *   timeoutMs?: number, redirect?: 'follow' | 'error' | 'manual' }} [options]
 * @returns {Promise<{ status: number, body: string, headers: Record<string, string>, url: string }>}
 *   response status and text body (plus headers/final URL for diagnostics)
 */
export async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    redirect = 'manual',
  } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method, headers, body, redirect, signal: controller.signal })
    const text = await response.text()
    return {
      status: response.status,
      body: text,
      headers: Object.fromEntries(response.headers.entries()),
      url: response.url === '' ? url : response.url,
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`httpRequest: ${method} ${url} timed out after ${timeoutMs}ms`)
    }
    throw new Error(`httpRequest: ${method} ${url} failed: ${messageOf(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Call one unary Remote method through the browser-facing HTTP bridge.
 *
 * `POST /api/<namespace>/<method>` with the Connection envelope
 * `{type:"client-request",rpcId,method,payload:{args}}`; the reply is
 * `{type:"server-response",rpcId,result:{ok:true,value}}`.
 * @param {string} origin instance origin, e.g. `http://127.0.0.1:34000`
 * @param {string} cookie authenticated cookie from {@link login}
 * @param {string} method Remote method name, e.g. `session/create`
 * @param {Record<string, unknown>} args Remote argument object (named fields)
 * @param {{ timeoutMs?: number }} [options] HTTP timeout override
 * @returns {Promise<any>} `result.value` from the server response
 */
export async function rpc(origin, cookie, method, args, options = {}) {
  return rpcCall(origin, cookie, method, args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
}

/**
 * Shared implementation of one unary Remote call.
 * @param {string} origin instance origin
 * @param {string} cookie authenticated cookie
 * @param {string} method Remote method name
 * @param {Record<string, unknown>} args Remote argument object
 * @param {number} timeoutMs HTTP timeout
 * @returns {Promise<any>} `result.value` from the server response
 */
async function rpcCall(origin, cookie, method, args, timeoutMs) {
  if (typeof method !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(method)) {
    throw new Error(`rpc: invalid Remote method name: ${JSON.stringify(method)}`)
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`rpc: args for ${method} must be a plain object (got ${typeof args})`)
  }
  const rpcId = nextRpcId('rpc')
  const response = await httpRequest(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    timeoutMs,
  })
  if (response.status !== 200) {
    throw new Error(`rpc ${method} failed: HTTP ${response.status}: ${response.body.slice(0, 400)}`)
  }
  let envelope
  try {
    envelope = JSON.parse(response.body)
  } catch (error) {
    throw new Error(`rpc ${method} returned non-JSON (${messageOf(error)}): ${response.body.slice(0, 400)}`)
  }
  if (envelope?.type !== 'server-response') {
    throw new Error(`rpc ${method} returned an unexpected envelope: ${response.body.slice(0, 400)}`)
  }
  if (typeof envelope.rpcId === 'string' && envelope.rpcId !== rpcId) {
    throw new Error(`rpc ${method} answered with rpcId ${JSON.stringify(envelope.rpcId)}, expected ${JSON.stringify(rpcId)}`)
  }
  const result = envelope.result
  if (result?.ok !== true) {
    const code = typeof result?.error?.code === 'string' ? result.error.code : 'unknown'
    const message = typeof result?.error?.message === 'string' ? result.error.message : response.body.slice(0, 400)
    throw new Error(`rpc ${method} failed: ${code}: ${message}`)
  }
  return result.value
}

/**
 * Read `GET /` and parse the injected `window.__DSH_BOOT__` boot graph.
 * @param {string} origin instance origin
 * @param {string} cookie authenticated cookie
 * @returns {Promise<{ boot: any, html: string }>} parsed boot graph and the raw index HTML
 */
export async function fetchBootGraph(origin, cookie) {
  const response = await httpRequest(`${origin}/`, { headers: { cookie } })
  if (response.status !== 200) {
    throw new Error(`fetchBootGraph: GET / answered HTTP ${response.status} instead of 200 (authenticated?)`)
  }
  const marker = 'globalThis["__DSH_BOOT__"]'
  const markerIndex = response.body.indexOf(marker)
  if (markerIndex < 0) {
    throw new Error('fetchBootGraph: index HTML does not contain globalThis["__DSH_BOOT__"]')
  }
  const equalsIndex = response.body.indexOf('=', markerIndex + marker.length)
  const scriptEnd = response.body.indexOf('</script>', equalsIndex)
  if (equalsIndex < 0 || scriptEnd < 0) {
    throw new Error('fetchBootGraph: could not delimit the injected __DSH_BOOT__ script block')
  }
  let jsonText = response.body.slice(equalsIndex + 1, scriptEnd).trim()
  if (jsonText.endsWith(';')) jsonText = jsonText.slice(0, -1).trim()
  let boot
  try {
    boot = JSON.parse(jsonText)
  } catch (error) {
    throw new Error(`fetchBootGraph: injected __DSH_BOOT__ is not valid JSON (${messageOf(error)})`)
  }
  return { boot, html: response.body }
}

/**
 * Create a Session through `session/create`.
 * @param {string} origin instance origin
 * @param {string} cookie authenticated cookie
 * @param {{ cwd?: string, workspaceId?: string, sessionId?: string, agentPreset?: string }} [request]
 * @returns {Promise<{ sessionId: string, agentPreset?: string }>} created Session
 */
export async function createSession(origin, cookie, request = {}) {
  const args = {}
  for (const key of ['cwd', 'workspaceId', 'sessionId', 'agentPreset']) {
    if (request[key] !== undefined) args[key] = request[key]
  }
  return rpc(origin, cookie, 'session/create', { request: args })
}

/**
 * Read the durable state cursor of one Session (`session/state`).
 * @param {string} origin instance origin
 * @param {string} cookie authenticated cookie
 * @param {string} sessionId Session id
 * @returns {Promise<{ cursor: number } & Record<string, unknown>>} Session state
 */
export async function readSessionState(origin, cookie, sessionId) {
  return rpc(origin, cookie, 'session/state', { request: { sessionId } })
}

/**
 * Queue one user prompt into a Session (`session/prompt`).
 * @param {string} origin instance origin
 * @param {string} cookie authenticated cookie
 * @param {{ sessionId: string, text: string, mode?: 'queue' | 'steer' }} request
 * @returns {Promise<{ accepted: boolean }>} acceptance result
 */
export async function promptSession(origin, cookie, request) {
  if (typeof request?.sessionId !== 'string' || typeof request?.text !== 'string') {
    throw new Error('promptSession: sessionId and text are required')
  }
  const prompt = {
    requestId: nextRpcId('prompt'),
    sessionId: request.sessionId,
    mode: request.mode ?? 'queue',
    content: [{ type: 'text', text: request.text }],
  }
  return rpc(origin, cookie, 'session/prompt', { request: prompt })
}

/**
 * Wait until the Session settles (`session/wait`).
 * @param {string} origin instance origin
 * @param {string} cookie authenticated cookie
 * @param {{ sessionId: string, afterSeq?: number, timeoutMs?: number }} request
 * @returns {Promise<{ reason: string, state?: { cursor: number }, output?: { records: any[] } }>}
 *   wait reason (`idle` / `input-required` / `timeout`) and the committed records
 */
export async function waitSession(origin, cookie, request) {
  const args = { sessionId: request?.sessionId }
  if (typeof args.sessionId !== 'string') throw new Error('waitSession: sessionId is required')
  if (request.afterSeq !== undefined) args.afterSeq = request.afterSeq
  if (request.timeoutMs !== undefined) args.timeoutMs = request.timeoutMs
  // The HTTP call must outlive the server-side wait bound.
  const httpTimeoutMs = Math.max(DEFAULT_TIMEOUT_MS, (request.timeoutMs ?? 60_000) + 15_000)
  return rpc(origin, cookie, 'session/wait', { request: args }, { timeoutMs: httpTimeoutMs })
}

/**
 * Read one page of the durable Session log (`session/events`).
 * @param {string} origin instance origin
 * @param {string} cookie authenticated cookie
 * @param {string} sessionId Session id
 * @param {{ throughSeq?: number, maxMessages?: number }} [request]
 * @returns {Promise<{ cursor: number, records: any[], hasMore: boolean }>} event page
 */
export async function readEvents(origin, cookie, sessionId, request = {}) {
  const args = { address: { kind: 'session', sessionId } }
  if (request.throughSeq !== undefined) args.throughSeq = request.throughSeq
  if (request.maxMessages !== undefined) args.maxMessages = request.maxMessages
  return rpc(origin, cookie, 'session/events', { request: args })
}

/**
 * Read the deterministic mock LLM request log.
 * @param {number} port mock LLM port (`state/llm.port`)
 * @param {string} [host] mock LLM host (default `127.0.0.1`)
 * @returns {Promise<{ requests: any[] }>} logged model requests, in order
 */
export async function fetchMockRequests(port, host = '127.0.0.1') {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`fetchMockRequests: invalid mock LLM port: ${JSON.stringify(port)}`)
  }
  const response = await httpRequest(`http://${host}:${port}/__mock/requests`, { timeoutMs: 10_000 })
  if (response.status !== 200) {
    throw new Error(`fetchMockRequests: GET /__mock/requests answered HTTP ${response.status}`)
  }
  const parsed = JSON.parse(response.body)
  // mock-llm.mjs answers `{requests:[...]}`; accept a bare array too so the
  // helper keeps working if the mock surface changes shape.
  if (Array.isArray(parsed)) return { requests: parsed }
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.requests)) {
    return { requests: parsed.requests }
  }
  throw new Error('fetchMockRequests: /__mock/requests did not return a request log')
}

/**
 * Render an unknown thrown value as a message.
 * @param {unknown} error thrown value
 * @returns {string} message text
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
