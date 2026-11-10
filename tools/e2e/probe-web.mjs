#!/usr/bin/env node
/**
 * Probe the isolated DSH Web instance without a browser.
 *
 *   node probe-web.mjs --state-dir /tmp/dsh-e2e/state \
 *     --assert-client-entry e2e-trivial-plugin \
 *     --assert-client-bundle e2e-trivial-plugin \
 *     --assert-no-client-entry @deepseek-ai/dsh-client-ui-goal \
 *     --assert-host-route /e2e-trivial/health
 *
 * Checks performed:
 *   - the launch-token exchange yields the browser cookie (authentication works),
 *   - `GET /` serves the HTML with `window.__DSH_BOOT__` injected,
 *   - the composed boot graph contains (or not) a client entry,
 *   - the entry's bundle URL serves JavaScript registering that package,
 *   - an arbitrary host route answers 200.
 *
 * Exit code 0 when every requested assertion passes, 1 otherwise.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  fetchBootGraph,
  httpRequest,
  login,
  readState,
} from './lib/web-client.mjs'

const { values } = parseArgs({
  options: {
    'state-dir': { type: 'string', default: '/tmp/dsh-e2e/state' },
    'assert-client-entry': { type: 'string', multiple: true, default: [] },
    'assert-client-bundle': { type: 'string', multiple: true, default: [] },
    'assert-no-client-entry': { type: 'string', multiple: true, default: [] },
    'assert-host-route': { type: 'string', multiple: true, default: [] },
    'print-entries': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log(`probe-web.mjs — inspect the boot graph of the isolated DSH Web instance

Options:
  --state-dir <dir>               start-web.sh state directory (default /tmp/dsh-e2e/state)
  --assert-client-entry <id>      fail unless window.__DSH_BOOT__.entries has this package id (repeatable)
  --assert-client-bundle <id>     fail unless the entry's served bundle registers the package (repeatable)
  --assert-no-client-entry <id>   fail when window.__DSH_BOOT__.entries has this package id (repeatable)
  --assert-host-route <path>      fail unless GET <origin><path> answers 200 (repeatable)
  --print-entries                 print every boot graph entry
  --json                          machine-readable report
`)
  process.exit(0)
}

const state = readState(values['state-dir'])
const { origin, cookie } = await login(state.url)
const { boot } = await fetchBootGraph(origin, cookie)

const entries = Array.isArray(boot.entries) ? boot.entries : []
const byId = new Map(entries.map(entry => [entry.id, entry]))
const checks = []
let failed = false

function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  if (!ok) failed = true
  if (!values.json) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

check('boot-graph rev present', typeof boot.rev === 'string' && boot.rev.length > 0, `rev=${boot.rev}`)
check('boot-graph has entries', entries.length > 0, `${entries.length} entries, ${Array.isArray(boot.batches) ? boot.batches.length : 0} batches`)

for (const id of values['assert-client-entry']) {
  const entry = byId.get(id)
  check(`client entry ${id}`, entry !== undefined, entry === undefined ? 'missing from window.__DSH_BOOT__.entries' : `url=${entry.url} rev=${entry.rev}`)
}

for (const id of values['assert-no-client-entry']) {
  const entry = byId.get(id)
  check(`client entry absent ${id}`, entry === undefined,
    entry === undefined ? 'not in window.__DSH_BOOT__.entries' : `unexpected entry: url=${entry.url}`)
}

for (const id of values['assert-client-bundle']) {
  const entry = byId.get(id)
  if (entry === undefined) {
    check(`client bundle ${id}`, false, 'entry missing from boot graph')
    continue
  }
  // Boot entry URLs are document-relative (`plugins/??<pkg>/client.js&rev=...`).
  const bundleUrl = new URL(entry.url, `${origin}/`).href
  const response = await httpRequest(bundleUrl, { headers: { cookie } })
  const looksLikeBundle = response.status === 200
    && response.body.includes('__ModuleLoader__.load')
    && response.body.includes(id)
  check(`client bundle ${id}`, looksLikeBundle, `HTTP ${response.status}, ${response.body.length} bytes from ${bundleUrl}`)
}

for (const path of values['assert-host-route']) {
  const route = path.startsWith('/') ? path : `/${path}`
  const response = await httpRequest(`${origin}${route}`, { headers: { cookie } })
  let detail = `HTTP ${response.status}`
  try {
    detail += ` ${response.body.slice(0, 200)}`
  } catch {
    /* body already text */
  }
  check(`host route GET ${route}`, response.status === 200, detail)
}

// The host fixture plugin logs a marker line on startup; record it as evidence
// even though the health route is the authoritative check.
try {
  const hostLog = readFileSync(`${state.stateDir}/../logs/web.log`, 'utf8')
  const marker = /\[e2e-trivial-plugin\] host-half loaded[^\n]*/.exec(hostLog)
  if (marker) check('host plugin log marker', true, marker[0].slice(0, 160))
} catch {
  /* optional evidence */
}

if (values['print-entries'] && !values.json) {
  console.log(`\nwindow.__DSH_BOOT__ entries (${entries.length}):`)
  for (const entry of entries) {
    const flags = [
      entry.immediately ? 'immediately' : undefined,
      Array.isArray(entry.inject) && entry.inject.length > 0 ? `inject=[${entry.inject.join(',')}]` : undefined,
    ].filter(Boolean).join(' ')
    console.log(`  ${entry.id}  rev=${entry.rev}${flags === '' ? '' : `  ${flags}`}`)
  }
}

if (values.json) {
  console.log(JSON.stringify({
    ok: !failed,
    origin,
    rev: boot.rev,
    release: boot.release,
    entryCount: entries.length,
    entries: values['print-entries'] ? entries.map(entry => entry.id) : undefined,
    checks,
  }, null, 2))
}

process.exit(failed ? 1 : 0)
