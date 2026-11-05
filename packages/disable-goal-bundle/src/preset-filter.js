/**
 * Companion preset filter for @yankeguo/dsh-disable-goal-bundle.
 *
 * The built-in goal mode lives inside the shipped agent presets: the Web
 * composition keeps the `goal` service on the host plane and mounts
 * `command-goal` / `tool-goal` per preset. A profile patch cannot target those
 * child rows (they are config data, not Loader rows), and a preset row's
 * `config` cannot be computed with `!!js`: `@deepseek-ai/dsh-agent-preset` is an
 * entry-group carrier, so the Loader deliberately preserves its config
 * expressions unevaluated.
 *
 * This plugin therefore replaces one shipped preset row with a tiny row:
 * the bundle patch disables `preset-<id>` and inserts a row running this file
 * with `{ preset: '<id>', remove: ['command-goal', 'tool-goal'] }`. At boot we
 * read the *installed* shipped preset declaration through the Loader's own
 * module resolution (works inside app.asar), filter its child list, and mount
 * the real `@deepseek-ai/dsh-agent-preset` as a child with that config. Nothing
 * is copied, so DSH upgrades need no patch regeneration.
 *
 * @module @yankeguo/dsh-disable-goal-bundle/preset-filter
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'

/** Plugin name reported to the Cordis loader. */
export const name = 'infini-goal-preset-filter'

/** The Loader service supplies module resolution and the composition base URL. */
export const inject = ['loader']

/** Default child rows removed from every shipped preset. */
const DEFAULT_REMOVE = ['command-goal', 'tool-goal']

/**
 * Resolve one package manifest URL through the Loader's own resolver, which
 * also understands the packaged app.asar and the installation runtime graph.
 * @param {import('@deepseek-ai/cordis').Context} ctx entry context
 * @param {string} specifier package specifier to resolve
 * @returns {URL} resolved manifest URL
 */
function resolveManifest(ctx, specifier) {
  const loader = ctx.get('loader')
  if (loader === undefined) throw new Error(`${name}: the loader service is unavailable`)
  const internal = loader.internal
  const parentUrl = ctx.baseUrl ?? `file://${process.cwd()}/`
  const result = internal.version === 'v2'
    ? internal.resolveSync(parentUrl, { specifier, attributes: {} })
    : internal.resolveSync(specifier, parentUrl, {})
  return new URL(result.url)
}

/**
 * Parse a shipped preset patch file with the include YAML dialect, keeping
 * `!!js` child expressions as expression nodes for their own plugins.
 * @param {URL} manifest `@deepseek-ai/dsh-web-app/package.json` URL
 * @param {string} presetId shipped preset id
 * @returns {any} the preset declaration's `config` object
 */
function readShippedDeclaration(manifest, presetId) {
  const yaml = createRequire(new URL('./preset-filter.cjs', manifest))('yaml')
  const file = new URL(`presets/${presetId}.patch.yml`, manifest)
  const text = readFileSync(file, 'utf8')
  // yaml v2 custom scalar tag: resolve() returns the constructed value directly.
  const jsExprTag = {
    tag: 'tag:yaml.org,2002:js',
    resolve: (value) => ({ __jsExpr: value }),
    identify: (value) => value instanceof Object && '__jsExpr' in value,
  }
  const patches = yaml.parse(text, { customTags: [jsExprTag] })
  const rows = Array.isArray(patches) ? patches.flatMap(patch => patch?.insert ?? []) : []
  const declaration = rows.find(row => row
    && row.name === '@deepseek-ai/dsh-agent-preset'
    && row.config !== null
    && typeof row.config === 'object'
    && row.config.id === presetId)
  if (declaration === undefined) {
    throw new Error(`${name}: shipped preset "${presetId}" was not found in @deepseek-ai/dsh-web-app`)
  }
  return declaration.config
}

/**
 * Mount a copy of one shipped preset without the requested child rows.
 * @param {import('@deepseek-ai/cordis').Context} ctx entry context
 * @param {{ preset?: string, remove?: string[] }} [config] target preset and rows
 */
export function apply(ctx, config = {}) {
  const presetId = config.preset
  if (typeof presetId !== 'string' || presetId.length === 0) {
    throw new Error(`${name}: config.preset is required`)
  }
  const remove = new Set(Array.isArray(config.remove) ? config.remove : DEFAULT_REMOVE)
  const declaration = readShippedDeclaration(resolveManifest(ctx, '@deepseek-ai/dsh-web-app/package.json'), presetId)
  const plugins = declaration.plugins.filter(row => !(row && remove.has(row.id)))
  ctx.plugin(AgentPreset, { ...declaration, plugins })
}
