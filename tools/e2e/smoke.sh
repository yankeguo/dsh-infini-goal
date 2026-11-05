#!/usr/bin/env bash
# One-shot end-to-end smoke test of the isolated harness.
#
# Proves, against the installed DSH 0.2.2-rc.1 runtime and without any real
# model API token:
#
#   1. an isolated DSH_HOME under /tmp boots the shipped `web` composition on a
#      port >= 34000 and prints its tokenized readiness URL,
#   2. a plugin inserted by ABSOLUTE FILESYSTEM PATH mounts in the Host
#      (GET /e2e-trivial/health) and in the Browser
#      (window.__DSH_BOOT__ contains the package and its client bundle is served),
#   3. a Session is created and prompted through the same browser-facing Web
#      API, the deterministic mock LLM streams a scripted answer, a scripted
#      tool call round-trips through the bash tool, and the Turn/Step/tool
#      events are observed in the durable Session log,
#   4. the instance shuts down cleanly and only harness-spawned PIDs are used.
#
# Usage:
#   tools/e2e/smoke.sh            # fresh run, stops the instance at the end
#   DSH_E2E_KEEP_RUNNING=1 tools/e2e/smoke.sh   # keep the instance for browser checks
set -euo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

SMOKE_DIR="${DSH_E2E_ROOT}/smoke"
WEB_BASE="http://${DSH_E2E_HOST}:${DSH_E2E_WEB_PORT}"

PASS_STEPS=0
step() { PASS_STEPS=$((PASS_STEPS + 1)); printf '\n=== [%d] %s ===\n' "${PASS_STEPS}" "$*"; }
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

cleanup() {
  local code=$?
  if [[ "${DSH_E2E_KEEP_RUNNING:-0}" == "1" ]]; then
    echo ""
    echo "e2e: DSH_E2E_KEEP_RUNNING=1 — leaving the isolated instance running"
    echo "e2e:   browser URL: $(cat "${STATE_DIR}/web.url" 2>/dev/null || echo '<not started>')"
    echo "e2e:   stop with:  ${E2E_DIR}/stop-web.sh"
    return 0
  fi
  "${E2E_DIR}/stop-web.sh" >/dev/null 2>&1 || true
  return "${code}"
}
trap cleanup EXIT

# ---------------------------------------------------------------- clean ---
step "bootstrap fresh isolated harness"
"${E2E_DIR}/bootstrap.sh" --fresh
mkdir -p "${SMOKE_DIR}"
[[ "${DSH_HOME}" == /tmp/* ]] || fail "DSH_HOME must stay under /tmp, got ${DSH_HOME}"
[[ -f "${DSH_HOME}/profiles/${DSH_E2E_PROFILE}/cordis.patch.yml" ]] || fail "custom profile was not created"
echo "PASS isolated home=${DSH_HOME} profile=${DSH_E2E_PROFILE}"

# ----------------------------------------------------------------- boot ---
step "boot isolated DSH web + mock LLM"
"${E2E_DIR}/start-web.sh"
WEB_URL="$(cat "${STATE_DIR}/web.url")"
[[ "${WEB_URL}" == http://*"/?token="* ]] || fail "readiness URL lacks the launch token: ${WEB_URL}"
echo "PASS readiness url=${WEB_URL}"
grep -q "dsh web:" "${LOG_DIR}/web.log" || fail "no readiness line in web.log"

# ----------------------------------------------------- host plugin + boot ---
step "host plugin inserted by absolute path is live"
HEALTH="$(curl -fsS "${WEB_BASE}/e2e-trivial/health")" || fail "fixture host route unreachable"
echo "PASS ${HEALTH}"
echo "${HEALTH}" | grep -q '"plugin":"e2e-trivial-plugin"' || fail "unexpected host fixture payload: ${HEALTH}"

step "client plugin is present in window.__DSH_BOOT__ and its bundle is served"
"${DSH_E2E_NODE}" "${E2E_DIR}/probe-web.mjs" \
  --state-dir "${STATE_DIR}" \
  --assert-client-entry e2e-trivial-plugin \
  --assert-client-bundle e2e-trivial-plugin \
  --assert-host-route /e2e-trivial/health \
  --print-entries >"${SMOKE_DIR}/probe-web.log" 2>&1 || {
    cat "${SMOKE_DIR}/probe-web.log" >&2
    fail "probe-web assertions failed"
  }
grep -q 'PASS client entry e2e-trivial-plugin' "${SMOKE_DIR}/probe-web.log" || fail "boot graph assertion missing"
grep -q 'PASS client bundle e2e-trivial-plugin' "${SMOKE_DIR}/probe-web.log" || fail "client bundle assertion missing"
grep -E 'e2e-trivial-plugin' "${SMOKE_DIR}/probe-web.log" | sed 's/^/  /'
echo "PASS window.__DSH_BOOT__ includes e2e-trivial-plugin"

# --------------------------------------------------- scripted text turn ---
step "create a Session and run a scripted text turn through the Web API"
"${DSH_E2E_NODE}" "${E2E_DIR}/run-session.mjs" \
  --state-dir "${STATE_DIR}" \
  --cwd "${WORKSPACE_DIR}" \
  --prompt "hello from the isolated e2e harness" \
  --expect-assistant "MOCK E2E first turn" \
  --expect '"turn/end"' \
  --events-out "${SMOKE_DIR}/events-text.json" \
  --json >"${SMOKE_DIR}/session-text.json" 2>"${SMOKE_DIR}/session-text.err" || {
    cat "${SMOKE_DIR}/session-text.err" >&2
    cat "${SMOKE_DIR}/session-text.json" >&2
    fail "scripted text turn failed"
  }
grep -q '"MOCK E2E first turn"' "${SMOKE_DIR}/session-text.json" || fail "mock text answer missing from turn report"
echo "PASS assistant text: MOCK E2E first turn"

# --------------------------------------------------- scripted tool turn ---
step "run a scripted tool-call turn (mock LLM -> bash tool -> mock LLM)"
"${DSH_E2E_NODE}" "${E2E_DIR}/run-session.mjs" \
  --state-dir "${STATE_DIR}" \
  --cwd "${WORKSPACE_DIR}" \
  --prompt "please run the deterministic tool" \
  --expect-assistant "MOCK E2E final turn" \
  --expect '"tool/call"' \
  --expect "e2e-tool-ok" \
  --events-out "${SMOKE_DIR}/events-tool.json" \
  --json >"${SMOKE_DIR}/session-tool.json" 2>"${SMOKE_DIR}/session-tool.err" || {
    cat "${SMOKE_DIR}/session-tool.err" >&2
    cat "${SMOKE_DIR}/session-tool.json" >&2
    fail "scripted tool turn failed"
  }
grep -q '"MOCK E2E final turn"' "${SMOKE_DIR}/session-tool.json" || fail "mock final answer missing"
"${DSH_E2E_NODE}" -e '
  const fs = require("node:fs")
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  const call = (report.toolCalls ?? []).find(entry => entry.name === "bash")
  const result = (report.toolResults ?? []).find(entry => String(entry.text).includes("e2e-tool-ok"))
  if (call === undefined) throw new Error("no bash tool/call event")
  if (result === undefined) throw new Error("no successful bash tool/result carrying e2e-tool-ok")
  if (result.isError) throw new Error("bash tool/result reported an error")
  console.log(`  tool call: ${call.name} ${call.arguments}`)
  console.log(`  tool result: ${JSON.stringify(result.text)} isError=${result.isError}`)
' "${SMOKE_DIR}/session-tool.json" || fail "tool-call evidence check failed"
grep -q 'assistant/message' "${SMOKE_DIR}/events-tool.json" || fail "events dump missing assistant/message"
echo "PASS tool call round-trip observed in the Session log"

# ------------------------------------------------------------- mock log ---
step "mock LLM request log matches the scripted sequence"
"${DSH_E2E_NODE}" -e '
  const fs = require("node:fs")
  const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  if (lines.length !== 3) throw new Error(`expected 3 mock requests, got ${lines.length}`)
  const kinds = lines.map(entry => entry.stepKind)
  if (JSON.stringify(kinds) !== JSON.stringify(["text", "tool_call", "text"])) throw new Error(`unexpected step kinds: ${kinds}`)
  if (lines[2].hasToolResult !== true) throw new Error("third mock request did not carry the tool result")
  const firstPrompt = (lines[0].userTexts ?? []).join("\n")
  if (!firstPrompt.includes("hello from the isolated e2e harness")) throw new Error("first mock request lost the prompt")
  console.log(`  requests=${lines.length} kinds=${kinds.join(",")} toolResult=${lines[2].hasToolResult}`)
' "${LOG_DIR}/mock-llm-requests.jsonl" || fail "mock LLM request log assertion failed"
echo "PASS deterministic mock sequence consumed exactly once per model request"

# ---------------------------------------------------------------- stop ---
step "clean shutdown of harness-spawned processes"
WEB_PID="$(cat "${STATE_DIR}/web.pid")"
LLM_PID="$(cat "${STATE_DIR}/llm.pid")"
"${E2E_DIR}/stop-web.sh"
kill -0 "${WEB_PID}" 2>/dev/null && fail "web pid ${WEB_PID} still alive after stop"
kill -0 "${LLM_PID}" 2>/dev/null && fail "mock llm pid ${LLM_PID} still alive after stop"
for _ in $(seq 1 100); do
  e2e_port_free "${DSH_E2E_WEB_PORT}" && e2e_port_free "${DSH_E2E_LLM_PORT}" && break
  sleep 0.1
done
e2e_port_free "${DSH_E2E_WEB_PORT}" || fail "web port ${DSH_E2E_WEB_PORT} still bound"
e2e_port_free "${DSH_E2E_LLM_PORT}" || fail "mock LLM port ${DSH_E2E_LLM_PORT} still bound"
echo "PASS stopped both harness processes and released both ports"

# ------------------------------------------------------------- summary ---
step "summary"
echo "SMOKE PASS (${PASS_STEPS} steps)"
echo "  isolated home : ${DSH_HOME}"
echo "  profile       : ${DSH_E2E_PROFILE} (from shipped web template)"
echo "  web URL       : ${WEB_URL}"
echo "  artifacts     : ${SMOKE_DIR}"
