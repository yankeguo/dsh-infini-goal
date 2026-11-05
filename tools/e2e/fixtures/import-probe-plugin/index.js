/**
 * E2E risk probe: does the isolated DSH Host resolve and mount a plugin inserted
 * by ABSOLUTE FILESYSTEM PATH whose host half imports `@deepseek-ai/*` runtime
 * packages?
 *
 * This is the integration shape of the real plugin suite: built ESM bundles are
 * inserted by absolute path (see `scripts/dev-patch.mjs`) and legitimately import
 * `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, ...
 * Those packages are installed in the *repo's* node_modules (pnpm), not in the
 * DSH installation. The DSH launcher installs its own process-local ESM/CJS
 * resolver ("runtime resolution") over Node's resolvers, so the question is
 * which copy wins for an importer outside the installation and whether the
 * imported symbols still interoperate with the Host's Context/Service identity.
 *
 * The plugin answers that empirically and exposes the findings on
 * `GET /e2e-import-probe/health`, plus stderr markers for the boot log.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'e2e-import-probe-plugin'

/**
 * Resolve a bare package specifier from this module, through whatever ESM
 * resolver hooks the launcher installed, without importing it again.
 * @param {string} specifier
 */
function resolveUrl(specifier) {
  try {
    return import.meta.resolve(specifier)
  } catch (error) {
    return `resolve-error: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** True when this URL lives inside the repo checkout's pnpm store. */
function isRepoCopy(url) {
  return typeof url === 'string' && url.includes('/node_modules/.pnpm/@deepseek-ai+')
}

/** True when this URL lives inside the DSH installation (app.asar/runtime). */
function isInstallationCopy(url) {
  if (typeof url !== 'string') return false
  let decoded = url
  try {
    decoded = decodeURI(url)
  } catch {
    /* keep the raw URL */
  }
  return decoded.includes('DeepSeek Harness.app') || decoded.includes('app.asar') || decoded.includes('/tmp/dsh-asar/')
}

/**
 * Run the import/probe checks once per mounted plugin.
 * @param {unknown} ctx - the Host plugin context handed to apply().
 */
async function runProbe(ctx) {
  /** @type {Record<string, unknown>} */
  const report = {
    plugin: name,
    pid: process.pid,
    // Identity: the imported Context class must be the one the Host constructed.
    contextIdentity: ctx instanceof Context,
    ctxConstructor: typeof ctx?.constructor?.name === 'string' ? ctx.constructor.name : typeof ctx,
    // Resolution: where did the launcher's resolver send each bare import?
    resolution: {
      cordis: resolveUrl('@deepseek-ai/cordis'),
      'dsh-llm': resolveUrl('@deepseek-ai/dsh-llm'),
      'dsh-session': resolveUrl('@deepseek-ai/dsh-session'),
    },
    checks: {},
  }
  report.resolutionFromRepoCopy = isRepoCopy(report.resolution.cordis)
  report.resolutionFromInstallation = isInstallationCopy(report.resolution.cordis)

  /** @type {Record<string, unknown>} */
  const checks = report.checks
  // 1) A runtime function imported from dsh-llm must produce a valid message.
  try {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'e2e import probe' }],
      source: { kind: 'user' },
    })
    checks.createUserMessage = message?.role === 'user'
      && typeof message.id === 'string'
      && message.content?.[0]?.text === 'e2e import probe'
  } catch (error) {
    checks.createUserMessage = `error: ${error instanceof Error ? error.message : String(error)}`
  }
  // 2) A brand helper from dsh-session must be callable.
  try {
    const id = SessionId('session-e2e-probe')
    checks.sessionIdBrand = typeof id === 'string' && id === 'session-e2e-probe'
  } catch (error) {
    checks.sessionIdBrand = `error: ${error instanceof Error ? error.message : String(error)}`
  }
  // 3) A Service subclass imported from the runtime cordis copy must mount into
  //    the Host's Context tree and be retrievable by service key.
  try {
    class ImportProbeService extends Service {
      /**
       * @param {import('@deepseek-ai/cordis').Context} serviceCtx
       */
      constructor(serviceCtx) {
        super(serviceCtx, 'e2eImportProbeService')
        this.payload = { mounted: true, from: 'import-probe-plugin' }
      }
    }
    // Await the fiber so the constructor (and therefore ctx.provide) has run.
    await ctx.plugin(ImportProbeService)
    const resolved = ctx.get('e2eImportProbeService')
    checks.serviceMount = resolved?.payload?.mounted === true
    checks.serviceSameCordis = resolved instanceof ImportProbeService
  } catch (error) {
    checks.serviceMount = `error: ${error instanceof Error ? error.message : String(error)}`
  }

  report.ok = report.contextIdentity === true
    && checks.createUserMessage === true
    && checks.sessionIdBrand === true
    && checks.serviceMount === true
  return report
}

export async function apply(ctx) {
  const report = await runProbe(ctx)
  process.stderr.write(`[e2e-import-probe-plugin] ${JSON.stringify(report)}\n`)

  ctx.inject(['webServer'], (injected) => {
    return injected.effect(() => injected.webServer.register({
      kind: 'exact',
      path: '/e2e-import-probe/health',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(report))
      },
    }), 'e2e-import-probe-plugin: /e2e-import-probe/health')
  })
}
