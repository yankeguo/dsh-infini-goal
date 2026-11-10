#!/usr/bin/env node
/**
 * Approve the staged npm uploads of one release with a human 2FA prompt, then
 * create the matching GitHub Release.
 *
 * The CI workflow only stages packages; a staged upload is private and not
 * installable. This script is the proof-of-presence step that runs on a
 * maintainer machine:
 *
 *   - it lists the staged versions of the requested release (`npm stage list`),
 *     checks that every workspace package of that version is staged exactly once
 *     with the expected dist-tag, and prints the stage ids for review;
 *   - `--list-only` stops after that review;
 *   - `--reject` discards the staged uploads instead (recovery after a bad
 *     staging run: versions can only be staged again once rejected);
 *   - the default action approves every stage id in dependency order (`npm
 *     stage approve`, which prompts for a one-time password per package),
 *     verifies that the versions are now public, and creates the GitHub Release
 *     from `docs/releases/v<version>.md`;
 *   - `--dry-run` shows every command without approving anything.
 *
 * Usage:
 *   node scripts/promote-release.mjs --version 0.2.0 --list-only
 *   node scripts/promote-release.mjs --version 0.2.0 --dry-run
 *   node scripts/promote-release.mjs --version 0.2.0            # approve + release
 *   node scripts/promote-release.mjs --version 0.2.0 --reject   # discard staged uploads
 *
 * Prerequisites: `npm login` as a maintainer with 2FA-enabled credentials and
 * (for the GitHub Release) an authenticated `gh` CLI.
 *
 * Partial failure: approved packages are public and cannot be un-published;
 * staged-but-unapproved packages persist, so a failed approval can simply be
 * re-run. If a staged upload itself is wrong, reject the remaining ones and cut
 * the next patch version — never move or reuse the tag.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  assertReleaseTag,
  loadReleasePlan,
  messageOf,
  releaseNotesPath,
} from './lib/release.mjs'

/** Repository root (this script lives in `scripts/`). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** A staged npm upload id is a UUID. */
const STAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * Print the command-line usage text.
 * @returns {void}
 */
function printUsage() {
  const lines = [
    'Approve staged npm uploads with 2FA and create the GitHub Release.',
    '',
    'Usage:',
    '  node scripts/promote-release.mjs --version <version> [options]',
    '',
    'Options:',
    '  --version <version>     release version to promote, e.g. 0.2.0 (required)',
    '  --release-tag <tag>     GitHub Release tag (default: v<version>)',
    '  --tag <dist-tag>        dist-tag the staged versions must carry (default: latest, next for a prerelease)',
    '  --list-only             list and verify the staged uploads, do not approve',
    '  --dry-run               print the approve/release commands, change nothing',
    '  --reject                reject the staged uploads of this version instead of approving',
    '  --no-github-release     approve the packages but skip the GitHub Release',
    '  --yes                   skip the confirmation prompt (still prompts npm for 2FA)',
    '  -h, --help              show this help',
    '',
    'Requirements: npm login with 2FA for approvals, authenticated gh for the release.',
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
 *   listOnly: boolean,
 *   dryRun: boolean,
 *   reject: boolean,
 *   noGithubRelease: boolean,
 *   yes: boolean,
 *   help: boolean,
 * }}
 *   parsed options
 */
function parseArguments(argv) {
  const options = {
    version: undefined,
    releaseTag: undefined,
    distTag: undefined,
    listOnly: false,
    dryRun: false,
    reject: false,
    noGithubRelease: false,
    yes: false,
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
      case '--list-only':
        options.listOnly = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--reject':
        options.reject = true
        break
      case '--no-github-release':
        options.noGithubRelease = true
        break
      case '--yes':
        options.yes = true
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
 * Run a command and capture its output.
 * @param {string} command executable name
 * @param {string[]} argumentsList command arguments
 * @returns {{ status: number | null, stdout: string, stderr: string, error?: Error }}
 *   captured result; `status` is `null` when the process could not start
 */
function capture(command, argumentsList) {
  const result = spawnSync(command, argumentsList, { cwd: ROOT, encoding: 'utf8', env: process.env })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...result.error === undefined ? {} : { error: result.error },
  }
}

/**
 * Run a command with the caller's terminal, so npm can prompt for a one-time
 * password and print its own progress.
 * @param {string} command executable name
 * @param {string[]} argumentsList command arguments
 * @returns {{ status: number | null, error?: Error }} the exit status
 */
function runInteractive(command, argumentsList) {
  const result = spawnSync(command, argumentsList, { cwd: ROOT, stdio: 'inherit', env: process.env })
  return {
    status: result.status,
    ...result.error === undefined ? {} : { error: result.error },
  }
}

/**
 * Turn a failed `npm` invocation into one readable line.
 * @param {{ stdout: string, stderr: string }} result captured command output
 * @returns {string} the registry's summary when npm printed JSON, else the first stderr line
 */
function npmFailure(result) {
  try {
    const parsed = JSON.parse(result.stdout)
    const summary = parsed?.error?.summary
    if (typeof summary === 'string' && summary !== '') return summary
  } catch {
    // Not JSON: fall through to the raw output.
  }
  const line = result.stderr.trim().split('\n')[0] ?? ''
  return line === '' ? 'npm failed without a diagnostic' : line
}

/**
 * Read the staged uploads of one version from the registry.
 * @param {string} version release version
 * @returns {Array<{ id: string, packageName: string, version: string, tag?: string, status?: string, createdAt?: string, actor?: string }>}
 *   staged upload records of that version
 */
function readStagedUploads(version) {
  const result = capture('npm', ['stage', 'list', '--json'])
  if (result.error !== undefined) {
    throw new Error(`could not run npm: ${messageOf(result.error)} (npm >= 11.20.0 is required)`)
  }
  if (result.status !== 0) {
    throw new Error(`npm stage list failed: ${npmFailure(result)} (run "npm login" as a maintainer with 2FA)`)
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(`npm stage list --json did not return JSON: ${result.stdout.trim().split('\n')[0] ?? ''}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('npm stage list --json returned an unexpected shape (expected an array)')
  }
  const uploads = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    if (item.version !== version) continue
    uploads.push({
      id: String(item.id ?? ''),
      packageName: String(item.packageName ?? ''),
      version: String(item.version ?? ''),
      ...typeof item.tag === 'string' ? { tag: item.tag } : {},
      ...typeof item.status === 'string' ? { status: item.status } : {},
      ...typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {},
      ...typeof item.actor === 'string' ? { actor: item.actor } : {},
    })
  }
  return uploads
}

/**
 * Check whether one package version is already public on the registry.
 *
 * A retry after a partial approval finds no staged upload for the packages that
 * were already approved; those are public and must be skipped, not reported as
 * missing.
 * @param {string} packageName npm package name
 * @param {string} version release version
 * @returns {boolean} true when the registry serves that exact version
 */
function isPublished(packageName, version) {
  const result = capture('npm', ['view', `${packageName}@${version}`, 'version', '--json'])
  if (result.status !== 0) return false
  return result.stdout.trim().replace(/^"|"$/gu, '') === version
}

/**
 * Audit the staged uploads against the release plan.
 * @param {{ order: Array<{ name: string }>, version: string }} plan release plan
 * @param {Array<{ id: string, packageName: string, tag?: string }>} uploads staged uploads of the version
 * @param {string} distTag expected dist-tag
 * @returns {{ problems: string[], warnings: string[], byName: Map<string, { id: string, packageName: string, tag?: string }>, missing: string[] }}
 *   audit result; `problems` block approval, `missing` names packages with no staged upload
 *   (a retry after a partial approval finds already-published ones there), `warnings` do not block
 */
function auditUploads(plan, uploads, distTag) {
  const problems = []
  const warnings = []
  const byName = new Map()
  const expected = new Set(plan.order.map(pkg => pkg.name))
  for (const upload of uploads) {
    if (!expected.has(upload.packageName)) {
      warnings.push(`${upload.packageName}@${upload.version} is staged but is not a package of this workspace`)
      continue
    }
    if (byName.has(upload.packageName)) {
      problems.push(`${upload.packageName}@${upload.version} has more than one staged upload`)
      continue
    }
    if (!STAGE_ID.test(upload.id)) {
      problems.push(`${upload.packageName}@${upload.version} has an unexpected stage id "${upload.id}"`)
      continue
    }
    if (upload.tag !== undefined && upload.tag !== distTag) {
      problems.push(`${upload.packageName}@${upload.version} is staged with tag "${upload.tag}", expected "${distTag}" (the tag is immutable: reject and re-stage)`)
      continue
    }
    byName.set(upload.packageName, upload)
  }
  const missing = plan.order.filter(pkg => !byName.has(pkg.name)).map(pkg => pkg.name)
  return { problems, warnings, byName, missing }
}

/**
 * Print the staged uploads as a table.
 * @param {{ order: Array<{ name: string }>, version: string }} plan release plan
 * @param {Map<string, { id: string, packageName: string, tag?: string, createdAt?: string, actor?: string }>} byName audited uploads
 * @param {Set<string>} [alreadyPublic] packages already published (a retry after a partial approval)
 * @returns {void}
 */
function printUploads(plan, byName, alreadyPublic = new Set()) {
  console.log(`staged uploads for ${plan.version}: ${byName.size}/${plan.order.length}`)
  for (const [index, pkg] of plan.order.entries()) {
    const upload = byName.get(pkg.name)
    if (upload === undefined) {
      console.log(`  ${index + 1}/${plan.order.length}  ${pkg.name}@${plan.version}  ${alreadyPublic.has(pkg.name) ? 'ALREADY PUBLIC' : 'MISSING'}`)
      continue
    }
    const details = [
      `stage-id ${upload.id}`,
      upload.tag === undefined ? undefined : `tag ${upload.tag}`,
      upload.createdAt === undefined ? undefined : `staged ${upload.createdAt}`,
      upload.actor === undefined ? undefined : `by ${upload.actor}`,
    ].filter(part => part !== undefined)
    console.log(`  ${index + 1}/${plan.order.length}  ${pkg.name}@${plan.version}  ${details.join(', ')}`)
  }
}

/**
 * Ask for confirmation on a terminal.
 * @param {string} question question text
 * @param {boolean} yes whether `--yes` skipped the prompt
 * @returns {Promise<void>} resolves when confirmed
 */
async function confirmOrAbort(question, yes) {
  if (yes) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('refusing to continue without a terminal; re-run interactively or pass --yes')
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await readline.question(`${question} [y/N] `)
    if (!/^y(?:es)?$/iu.test(answer.trim())) throw new Error('cancelled')
  } finally {
    readline.close()
  }
}

/**
 * Reject or approve staged uploads in dependency order.
 * @param {'reject' | 'approve'} action npm stage subcommand
 * @param {{ order: Array<{ name: string }>, version: string }} plan release plan
 * @param {Map<string, { id: string }>} byName audited uploads
 * @param {boolean} dryRun print the commands only
 * @returns {Array<{ name: string, status: number | null }>} per-package results
 */
function applyStages(action, plan, byName, dryRun) {
  const results = []
  const packages = plan.order.filter(pkg => byName.has(pkg.name))
  for (const [index, pkg] of packages.entries()) {
    const upload = byName.get(pkg.name)
    if (upload === undefined) continue
    console.log(`\n[${index + 1}/${packages.length}] npm stage ${action} ${upload.id}  (${pkg.name})`)
    if (dryRun) {
      results.push({ name: pkg.name, status: 0 })
      continue
    }
    const result = runInteractive('npm', ['stage', action, upload.id])
    if (result.error !== undefined) {
      console.error(`could not run npm: ${messageOf(result.error)}`)
      results.push({ name: pkg.name, status: null })
      continue
    }
    results.push({ name: pkg.name, status: result.status })
    if (result.status !== 0) break
  }
  return results
}

/**
 * Report a failed reject/approve run.
 * @param {'reject' | 'approve'} action attempted action
 * @param {{ order: Array<{ name: string }>, version: string }} plan release plan
 * @param {Map<string, { id: string }>} byName audited uploads
 * @param {Array<{ name: string, status: number | null }>} results per-package results
 * @returns {void}
 */
function reportStageFailure(action, plan, byName, results) {
  const failed = results.find(result => result.status !== 0)
  const succeeded = results.filter(result => result.status === 0).map(result => result.name)
  const remaining = [...byName.keys()].filter(name => !succeeded.includes(name))
  console.error(`\n${action.toUpperCase()} FAILED at ${failed?.name ?? 'an unknown package'} (exit ${String(failed?.status)})`)
  if (succeeded.length > 0) {
    console.error(`${action === 'approve' ? 'Approved and now public' : 'Rejected'}: ${succeeded.join(', ')}`)
  }
  if (remaining.length > 0) {
    console.error(`Still staged (private): ${remaining.map(name => `${name}@${plan.version}`).join(', ')}`)
  }
  if (action === 'approve') {
    console.error([
      'Recovery:',
      '  - Re-run this command to approve the remaining staged packages; staged uploads persist.',
      '  - If the staged upload itself is wrong, reject the remaining ones and release the next patch',
      '    version: approved packages cannot be un-published safely.',
      '  - No GitHub Release was created.',
    ].join('\n'))
  } else {
    console.error([
      'Recovery:',
      '  - Re-run this command to reject the remaining staged versions.',
      '  - Then re-run the staging workflow for the same tag once the cause is fixed.',
    ].join('\n'))
  }
}

/**
 * Verify that every approved package version is now published.
 * @param {{ order: Array<{ name: string }> }} plan release plan
 * @param {string} version release version
 * @returns {string[]} packages whose published version could not be verified
 */
function verifyPublished(plan, version) {
  const failures = []
  console.log('\nverifying published versions:')
  for (const pkg of plan.order) {
    const result = capture('npm', ['view', `${pkg.name}@${version}`, 'version', '--json'])
    if (result.status !== 0) {
      failures.push(pkg.name)
      console.log(`  FAIL ${pkg.name}@${version}: ${npmFailure(result)}`)
      continue
    }
    const published = result.stdout.trim().replace(/^"|"$/gu, '')
    if (published !== version) {
      failures.push(pkg.name)
      console.log(`  FAIL ${pkg.name}: registry reports "${published}", expected "${version}"`)
      continue
    }
    console.log(`  OK   ${pkg.name}@${version}`)
  }
  return failures
}

/**
 * Create the GitHub Release from the committed release notes.
 * @param {{ rootDir: string, version: string }} plan release plan
 * @param {string} releaseTag release tag, e.g. `v0.2.0`
 * @param {boolean} dryRun print the command only
 * @returns {number | null} the gh exit status, `null` when gh is unavailable or the command is only printed
 */
function createGithubRelease(plan, releaseTag, dryRun) {
  const notes = releaseNotesPath(plan.rootDir, plan.version)
  const argumentsList = ['release', 'create', releaseTag, '--title', releaseTag]
  const printable = existsSync(notes)
  if (printable) {
    argumentsList.push('--notes-file', notes)
  } else {
    argumentsList.push('--generate-notes')
  }
  console.log(`\nGitHub Release: ${releaseTag}${printable ? ` (notes: docs/releases/v${plan.version}.md)` : ' (generated notes)'}`)
  if (dryRun) {
    console.log(`  gh ${argumentsList.join(' ')}`)
    return null
  }
  const result = capture('gh', argumentsList)
  if (result.error !== undefined) {
    console.error(`could not run gh: ${messageOf(result.error)}`)
    console.error(`create the release manually after installing gh: gh ${argumentsList.join(' ')}`)
    return null
  }
  if (result.status !== 0) {
    console.error(`gh release create failed: ${(result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? ''}`)
    console.error(`the packages are published; create the release manually: gh ${argumentsList.join(' ')}`)
    return result.status
  }
  const url = result.stdout.trim().split('\n').find(line => line.startsWith('http')) ?? ''
  console.log(`  created${url === '' ? '' : `: ${url}`}`)
  return 0
}

/**
 * Run the promotion flow.
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }
  if (options.version === undefined) {
    throw new Error('--version <version> is required, e.g. --version 0.2.0')
  }
  const releaseTag = options.releaseTag ?? `v${options.version}`
  const plan = loadReleasePlan({
    rootDir: ROOT,
    version: options.version,
    checkVersions: false,
  })
  assertReleaseTag(releaseTag, plan.version)
  if (plan.rootManifest.version !== plan.version) {
    console.log(
      `note: the checkout is at version ${String(plan.rootManifest.version)};`
      + ` promoting the staged ${plan.version} release (package names and order only).`,
    )
  }
  console.log(`release: ${plan.version} (${plan.order.length} packages)`)
  console.log(`GitHub Release tag: ${releaseTag}`)

  // A prerelease release is staged with `next` by default, never `latest`.
  const distTag = options.distTag ?? (plan.version.includes('-') ? 'next' : 'latest')
  console.log(`dist-tag: ${distTag}`)
  const uploads = readStagedUploads(plan.version)

  // Rejecting only needs the valid staged uploads; completeness and approval
  // state do not matter (this is the cleanup path after any failed staging run).
  if (options.reject) {
    const expected = new Set(plan.order.map(pkg => pkg.name))
    const rejectable = new Map()
    for (const upload of uploads) {
      if (!expected.has(upload.packageName) || !STAGE_ID.test(upload.id)) continue
      if (!rejectable.has(upload.packageName)) rejectable.set(upload.packageName, upload)
    }
    if (rejectable.size === 0) {
      console.log(`no staged uploads for ${plan.version}; nothing to reject`)
      return
    }
    printUploads(plan, rejectable)
    await confirmOrAbort(`Reject ${rejectable.size} staged package(s) of ${plan.version}? They must be staged again afterwards.`, options.yes)
    const results = applyStages('reject', plan, rejectable, options.dryRun)
    const failed = results.find(result => result.status !== 0)
    if (failed !== undefined) {
      reportStageFailure('reject', plan, rejectable, results)
      process.exitCode = 1
      return
    }
    if (options.dryRun) {
      console.log(`\ndry run: would reject ${results.length} staged package(s) of ${plan.version}; nothing was published.`)
    } else {
      console.log(`\nrejected ${results.length} staged package(s) of ${plan.version}; nothing was ever public.`)
      console.log('next: re-run the staging workflow for the same tag once the cause is fixed.')
    }
    return
  }

  const { problems, warnings, byName, missing } = auditUploads(plan, uploads, distTag)
  // Retrying after a partial approval: packages that are already public have no
  // staged upload any more. They are skipped, not reported as missing.
  const alreadyPublic = new Set()
  for (const name of missing) {
    if (isPublished(name, plan.version)) alreadyPublic.add(name)
    else problems.push(`${name}@${plan.version} is not staged`)
  }
  printUploads(plan, byName, alreadyPublic)
  for (const warning of warnings) console.warn(`warning: ${warning}`)
  if (alreadyPublic.size > 0) {
    console.log(`already public (skipped): ${[...alreadyPublic].join(', ')}`)
  }
  if (problems.length > 0) {
    console.error(`\nstaged uploads are not ready for promotion:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    if (byName.size > 0) {
      console.error(`\nclean up with: node scripts/promote-release.mjs --version ${plan.version} --reject`)
    }
    process.exitCode = 1
    return
  }

  if (options.listOnly) {
    if (byName.size === 0) {
      console.log([
        '',
        `all ${plan.order.length} packages of ${plan.version} are already public.`,
        'next: re-run without --list-only to verify and create the GitHub Release, or create it manually:',
        `  gh release create ${releaseTag} --title ${releaseTag} --notes-file docs/releases/v${plan.version}.md`,
      ].join('\n'))
      return
    }
    console.log([
      '',
      'staged uploads verified; nothing was approved.',
      'next (maintainer machine, 2FA prompt per package):',
      `  node scripts/promote-release.mjs --version ${plan.version} --dry-run    # show the approve commands`,
      `  node scripts/promote-release.mjs --version ${plan.version}              # approve + GitHub Release`,
      `  node scripts/promote-release.mjs --version ${plan.version} --reject     # discard instead`,
    ].join('\n'))
    return
  }

  if (options.dryRun) {
    console.log('\ndry run: approve commands')
    for (const [index, pkg] of plan.order.entries()) {
      const upload = byName.get(pkg.name)
      if (upload === undefined) continue
      console.log(`  ${index + 1}/${plan.order.length}  npm stage approve ${upload.id}  (${pkg.name})`)
    }
    if (byName.size === 0) console.log(`  (nothing to approve: all ${plan.order.length} packages are already public)`)
    if (!options.noGithubRelease) createGithubRelease(plan, releaseTag, true)
    console.log('\ndry run: nothing was approved and no release was created.')
    return
  }

  if (byName.size === 0) {
    console.log(`\nall ${plan.order.length} packages of ${plan.version} are already public; skipping approvals.`)
  } else {
    await confirmOrAbort(
      `Approve ${byName.size} staged package(s) of ${plan.version}?`
      + `${alreadyPublic.size > 0 ? ` (${alreadyPublic.size} already public)` : ''} This publishes them publicly.`,
      options.yes,
    )
    const results = applyStages('approve', plan, byName, false)
    const failed = results.find(result => result.status !== 0)
    if (failed !== undefined) {
      reportStageFailure('approve', plan, byName, results)
      process.exitCode = 1
      return
    }
    console.log(`\napproved ${results.length} staged package(s) of ${plan.version}; they are now public.`)
  }

  const unverified = verifyPublished(plan, plan.version)
  if (unverified.length > 0) {
    console.error(`\ncould not verify the published version of: ${unverified.join(', ')}`)
    console.error('check the registry before creating the GitHub Release.')
    process.exitCode = 1
    return
  }

  if (options.noGithubRelease) {
    console.log(`\nreleased ${plan.version} to npm; GitHub Release skipped (--no-github-release).`)
    return
  }
  const releaseStatus = createGithubRelease(plan, releaseTag, false)
  if (releaseStatus !== 0) {
    process.exitCode = 1
    return
  }
  console.log(`\nreleased ${plan.version}: all ${plan.order.length} packages are public and the GitHub Release exists.`)
}

try {
  await main()
} catch (error) {
  console.error(`\npromote-release: ${messageOf(error)}`)
  process.exitCode = 1
}
