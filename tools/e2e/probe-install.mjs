#!/usr/bin/env node
/**
 * Installed-profile proof for the infini-goal suite (user-facing install path).
 *
 * probe-install.sh boots an isolated profile whose `dsh.profile.bundles` list
 * contains `@yankeguo/dsh-infini-goal-bundle` and whose plugin packages are
 * symlinked into the profile's own node_modules by
 * `scripts/install-profile.mjs` — no `--patch` overlays. This script proves the
 * installed composition over the browser-facing Web API:
 *
 *   1. `commands/list` on a real Session advertises the `/infini-goal` command
 *      (command plugin row active),
 *   2. `commands/execute` `/infini-goal <objective>` creates the goal (proves
 *      the real host command path), `/infini-goal status` renders the live
 *      status, `/infini-goal pause` changes the phase,
 *   3. the driver row is active: an automatic `user/message` round with
 *      `source.kind === 'infini-goal'` appears after the goal is created,
 *   4. the control plugin (added as a plain patch overlay for observability)
 *      reports the same goal from `ctx.infiniGoals`.
 *
 * Usage: node probe-install.mjs --state-dir <dir> --workspace <dir> [--json]
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
  rpc,
  waitSession,
} from './lib/web-client.mjs'

const { values } = parseArgs({
  options: {
    'state-dir': { type: 'string', default: '/tmp/dsh-e2e/state' },
    workspace: { type: 'string', default: '/tmp/dsh-e2e/workspace' },
    objective: { type: 'string', default: 'Install-mode objective via host command' },
    json: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

const state = readState(values['state-dir'])
const { origin, cookie } = await login(state.url)
const failures = []
const evidence = { steps: [] }

function check(name, ok, detail) {
  evidence.steps.push({ name, ok, detail })
  if (!ok) failures.push({ name, detail })
  if (!values.json) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

async function control(path) {
  const response = await httpRequest(`${origin}${path}`, { timeoutMs: 20_000 })
  const parsed = JSON.parse(response.body)
  if (response.status !== 200 || parsed?.ok !== true) throw new Error(`control ${path} failed: ${parsed?.message ?? response.body.slice(0, 300)}`)
  return parsed
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

function roundStarts(records) {
  return records
    .filter(record => record?.event?.type === 'user/message' && record.event.data?.source?.kind === 'infini-goal')
    .map(record => ({ round: record.event.data.source.round, time: record.event.time, seq: record.event.seq }))
}

/* ---------------------------------------------------- command catalogue -- */

const created = await createSession(origin, cookie, { cwd: values.workspace })
const sessionId = created.sessionId

const commands = await rpc(origin, cookie, 'commands/list', { agentId: sessionId })
const commandNames = Array.isArray(commands) ? commands.map(entry => entry?.name).filter(name => typeof name === 'string') : []
const infiniCommand = Array.isArray(commands) ? commands.find(entry => entry?.name === 'infini-goal') : undefined
check('commands/list advertises /infini-goal', infiniCommand !== undefined, {
  name: infiniCommand?.name,
  description: infiniCommand?.description?.slice(0, 120),
  inputHint: infiniCommand?.input?.hint?.slice(0, 160),
  commandCount: commandNames.length,
})

/* -------------------------------------------------- command execution --- */

async function execute(line) {
  return rpc(origin, cookie, 'commands/execute', {
    agentId: sessionId,
    line,
    submittedAttachments: [],
  })
}

const createdExecution = await execute(`/infini-goal ${values.objective}`)
check('commands/execute creates the goal', createdExecution?.result?.kind === 'success',
  createdExecution?.result?.text?.slice(0, 400) ?? JSON.stringify(createdExecution).slice(0, 400))
check('create output renders the active status', String(createdExecution?.result?.text ?? '').includes('Status: active'),
  createdExecution?.result?.text?.slice(0, 200))

const statusExecution = await execute('/infini-goal status')
check('commands/execute /infini-goal status succeeds', statusExecution?.result?.kind === 'success',
  statusExecution?.result?.text?.slice(0, 400))
check('status output reports the objective and a round counter',
  String(statusExecution?.result?.text ?? '').includes(values.objective) && String(statusExecution?.result?.text ?? '').includes('Rounds started:'),
  statusExecution?.result?.text?.slice(0, 400))

/* --------------------------------------------------------- driver row --- */

const before = await readSessionState(origin, cookie, sessionId)
let rounds = []
const deadline = Date.now() + 15_000
while (Date.now() < deadline) {
  const page = await readEvents(origin, cookie, sessionId, { throughSeq: (await readSessionState(origin, cookie, sessionId)).cursor })
  rounds = roundStarts(page.records)
  if (rounds.length > 0) break
  await sleep(250)
}
check('installed driver starts an automatic round', rounds.length > 0, rounds.slice(0, 2))
// Let the round's turn settle so the pause below lands on a quiescent agent.
if (rounds.length > 0) {
  await waitSession(origin, cookie, { sessionId, afterSeq: before.cursor, timeoutMs: 30_000 }).catch(() => undefined)
}

const pauseExecution = await execute('/infini-goal pause')
check('commands/execute /infini-goal pause succeeds', pauseExecution?.result?.kind === 'success',
  pauseExecution?.result?.text?.slice(0, 300))
check('pause output reports the paused phase', String(pauseExecution?.result?.text ?? '').includes('Status: paused'),
  pauseExecution?.result?.text?.slice(0, 200))

const pausedStatus = await control(`/e2e-infini/status?sessionId=${encodeURIComponent(sessionId)}`)
check('ctx.infiniGoals phase is paused after the command', pausedStatus.view?.phase === 'paused', {
  phase: pausedStatus.view?.phase,
  objective: pausedStatus.view?.objective,
  roundsStarted: pausedStatus.view?.roundsStarted,
})
check('the command and the control plugin observe the same objective', pausedStatus.view?.objective === values.objective)

// Tool row: the installed composition's automatic round already ran one model
// turn; its request/header event must advertise the three infini-goal tools.
const stateAfter = await readSessionState(origin, cookie, sessionId)
const latestPage = await readEvents(origin, cookie, sessionId, { throughSeq: stateAfter.cursor })
const advertisedTools = requestHeaderToolNames(latestPage.records)
for (const tool of ['get_infini_goal', 'create_infini_goal', 'update_infini_goal']) {
  check(`installed tool row advertises ${tool}`, advertisedTools.includes(tool),
    `advertised: ${advertisedTools.join(',') || 'none'}`)
}

// Leave the installed goal paused (safe); resume is exercised by suite scenarios.
const report = {
  ok: failures.length === 0,
  origin,
  sessionId,
  commandCount: commandNames.length,
  infiniCommand,
  createdText: createdExecution?.result?.text,
  statusText: statusExecution?.result?.text,
  rounds,
  pausedView: pausedStatus.view,
  steps: evidence.steps,
  failures,
}

if (values.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('')
  if (failures.length > 0) {
    console.log('PROBE INSTALL FAIL')
    for (const failure of failures) console.log(`  - ${failure.name}: ${typeof failure.detail === 'string' ? failure.detail : JSON.stringify(failure.detail)}`)
  } else {
    console.log('PROBE INSTALL PASS')
  }
}
process.exit(failures.length === 0 ? 0 : 1)
