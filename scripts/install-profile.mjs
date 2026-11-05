#!/usr/bin/env node
/**
 * Link the built infini-goal plugin suite into a DSH profile.
 *
 * This is the self-install path for a local checkout:
 *   - symlinks every `@yankeguo/dsh-*` workspace package into
 *     `$DSH_HOME/profiles/<profile>/node_modules/@yankeguo/`;
 *   - appends the main bundle to the profile's `dsh.profile.bundles`;
 *   - with `--disable-builtin-goal`, also selects the optional
 *     `@yankeguo/dsh-disable-goal-bundle` companion and removes a previously
 *     generated profile-patch block that did the same thing.
 *
 * The profile's HMR composes the selection live; restart DSH once so every
 * existing session is bound to the new preset revisions.
 *
 * Usage:
 *   node scripts/install-profile.mjs [--profile desktop] [--dsh-home ~/.dsh]
 *                                    [--disable-builtin-goal] [--uninstall] [--dry-run]
 */
import { copyFileSync, existsSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BLOCK_BEGIN, removeGeneratedBlock } from './lib/disable-goal.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_BUNDLE = '@yankeguo/dsh-infini-goal-bundle'
const DISABLE_GOAL_BUNDLE = '@yankeguo/dsh-disable-goal-bundle'

/** Parse `--flag value` and boolean `--flag` arguments. */
function parseArgs(argv) {
  const options = {
    profile: 'desktop',
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    uninstall: false,
    dryRun: false,
    disableBuiltinGoal: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--profile':
        options.profile = argv[++index]
        break
      case '--dsh-home':
        options.dshHome = argv[++index]
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
        console.log('Usage: node scripts/install-profile.mjs [--profile desktop] [--dsh-home <dir>] [--disable-builtin-goal] [--uninstall] [--dry-run]')
        process.exit(0)
      // fallthrough for unknown flags
      default:
        throw new Error(`unknown argument: ${String(arg)}`)
    }
  }
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
  if (options.disableBuiltinGoal && disableBundle === undefined) {
    throw new Error(`workspace package ${DISABLE_GOAL_BUNDLE} not found`)
  }
  const missingBuild = packages.filter(entry => entry.manifest.dsh?.bundle === undefined && !existsSync(entry.built))
  if (missingBuild.length > 0) {
    throw new Error(`run "pnpm build" first; missing: ${missingBuild.map(entry => entry.manifest.name).join(', ')}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  const scopedDir = join(profileDir, 'node_modules', '@yankeguo')
  const patchPath = join(profileDir, 'cordis.patch.yml')

  if (options.uninstall) {
    const next = bundles.filter(name => name !== MAIN_BUNDLE && name !== DISABLE_GOAL_BUNDLE)
    if (!options.dryRun) {
      backup(manifestPath)
      manifest.dsh.profile.bundles = next
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      for (const entry of packages) {
        const linkPath = join(scopedDir, entry.manifest.name.replace(/^@[^/]+\//u, ''))
        if (isSymlink(linkPath)) unlinkSync(linkPath)
      }
    }
    console.log(`${options.dryRun ? '[dry-run] ' : ''}uninstalled ${MAIN_BUNDLE} from profile ${options.profile}`)
    return
  }

  if (!bundles.includes(MAIN_BUNDLE)) bundles.push(MAIN_BUNDLE)
  if (options.disableBuiltinGoal && !bundles.includes(DISABLE_GOAL_BUNDLE)) {
    bundles.push(DISABLE_GOAL_BUNDLE)
  }

  if (!options.dryRun) {
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
    if (options.disableBuiltinGoal && existsSync(patchPath)) {
      const text = readFileSync(patchPath, 'utf8')
      if (text.includes(BLOCK_BEGIN)) {
        backup(patchPath)
        writeFileSync(patchPath, removeGeneratedBlock(text))
        console.log(`removed a previously generated disable-goal block from ${patchPath}`)
      }
    }
    backup(manifestPath)
    manifest.dsh.profile.bundles = bundles
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  console.log(`${options.dryRun ? '[dry-run] ' : ''}enabled ${MAIN_BUNDLE} in profile ${options.profile}`)
  if (options.disableBuiltinGoal) {
    console.log(`${options.dryRun ? '[dry-run] ' : ''}enabled ${DISABLE_GOAL_BUNDLE} (built-in dsh-goal mode off; toggle it in Plugins)`)
  } else {
    console.log('built-in dsh-goal mode left untouched; pass --disable-builtin-goal to turn it off')
  }
  console.log('Restart DSH once so existing sessions bind to the new preset revisions.')
  console.log('Try: /infini-goal <objective>   or ask the model to create an infini goal.')
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

await main()
