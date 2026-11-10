#!/usr/bin/env node
/**
 * Stage every publishable workspace package to the npm registry in dependency
 * order, without publishing anything: staged uploads stay private until a
 * maintainer approves each one with a 2FA prompt (see
 * `scripts/promote-release.mjs`).
 *
 * This is the publish step of `.github/workflows/publish.yml`; a maintainer can
 * also dry-run it locally.
 *
 * Why `pnpm stage publish` and not `npm stage publish`:
 * npm packs `package.json` verbatim, so the bundle's `workspace:*` dependency
 * specs would ship unresolved (verified against a local registry stub); pnpm
 * rewrites every `workspace:` spec to the exact workspace version while packing
 * and orders the pack the same way `pnpm publish` does.
 *
 * Usage:
 *   node scripts/stage-release.mjs --check
 *   node scripts/stage-release.mjs --dry-run --no-git-checks
 *   node scripts/stage-release.mjs --release-tag v0.2.0 --provenance --no-git-checks
 *
 * Exit status: 0 when every package was staged (or the plan checked out under
 * `--check`/`--dry-run`), 1 on the first failure. A failed run leaves nothing
 * public; the staged entries must be rejected before the same versions can be
 * staged again (`node scripts/promote-release.mjs --version <version> --reject`).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPackageContents,
  describePlan,
  loadReleasePlan,
  messageOf,
} from './lib/release.mjs'

/** Repository root (this script lives in `scripts/`). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Print the command-line usage text.
 * @returns {void}
 */
function printUsage() {
  const lines = [
    'Stage every publishable workspace package to npm in dependency order.',
    '',
    'Usage:',
    '  node scripts/stage-release.mjs [options]',
    '',
    'Options:',
    '  --version <version>     expected package version (default: root package.json version)',
    '  --release-tag <tag>     v<version> tag to validate against the package versions',
    '  --tag <dist-tag>        dist-tag for the staged versions (default: latest, next for a prerelease)',
    '  --provenance            attach a provenance attestation (CI; ignored with --dry-run)',
    '  --no-git-checks         skip pnpm\'s git checks (CI checks out the tag detached)',
    '  --dry-run               pack every package with pnpm --dry-run; reveal what would be staged',
    '  --check                 validate the release plan and build artifacts; do not invoke pnpm',
    '  --gate                  validate versions/tag/order only (no build-artifact check)',
    '  -h, --help              show this help',
    '',
    'Nothing is public after a successful run: every staged version still needs',
    'a maintainer approval with 2FA (node scripts/promote-release.mjs).',
  ]
  console.log(lines.join('\n'))
}

/**
 * Parse one option value.
 * @param {string[]} argv raw arguments
 * @param {number} index index of the flag
 * @param {string} flag flag name for the error message
 * @returns {string} the following argument
 */
function optionValue(argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`)
  }
  return value
}

/**
 * Parse the command line into options.
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{
 *   version?: string,
 *   releaseTag?: string,
 *   distTag?: string,
 *   provenance: boolean,
 *   noGitChecks: boolean,
 *   dryRun: boolean,
 *   check: boolean,
 *   gate: boolean,
 *   help: boolean,
 * }}
 *   parsed options
 */
function parseArguments(argv) {
  const options = {
    version: undefined,
    releaseTag: undefined,
    distTag: undefined,
    provenance: false,
    noGitChecks: false,
    dryRun: false,
    check: false,
    gate: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--version':
        options.version = optionValue(argv, index, argument)
        index += 1
        break
      case '--release-tag':
        options.releaseTag = optionValue(argv, index, argument)
        index += 1
        break
      case '--tag':
        options.distTag = optionValue(argv, index, argument)
        index += 1
        break
      case '--provenance':
        options.provenance = true
        break
      case '--no-git-checks':
        options.noGitChecks = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--check':
        options.check = true
        break
      case '--gate':
        options.gate = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${argument}`)
    }
  }
  return options
}

/**
 * Append Markdown to the GitHub Actions job summary when running in CI.
 * @param {string} markdown summary body
 * @returns {void}
 */
function writeStepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file === undefined || file === '') return
  try {
    appendFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`)
  } catch (error) {
    console.warn(`could not write the job summary: ${messageOf(error)}`)
  }
}

/**
 * Require a recent pnpm, the only package manager that rewrites `workspace:`
 * specs while packing a staged publish.
 * @returns {string} the pnpm version string
 */
function requirePnpm() {
  const result = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('pnpm is required on PATH for staged publishing (CI installs it via pnpm/action-setup)')
  }
  const version = result.stdout.trim()
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  if (!Number.isInteger(major) || major < 12) {
    throw new Error(`pnpm >= 12 is required for staged publishing (found ${version})`)
  }
  return version
}

/**
 * Stage one package by running `pnpm stage publish` in its directory.
 * @param {{ path: string, name: string }} pkg package to stage
 * @param {string} version release version, for the progress line
 * @param {string[]} argumentsList `pnpm stage publish` flags shared by every package
 * @returns {number | null} the exit status, or `null` when pnpm could not run
 */
function stagePackage(pkg, version, argumentsList) {
  console.log(`\n==> ${pkg.name}@${version}`)
  const result = spawnSync('pnpm', ['stage', 'publish', ...argumentsList], {
    cwd: pkg.path,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error !== undefined) {
    console.error(`could not run pnpm in ${pkg.path}: ${messageOf(result.error)}`)
    return null
  }
  return result.status
}

/**
 * Report a failed staging run with the recovery steps.
 * @param {{ version: string }} plan release plan
 * @param {Array<{ name: string }>} staged packages staged before the failure
 * @param {Array<{ name: string }>} remaining packages the run did not stage
 * @param {string} reason failure description
 * @returns {void}
 */
function reportFailure(plan, staged, remaining, reason) {
  const lines = [
    '',
    `STAGING FAILED: ${reason}`,
    `Staged ${staged.length} of ${staged.length + remaining.length} packages before the failure.`,
    '',
    'Nothing is public: staged uploads are private until every package is approved.',
    'Recovery:',
    `  1. Discard the staged uploads of this version (2FA prompt per package):`,
    `       node scripts/promote-release.mjs --version ${plan.version} --reject`,
    '  2. Fix the cause (registry/trust/OIDC; for transient failures only) and re-run the',
    '     workflow for the SAME tag via workflow_dispatch with release_tag — never move the tag.',
    '  3. If the cause needs a code change, release the next patch version instead:',
    '     the staged versions of this run are rejected in step 1 and stay private until then.',
  ]
  if (staged.length > 0) {
    lines.push('', 'Already staged (must be rejected before they can be staged again):')
    for (const pkg of staged) lines.push(`  - ${pkg.name}@${plan.version}`)
  }
  console.error(lines.join('\n'))
  writeStepSummary([
    '### Staged publish failed',
    '',
    reason,
    '',
    `Staged ${staged.length}/${staged.length + remaining.length} packages for ${plan.version}; nothing is public.`,
    '',
    `Recovery: \`node scripts/promote-release.mjs --version ${plan.version} --reject\`, fix, then re-run the workflow for the same tag.`,
  ].join('\n'))
}

/**
 * Run the staged release.
 * @returns {void}
 */
function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }
  const plan = loadReleasePlan({
    rootDir: ROOT,
    version: options.version,
    releaseTag: options.releaseTag,
  })
  console.log(`release plan: v${plan.version} (${plan.order.length} packages, dependency order)`)
  for (const line of describePlan(plan)) console.log(`  ${line}`)
  if (options.releaseTag !== undefined) console.log(`release tag: ${options.releaseTag} matches every package version`)
  // A prerelease must never move `latest`: default it to the `next` dist-tag.
  const distTag = options.distTag ?? (plan.version.includes('-') ? 'next' : 'latest')
  console.log(`dist-tag: ${distTag}`)
  if (options.gate) {
    console.log('\nversion/tag gate OK (--gate); the staging run re-validates build artifacts')
    return
  }
  assertPackageContents(plan)
  if (plan.version.includes('-') && distTag === 'latest') {
    console.warn(
      `warning: ${plan.version} is a prerelease but --tag latest was requested;`
      + ' approval would move the "latest" dist-tag onto a prerelease version.',
    )
  }
  if (options.check) {
    console.log('\nrelease plan OK; nothing was staged (--check)')
    return
  }

  const pnpmVersion = requirePnpm()
  console.log(`pnpm ${pnpmVersion}`)

  const argumentsList = ['--access', 'public', '--tag', distTag]
  if (options.noGitChecks) argumentsList.push('--no-git-checks')
  if (options.dryRun) {
    argumentsList.push('--dry-run')
    if (options.provenance) console.log('note: --provenance is ignored with --dry-run (nothing is uploaded)')
  } else if (options.provenance) {
    argumentsList.push('--provenance')
  }

  const staged = []
  for (const [index, pkg] of plan.order.entries()) {
    console.log(`\n[${index + 1}/${plan.order.length}] staging ${pkg.name}@${plan.version}`)
    const status = stagePackage(pkg, plan.version, argumentsList)
    if (status !== 0) {
      reportFailure(plan, staged, plan.order.slice(index), status === null ? 'pnpm could not start' : `pnpm stage publish exited with ${String(status)}`)
      process.exitCode = 1
      return
    }
    staged.push(pkg)
  }

  const verb = options.dryRun ? 'would stage' : 'staged'
  const summary = [
    `\n${verb} ${staged.length}/${plan.order.length} package(s) at ${plan.version} with dist-tag ${distTag}.`,
    ...staged.map(pkg => `  - ${pkg.name}@${plan.version} (${verb})`),
  ]
  if (options.dryRun) {
    summary.push('', `dry run: nothing was uploaded; re-run with --no-git-checks (CI does) to stage for real.`)
  } else {
    summary.push(
      '',
      'Nothing is public yet: staged versions are not installable until a maintainer approves them.',
      'Next (maintainer machine, npm login with 2FA):',
      `  node scripts/promote-release.mjs --version ${plan.version} --list-only    # inspect the staged uploads`,
      `  node scripts/promote-release.mjs --version ${plan.version}               # approve + GitHub Release`,
    )
  }
  console.log(summary.join('\n'))
  writeStepSummary([
    `### ${options.dryRun ? 'Staged publish dry run' : 'Packages staged'} — v${plan.version}`,
    '',
    `${staged.length}/${plan.order.length} packages ${verb} with dist-tag \`${distTag}\`.`,
    '',
    '| # | package | version |',
    '| --- | --- | --- |',
    ...staged.map((pkg, index) => `| ${index + 1} | \`${pkg.name}\` | \`${plan.version}\` |`),
    '',
    options.dryRun
      ? 'Dry run: nothing was uploaded.'
      : 'Nothing is public until a maintainer approves every staged version with 2FA: `node scripts/promote-release.mjs --version '
        + `${plan.version}\` (and \`--list-only\` to inspect first).`,
  ].join('\n'))
}

try {
  main()
} catch (error) {
  console.error(`\nstage-release: ${messageOf(error)}`)
  process.exitCode = 1
}
