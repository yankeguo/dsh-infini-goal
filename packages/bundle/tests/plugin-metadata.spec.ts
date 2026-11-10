/**
 * Cross-package guard for the DSH plugin display metadata.
 *
 * DSH resolves `${specifier}/locale/en.json` through the package `exports`,
 * reads every sibling `*.json` in that locale directory as a translation, and
 * validates `meta.title` / `meta.description` as non-empty strings, falling
 * back to the package.json `name` / `description` when a locale field is
 * missing. The assertions therefore live in one cross-package spec: every
 * shipped plugin must carry both locales, publish them through `files` and
 * `exports`, and keep its manifest description in sync with the canonical
 * English description.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Repository root (this spec lives in `packages/bundle/tests/`). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** One published plugin package: its workspace directory and npm name. */
interface PluginPackage {
  /** Directory name under `packages/`. */
  dir: string
  /** Published npm package name. */
  name: string
}

/** Every package that must ship DSH plugin display metadata. */
const PACKAGES: PluginPackage[] = [
  { dir: 'protocol', name: '@yankeguo/dsh-infini-goal-protocol' },
  { dir: 'infini-goal', name: '@yankeguo/dsh-infini-goal' },
  { dir: 'driver', name: '@yankeguo/dsh-infini-goal-driver' },
  { dir: 'tool', name: '@yankeguo/dsh-tool-infini-goal' },
  { dir: 'command', name: '@yankeguo/dsh-command-infini-goal' },
  { dir: 'client-ui', name: '@yankeguo/dsh-client-ui-infini-goal' },
  { dir: 'bundle', name: '@yankeguo/dsh-infini-goal-bundle' },
  { dir: 'disable-goal-bundle', name: '@yankeguo/dsh-disable-goal-bundle' },
]

/** Locale ids every plugin must translate. */
const LOCALES = ['en', 'zh'] as const

/** One locale id every plugin must translate. */
type LocaleId = (typeof LOCALES)[number]

/** The locale file names DSH accepts (`en.json`, `zh.json`, `pt-BR.json`, ...). */
const LOCALE_FILE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*\.json$/

/** English marketing superlatives a user-facing description must not contain. */
const SUPERLATIVES_EN = [
  'best',
  'powerful',
  'seamless',
  'ultimate',
  'revolutionary',
  'cutting-edge',
  'world-class',
  'amazing',
  'effortless',
  'one-click',
  'game-changing',
]

/** Chinese marketing superlatives a user-facing description must not contain. */
const SUPERLATIVES_ZH = ['最佳', '最强', '领先', '完美', '极致', '颠覆', '神器', '一键', '震撼', '顶级']

/** The display strings DSH reads from one locale document. */
interface LocaleMeta {
  /** Plugin display title. */
  title: string
  /** Plugin display description. */
  description: string
}

/** The package.json fields this spec inspects. */
interface PackageManifest {
  name?: unknown
  description?: unknown
  files?: unknown
  exports?: unknown
}

/**
 * Read one JSON file.
 * @param path - absolute file path
 * @returns the parsed JSON value
 */
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

/**
 * Read one package's package.json.
 * @param pkg - expected plugin package
 * @returns the parsed manifest fields the spec relies on
 */
function readManifest(pkg: PluginPackage): PackageManifest {
  return readJson(join(ROOT, 'packages', pkg.dir, 'package.json')) as PackageManifest
}

/**
 * Read and validate one locale document, so a malformed file fails here with
 * its path instead of surfacing as a confusing later assertion.
 * @param pkg - expected plugin package
 * @param locale - locale id
 * @returns the validated display title and description
 */
function readLocaleMeta(pkg: PluginPackage, locale: LocaleId): LocaleMeta {
  const path = join(ROOT, 'packages', pkg.dir, 'locale', `${locale}.json`)
  expect(existsSync(path), `missing locale file: ${path}`).toBe(true)
  const document = readJson(path)
  expect(document, `${path} must be a JSON object`).not.toBeNull()
  expect(document, `${path} must be a JSON object`).toBeTypeOf('object')
  expect(Array.isArray(document), `${path} must be a JSON object`).toBe(false)
  const meta = (document as Record<string, unknown>).meta
  expect(meta, `${path}#meta must be an object`).not.toBeNull()
  expect(meta, `${path}#meta must be an object`).toBeTypeOf('object')
  expect(Array.isArray(meta), `${path}#meta must be an object`).toBe(false)
  const fields = meta as Record<string, unknown>
  const title = fields.title
  const description = fields.description
  expect(title, `${path}#meta.title must be a string`).toBeTypeOf('string')
  expect(description, `${path}#meta.description must be a string`).toBeTypeOf('string')
  const titleText = title as string
  const descriptionText = description as string
  expect(titleText.trim(), `${path}#meta.title must not be blank`).not.toBe('')
  expect(descriptionText.trim(), `${path}#meta.description must not be blank`).not.toBe('')
  return { title: titleText, description: descriptionText }
}

/**
 * Build a case-insensitive whole-word matcher for one forbidden English term.
 * @param term - literal English term
 * @returns a regex matching the term as a whole word
 */
function wholeWord(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'i')
}

describe('plugin metadata', () => {
  it('keeps the expected package list in sync with packages/', () => {
    const dirs = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(dirs).toEqual(PACKAGES.map(pkg => pkg.dir).sort())
  })

  for (const pkg of PACKAGES) {
    describe(`${pkg.dir} (${pkg.name})`, () => {
      it('exists as a package directory with the expected npm name', () => {
        const dir = join(ROOT, 'packages', pkg.dir)
        expect(existsSync(dir), `missing package directory: ${dir}`).toBe(true)
        expect(statSync(dir).isDirectory()).toBe(true)
        expect(readManifest(pkg).name, `${pkg.dir}/package.json#name`).toBe(pkg.name)
      })

      it('ships both locales with a non-empty meta title and description', () => {
        for (const locale of LOCALES) {
          const meta = readLocaleMeta(pkg, locale)
          expect(meta.title.trim(), `${pkg.dir}/locale/${locale}.json#meta.title`).not.toBe('')
          expect(meta.description.trim(), `${pkg.dir}/locale/${locale}.json#meta.description`).not.toBe('')
        }
      })

      it('names every locale JSON file the way DSH accepts', () => {
        const localeDir = join(ROOT, 'packages', pkg.dir, 'locale')
        const files = readdirSync(localeDir).filter(file => file.endsWith('.json'))
        for (const file of files) {
          expect(file, `${pkg.dir}/locale/${file} must be a valid DSH locale file name`).toMatch(LOCALE_FILE)
        }
        expect(files, `${pkg.dir}/locale must ship en.json`).toContain('en.json')
        expect(files, `${pkg.dir}/locale must ship zh.json`).toContain('zh.json')
      })

      it('publishes the locale files and keeps the package.json export', () => {
        const manifest = readManifest(pkg)
        expect(Array.isArray(manifest.files), `${pkg.dir}/package.json#files must be an array`).toBe(true)
        expect(manifest.files, `${pkg.dir}/package.json#files must include locale/*.json`).toContain('locale/*.json')
        const exportsField = manifest.exports
        expect(exportsField, `${pkg.dir}/package.json#exports must be an object`).not.toBeNull()
        expect(exportsField, `${pkg.dir}/package.json#exports must be an object`).toBeTypeOf('object')
        const exportsMap = exportsField as Record<string, unknown>
        expect(exportsMap['./locale/*.json'], `${pkg.dir}/package.json#exports`).toBe('./locale/*.json')
        expect(exportsMap['./package.json'], `${pkg.dir}/package.json#exports`).toBe('./package.json')
      })

      it('keeps package.json description in sync with locale/en.json', () => {
        const canonical = readLocaleMeta(pkg, 'en').description
        expect(readManifest(pkg).description, `${pkg.dir}/package.json#description`).toBe(canonical)
      })

      it('uses a user-friendly title', () => {
        const scopedName = pkg.name.toLowerCase()
        const bareName = scopedName.replace(/^@[^/]+\//, '')
        for (const locale of LOCALES) {
          const { title } = readLocaleMeta(pkg, locale)
          expect(title, `${pkg.dir}/locale/${locale}.json#meta.title must not include '@'`).not.toContain('@')
          expect(
            title.toLowerCase().startsWith('dsh-'),
            `${pkg.dir}/locale/${locale}.json#meta.title must not start with 'dsh-'`,
          ).toBe(false)
          expect(
            title.toLowerCase(),
            `${pkg.dir}/locale/${locale}.json#meta.title must not include the package name`,
          ).not.toContain(scopedName)
          expect(
            title.toLowerCase(),
            `${pkg.dir}/locale/${locale}.json#meta.title must not include the bare package name`,
          ).not.toContain(bareName)
        }
      })

      it('avoids marketing superlatives in its descriptions', () => {
        const en = readLocaleMeta(pkg, 'en').description.toLowerCase()
        for (const term of SUPERLATIVES_EN) {
          expect(en, `${pkg.dir} English description must not use "${term}"`).not.toMatch(wholeWord(term))
        }
        const zh = readLocaleMeta(pkg, 'zh').description
        for (const term of SUPERLATIVES_ZH) {
          expect(zh, `${pkg.dir} Chinese description must not use "${term}"`).not.toContain(term)
        }
      })
    })
  }
})
