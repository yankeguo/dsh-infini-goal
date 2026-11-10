#!/usr/bin/env node
/**
 * Regenerate the two committed "disable the built-in dsh-goal mode" bundle
 * patches from one source of truth:
 *
 *   1. `packages/disable-goal-bundle/cordis.patch.yml` — the standalone
 *      companion bundle (for profiles that want the built-in goal off without
 *      the infini-goal suite);
 *   2. `packages/bundle/cordis.disable-goal.patch.yml` — the same layer,
 *      embedded by `@yankeguo/dsh-infini-goal-bundle` through its
 *      `dsh.bundle.patch` file list (so installing the main bundle switches the
 *      built-in goal off by default).
 *
 * Both files use the SAME row ids on purpose: when a profile still enables both
 * bundles, DSH composes duplicate insert rows but the Loader keeps a single
 * entry per id (the last row wins), so the preset filters mount once. Distinct
 * ids would mount two filters per preset and fail with "Duplicate agent preset".
 *
 * Default (dynamic): the patch disables the shipped `preset-*` declaration rows
 * and mounts `@yankeguo/dsh-disable-goal-bundle/preset-filter` for each. The
 * filter plugin reads the installed `@deepseek-ai/dsh-web-app` preset
 * declaration at boot and mounts the real agent-preset with `command-goal` /
 * `tool-goal` filtered out. Nothing is copied, so a DSH upgrade needs no
 * regeneration; these files only change when the bundles' own layout changes.
 *
 * `--static` emits the legacy snapshot instead: the full shipped child lists
 * minus the goal rows, baked from the installed app.asar. Use it as a fallback
 * if a future DSH release changes the Loader/preset internals the dynamic
 * filter relies on.
 *
 * Usage:
 *   node scripts/build-disable-goal-bundle.mjs            # dynamic patches (default)
 *   node scripts/build-disable-goal-bundle.mjs --print    # print the companion patch
 *   node scripts/build-disable-goal-bundle.mjs --print-main  # print the embedded patch
 *   node scripts/build-disable-goal-bundle.mjs --check    # exit 1 when either patch or a manifest is stale
 *   node scripts/build-disable-goal-bundle.mjs --static   # snapshot fallback (both files)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ASAR,
  loadPresetPatches,
  readDshVersion,
  renderDynamicDisableGoalPatch,
  renderStaticDisableGoalPatch,
  validateBundleManifests,
} from './lib/disable-goal.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Standalone companion bundle patch (only disables the built-in goal mode). */
const DEFAULT_OUT = join(ROOT, 'packages', 'disable-goal-bundle', 'cordis.patch.yml')
/** Layer embedded by the main bundle's `dsh.bundle.patch` file list. */
const DEFAULT_MAIN_OUT = join(ROOT, 'packages', 'bundle', 'cordis.disable-goal.patch.yml')

const USAGE = `Usage:
  node scripts/build-disable-goal-bundle.mjs [--print | --print-main] [--check] [--static]
  Options:
    --print                print the companion bundle patch instead of writing
    --print-main           print the main bundle's embedded patch instead of writing
    --check                exit 1 when either generated patch (or a bundle manifest) is stale
    --static               emit a snapshot of the shipped preset child lists instead of the dynamic filter
    --out <path>           companion bundle patch output (default packages/disable-goal-bundle/cordis.patch.yml)
    --main-out <path>      main bundle embedded patch output (default packages/bundle/cordis.disable-goal.patch.yml)
    --app-asar <path>      installed app.asar for --static (default ${DEFAULT_ASAR})
    --presets-dir <path>   read preset patches from a directory for --static
    --exclude <names>      comma-separated preset names to skip for --static
`

/** Parse arguments. */
function parseArgs(argv) {
  const options = {
    mode: 'write',
    static: false,
    out: DEFAULT_OUT,
    mainOut: DEFAULT_MAIN_OUT,
    appAsar: DEFAULT_ASAR,
    presetsDir: undefined,
    exclude: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--print':
        options.mode = 'print'
        break
      case '--print-main':
        options.mode = 'print-main'
        break
      case '--check':
        options.mode = 'check'
        break
      case '--static':
        options.static = true
        break
      case '--out':
        options.out = resolve(argv[++index])
        break
      case '--main-out':
        options.mainOut = resolve(argv[++index])
        break
      case '--app-asar':
        options.appAsar = resolve(argv[++index])
        break
      case '--presets-dir':
        options.presetsDir = resolve(argv[++index])
        break
      case '--exclude':
        options.exclude = argv[++index].split(',').map(name => name.trim()).filter(Boolean)
        break
      case '-h':
      case '--help':
        process.stdout.write(USAGE)
        process.exit(0)
      // fallthrough for unknown flags
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * Render one target's generated patch.
 * @param {{ static: boolean, appAsar: string, presetsDir?: string, exclude: string[] }} options
 * @param {'companion' | 'main'} target generated file owner
 * @returns {string} patch text
 */
function renderPatch(options, target) {
  if (!options.static) return renderDynamicDisableGoalPatch(target)
  const presetPatches = loadPresetPatches(options)
  const version = options.presetsDir === undefined ? readDshVersion(options.appAsar) : 'unknown'
  return renderStaticDisableGoalPatch(target, presetPatches, version)
}

/**
 * Read a file that may not exist yet.
 * @param {string} path absolute path
 * @returns {string} file text, or an empty string when absent
 */
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Compare one generated patch with its committed copy.
 * @param {string} label human-readable target label
 * @param {string} path committed file path
 * @param {string} expected generated text
 * @returns {string | undefined} failure message
 */
function stalePatch(label, path, expected) {
  const current = readIfPresent(path)
  if (current === expected) return undefined
  if (current === '') return `${label} is missing: ${path}`
  return `${label} is stale: ${path} (run without --check to regenerate)`
}

try {
  const options = parseArgs(process.argv.slice(2))
  const companionPatch = renderPatch(options, 'companion')
  const mainPatch = renderPatch(options, 'main')

  if (options.mode === 'print' || options.mode === 'print-main') {
    process.stdout.write(options.mode === 'print' ? companionPatch : mainPatch)
  } else if (options.mode === 'check') {
    const failures = [
      stalePatch('companion bundle patch', options.out, companionPatch),
      stalePatch('main bundle embedded patch', options.mainOut, mainPatch),
      ...validateBundleManifests(ROOT),
    ].filter(failure => failure !== undefined)
    if (failures.length > 0) {
      for (const failure of failures) console.error(`build-disable-goal-bundle: ${failure}`)
      process.exit(1)
    }
    console.log('build-disable-goal-bundle: generated patches and bundle manifests are up to date')
  } else {
    writeFileSync(options.out, companionPatch)
    writeFileSync(options.mainOut, mainPatch)
    console.log(`wrote ${options.out}`)
    console.log(`wrote ${options.mainOut}`)
    const failures = validateBundleManifests(ROOT)
    if (failures.length > 0) {
      for (const failure of failures) console.error(`build-disable-goal-bundle: ${failure}`)
      process.exit(1)
    }
  }
} catch (error) {
  console.error(`build-disable-goal-bundle: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
