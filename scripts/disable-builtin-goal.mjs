#!/usr/bin/env node
/**
 * Disable the built-in dsh-goal mode in a DSH profile so this plugin suite is
 * the only goal system.
 *
 * Why not just disable the `goal` host row? The shipped Web surface keeps the
 * `goals` SERVICE on the host plane and mounts `command-goal` / `tool-goal`
 * per agent preset. Disabling the service makes every preset activation fail
 * with `agent-preset/invalid: ... waiting for goals`. So this helper instead:
 *
 *   - disables `goal-round-driver` (no more built-in automatic rounds),
 *   - disables `ui-goal` (no more built-in GoalBar in the composer),
 *   - overrides the `preset-standard` / `preset-ptc` / `preset-cordis` rows
 *     with a copy of their shipped `config.plugins` minus `command-goal` and
 *     `tool-goal` (no `/goal` command and no get_goal/create_goal/update_goal
 *     tools for new agents).
 *
 * The `goal` service stays mounted (inert): session logs that contain
 * `goal/change` events keep replaying, and preset activation stays valid.
 *
 * Shipped preset definitions come from the installed app.asar, so the helper
 * must run against the same DSH build that owns the profile. Re-run it after a
 * DSH upgrade (`--write` replaces the previously generated block).
 *
 * Usage:
 *   node scripts/disable-builtin-goal.mjs --print
 *   node scripts/disable-builtin-goal.mjs --write \
 *     --profile-patch ~/.dsh/profiles/desktop/cordis.patch.yml
 *   node scripts/disable-builtin-goal.mjs --remove \
 *     --profile-patch ~/.dsh/profiles/desktop/cordis.patch.yml
 *   node scripts/disable-builtin-goal.mjs --print --presets-dir /tmp/dsh-asar/.../presets
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const BEGIN_MARKER = '# BEGIN dsh-infini-goal: disable builtin dsh-goal'
const END_MARKER = '# END dsh-infini-goal: disable builtin dsh-goal'
const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const PRESETS = ['standard', 'ptc', 'cordis']
const GOAL_ROWS = ['command-goal', 'tool-goal']

const USAGE = `Usage:
  node scripts/disable-builtin-goal.mjs --print
  node scripts/disable-builtin-goal.mjs --write --profile-patch <path>
  node scripts/disable-builtin-goal.mjs --remove --profile-patch <path>

Options:
  --print                  print the generated patch block (default)
  --write                  append/replace the generated block in --profile-patch
  --remove                 remove the generated block from --profile-patch
  --profile-patch <path>   profile patch file (default ~/.dsh/profiles/desktop/cordis.patch.yml)
  --app-asar <path>        installed app.asar (default ${DEFAULT_ASAR})
  --presets-dir <path>     read preset patches from a directory instead of app.asar
  --exclude                 comma-separated preset names to skip (default: none)
`

/**
 * Parse `--flag value` options and boolean flags.
 * @param {string[]} argv process arguments
 */
function parseArgs(argv) {
  const options = {
    mode: 'print',
    profilePatch: join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    appAsar: DEFAULT_ASAR,
    presetsDir: undefined,
    exclude: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--print':
        options.mode = 'print'
        break
      case '--write':
        options.mode = 'write'
        break
      case '--remove':
        options.mode = 'remove'
        break
      case '--profile-patch':
        options.profilePatch = resolve(argv[++index])
        break
      case '--app-asar':
        options.appAsar = resolve(argv[++index])
        break
      case '--presets-dir':
        options.presetsDir = resolve(argv[++index])
        break
      case '--exclude':
        options.exclude = argv[++index].split(',').map(name => name.trim()).filter(Boolean)
        break
      case '-h':
      case '--help':
        process.stdout.write(USAGE)
        process.exit(0)
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * Read one text file from the installed app.asar.
 *
 * Electron's Node integration understands asar archives, so spawning the app
 * binary with ELECTRON_RUN_AS_NODE reads inside app.asar without extracting it.
 * @param {string} appAsar absolute app.asar path
 * @param {string} innerPath path relative to the asar root
 * @returns {string} file text
 */
function readFromAsar(appAsar, innerPath) {
  const appPath = dirname(dirname(appAsar))
  const executable = join(appPath, 'MacOS', 'DeepSeek Harness')
  const script = `const fs = require('node:fs'); process.stdout.write(fs.readFileSync(${JSON.stringify(join(appAsar, innerPath))}, 'utf8'))`
  const result = spawnSync(executable, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`could not read ${innerPath} from ${appAsar}: ${result.stderr || result.error}`)
  }
  return result.stdout
}

/**
 * Collect the shipped preset patch files.
 * @param {{ presetsDir?: string, appAsar: string }} options
 * @returns {Map<string, string>} preset name -> patch text
 */
function loadPresetPatches(options) {
  const texts = new Map()
  for (const name of PRESETS) {
    if (options.exclude.includes(name)) continue
    const text = options.presetsDir === undefined
      ? readFromAsar(options.appAsar, `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/${name}.patch.yml`)
      : readFileSync(join(options.presetsDir, `${name}.patch.yml`), 'utf8')
    texts.set(name, text)
  }
  return texts
}

/**
 * Remove one `- id: <entryId>` plugin entry (and its `name:` line) from an
 * indented YAML fragment.
 * @param {string[]} lines fragment lines
 * @param {string} entryId entry id to drop
 * @returns {string[]} filtered lines
 */
function stripEntry(lines, entryId) {
  const kept = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === `- id: ${entryId}`) {
      index += 1
      if (index < lines.length && lines[index].trim().startsWith('name:')) index += 1
      continue
    }
    kept.push(line)
    index += 1
  }
  return kept
}

/**
 * Build the replacement `config:` block for one preset declaration: everything
 * after the row's `config:` line, dedented by four spaces (so it becomes a
 * child of a top-level patch entry), minus the goal command/tool entries.
 * @param {string} presetName shipped preset name
 * @param {string} text shipped preset patch text
 * @returns {string[]} dedented config lines
 */
function buildPresetConfig(presetName, text) {
  const lines = text.split('\n')
  const configIndex = lines.findIndex(line => line === '      config:')
  if (configIndex < 0) throw new Error(`${presetName}.patch.yml: no "      config:" line found`)
  let body = lines.slice(configIndex + 1)
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  // Sanity: the shipped preset file must contain the goal rows we expect.
  for (const entry of GOAL_ROWS) {
    if (!body.some(line => line.trim() === `- id: ${entry}`)) {
      throw new Error(`${presetName}.patch.yml: expected plugin entry "${entry}" was not found`)
    }
    body = stripEntry(body, entry)
  }
  return body.map(line => (line.startsWith('    ') ? line.slice(4) : line))
}

/**
 * Render the complete generated patch block (without markers).
 * @param {Map<string, string>} presetPatches shipped preset patches
 * @returns {string[]} patch lines
 */
function buildBlock(presetPatches) {
  const lines = [
    '# Disable the built-in dsh-goal mode so the infini-goal suite is the only',
    '# goal system. The `goal` service itself stays mounted: shipped Web surfaces',
    '# mount command-goal/tool-goal per agent preset, and removing the service',
    '# makes preset activation fail with "waiting for goals".',
    '#',
    '# Generated by scripts/disable-builtin-goal.mjs; re-run it after a DSH upgrade.',
    '- id: goal-round-driver',
    '  disabled: true',
    '- id: ui-goal',
    '  disabled: true',
  ]
  for (const [name, text] of presetPatches) {
    lines.push('', `# preset ${name} without command-goal / tool-goal`)
    lines.push(`- id: preset-${name}`)
    lines.push("  name: '@deepseek-ai/dsh-agent-preset'")
    lines.push('  config:')
    lines.push(...buildPresetConfig(name, text))
  }
  return lines
}

/** Remove the previously generated block (between markers) from a patch text. */
function removeBlock(text) {
  const begin = text.indexOf(BEGIN_MARKER)
  if (begin < 0) return text
  const end = text.indexOf(END_MARKER, begin)
  if (end < 0) throw new Error('generated block starts but has no END marker; repair the profile patch by hand')
  let after = end + END_MARKER.length
  if (text[after] === '\n') after += 1
  return text.slice(0, begin).replace(/\n+$/, '\n') + text.slice(after)
}

/** Run the requested mode. */
function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.mode === 'remove') {
    if (!existsSync(options.profilePatch)) throw new Error(`profile patch not found: ${options.profilePatch}`)
    const text = readFileSync(options.profilePatch, 'utf8')
    if (!text.includes(BEGIN_MARKER)) {
      console.log('no generated block found; nothing to remove')
      return
    }
    backup(options.profilePatch)
    writeFileSync(options.profilePatch, removeBlock(text))
    console.log(`removed generated block from ${options.profilePatch}`)
    return
  }

  const presetPatches = loadPresetPatches(options)
  if (presetPatches.size === 0) throw new Error('all presets were excluded; nothing to generate')
  const block = [BEGIN_MARKER, ...buildBlock(presetPatches), END_MARKER].join('\n') + '\n'

  if (options.mode === 'print') {
    process.stdout.write(block)
    return
  }

  if (!existsSync(options.profilePatch)) throw new Error(`profile patch not found: ${options.profilePatch}`)
  const original = readFileSync(options.profilePatch, 'utf8')
  const withoutBlock = removeBlock(original).replace(/\n+$/, '\n')
  backup(options.profilePatch)
  writeFileSync(options.profilePatch, `${withoutBlock}\n${block}`)
  console.log(`wrote generated block to ${options.profilePatch}`)
}

/** Back up a file before rewriting it. */
function backup(path) {
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const target = `${path}.bak-disable-goal-${stamp}`
  copyFileSync(path, target)
  console.log(`backed up ${path} -> ${target}`)
}

try {
  main()
} catch (error) {
  console.error(`disable-builtin-goal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
