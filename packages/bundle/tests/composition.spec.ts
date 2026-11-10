/**
 * Keep the two generated "disable the built-in dsh-goal" bundle patches and the
 * bundle manifests wired together.
 *
 * `@yankeguo/dsh-infini-goal-bundle` embeds the disable layer by default
 * (`dsh.bundle.patch` lists `./cordis.disable-goal.patch.yml` after
 * `./cordis.patch.yml`), and `@yankeguo/dsh-disable-goal-bundle` keeps shipping
 * the same layer standalone. Both files are rendered by
 * `scripts/build-disable-goal-bundle.mjs` from one builder; the shared row ids
 * are a safety property, not duplication: a profile that still enables both
 * bundles composes duplicate insert rows, and the DSH Loader keeps one entry per
 * id (the last row wins), so the preset filters mount exactly once. Distinct ids
 * would mount two filters per preset and fail with "Duplicate agent preset".
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Repository root (this spec lives in `packages/bundle/tests/`). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MAIN_PATCH = join(ROOT, 'packages', 'bundle', 'cordis.patch.yml')
const MAIN_DISABLE_PATCH = join(ROOT, 'packages', 'bundle', 'cordis.disable-goal.patch.yml')
const COMPANION_PATCH = join(ROOT, 'packages', 'disable-goal-bundle', 'cordis.patch.yml')
const MAIN_MANIFEST = join(ROOT, 'packages', 'bundle', 'package.json')
const GENERATOR = join(ROOT, 'scripts', 'build-disable-goal-bundle.mjs')

/**
 * Drop comment and blank lines, so the two generated files' identical YAML rows
 * compare equal while their header comments stay target-specific.
 * @param text - patch file text
 * @returns the row lines
 */
function rowLines(text: string): string[] {
  return text.split('\n').filter(line => line.trim() !== '' && !line.startsWith('#'))
}

/** The main bundle's manifest fields this spec relies on. */
interface MainManifest {
  dsh?: { bundle?: { patch?: unknown } }
  dependencies?: Record<string, string>
  files?: string[]
  exports?: Record<string, string>
}

/**
 * Read and parse the main bundle's manifest.
 * @returns the parsed manifest fields the composition relies on
 */
function readMainManifest(): MainManifest {
  return JSON.parse(readFileSync(MAIN_MANIFEST, 'utf8')) as MainManifest
}

describe('bundle composition', () => {
  it('embeds exactly the companion bundle rows in the main bundle', () => {
    expect(rowLines(readFileSync(MAIN_DISABLE_PATCH, 'utf8')))
      .toEqual(rowLines(readFileSync(COMPANION_PATCH, 'utf8')))
  })

  it('disables the built-in goal rows and mounts one filter per shipped preset', () => {
    const rows = rowLines(readFileSync(MAIN_DISABLE_PATCH, 'utf8')).join('\n')
    for (const id of ['goal-round-driver', 'ui-goal', 'preset-standard', 'preset-ptc', 'preset-cordis']) {
      expect(rows).toContain(`- id: ${id}\n  disabled: true`)
    }
    for (const id of ['preset-standard-filter', 'preset-ptc-filter', 'preset-cordis-filter']) {
      expect(rows).toContain(`- id: ${id}`)
    }
    expect(rows).toContain("name: '@yankeguo/dsh-disable-goal-bundle/preset-filter'")
  })

  it('applies the main rows before the embedded disable layer', () => {
    expect(readMainManifest().dsh?.bundle?.patch)
      .toEqual(['./cordis.patch.yml', './cordis.disable-goal.patch.yml'])
  })

  it('ships the generated patch file and the module its rows import', () => {
    const manifest = readMainManifest()
    expect(manifest.files).toContain('cordis.disable-goal.patch.yml')
    expect(manifest.exports?.['./cordis.disable-goal.patch.yml']).toBe('./cordis.disable-goal.patch.yml')
    expect(manifest.dependencies?.['@yankeguo/dsh-disable-goal-bundle']).toBeDefined()
    // The main patch file itself stays hand-written next to the generated layer.
    expect(readFileSync(MAIN_PATCH, 'utf8')).toContain("- id: infini-goal\n      name: '@yankeguo/dsh-infini-goal'")
  })

  it('keeps the generated patches and manifests up to date', () => {
    expect(() => execFileSync(process.execPath, [GENERATOR, '--check'], { cwd: ROOT, stdio: 'pipe' })).not.toThrow()
  })
})
