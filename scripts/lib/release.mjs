#!/usr/bin/env node
/**
 * Shared release-plan helpers for the staged publishing scripts.
 *
 * The release is one version of every publishable workspace package
 * (`packages/<dir>/package.json`, non-private). All of them must carry the
 * same version, and the `v<version>` tag must name exactly that version.
 *
 * Package order is a dependency topological order over the workspace's own
 * `dependencies`: a package is staged only after every workspace package it
 * depends on has been staged, so a consumer's staged manifest can reference
 * exact versions that already exist as staged uploads. Ties keep the
 * alphabetical directory order, which makes the printed plan reproducible.
 *
 * Used by:
 *   - scripts/stage-release.mjs (the CI staging run and local dry runs),
 *   - scripts/promote-release.mjs (approval/reject needs the same package list
 *     and the same order).
 *
 * Nothing here uploads or mutates the registry: every helper is read-only.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Directory under the repository root that holds the publishable packages. */
export const PACKAGES_DIRECTORY = 'packages'

/**
 * Read and parse one JSON file.
 * @param {string} file absolute path
 * @returns {any} parsed JSON value
 */
export function readJsonFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`could not read ${file}: ${messageOf(error)}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${messageOf(error)}`)
  }
}

/**
 * Discover the publishable packages of the workspace, sorted by directory name.
 *
 * A package is publishable when its manifest has a non-empty `name` and does
 * not set `private: true` (which also skips the root project).
 * @param {string} rootDir repository root
 * @returns {Array<{ dir: string, path: string, name: string, manifest: any, dependencies: string[] }>}
 *   publishable packages; `dependencies` starts empty and is filled by
 *   {@link linkWorkspaceDependencies}
 */
export function discoverPackages(rootDir) {
  const packagesRoot = join(rootDir, PACKAGES_DIRECTORY)
  let entries
  try {
    entries = readdirSync(packagesRoot, { withFileTypes: true })
  } catch (error) {
    throw new Error(`could not list ${packagesRoot}: ${messageOf(error)}`)
  }
  const packages = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const dir = entry.name
    const packageDir = join(packagesRoot, dir)
    let manifest
    try {
      manifest = readJsonFile(join(packageDir, 'package.json'))
    } catch {
      // A directory without a readable manifest is not a workspace package.
      continue
    }
    if (typeof manifest.name !== 'string' || manifest.name === '') continue
    if (manifest.private === true) continue
    packages.push({ dir, path: packageDir, name: manifest.name, manifest, dependencies: [] })
  }
  return packages
}

/**
 * Resolve each package's dependencies that are also workspace packages.
 *
 * Internal dependencies must use the `workspace:` protocol: `pnpm publish` /
 * `pnpm stage publish` rewrite that protocol to the exact current version when
 * packing the tarball, while a plain semver range would ship as written and
 * could point at a different published version.
 * @param {Array<{ name: string, dependencies: string[], manifest: any }>} packages packages from {@link discoverPackages}
 * @returns {void}
 */
export function linkWorkspaceDependencies(packages) {
  const byName = new Map(packages.map(packageOf => [packageOf.name, packageOf]))
  for (const pkg of packages) {
    const dependencies = []
    for (const [name, range] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (!byName.has(name)) continue
      if (typeof range !== 'string' || !range.startsWith('workspace:')) {
        throw new Error(
          `${pkg.name} depends on workspace package ${name} through "${String(range)}";`
          + ' internal dependencies must use the "workspace:" protocol so the published manifest'
          + ' carries the exact released version',
        )
      }
      dependencies.push(name)
    }
    pkg.dependencies = dependencies
  }
}

/**
 * Sort packages so every package follows the workspace packages it depends on.
 *
 * Stable and deterministic: among packages that are ready, the one that comes
 * first in the directory-sorted package list wins.
 * @param {Array<{ name: string, dependencies: string[] }>} packages packages from {@link discoverPackages}
 * @returns {typeof packages} a new array in staging order
 * @throws when the workspace dependencies contain a cycle
 */
export function topologicalOrder(packages) {
  const done = new Set()
  const order = []
  while (order.length < packages.length) {
    const next = packages.find(pkg => !done.has(pkg.name) && pkg.dependencies.every(name => done.has(name)))
    if (next === undefined) {
      const blocked = packages.filter(pkg => !done.has(pkg.name)).map(pkg => pkg.name)
      throw new Error(`workspace dependencies contain a cycle between: ${blocked.join(', ')}`)
    }
    done.add(next.name)
    order.push(next)
  }
  return order
}

/**
 * Assert that the release tag names the expected version.
 * @param {string} releaseTag tag such as `v0.2.0`
 * @param {string} version expected package version, e.g. `0.2.0`
 * @returns {void}
 */
export function assertReleaseTag(releaseTag, version) {
  if (!releaseTag.startsWith('v')) {
    throw new Error(`release tag must start with "v" (got "${releaseTag}")`)
  }
  const tagged = releaseTag.slice(1)
  if (tagged !== version) {
    throw new Error(`release tag ${releaseTag} expects version ${tagged}, but the release version is ${version}`)
  }
}

/**
 * Load and validate the release plan: one version, one tag, a dependency order.
 * @param {{ rootDir: string, version?: string, releaseTag?: string, checkVersions?: boolean }} options
 *   `rootDir` repository root, `version` expected version (default: the root
 *   manifest version), `releaseTag` tag to validate against that version,
 *   `checkVersions` whether every package must already carry the version
 *   (staging requires it; approval only needs names and order)
 * @returns {{
 *   rootDir: string,
 *   version: string,
 *   packages: Array<any>,
 *   order: Array<any>,
 *   rootManifest: any,
 * }}
 *   validated plan; `order` is the dependency staging order
 */
export function loadReleasePlan({ rootDir, version, releaseTag, checkVersions = true }) {
  const rootManifest = readJsonFile(join(rootDir, 'package.json'))
  const expectedVersion = version ?? rootManifest.version
  if (typeof expectedVersion !== 'string' || expectedVersion === '') {
    throw new Error('could not determine the release version')
  }
  if (rootManifest.private !== true) {
    throw new Error(`${rootManifest.name ?? 'the root project'} must stay private: it is not a publishable package`)
  }
  const packages = discoverPackages(rootDir)
  if (packages.length === 0) {
    throw new Error(`no publishable packages found under ${join(rootDir, PACKAGES_DIRECTORY)}`)
  }
  linkWorkspaceDependencies(packages)
  if (checkVersions) {
    const mismatched = packages
      .filter(pkg => pkg.manifest.version !== expectedVersion)
      .map(pkg => `${pkg.name}@${String(pkg.manifest.version)}`)
    if (rootManifest.version !== expectedVersion) {
      mismatched.unshift(`${String(rootManifest.name)}@${String(rootManifest.version)} (root project)`)
    }
    if (mismatched.length > 0) {
      throw new Error(
        `expected every publishable package to be at version ${expectedVersion}, but: ${mismatched.join(', ')}`,
      )
    }
  }
  if (releaseTag !== undefined) assertReleaseTag(releaseTag, expectedVersion)
  return {
    rootDir,
    version: expectedVersion,
    packages,
    order: topologicalOrder(packages),
    rootManifest,
  }
}

/**
 * Verify that every literal `files` entry of every package exists on disk.
 *
 * The CI staging run happens after `pnpm build`; running this guard before the
 * first upload turns a forgotten build (or a stale manifest entry) into a clear
 * preflight failure instead of a staged tarball with missing files.
 * @param {{ packages: Array<{ name: string, dir: string, path: string, manifest: any }> }} plan release plan
 * @returns {void}
 * @throws when a package has no `files` list or a literal entry is missing
 */
export function assertPackageContents(plan) {
  const problems = []
  for (const pkg of plan.packages) {
    const files = pkg.manifest.files
    if (!Array.isArray(files) || files.length === 0) {
      problems.push(`${pkg.name}: package.json has no "files" list`)
      continue
    }
    for (const entry of files) {
      if (typeof entry !== 'string' || entry === '') {
        problems.push(`${pkg.name}: "files" contains an empty or non-string entry`)
        continue
      }
      // Glob entries (`locale/*.json`) are checked by the packed tarball itself.
      if (entry.includes('*')) continue
      try {
        statSync(join(pkg.path, entry))
      } catch {
        problems.push(`${pkg.name}: "files" entry "${entry}" is missing from packages/${pkg.dir}/ (run pnpm build first)`)
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`staged release contents are incomplete:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
  }
}

/**
 * Render the release plan as printable lines.
 * @param {{ version: string, order: Array<{ name: string, dir: string }> }} plan release plan
 * @returns {string[]} one line per package, prefixed with its staging position
 */
export function describePlan(plan) {
  return plan.order.map((pkg, index) => `${index + 1}/${plan.order.length}  ${pkg.name}@${plan.version}  (packages/${pkg.dir})`)
}

/**
 * Path of the committed release notes for a version.
 * @param {string} rootDir repository root
 * @param {string} version release version, e.g. `0.2.0`
 * @returns {string} absolute path of `docs/releases/v<version>.md`
 */
export function releaseNotesPath(rootDir, version) {
  return join(rootDir, 'docs', 'releases', `v${version}.md`)
}

/**
 * Extract a readable message from an unknown thrown value.
 * @param {unknown} error thrown value
 * @returns {string} its message, or its string form
 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
