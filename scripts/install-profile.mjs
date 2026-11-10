#!/usr/bin/env node
/**
 * Link the built infini-goal plugin suite into a DSH profile.
 *
 * This is the self-install path for a local checkout:
 *   - symlinks every `@yankeguo/dsh-*` workspace package into
 *     `$DSH_HOME/profiles/<profile>/node_modules/@yankeguo/`;
 *   - appends the main bundle to the profile's `dsh.profile.bundles`. The main
 *     bundle embeds the built-in-goal disable layer
 *     (`cordis.disable-goal.patch.yml`), so installing it switches the built-in
 *     dsh-goal mode off by default — no companion bundle is selected;
 *   - deselects a previously selected `@yankeguo/dsh-disable-goal-bundle`
 *     companion: its layer is now redundant, and two selected bundles would
 *     compose duplicate (though tolerated) filter rows. The companion package
 *     stays installed because the main bundle imports its `preset-filter`
 *     runtime module;
 *   - removes a previously generated profile-patch block that disabled the
 *     built-in goal: the bundle layer supersedes it, and a leftover block would
 *     duplicate the same insert rows.
 *
 * `--disable-builtin-goal` is accepted as a deprecated no-op so scripts written
 * against older releases keep working; the built-in goal is already off.
 *
 * The write is idempotent: the profile manifest is only rewritten (and only
 * backed up) when its content actually changes, so repeated runs leave no
 * backup clutter. `--uninstall` reverses the links, the bundle selection, and
 * any generated disable-goal patch block so the profile cannot keep pointing at
 * packages that are no longer linked.
 *
 * The profile's HMR composes the selection live; restart DSH once so every
 * existing session is bound to the new preset revisions. Individual bundle rows
 * can be toggled later on the Plugins page.
 *
 * Usage:
 *   node scripts/install-profile.mjs [--profile desktop] [--dsh-home ~/.dsh]
 *                                    [--disable-builtin-goal] [--uninstall] [--dry-run]
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BLOCK_BEGIN, removeGeneratedBlock } from './lib/disable-goal.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_BUNDLE = '@yankeguo/dsh-infini-goal-bundle'
const DISABLE_GOAL_BUNDLE = '@yankeguo/dsh-disable-goal-bundle'

/**
 * Parse `--flag value` and boolean `--flag` arguments.
 * @param argv - arguments after `node scripts/install-profile.mjs`.
 */
function parseArgs(argv) {
  const options = {
    profile: 'desktop',
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    uninstall: false,
    dryRun: false,
    /** Deprecated compatibility alias: the built-in goal is now off by default. */
    disableBuiltinGoal: false,
  }
  /** Read the value of a `--flag value` pair and reject a missing/flag value. */
  const valueOf = (flag) => {
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    return value
  }
  let index = 0
  for (; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--profile':
        options.profile = valueOf('--profile')
        break
      case '--dsh-home':
        options.dshHome = valueOf('--dsh-home')
        break
      case '--uninstall':
        options.uninstall = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--disable-builtin-goal':
        options.disableBuiltinGoal = true
        break
      case '--help':
      case '-h':
        console.log('Usage: node scripts/install-profile.mjs [--profile desktop] [--dsh-home <dir>] [--disable-builtin-goal (deprecated)] [--uninstall] [--dry-run]')
        process.exit(0)
      // fallthrough for unknown flags
      default:
        throw new Error(`unknown argument: ${String(arg)}`)
    }
  }
  options.dshHome = resolve(options.dshHome)
  if (options.profile.trim().length === 0) throw new Error('--profile must not be empty')
  return options
}

/** Resolve every plugin package directory with its manifest. */
async function readPackages() {
  const base = join(ROOT, 'packages')
  const entries = []
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(base, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const built = join(dir, 'lib', 'index.js')
    entries.push({ dir, manifest, built })
  }
  return entries.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
}

/**
 * Every built artifact a package must have before a profile link is usable.
 * @param entry - one workspace package entry from {@link readPackages}.
 * @returns the missing built files (package-relative), empty when complete.
 */
function missingBuildArtifacts(entry) {
  const missing = []
  const manifest = entry.manifest
  if (manifest.dsh?.bundle !== undefined) {
    // A patch-only bundle has no host entry. The companion bundle ships the
    // runtime preset filter its patch rows import — the main bundle now embeds
    // the same rows and depends on that package, so the asset is always needed.
    if (manifest.name === DISABLE_GOAL_BUNDLE && !existsSync(join(entry.dir, 'lib', 'preset-filter.js'))) {
      missing.push('lib/preset-filter.js')
    }
    return missing
  }
  if (!existsSync(entry.built)) missing.push('lib/index.js')
  if (manifest.dsh?.client !== undefined && !existsSync(join(entry.dir, 'lib', 'client.js'))) {
    missing.push('lib/client.js')
  }
  return missing
}

/** Whether one path is an existing symbolic link. */
function isSymlink(path) {
  try {
    readlinkSync(path)
    return true
  } catch {
    return false
  }
}

/** Keep one timestamped backup before rewriting a file. */
function backup(path) {
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const target = `${path}.bak-infini-goal-${stamp}`
  copyFileSync(path, target)
  console.log(`backed up ${path} -> ${target}`)
}

/**
 * Write a JSON file only when its canonical form changed, backing up first.
 * @param path - file to rewrite.
 * @param manifest - parsed manifest value.
 * @returns whether the file was written.
 */
function writeManifestIfChanged(path, manifest) {
  const next = `${JSON.stringify(manifest, null, 2)}\n`
  if (readFileSync(path, 'utf8') === next) return false
  backup(path)
  writeFileSync(path, next)
  return true
}

/** Remove a previously generated disable-goal block from a profile patch file. */
function removeGeneratedPatchBlock(patchPath) {
  if (!existsSync(patchPath)) return false
  const text = readFileSync(patchPath, 'utf8')
  if (!text.includes(BLOCK_BEGIN)) return false
  backup(patchPath)
  writeFileSync(patchPath, removeGeneratedBlock(text))
  console.log(`removed a generated disable-goal block from ${patchPath}`)
  return true
}

/** Install (or remove) the profile links and bundle selection. */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`profile "${options.profile}" not found at ${profileDir} (set --dsh-home/--profile)`)
  }
  const packages = await readPackages()
  const byName = new Map(packages.map(entry => [entry.manifest.name, entry]))
  const mainBundle = byName.get(MAIN_BUNDLE)
  const disableBundle = byName.get(DISABLE_GOAL_BUNDLE)
  if (mainBundle === undefined) throw new Error(`workspace package ${MAIN_BUNDLE} not found`)
  if (disableBundle === undefined) {
    throw new Error(`workspace package ${DISABLE_GOAL_BUNDLE} not found (the main bundle imports its preset-filter runtime module)`)
  }
  const missingBuild = packages.flatMap(entry => missingBuildArtifacts(entry).map(file => `${entry.manifest.name} (${file})`))
  if (missingBuild.length > 0) {
    throw new Error(`run "pnpm build" first; missing: ${missingBuild.join(', ')}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  if (manifest.dsh.profile.bundles !== undefined && !Array.isArray(manifest.dsh.profile.bundles)) {
    throw new Error(`profile ${manifestPath} has a non-array dsh.profile.bundles; refusing to rewrite it`)
  }
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : []
  const scopedDir = join(profileDir, 'node_modules', '@yankeguo')
  const patchPath = join(profileDir, 'cordis.patch.yml')

  if (options.uninstall) {
    const next = bundles.filter(name => name !== MAIN_BUNDLE && name !== DISABLE_GOAL_BUNDLE)
    if (!options.dryRun) {
      manifest.dsh.profile.bundles = next
      for (const entry of packages) {
        const linkPath = join(scopedDir, entry.manifest.name.replace(/^@[^/]+\//u, ''))
        if (isSymlink(linkPath)) unlinkSync(linkPath)
      }
      // A leftover generated block inserts the same filter rows the bundle layer
      // provides (and points at the packages removed here), so uninstall removes
      // it too; otherwise the next boot would duplicate or fail to resolve rows.
      removeGeneratedPatchBlock(patchPath)
      writeManifestIfChanged(manifestPath, manifest)
    }
    console.log(`${options.dryRun ? '[dry-run] ' : ''}uninstalled ${MAIN_BUNDLE} from profile ${options.profile}`)
    if (next.length !== bundles.length) console.log(`  removed from dsh.profile.bundles: ${bundles.filter(name => !next.includes(name)).join(', ')}`)
    return
  }

  // The main bundle embeds the built-in-goal disable layer, so a leftover
  // companion selection is redundant and would duplicate the shared filter row
  // ids (tolerated at runtime, but the Plugins page cannot switch those rows).
  const next = bundles.filter(name => name !== DISABLE_GOAL_BUNDLE)
  const deselectedCompanion = next.length !== bundles.length
  if (!next.includes(MAIN_BUNDLE)) next.push(MAIN_BUNDLE)

  if (options.dryRun) {
    console.log(`[dry-run] would link ${packages.length} packages into ${scopedDir}`)
    if (deselectedCompanion) {
      console.log(`[dry-run] would deselect ${DISABLE_GOAL_BUNDLE}: the main bundle embeds the same disable layer`)
    }
  } else {
    await mkdir(scopedDir, { recursive: true })
    for (const entry of packages) {
      const linkPath = join(scopedDir, entry.manifest.name.replace(/^@[^/]+\//u, ''))
      if (isSymlink(linkPath)) {
        const target = resolve(dirname(linkPath), readlinkSync(linkPath))
        if (target === entry.dir) continue
        unlinkSync(linkPath)
      } else if (existsSync(linkPath)) {
        // A profile installed through the plugin manager owns real package
        // directories (pnpm layout). Leave an equivalent installed copy alone
        // and only link the packages this checkout adds.
        const installedManifest = join(linkPath, 'package.json')
        if (existsSync(installedManifest)) {
          const installed = JSON.parse(readFileSync(installedManifest, 'utf8'))
          if (installed.name === entry.manifest.name) {
            console.log(`kept installed package ${entry.manifest.name} (${installed.version ?? 'unknown'})`)
            continue
          }
        }
        throw new Error(`${linkPath} exists and is not a symlink; refusing to replace it`)
      }
      symlinkSync(entry.dir, linkPath, 'dir')
      console.log(`linked ${entry.manifest.name} -> ${entry.dir}`)
    }
    removeGeneratedPatchBlock(patchPath)
    manifest.dsh.profile.bundles = next
    writeManifestIfChanged(manifestPath, manifest)
  }

  console.log(`${options.dryRun ? '[dry-run] ' : ''}enabled ${MAIN_BUNDLE} in profile ${options.profile}`)
  if (deselectedCompanion) {
    console.log(`  deselected ${DISABLE_GOAL_BUNDLE}: its layer is now embedded by the main bundle (package kept installed)`)
  }
  if (options.disableBuiltinGoal) {
    console.log('note: --disable-builtin-goal is deprecated and no longer needed; the main bundle switches the built-in dsh-goal mode off by default')
  }
  console.log('built-in dsh-goal mode is off by default; toggle individual bundle rows on the Plugins page')
  console.log('Restart DSH once so existing sessions bind to the new preset revisions.')
  console.log('Try: /infini-goal <objective>   or ask the model to create an infini goal.')
}

try {
  await main()
} catch (error) {
  console.error(`install-profile: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
