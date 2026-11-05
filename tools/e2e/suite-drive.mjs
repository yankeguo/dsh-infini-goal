#!/usr/bin/env node
/**
 * Scenario driver for the real infini-goal plugin suite E2E.
 *
 * Boots nothing itself: it talks to an isolated instance started by suite.sh
 * whose composition contains the suite's host packages plus the E2E control
 * plugin (`fixtures/e2e-control-plugin`). It creates Sessions through the normal
 * browser-facing Web API, then drives goals through the control plugin's
 * dependency-free HTTP surface, and observes automatic rounds in the durable
 * Session log (`user/message` events whose `source.kind` is `infini-goal`).
 *
 * Scenarios (see tools/e2e/README.md):
 *   1. automatic pacing — active goal + minIntervalMs=2000 produces rounds
 *      1,2,3 with consecutive round-start events at least ~2000 ms apart.
 *   2. quiet window — a window covering "now" suppresses automatic rounds;
 *      after the window ends the next round starts promptly.
 *   3. paused goal — a paused goal produces no automatic rounds for ~5 s.
 *
 * Usage:
 *   node suite-drive.mjs --state-dir /tmp/dsh-e2e/state --workspace /tmp/dsh-e2e/workspace
 * Optional: --only scenario1,scenario2 --json --timeout-ms 90000
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import {
  createSession,
  httpRequest,
  login,
  readEvents,
  readSessionState,
  readState,
} from './lib/web-client.mjs'

const { values } = parseArgs({
  options: {
    'state-dir': { type: 'string', default: '/tmp/dsh-e2e/state' },
    workspace: { type: 'string', default: '/tmp/dsh-e2e/workspace' },
    only: { type: 'string' },
    'timeout-ms': { type: 'string', default: '90000' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log(`suite-drive.mjs — drive infini-goal suite scenarios through the isolated Web instance

Options:
  --state-dir <dir>    start-web.sh state directory (default /tmp/dsh-e2e/state)
  --workspace <dir>    working directory for created Sessions
  --only <a,b>         run only these scenarios (scenario1,scenario2,scenario3)
  --timeout-ms <n>     per-wait bound (default 90000)
  --json               machine-readable report
`)
  process.exit(0)
}

const state = readState(values['state-dir'])
const { origin, cookie } = await login(state.url)
const TIMEOUT_MS = Number(values['timeout-ms'])
const only = values.only === undefined ? undefined : new Set(values.only.split(',').map(part => part.trim()))

/* ---------------------------------------------------------------- HTTP -- */

/** Call the E2E control plugin. */
async function control(method, path, body) {
  const response = await httpRequest(`${origin}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 30_000,
  })
  let parsed
  try {
    parsed = JSON.parse(response.body)
  } catch {
    throw new Error(`control ${method} ${path} returned non-JSON HTTP ${response.status}: ${response.body.slice(0, 400)}`)
  }
  if (response.status !== 200 || parsed?.ok !== true) {
    throw new Error(`control ${method} ${path} failed HTTP ${response.status}: ${parsed?.code ?? ''} ${parsed?.message ?? response.body.slice(0, 400)}`)
  }
  return parsed
}

/* ------------------------------------------------------------- helpers -- */

/** Wait until the live Agent for a Session is registered (create makes it live). */
async function waitForAgent(sessionId) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const health = await control('GET', '/e2e-infini/health')
    if (health.agents.some(agent => agent.id === sessionId)) return
    await sleep(100)
  }
  throw new Error(`Session ${sessionId} never produced a live Agent`)
}

/** New Session in the isolated instance. */
async function newSession(label) {
  const created = await createSession(origin, cookie, { cwd: values.workspace })
  await waitForAgent(created.sessionId)
  return created.sessionId
}

/**
 * Read the durable log and return automatic infini-goal round-start messages
 * in order: `{ round, time, seq, goalId }`.
 */
async function roundStarts(sessionId) {
  const current = await readSessionState(origin, cookie, sessionId)
  const page = await readEvents(origin, cookie, sessionId, { throughSeq: current.cursor })
  const rounds = []
  for (const record of page.records) {
    const event = record?.event
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'infini-goal') continue
    rounds.push({ round: source.round, time: event.time, seq: event.seq, goalId: source.goalId })
  }
  return rounds
}

/** Poll `roundStarts` until the predicate holds. */
async function waitForRounds(sessionId, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let latest = []
  while (Date.now() < deadline) {
    latest = await roundStarts(sessionId)
    if (predicate(latest)) return latest
    await sleep(200)
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms (rounds observed: ${latest.map(entry => entry.round).join(',') || 'none'})`)
}

/** Poll status until the predicate holds, returning the last status read. */
async function waitForStatus(sessionId, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await control('GET', `/e2e-infini/status?sessionId=${encodeURIComponent(sessionId)}`)
    if (predicate(latest)) return latest
    await sleep(250)
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms; last status: ${JSON.stringify(latest)}`)
}

/** Format an instant as local `HH:mm` in a zone (quiet-window grammar). */
function formatHourMinute(epochMs, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs))
}

/** Round-start gap assertions shared by the pacing scenario. */
function checkSpacing(rounds, minimumMs, toleranceMs) {
  const failures = []
  for (let index = 1; index < rounds.length; index += 1) {
    const gap = rounds[index].time - rounds[index - 1].time
    if (gap < minimumMs - toleranceMs) {
      failures.push(`round ${rounds[index].round} started ${gap}ms after round ${rounds[index - 1].round} (minimum ${minimumMs}ms)`)
    }
  }
  return failures
}

/* ------------------------------------------------------------- runner -- */

const results = []
let failed = false

/** Record one scenario result and print its human summary. */
function record(name, ok, details, failures = []) {
  results.push({ name, ok, details, failures })
  if (!ok) failed = true
  if (!values.json) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
    for (const [key, value] of Object.entries(details)) console.log(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    for (const failure of failures) console.log(`  - ${failure}`)
  }
}

/** Scenario 1: active goal drives paced automatic rounds. */
async function scenario1() {
  const sessionId = await newSession('scenario1')
  const created = await control('POST', '/e2e-infini/create', {
    sessionId,
    objective: 'E2E scenario 1: keep making progress without a round limit',
    minIntervalMs: 2000,
  })
  const rounds = await waitForRounds(sessionId, entries => entries.length >= 3, 25_000, 'scenario1 rounds')
  const status = await control('GET', `/e2e-infini/status?sessionId=${encodeURIComponent(sessionId)}`)
  const failures = checkSpacing(rounds.slice(0, 3), 2000, 50)
  if (![1, 2, 3].every(round => rounds.some(entry => entry.round === round))) {
    failures.push(`expected rounds 1,2,3; observed ${rounds.map(entry => entry.round).join(',')}`)
  }
  if (!(status.view?.roundsStarted >= 3)) failures.push(`view.roundsStarted=${status.view?.roundsStarted} (expected >= 3)`)
  if (created.view?.phase !== 'active') failures.push(`created goal phase=${created.view?.phase} (expected active)`)
  record('scenario1 automatic rounds respect minIntervalMs', failures.length === 0, {
    sessionId,
    roundStarts: rounds.slice(0, 3).map(entry => ({ round: entry.round, at: new Date(entry.time).toISOString(), seq: entry.seq })),
    gapsMs: rounds.slice(1, 3).map((entry, index) => entry.time - rounds[index].time),
    roundsStarted: status.view?.roundsStarted,
    plan: status.plan,
  }, failures)
}

/** Scenario 2: a quiet window suppresses rounds until it ends. */
async function scenario2() {
  const sessionId = await newSession('scenario2')
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = Date.now()
  const start = formatHourMinute(now - 2 * 60_000, timeZone)
  // Ceil to the next local minute, with at least 8 s of window left so the
  // "suppressed" observation is meaningful; skip whole minutes otherwise.
  let endEpoch = Math.ceil((now + 1) / 60_000) * 60_000
  while (endEpoch - now < 8_000) endEpoch += 60_000
  const end = formatHourMinute(endEpoch, timeZone)
  const created = await control('POST', '/e2e-infini/create', {
    sessionId,
    objective: 'E2E scenario 2: wait while the quiet window is active',
    minIntervalMs: 1000,
    quietWindows: [{ days: [], start, end }],
    timezone: timeZone,
  })
  const duringWindow = await control('GET', `/e2e-infini/status?sessionId=${encodeURIComponent(sessionId)}`)
  const failures = []
  if (duringWindow.plan?.quietUntil === null || duringWindow.plan?.quietUntil === undefined) {
    failures.push(`plan.quietUntil is ${JSON.stringify(duringWindow.plan?.quietUntil)}; expected the active window's end`)
  }
  if (duringWindow.plan?.reason !== 'quiet-window') {
    failures.push(`plan.reason=${JSON.stringify(duringWindow.plan?.reason)}; expected "quiet-window"`)
  }
  const before = (await roundStarts(sessionId)).length
  await sleep(3000)
  const during = (await roundStarts(sessionId)).length
  if (during !== before) failures.push(`rounds advanced during the quiet window (${before} -> ${during})`)

  const quietUntil = duringWindow.plan?.quietUntil
  const quietEndStatus = quietUntil === undefined
    ? duringWindow
    : await waitForStatus(sessionId, status => status.plan?.quietUntil === null, 90_000, 'scenario2 quiet end')
  const quietEndedAt = Date.now()
  const roundsAfter = await waitForRounds(sessionId, entries => entries.length > during, 15_000, 'scenario2 round after quiet')
  const firstAfter = roundsAfter[during] ?? roundsAfter[roundsAfter.length - 1]
  const delayAfterQuiet = firstAfter.time - (quietEndStatus.plan?.now ?? quietEndedAt)
  if (delayAfterQuiet > 10_000) failures.push(`first round after the quiet window started ${delayAfterQuiet}ms after it ended (expected <= 10000ms)`)
  record('scenario2 quiet window suppresses then releases rounds', failures.length === 0, {
    sessionId,
    window: { start, end, timeZone, quietUntil: quietUntil === undefined ? null : new Date(quietUntil).toISOString() },
    roundsDuringWindow: during - before,
    firstRoundAfterQuiet: new Date(firstAfter.time).toISOString(),
    delayAfterQuietMs: delayAfterQuiet,
    createdPhase: created.view?.phase,
  }, failures)
}

/** Scenario 3: a paused goal produces no automatic rounds. */
async function scenario3() {
  const sessionId = await newSession('scenario3')
  await control('POST', '/e2e-infini/create', {
    sessionId,
    objective: 'E2E scenario 3: pause stops automatic continuation',
    minIntervalMs: 1000,
  })
  // Let automatic continuation prove it is running, then pause it.
  await waitForRounds(sessionId, entries => entries.length >= 1, 15_000, 'scenario3 first round')
  const paused = await control('POST', '/e2e-infini/pause', { sessionId })
  const failures = []
  if (paused.view?.phase !== 'paused') failures.push(`paused phase=${paused.view?.phase} (expected paused)`)
  await sleep(500)
  const before = (await roundStarts(sessionId)).length
  await sleep(5000)
  const after = (await roundStarts(sessionId)).length
  if (after !== before) failures.push(`rounds advanced while paused (${before} -> ${after})`)
  const status = await control('GET', `/e2e-infini/status?sessionId=${encodeURIComponent(sessionId)}`)
  record('scenario3 paused goal produces no automatic rounds', failures.length === 0, {
    sessionId,
    pausedAt: new Date().toISOString(),
    roundsBeforeWait: before,
    roundsAfterWait: after,
    view: status.view === null ? null : { phase: status.view.phase, roundsStarted: status.view.roundsStarted },
  }, failures)
}

/* ----------------------------------------------------------------- main -- */

const scenarios = [
  ['scenario1', scenario1],
  ['scenario2', scenario2],
  ['scenario3', scenario3],
]

for (const [name, run] of scenarios) {
  if (only !== undefined && !only.has(name)) continue
  try {
    await run()
  } catch (error) {
    record(name, false, {}, [error instanceof Error ? error.message : String(error)])
  }
}

if (values.json) {
  console.log(JSON.stringify({ ok: !failed, scenarios: results }, null, 2))
} else {
  console.log('')
  console.log(failed ? 'SUITE SCENARIOS FAIL' : 'SUITE SCENARIOS PASS')
}
process.exit(failed ? 1 : 0)
