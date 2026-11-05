/**
 * E2E control surface for the infini-goal plugin suite.
 *
 * Inserted by absolute filesystem path and only in the suite run (never in the
 * trivial smoke). It is deliberately dependency-free at runtime: it ducks the
 * Host's Cordis context and talks to the suite's own host services through
 * their public service keys, so it does not care which copy of `@deepseek-ai/*`
 * the plugin bundles imported.
 *
 * Services it depends on (loader waits until all three are available):
 *   - `agents`      — `@deepseek-ai/dsh-agent` live Agent registry
 *   - `infiniGoals` — `@yankeguo/dsh-infini-goal` host service
 *   - `webServer`   — `@deepseek-ai/dsh-host-webserver`
 *
 * HTTP routes (plain named routes, not the authenticated `/api` bridge):
 *
 *   GET  /e2e-infini/health
 *        -> { ok, agents: [{ sessionId }], hasInfiniGoals: true }
 *
 *   POST /e2e-infini/create
 *        body { sessionId?, objective, minIntervalMs?, quietWindows?, timezone? }
 *        -> { ok, agentId, view }        (ctx.infiniGoals.create(agent, request))
 *        -> { ok:false, code, message }  (HTTP 400; e.g. INFINI_GOAL_ALREADY_EXISTS)
 *
 *   GET  /e2e-infini/status?sessionId=...
 *        -> { ok, agentId, view, plan, now }   (get + plan; view may be null)
 *
 *   POST /e2e-infini/pause  body { sessionId? }   -> { ok, view }
 *   POST /e2e-infini/resume body { sessionId? }   -> { ok, view }
 *
 * A missing `sessionId` resolves to the first live root agent, so a single-
 * session scenario needs no id plumbing. Round observation stays on the
 * existing Web API (`POST /api/session/events`), which is the same durable log
 * the browser reads.
 */

export const name = 'e2e-control-plugin'

/** The suite's goal service and the agent registry must exist before mounting. */
export const inject = ['agents', 'infiniGoals']

/** Read the JSON request body (bounded, tolerant of empty bodies). */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_048_576) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Resolve the live Agent named by a request, falling back to the first root. */
function findAgent(ctx, sessionId) {
  if (typeof sessionId === 'string' && sessionId !== '') {
    return ctx.agents.get(sessionId)
  }
  const roots = ctx.agents.roots()
  return roots[0] ?? ctx.agents.list()[0]
}

/** Render one error as an HTTP payload. */
function sendError(res, error) {
  const code = typeof error?.code === 'string' ? error.code : 'E2E_CONTROL_ERROR'
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 400, { ok: false, code, message })
}

/** Build the request object a create call accepts, dropping absent fields. */
function createRequest(body) {
  const request = { objective: String(body.objective ?? '') }
  if (body.minIntervalMs !== undefined) request.minIntervalMs = body.minIntervalMs
  if (body.quietWindows !== undefined) request.quietWindows = body.quietWindows
  if (body.timezone !== undefined) request.timezone = body.timezone
  return request
}

/** Register the control routes on the isolated Web server. */
export function apply(ctx) {
  ctx.inject(['webServer'], (injected) => {
    return injected.effect(() => injected.webServer.register({
      kind: 'prefix',
      path: '/e2e-infini',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://e2e.internal')
        try {
          if (req.method === 'GET' && url.pathname === '/e2e-infini/health') {
            sendJson(res, 200, {
              ok: true,
              hasInfiniGoals: true,
              agents: ctx.agents.list().map(agent => ({ id: agent.id })),
              roots: ctx.agents.roots().map(agent => ({ id: agent.id })),
            })
            return
          }
          if (req.method === 'POST' && url.pathname === '/e2e-infini/create') {
            const body = await readJsonBody(req)
            const agent = findAgent(ctx, body.sessionId)
            if (agent === undefined) throw Object.assign(new Error('no live Agent; create a Session first'), { code: 'E2E_NO_AGENT' })
            const view = ctx.infiniGoals.create(agent, createRequest(body))
            sendJson(res, 200, { ok: true, agentId: agent.id, view })
            return
          }
          if (req.method === 'GET' && url.pathname === '/e2e-infini/status') {
            const agent = findAgent(ctx, url.searchParams.get('sessionId') ?? undefined)
            if (agent === undefined) throw Object.assign(new Error('no live Agent; create a Session first'), { code: 'E2E_NO_AGENT' })
            sendJson(res, 200, {
              ok: true,
              agentId: agent.id,
              now: Date.now(),
              view: ctx.infiniGoals.get(agent) ?? null,
              plan: ctx.infiniGoals.plan(agent) ?? null,
            })
            return
          }
          if (req.method === 'POST' && (url.pathname === '/e2e-infini/pause' || url.pathname === '/e2e-infini/resume')) {
            const body = await readJsonBody(req)
            const agent = findAgent(ctx, body.sessionId)
            if (agent === undefined) throw Object.assign(new Error('no live Agent; create a Session first'), { code: 'E2E_NO_AGENT' })
            const view = ctx.infiniGoals.get(agent)
            if (view === undefined) throw Object.assign(new Error('no current infini-goal'), { code: 'E2E_NO_GOAL' })
            const ref = { id: view.id, revision: view.revision }
            const updated = url.pathname.endsWith('/pause')
              ? ctx.infiniGoals.pause(agent, ref)
              : ctx.infiniGoals.resume(agent, ref)
            sendJson(res, 200, { ok: true, agentId: agent.id, view: updated })
            return
          }
          sendJson(res, 404, { ok: false, code: 'E2E_NOT_FOUND', message: `${req.method} ${url.pathname}` })
        } catch (error) {
          sendError(res, error)
        }
      },
    }), 'e2e-control-plugin: /e2e-infini')
  })
}
