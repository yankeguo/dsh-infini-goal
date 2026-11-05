#!/usr/bin/env node
/**
 * Build every plugin package into its `lib/` directory.
 *
 * Host entries are bundled with esbuild and externalize only `@deepseek-ai/*`
 * packages, which the DSH installation itself resolves at runtime. Workspace
 * packages (`@yankeguo/*`) are inlined so each loaded plugin file is
 * self-contained. Browser entries are bundled the same way and then wrapped in
 * the client-module loader factory format (`window.__ModuleLoader__.load`).
 */
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages')

/** Every plugin package in build order. */
const TARGETS = [
  { dir: 'protocol', entries: ['index', 'client'] },
  { dir: 'infini-goal', entries: ['index'] },
  { dir: 'driver', entries: ['index'] },
  { dir: 'tool', entries: ['index'] },
  { dir: 'command', entries: ['index'] },
  { dir: 'client-ui', entries: ['index'], client: 'client/index' },
  { dir: 'bundle', source: false },
]

/** Shared esbuild options for a Host plugin bundle. */
const HOST_OPTIONS = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  jsx: 'automatic',
  jsxImportSource: 'react',
  legalComments: 'none',
  logLevel: 'warning',
  // The DSH installation resolves official packages at runtime; our own
  // workspace packages are installed alongside the bundle and stay external so
  // one shared protocol/core instance is used instead of per-package copies.
  external: ['@deepseek-ai/*', '@yankeguo/*', 'node:*'],
  banner: { js: '// Built by dsh-infini-goal. Do not edit.' },
}

/** Shared esbuild options for a browser bundle. */
const CLIENT_OPTIONS = {
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110', 'safari16', 'firefox110'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  legalComments: 'none',
  logLevel: 'warning',
  // Platform modules shared by the browser shell through the module table.
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    'zod',
    '@tanstack/react-virtual',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ],
}

/** Read and parse one package manifest. */
async function readManifest(dir) {
  return JSON.parse(await readFile(join(PACKAGES, dir, 'package.json'), 'utf8'))
}

/** Build one Host-side entry point. */
async function buildHostEntry(dir, entry) {
  const outfile = join(PACKAGES, dir, 'lib', `${entry}.js`)
  await build({
    ...HOST_OPTIONS,
    entryPoints: [join(PACKAGES, dir, 'src', `${entry}.ts`)],
    outfile,
  })
  return outfile
}

/** Build the browser bundle and wrap it in the client-module loader format. */
async function buildClientEntry(dir, entry, packageName) {
  const outfile = join(PACKAGES, dir, 'lib', 'client.js')
  const result = await build({
    ...CLIENT_OPTIONS,
    entryPoints: [join(PACKAGES, dir, 'src', `${entry}.tsx`)],
    write: false,
  })
  const code = result.outputFiles[0]?.text
  if (code === undefined) throw new Error(`${dir}: esbuild produced no client output`)
  const wrapped = [
    `window.__ModuleLoader__.load({`,
    `\tid: ${JSON.stringify(packageName)},`,
    `\tfactory: (require) => {`,
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    code.split('\n').map(line => (line.length > 0 ? `\t\t${line}` : line)).join('\n'),
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n')
  await mkdir(dirname(outfile), { recursive: true })
  await writeFile(outfile, wrapped)
  return outfile
}

/** Build one plugin package. */
async function buildPackage(target) {
  const packageDir = join(PACKAGES, target.dir)
  if (!existsSync(packageDir)) {
    console.warn(`skip missing package directory: ${target.dir}`)
    return
  }
  if (target.source === false) return
  const manifest = await readManifest(target.dir)
  await rm(join(packageDir, 'lib'), { recursive: true, force: true })
  await mkdir(join(packageDir, 'lib'), { recursive: true })
  for (const entry of target.entries) {
    if (!existsSync(join(packageDir, 'src', `${entry}.ts`))) {
      console.warn(`skip missing host entry: ${target.dir}/src/${entry}.ts`)
      continue
    }
    const outfile = await buildHostEntry(target.dir, entry)
    console.log(`built ${outfile.slice(ROOT.length + 1)}`)
  }
  if (target.client !== undefined) {
    const browserEntry = join(packageDir, 'src', `${target.client}.tsx`)
    if (!existsSync(browserEntry)) {
      console.warn(`skip missing client entry: ${target.dir}/src/${target.client}.tsx`)
    } else {
      const outfile = await buildClientEntry(target.dir, target.client, manifest.name)
      console.log(`built ${outfile.slice(ROOT.length + 1)}`)
    }
  }
}

for (const target of TARGETS) {
  await buildPackage(target)
}
console.log('build complete')
