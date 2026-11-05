#!/usr/bin/env node
/**
 * Link the built infini-goal plugin suite into a DSH profile.
 *
 * This is the self-install path for a local checkout:
 *   - symlinks every `@yankeguo/dsh-*-infini-goal*` package into
 *     `$DSH_HOME/profiles/<profile>/node_modules/`;
 *   - appends the bundle package name to the profile's `dsh.profile.bundles`.
 *
 * The profile's HMR then composes the new bundle live when it is enabled;
 * otherwise restart DSH. A Web page reload loads the client UI row.
 *
 * Usage:
 *   node scripts/install-profile.mjs [--profile desktop] [--dsh-home ~/.dsh] [--uninstall] [--dry-run]
 */
import { existsSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Parse `--flag value` and boolean `--flag` arguments. */
function parseArgs(argv) {
  const options = { profile: 'desktop', dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'), uninstall: false, dryRun: false }
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
      case '--help':
      case '-h':
        console.log('Usage: node scripts/install-profile.mjs [--profile desktop] [--dsh-home <dir>] [--uninstall] [--dry-run]')
        process.exit(0)
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
  const missingBuild = packages.filter(entry => entry.manifest.dsh?.bundle === undefined && !existsSync(entry.built))
  if (missingBuild.length > 0) {
    throw new Error(`run "pnpm build" first; missing: ${missingBuild.map(entry => entry.manifest.name).join(', ')}`)
  }
  const bundle = packages.find(entry => entry.manifest.dsh?.bundle !== undefined)
  if (bundle === undefined) throw new Error('no bundle package found under packages/')

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  const scopedDir = join(profileDir, 'node_modules', '@yankeguo')

  if (options.uninstall) {
    const next = bundles.filter(name => name !== bundle.manifest.name)
    if (!options.dryRun) {
      backup(manifestPath)
      manifest.dsh.profile.bundles = next
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      for (const entry of packages) {
        const linkPath = join(scopedDir, entry.manifest.name.replace(/^@[^/]+\//u, ''))
        if (isSymlink(linkPath)) unlinkSync(linkPath)
      }
    }
    console.log(`${options.dryRun ? '[dry-run] ' : ''}uninstalled ${bundle.manifest.name} from profile ${options.profile}`)
    return
  }

  if (!bundles.includes(bundle.manifest.name)) bundles.push(bundle.manifest.name)
  if (!options.dryRun) {
    backup(manifestPath)
    manifest.dsh.profile.bundles = bundles
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await mkdir(scopedDir, { recursive: true })
    for (const entry of packages) {
      const linkPath = join(scopedDir, entry.manifest.name.replace(/^@[^/]+\//u, ''))
      if (isSymlink(linkPath)) {
        const target = resolve(dirname(linkPath), readlinkSync(linkPath))
        if (target === entry.dir) continue
        unlinkSync(linkPath)
      } else if (existsSync(linkPath)) {
        throw new Error(`${linkPath} exists and is not a symlink; refusing to replace it`)
      }
      symlinkSync(entry.dir, linkPath, 'dir')
      console.log(`linked ${entry.manifest.name} -> ${entry.dir}`)
    }
  }
  console.log(`${options.dryRun ? '[dry-run] ' : ''}enabled ${bundle.manifest.name} in profile ${options.profile}`)
  console.log('Reload the Web page (or restart DSH) to load the client UI bar.')
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

/** Keep one timestamped backup before rewriting the profile manifest. */
function backup(path) {
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const target = `${path}.bak-infini-goal-${stamp}`
  copyFileSync(path, target)
  console.log(`backed up ${path} -> ${target}`)
}

await main()
