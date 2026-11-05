/**
 * Host half of the trivial E2E fixture plugin.
 *
 * The harness inserts this module by absolute filesystem path through a
 * `--patch` overlay. If the plugin loaded, three independent observations
 * become available:
 *
 *   1. the stderr marker line below (start script greps the host log),
 *   2. `GET /e2e-trivial/health` on the isolated Web server (a named route
 *      registered through `ctx.webServer`, not the SPA fallback), and
 *   3. the config object logged from the patch row, proving patch config
 *      reaches an externally inserted plugin.
 *
 * It also exposes a `Set` on `process` for in-process assertions if a future
 * test host plugin wants to read it.
 */

export const name = 'e2e-trivial-plugin'

/** Services this plugin waits for before registering its HTTP route. */
export const inject = []

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ marker?: string, log?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  const marker = typeof config.marker === 'string' ? config.marker : 'host-loaded'
  process.stderr.write(
    `[e2e-trivial-plugin] host-half loaded pid=${process.pid} marker=${marker} config=${JSON.stringify(config)}\n`,
  )

  ctx.inject(['webServer'], (injected) => {
    return injected.effect(() => injected.webServer.register({
      kind: 'exact',
      path: '/e2e-trivial/health',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, plugin: name, marker, pid: process.pid }))
      },
    }), 'e2e-trivial-plugin: /e2e-trivial/health')
  })
}
