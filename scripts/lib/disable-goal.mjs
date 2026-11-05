#!/usr/bin/env node
/**
 * Shared helpers for the optional "disable the built-in dsh-goal mode" scripts.
 *
 * The shipped Web composition keeps the `goal` SERVICE on the host plane but
 * mounts `command-goal` / `tool-goal` per agent preset. Removing the service
 * makes preset activation fail with `agent-preset/invalid: ... waiting for
 * goals`, so the scripts only:
 *
 *   - disable `goal-round-driver` (no more built-in automatic rounds),
 *   - disable `ui-goal` (no more built-in client GoalBar),
 *   - replace the shipped `preset-standard` / `preset-ptc` / `preset-cordis`
 *     declarations with the same child lists minus `command-goal` and
 *     `tool-goal` (snapshot mode), or disable those shipped declarations and
 *     mount one tiny `preset-filter` row each (dynamic mode).
 *
 * The shipped preset child lists are read from the installed Electron
 * `app.asar` with no third-party dependencies (this repo has neither `asar` nor
 * a YAML parser) — see {@link readAsarText} for the archive layout.
 *
 * Used by:
 *   - scripts/install-profile.mjs (BLOCK_BEGIN, removeGeneratedBlock),
 *   - scripts/disable-builtin-goal.mjs (static + dynamic profile blocks),
 *   - scripts/build-disable-goal-bundle.mjs (committed dynamic bundle patch).
 */
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'

/** First line of the marked block in a profile `cordis.patch.yml`. */
export const BLOCK_BEGIN = '# BEGIN dsh-infini-goal: disable builtin dsh-goal'
/** Last line of the marked block in a profile `cordis.patch.yml`. */
export const BLOCK_END = '# END dsh-infini-goal: disable builtin dsh-goal'
/** Default path of the installed DeepSeek Harness Electron archive. */
export const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/** Presets whose child lists are rewritten (minimal has no goal rows). */
const PRESETS = ['standard', 'ptc', 'cordis']
/** Child rows removed from every rewritten preset declaration. */
const GOAL_ROWS = ['command-goal', 'tool-goal']
/** Directory of the shipped preset patches inside the app.asar archive. */
const ASAR_PRESETS_DIR = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets'
/** Path of the DSH runtime manifest inside the app.asar archive. */
const ASAR_VERSION_FILE = 'dsh/package.json'

/**
 * Read the installed DSH runtime version from `dsh/package.json` inside
 * `app.asar`.
 * @param {string} [appAsar] installed app.asar path
 * @returns {string} DSH runtime version, e.g. `0.2.2-rc.1`
 */
export function readDshVersion(appAsar = DEFAULT_ASAR) {
  const text = readAsarText(appAsar, ASAR_VERSION_FILE)
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    throw new Error(`readDshVersion: ${ASAR_VERSION_FILE} inside ${appAsar} is not valid JSON: ${messageOf(error)}`)
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`readDshVersion: ${ASAR_VERSION_FILE} inside ${appAsar} has no version field`)
  }
  return manifest.version
}

/**
 * Read the shipped preset declaration patches, keyed by preset name.
 *
 * Presets listed in `exclude` are skipped; an excluded-everything result is an
 * empty Map and the caller reports it, while a single unreadable preset throws
 * (a DSH upgrade that renamed a preset must not silently produce a partial
 * patch). The map keeps the shipped preset order (`standard`, `ptc`, `cordis`).
 * @param {{ appAsar?: string, presetsDir?: string, exclude?: string[] }} [options]
 *   `appAsar` installed archive (default {@link DEFAULT_ASAR}), `presetsDir`
 *   unpacked `presets/` directory to read instead, `exclude` preset names
 * @returns {Map<string, string>} preset name -> preset patch YAML text
 */
export function loadPresetPatches({ appAsar = DEFAULT_ASAR, presetsDir, exclude = [] } = {}) {
  const excluded = new Set(exclude)
  const patches = new Map()
  for (const name of PRESETS) {
    if (excluded.has(name)) continue
    try {
      const text = presetsDir === undefined
        ? readAsarText(appAsar, `${ASAR_PRESETS_DIR}/${name}.patch.yml`)
        : readFileSync(join(presetsDir, `${name}.patch.yml`), 'utf8')
      patches.set(name, text)
    } catch (error) {
      const source = presetsDir === undefined ? appAsar : presetsDir
      throw new Error(`loadPresetPatches: could not read shipped preset "${name}" from ${source}: ${messageOf(error)}`)
    }
  }
  return patches
}

/**
 * Build the static snapshot entries: disable the driver and GoalBar, then
 * re-declare every preset without its goal command/tool rows.
 * @param {Map<string, string>} presetPatches preset name -> patch YAML text
 * @returns {string[]} patch lines (no trailing empty line)
 */
export function buildDisableGoalEntries(presetPatches) {
  const lines = [
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

/**
 * Build the dynamic entries: disable the shipped declarations and mount one
 * `preset-filter` row per preset. Matches the committed bundle patch and needs
 * no regeneration after a DSH upgrade.
 * @returns {string[]} patch lines (no trailing empty line)
 */
export function buildDynamicDisableGoalEntries() {
  const lines = [
    '- id: goal-round-driver',
    '  disabled: true',
    '- id: ui-goal',
    '  disabled: true',
  ]
  for (const name of PRESETS) {
    lines.push(`- id: preset-${name}`, '  disabled: true')
  }
  lines.push('- insert:')
  for (const name of PRESETS) {
    lines.push(
      `    - id: preset-${name}-filter`,
      "      name: '@yankeguo/dsh-disable-goal-bundle/preset-filter'",
      '      config:',
      `        preset: ${name}`,
      '        remove: [command-goal, tool-goal]',
    )
  }
  return lines
}

/**
 * Build the dynamic rows for a marked profile-patch block
 * (`scripts/disable-builtin-goal.mjs --dynamic`): the same entries as the
 * companion bundle patch.
 * @returns {string[]} patch lines (no trailing empty line)
 */
export function buildDynamicProfileBlockEntries() {
  return buildDynamicDisableGoalEntries()
}

/**
 * Remove a previously generated marked block, including the blank line that
 * separates it from the rest of the profile patch, leaving the remaining text
 * byte-stable.
 * @param {string} text profile patch text
 * @returns {string} text without the generated block
 */
export function removeGeneratedBlock(text) {
  const begin = text.indexOf(BLOCK_BEGIN)
  if (begin === -1) return text
  const endMarker = text.indexOf(BLOCK_END, begin + BLOCK_BEGIN.length)
  if (endMarker === -1) {
    throw new Error(`removeGeneratedBlock: found ${JSON.stringify(BLOCK_BEGIN)} without ${JSON.stringify(BLOCK_END)}`)
  }
  let start = begin
  // The writer emits `${withoutBlock}\n${block}`, i.e. one blank separator line
  // before the marker; drop it so the result equals the pre-generation text.
  if (begin >= 2 && text.slice(begin - 2, begin) === '\n\n') start = begin - 1
  let end = endMarker + BLOCK_END.length
  if (text[end] === '\r' && text[end + 1] === '\n') end += 2
  else if (text[end] === '\n') end += 1
  return text.slice(0, start) + text.slice(end)
}

/* ------------------------------------------------------------------------- *
 * app.asar reader (Electron "asar" archive format, no third-party deps)
 * ------------------------------------------------------------------------- */

/**
 * Build the child-list part of one preset declaration from its shipped patch.
 *
 * The shipped file is a patch row with a single `- insert:` list entry; its
 * `config:` block is copy/pasted verbatim except that every line is dedented by
 * four spaces (to become the child of a top-level patch entry) and the goal
 * command/tool rows are dropped. All other lines, including `!!js` tags and
 * comments, are kept byte-for-byte.
 * @param {string} presetName shipped preset name
 * @param {string} text shipped preset patch YAML text
 * @returns {string[]} dedented `config:` child lines
 */
function buildPresetConfig(presetName, text) {
  const lines = text.split('\n')
  const configIndex = lines.findIndex(line => line === '      config:')
  if (configIndex < 0) throw new Error(`${presetName}.patch.yml: no "      config:" line found`)
  let body = lines.slice(configIndex + 1)
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  for (const entryId of GOAL_ROWS) {
    if (!body.some(line => line.trim() === `- id: ${entryId}`)) {
      throw new Error(`${presetName}.patch.yml: expected plugin entry "${entryId}" was not found`)
    }
    body = stripEntry(body, entryId)
  }
  return body.map(line => (line.startsWith('    ') ? line.slice(4) : line))
}

/**
 * Drop one `- id: <entryId>` list item and its properties from an indented
 * YAML fragment. Lines of the next sibling item are preserved.
 * @param {string[]} lines fragment lines
 * @param {string} entryId plugin row id to drop
 * @returns {string[]} filtered lines
 */
function stripEntry(lines, entryId) {
  const kept = []
  let index = 0
  while (index < lines.length) {
    const match = /^(\s*)- id: (\S+)\s*$/u.exec(lines[index])
    if (match === null || match[2] !== entryId) {
      kept.push(lines[index])
      index += 1
      continue
    }
    const indent = match[1].length
    index += 1
    while (index < lines.length) {
      const line = lines[index]
      if (line.trim() === '') break
      const lineIndent = /^(\s*)/u.exec(line)[1].length
      if (lineIndent <= indent) break
      index += 1
    }
  }
  return kept
}

/**
 * Read one UTF-8 text file from an Electron `app.asar` archive.
 *
 * Archive layout (all integers little-endian):
 *   - 16-byte header: uint32 pickle size (=4), uint32 header byte size,
 *     uint32 unknown, uint32 JSON byte length;
 *   - the file tree JSON starts at file offset 16 and is `JSON byte length`
 *     long; `dataBase = 8 + header byte size`;
 *   - file entries carry `{ size, offset }`, `offset` relative to `dataBase`
 *     (`offset` may be a decimal string in newer archives), or `unpacked: true`
 *     for content stored next to the archive in `<app.asar>.unpacked/`.
 * @param {string} appAsar installed app.asar path
 * @param {string} innerPath slash-separated path inside the archive
 * @returns {string} file text
 */
function readAsarText(appAsar, innerPath) {
  const archive = openAsar(appAsar)
  try {
    const entry = findAsarEntry(archive.tree, innerPath)
    if (entry === undefined) throw new Error(`"${innerPath}" was not found in the archive`)
    if (entry.files !== undefined) throw new Error(`"${innerPath}" is a directory, not a file`)
    if (entry.unpacked === true) return readFileSync(`${appAsar}.unpacked/${innerPath}`, 'utf8')
    const size = Number(entry.size)
    const offset = Number(entry.offset)
    if (!Number.isInteger(size) || size < 0 || !Number.isInteger(offset) || offset < 0) {
      throw new Error(`"${innerPath}" has an invalid archive entry`)
    }
    const buffer = Buffer.alloc(size)
    readSync(archive.fd, buffer, 0, size, archive.dataBase + offset)
    return buffer.toString('utf8')
  } finally {
    closeSync(archive.fd)
  }
}

/**
 * Parse the header of one `app.asar` archive.
 * @param {string} appAsar archive path
 * @returns {{ fd: number, dataBase: number, tree: { files: Record<string, unknown> } }}
 *   open file descriptor (caller closes it), data block base and file tree
 */
function openAsar(appAsar) {
  let fd
  try {
    fd = openSync(appAsar, 'r')
  } catch (error) {
    throw new Error(
      `could not open the installed DSH app.asar at ${appAsar}: ${messageOf(error)}`
      + ' (pass --app-asar <path>, or --presets-dir <dir> for an unpacked presets directory)',
    )
  }
  try {
    const header = Buffer.alloc(16)
    if (readSync(fd, header, 0, 16, 0) < 16) throw new Error('the file is too short to be an asar archive')
    if (header.readUInt32LE(0) !== 4) throw new Error('unexpected asar header signature')
    const headerSize = header.readUInt32LE(4)
    const jsonLength = header.readUInt32LE(12)
    if (headerSize < 16 || jsonLength <= 0 || jsonLength + 8 > headerSize) {
      throw new Error('unexpected asar header sizes')
    }
    const json = Buffer.alloc(jsonLength)
    readSync(fd, json, 0, jsonLength, 16)
    return { fd, dataBase: 8 + headerSize, tree: JSON.parse(json.toString('utf8')) }
  } catch (error) {
    closeSync(fd)
    throw new Error(`${appAsar} is not a readable asar archive: ${messageOf(error)}`)
  }
}

/**
 * Walk the asar file tree for one path.
 * @param {{ files: Record<string, any> }} tree archive file tree
 * @param {string} innerPath slash-separated path inside the archive
 * @returns {any} file/directory entry, or `undefined`
 */
function findAsarEntry(tree, innerPath) {
  let node = { files: tree.files }
  for (const part of innerPath.split('/')) {
    if (node === undefined || node.files === undefined) return undefined
    node = node.files[part]
  }
  return node
}

/**
 * Render an unknown thrown value as a message.
 * @param {unknown} error thrown value
 * @returns {string} message text
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
