#!/usr/bin/env node
/**
 * One-off recovery for Session logs written by dsh-infini-goal 0.1.0.
 *
 * Released 0.1.0 stored every durable goal mutation as a custom
 * `infini-goal/change` Session event. The DeepSeek Harness persisted-Session
 * read path refuses event types outside its own repository-built vocabulary
 * unless the record is marked `ignorable`, so every Session that ever held an
 * infini-goal became unreadable after restart ("refusing to interpret the log —
 * it was likely written by a newer harness").
 *
 * Current builds store the same payload as an ignorable plugin record with the
 * event type `plugin:infini-goal/change` (see `appendPluginRecord` in
 * `@deepseek-ai/dsh-session`), which DSH retains and reloads but never exposes
 * to the model. This tool rewrites the broken rows in an existing
 * `session.v4.jsonl.zstd` log so it can be resumed again. The payload is not
 * changed and no other row is touched.
 *
 * Usage:
 *   node scripts/repair-session-log.mjs --dry-run <session-dir|log-file>...
 *   node scripts/repair-session-log.mjs --write   <session-dir|log-file>...
 *   node scripts/repair-session-log.mjs --dry-run --dsh-home ~/.dsh
 *   node scripts/repair-session-log.mjs --write   --dsh-home ~/.dsh
 *
 * Safety:
 *   - dry-run is the default; writes need --write;
 *   - a timestamped backup of every rewritten log is kept next to it;
 *   - the log is first decoded and validated structurally: only
 *     `infini-goal/change` rows are rewritten, and the tool refuses a log that
 *     contains another event type unknown to this plugin's DSH vocabulary;
 *   - a Session still being written by a running DSH instance must not be
 *     repaired: quit DSH (or close the Session) first. `session.lock` in the
 *     Session directory marks an open Session, and is reported as a warning
 *     (use --force only when you are sure the owning process is gone).
 *
 * Requirements: run `pnpm install` once; Node.js >= 24.9.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/** The broken persisted event type written by dsh-infini-goal 0.1.0. */
const LEGACY_EVENT_TYPE = 'infini-goal/change'

/** The ignorable plugin record type current builds write. */
const RECORD_EVENT_TYPE = 'plugin:infini-goal/change'

/** Physical log file name inside one DSH Session directory. */
const LOG_FILE_NAME = /^session\.v\d+\.jsonl\.zstd$/u

/** Default v4 header shape we understand. */
const SUPPORTED_FORMAT_VERSION = 4

const USAGE = `Usage:
  node scripts/repair-session-log.mjs [--dry-run|--write] [--force] [--json] <session-dir|log-file>...
  node scripts/repair-session-log.mjs [--dry-run|--write] [--force] [--json] --dsh-home <dir>

Options:
  --dry-run         report what would change (default)
  --write           rewrite the logs (timestamped .bak-repair-* backup first)
  --dsh-home <dir>  scan <dir>/sessions/**/session.v4.jsonl.zstd
  --force           repair even when the Session directory still holds a lock file
  --json            machine-readable report on stdout
  -h, --help        show this help

Notes:
  - Quit the DSH instance that owns a Session before repairing it; a running
    Harness may rewrite the log from memory afterwards.
  - Only rows whose event type is "infini-goal/change" are rewritten to the
    ignorable "plugin:infini-goal/change" record; every other byte/row value
    is preserved.
`

/**
 * Parse CLI arguments.
 * @param {string[]} argv - process arguments after the script name.
 */
function parseArgs(argv) {
  const options = { write: false, force: false, json: false, dshHome: undefined, paths: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--dry-run':
        options.write = false
        break
      case '--write':
        options.write = true
        break
      case '--force':
        options.force = true
        break
      case '--json':
        options.json = true
        break
      case '--dsh-home':
        options.dshHome = resolve(expectValue(argv, ++index, '--dsh-home'))
        break
      case '-h':
      case '--help':
        process.stdout.write(USAGE)
        process.exit(0)
        break
      default:
        if (argument.startsWith('--dsh-home=')) {
          options.dshHome = resolve(argument.slice('--dsh-home='.length))
          break
        }
        if (argument.startsWith('-')) throw new Error(`unknown argument: ${argument}`)
        options.paths.push(resolve(argument))
    }
  }
  if (options.dshHome === undefined) options.dshHome = resolve(join(homedir(), '.dsh'))
  if (options.paths.length === 0) options.paths.push(resolve(join(options.dshHome, 'sessions')))
  return options
}

/** Read one `--flag value` pair. */
function expectValue(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('-')) throw new Error(`${flag} needs a value`)
  return value
}

/** Recursively collect every physical session log below one directory. */
function collectLogs(paths) {
  const logs = []
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`path not found: ${path}`)
    const stats = statSync(path)
    if (stats.isFile()) {
      if (!LOG_FILE_NAME.test(basename(path))) throw new Error(`not a session log file: ${path}`)
      logs.push(path)
      continue
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) logs.push(...collectLogs([child]))
      else if (LOG_FILE_NAME.test(entry.name)) logs.push(child)
    }
  }
  return [...new Set(logs)].sort()
}

/**
 * Decode one physical log into its header and raw JSONL rows.
 * @param {string} file - absolute path of `session.v4.jsonl.zstd`.
 */
function decodeLog(file) {
  const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
  const lines = text.split('\n')
  const trailingNewline = text.endsWith('\n')
  if (trailingNewline) lines.pop()
  if (lines.length === 0) throw new Error(`empty session log: ${file}`)
  const headerLine = lines[0]
  const header = JSON.parse(headerLine)
  if (typeof header !== 'object' || header === null || header.version !== SUPPORTED_FORMAT_VERSION) {
    throw new Error(`unsupported session log format (expected v${SUPPORTED_FORMAT_VERSION}): ${file}`)
  }
  return { headerLine, lines, header, trailingNewline }
}

/**
 * Plan and (optionally) apply the repair for one log.
 * @param {string} file - absolute path of the log.
 * @param {boolean} write - whether to rewrite the file.
 * @param {boolean} force - repair even when a Session lock file exists.
 */
function repairLog(file, write, force) {
  const sessionDir = dirname(file)
  const lockFile = join(sessionDir, 'session.lock')
  const locked = existsSync(lockFile)
  const { headerLine, lines, header, trailingNewline } = decodeLog(file)
  const rewritten = []
  const foreignUnknown = []
  const nextLines = [headerLine]
  // `lines` includes the header row; only the event rows are rewritten.
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error(`corrupt session log row at ${file}: ${line.slice(0, 120)}`)
    }
    if (event.type === LEGACY_EVENT_TYPE) {
      const data = event.data
      if (typeof data !== 'object' || data === null || data.kind !== LEGACY_EVENT_TYPE) {
        throw new Error(`event "${LEGACY_EVENT_TYPE}" at seq ${event.seq} does not carry the expected payload (${file})`)
      }
      rewritten.push(event.seq)
      nextLines.push(JSON.stringify({ ...event, type: RECORD_EVENT_TYPE, ignorable: true }))
      continue
    }
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) foreignUnknown.push(event.type)
    nextLines.push(line)
  }
  if (foreignUnknown.length > 0) {
    throw new Error(
      `session log contains other event types unknown to this plugin's DSH vocabulary (${[...new Set(foreignUnknown)].join(', ')}); refusing to repair ${file}`,
    )
  }
  const result = {
    file,
    sessionId: typeof header.id === 'string' ? header.id : undefined,
    locked,
    rewritten,
    totalLines: lines.length,
  }
  if (rewritten.length > 0 && write) {
    if (locked && !force) {
      throw new Error(
        `Session "${result.sessionId ?? file}" still has ${basename(lockFile)} (quit DSH / close the Session first, or pass --force): ${file}`,
      )
    }
    const payload = `${nextLines.join('\n')}${trailingNewline ? '\n' : ''}`
    const file_ = file
    const stamp = new Date().toISOString().replaceAll(':', '-')
    const backup = `${file_}.bak-repair-${stamp}`
    copyFileSync(file_, backup)
    const temporary = `${file_}.repair-tmp-${process.pid}`
    writeFileSync(temporary, zstdCompressSync(Buffer.from(payload, 'utf8')))
    renameSync(temporary, file_)
    result.backup = backup
  }
  return result
}

/** Render one report line. */
function renderLine(result) {
  if (result.rewritten.length === 0) return `SKIP  ${result.file} (no ${LEGACY_EVENT_TYPE} rows)`
  const state = result.backup === undefined ? 'DRY-RUN' : 'REPAIRED'
  const lock = result.locked ? ' [session.lock present]' : ''
  return `${state} ${result.file} — rewrote ${result.rewritten.length} row(s)${lock}`
}

try {
  const options = parseArgs(process.argv.slice(2))
  const logs = collectLogs(options.paths)
  const results = []
  for (const file of logs) results.push(repairLog(file, options.write, options.force))
  if (options.json) {
    console.log(JSON.stringify({ write: options.write, results }, null, 2))
  } else {
    for (const result of results) console.log(renderLine(result))
    const changed = results.filter(result => result.rewritten.length > 0)
    console.log(
      `${options.write ? 'repaired' : 'would repair'} ${changed.length} of ${results.length} session log(s)`,
    )
    if (!options.write && changed.length > 0) {
      console.log('re-run with --write after quitting the DeepSeek Harness instance that owns these Sessions.')
    }
  }
} catch (error) {
  console.error(`repair-session-log: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
