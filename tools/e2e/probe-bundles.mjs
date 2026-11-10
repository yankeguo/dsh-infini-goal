#!/usr/bin/env node
/**
 * Composition assertions for `probe-bundles.sh` (bundle-packaging regression).
 *
 * The regression under test: installing `@yankeguo/dsh-infini-goal-bundle`
 * ALONE must switch DSH's built-in `dsh-goal` mode off by default, because the
 * bundle manifest declares `dsh.bundle.patch` as an ordered list whose second
 * file (`cordis.disable-goal.patch.yml`) is generated with the same rows as the
 * legacy companion bundle `@yankeguo/dsh-disable-goal-bundle`.
 *
 * This helper does the non-runtime half of the proof over files:
 *
 *   --phase a  the scratch profile produced by `scripts/install-profile.mjs`
 *              (main bundle selected, companion deselected) and the boot-free
 *              `dsh --dump-config` composition: expected rows mounted, built-in
 *              goal rows disabled, no duplicate top-level row ids;
 *   --phase b  the pre-change upgrade path: the legacy companion bundle put
 *              back immediately before the main bundle; same runtime behavior
 *              and exactly 2 tolerated rows for each `preset-*-filter` id;
 *   --edit-add-legacy-companion
 *              mutate the scratch profile manifest into the phase-B shape.
 *
 * `probe-bundles.sh` owns the isolated home, boots the Web instances and runs
 * the runtime probes; this helper only reads/rewrites files under the scratch
 * DSH home and prints PASS/FAIL lines.
 *
 * Usage:
 *   node probe-bundles.mjs --phase a --profile-dir <dir> --repo-root <dir> --dump <file>
 *   node probe-bundles.mjs --phase b --profile-dir <dir> --dump <file>
 *   node probe-bundles.mjs --edit-add-legacy-companion --profile-dir <dir>
 *   node probe-bundles.mjs --phase a --profile-dir <dir> --repo-root <dir> --dump <file> --json
 *
 * Exit code 0 when every check passes, 1 otherwise (edit mode: 0 on success).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

/** Main bundle package name (embeds the disable layer). */
const MAIN_BUNDLE = '@yankeguo/dsh-infini-goal-bundle'
/** Legacy standalone companion bundle package name (same rows, same ids). */
const COMPANION_BUNDLE = '@yankeguo/dsh-disable-goal-bundle'
/** The main bundle's declared patch files, in application order. */
const MAIN_PATCH_FILES = ['./cordis.patch.yml', './cordis.disable-goal.patch.yml']
/** Rows mounted by the main bundle layer. */
const INFINI_ROWS = ['infini-goal', 'infini-goal-driver', 'infini-goal-tool', 'infini-goal-command', 'infini-goal-ui']
/** Rows inserted by the disable layer, one per shipped preset. */
const FILTER_ROWS = ['preset-standard-filter', 'preset-ptc-filter', 'preset-cordis-filter']
/** Shipped rows the disable layer must switch off. */
const DISABLED_ROWS = ['goal-round-driver', 'ui-goal', 'preset-standard', 'preset-ptc', 'preset-cordis']
/** Name every filter row must mount (the companion package's runtime module). */
const FILTER_MODULE = '@yankeguo/dsh-disable-goal-bundle/preset-filter'

const { values } = parseArgs({
  options: {
    phase: { type: 'string' },
    'profile-dir': { type: 'string' },
    'repo-root': { type: 'string', default: '' },
    dump: { type: 'string' },
    'edit-add-legacy-companion': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log(`probe-bundles.mjs — composition assertions for tools/e2e/probe-bundles.sh

Options:
  --phase a|b                       assertion group (see the header comment)
  --profile-dir <dir>               scratch profile directory (honors --phase)
  --repo-root <dir>                 repository root (phase a: bundle manifest check)
  --dump <file>                     saved output of \`dsh <profile> --dump-config\`
  --edit-add-legacy-companion       put the companion bundle immediately before the main one
  --json                            machine-readable report
`)
  process.exit(0)
}

const checks = []
let failures = 0

/**
 * Record one PASS/FAIL assertion.
 * @param name - the assertion reported to the user.
 * @param ok - whether it passed.
 * @param detail - optional extra evidence (string or JSON-able value).
 */
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  if (!ok) failures += 1
  if (!values.json) {
    const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`)
  }
}

/** Print one informational line that never affects the exit code. */
function note(message) {
  if (!values.json) console.log(`NOTE ${message}`)
}

/**
 * Read and parse a JSON file.
 * @param path - absolute file path.
 * @returns the parsed value.
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** One top-level row of a `--dump-config` document. */
/**
 * Parse the top-level Loader rows of a `--dump-config` YAML document.
 *
 * The dump is a YAML list where every top-level row starts at column 0 with
 * `- id: <id>`; row properties are indented by exactly two spaces. Nested
 * rows (for example a preset's `plugins:` list) are indented deeper, so they
 * never match. This avoids taking a YAML dependency in the harness.
 * @param text - `dsh --dump-config` output.
 * @returns `{ id, name, disabled }` per top-level row, in document order.
 */
function parseTopLevelRows(text) {
  const rows = []
  let current
  for (const line of text.split('\n')) {
    const idMatch = /^- id: (.+)$/u.exec(line)
    if (idMatch !== null) {
      current = { id: idMatch[1].trim(), name: undefined, disabled: false }
      rows.push(current)
      continue
    }
    if (current === undefined) continue
    const nameMatch = /^  name: (.+)$/u.exec(line)
    if (nameMatch !== null) {
      current.name = nameMatch[1].trim().replace(/^'(.*)'$/u, '$1').replace(/^"(.*)"$/u, '$1')
      continue
    }
    if (line === '  disabled: true') current.disabled = true
  }
  return rows
}

/**
 * Read a profile's `dsh.profile.bundles` list.
 * @param profileDir - profile directory containing package.json.
 * @returns the selected bundle package names, or an empty list.
 */
function readProfileBundles(profileDir) {
  const manifest = readJson(join(profileDir, 'package.json'))
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles : []
}

/** Split rows into id counts, preserving nothing but counts. */
function countIds(rows) {
  const counts = new Map()
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  return counts
}

/** Assert one row is present exactly `want` times and report the actual count. */
function checkRowCount(rows, id, want) {
  const count = rows.filter(row => row.id === id).length
  check(`dump-config composes ${want} row${want === 1 ? '' : 's'} for ${id}`, count === want, `rows=${count}`)
}

/** Assert every listed row is disabled, using one PASS line per row. */
function checkDisabled(rows, ids) {
  const disabled = new Set(rows.filter(row => row.disabled).map(row => row.id))
  for (const id of ids) {
    check(`dump-config disables ${id}`, disabled.has(id), disabled.has(id) ? 'disabled: true' : 'row missing or still enabled')
  }
}

/**
 * Phase-A boot-free composition checks.
 * @param dump - saved `--dump-config` output.
 */
function checkDumpPhaseA(dump) {
  const rows = parseTopLevelRows(dump)
  const counts = countIds(rows)
  const duplicateIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort()
  check('dump-config has top-level rows', rows.length > 0, `rows=${rows.length}`)
  check('dump-config top-level row ids are unique', duplicateIds.length === 0,
    duplicateIds.length === 0 ? `ids=${counts.size}` : `duplicates: ${duplicateIds.join(', ')}`)
  for (const id of [...INFINI_ROWS, ...FILTER_ROWS]) checkRowCount(rows, id, 1)
  checkDisabled(rows, DISABLED_ROWS)
  const filterNames = rows.filter(row => FILTER_ROWS.includes(row.id)).map(row => row.name)
  check('every preset filter row mounts the companion preset-filter module',
    filterNames.length === FILTER_ROWS.length && filterNames.every(name => name === FILTER_MODULE),
    filterNames)
}

/**
 * Phase-B boot-free composition checks (both bundles enabled).
 * @param dump - saved `--dump-config` output.
 */
function checkDumpPhaseB(dump) {
  const rows = parseTopLevelRows(dump)
  const counts = countIds(rows)
  check('dump-config has top-level rows', rows.length > 0, `rows=${rows.length}`)
  for (const id of INFINI_ROWS) checkRowCount(rows, id, 1)
  for (const id of FILTER_ROWS) checkRowCount(rows, id, 2)
  const duplicateIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort()
  check('duplicate ids are limited to the three preset filter rows',
    duplicateIds.length === FILTER_ROWS.length && FILTER_ROWS.every(id => duplicateIds.includes(id)),
    duplicateIds.length === 0 ? 'no duplicates' : duplicateIds.join(', '))
  for (const id of [...FILTER_ROWS, ...INFINI_ROWS]) {
    const count = counts.get(id) ?? 0
    if (count > 1 && !FILTER_ROWS.includes(id)) check(`unexpected duplicate row ${id}`, false, `rows=${count}`)
  }
  checkDisabled(rows, DISABLED_ROWS)
  const filterNames = rows.filter(row => FILTER_ROWS.includes(row.id)).map(row => row.name)
  check('every composed preset filter row mounts the companion preset-filter module',
    filterNames.length === FILTER_ROWS.length * 2 && filterNames.every(name => name === FILTER_MODULE),
    filterNames.length)
}

/** Assertions over the scratch profile written by `scripts/install-profile.mjs`. */
function checkProfilePhaseA(profileDir) {
  const bundles = readProfileBundles(profileDir)
  check(`profile selects ${MAIN_BUNDLE}`, bundles.includes(MAIN_BUNDLE), bundles)
  check(`profile does not select ${COMPANION_BUNDLE}`, !bundles.includes(COMPANION_BUNDLE), bundles)

  const companionDir = join(profileDir, 'node_modules', '@yankeguo', 'dsh-disable-goal-bundle')
  note(existsSync(companionDir)
    ? `companion package ${COMPANION_BUNDLE} is still installed in the profile node_modules (the main bundle imports its preset-filter runtime module)`
    : `companion package ${COMPANION_BUNDLE} is NOT installed in the profile node_modules`)

  const mainDir = join(profileDir, 'node_modules', '@yankeguo', 'dsh-infini-goal-bundle')
  const mainManifestPath = join(mainDir, 'package.json')
  if (!existsSync(mainManifestPath)) {
    check('installed main bundle manifest is readable', false, mainManifestPath)
    return
  }
  const manifest = readJson(mainManifestPath)
  const declared = manifest?.dsh?.bundle?.patch
  check('installed main bundle declares an ordered two-file patch layer',
    Array.isArray(declared) && JSON.stringify(declared) === JSON.stringify(MAIN_PATCH_FILES),
    declared)
  for (const file of MAIN_PATCH_FILES) {
    const path = join(mainDir, file)
    check(`installed main bundle ships ${file}`, existsSync(path), path)
  }
  const dependency = manifest?.dependencies?.[COMPANION_BUNDLE]
  note(dependency === undefined
    ? `main bundle manifest does not list ${COMPANION_BUNDLE} as a dependency`
    : `main bundle manifest declares ${COMPANION_BUNDLE}${dependency === '' ? '' : ` (${dependency})`} as a runtime dependency`)
}

/** Assertions over the phase-B profile manifest (legacy companion re-selected). */
function checkProfilePhaseB(profileDir) {
  const bundles = readProfileBundles(profileDir)
  const companionIndex = bundles.indexOf(COMPANION_BUNDLE)
  const mainIndex = bundles.indexOf(MAIN_BUNDLE)
  check('legacy companion bundle is selected by the profile', companionIndex >= 0, bundles)
  check('legacy companion bundle is listed immediately before the main bundle',
    companionIndex >= 0 && mainIndex === companionIndex + 1,
    `companion=${companionIndex}, main=${mainIndex}`)
}

/** Turn the scratch profile into the pre-change upgrade shape. */
function editAddLegacyCompanion(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = readJson(manifestPath)
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const current = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  const bundles = current.filter(name => name !== COMPANION_BUNDLE)
  const mainIndex = bundles.indexOf(MAIN_BUNDLE)
  if (mainIndex < 0) throw new Error(`profile does not select ${MAIN_BUNDLE}: ${JSON.stringify(current)}`)
  bundles.splice(mainIndex, 0, COMPANION_BUNDLE)
  manifest.dsh.profile.bundles = bundles
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`edited ${manifestPath}`)
  console.log(`  dsh.profile.bundles = ${JSON.stringify(bundles)}`)
}

/** Validate the CLI invocation and print a usage error instead of a stack. */
function failUsage(message) {
  console.error(`probe-bundles: ${message}`)
  process.exit(2)
}

if (values['edit-add-legacy-companion']) {
  if (typeof values['profile-dir'] !== 'string') failUsage('--edit-add-legacy-companion needs --profile-dir')
  editAddLegacyCompanion(values['profile-dir'])
  process.exit(0)
}

if (values.phase !== 'a' && values.phase !== 'b') failUsage('--phase must be a or b')
if (typeof values['profile-dir'] !== 'string') failUsage('--profile-dir is required')
if (typeof values.dump !== 'string') failUsage('--dump is required')
if (!existsSync(values.dump)) failUsage(`dump file not found: ${values.dump}`)
const dumpText = readFileSync(values.dump, 'utf8')

if (values.phase === 'a') {
  checkProfilePhaseA(values['profile-dir'])
  checkDumpPhaseA(dumpText)
} else {
  checkProfilePhaseB(values['profile-dir'])
  checkDumpPhaseB(dumpText)
}

if (values.json) {
  console.log(JSON.stringify({
    ok: failures === 0,
    phase: values.phase,
    checkCount: checks.length,
    failures: failures === 0 ? [] : checks.filter(entry => !entry.ok),
    checks,
  }, null, 2))
}

const passed = checks.length - failures
if (values.json) {
  /* the JSON report above is the machine output */
} else if (failures === 0) {
  console.log(`PROBE BUNDLES CONFIG PASS (${passed} checks)`)
} else {
  console.log(`PROBE BUNDLES CONFIG FAIL (${failures} of ${checks.length} checks failed)`)
  for (const failure of checks.filter(entry => !entry.ok)) console.log(`  - ${failure.name}`)
}
process.exit(failures === 0 ? 0 : 1)
