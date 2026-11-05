#!/usr/bin/env bash
# Boot the isolated DSH Web instance plus the deterministic mock LLM.
#
#   tools/e2e/start-web.sh [extra-patch.yml ...]
#
# Every extra positional patch is appended to the launcher's `--patch` overlays
# after the generated ones, so a plugin suite under test can add/replace rows
# of the isolated profile without touching the shipped profile files:
#
#   tools/e2e/start-web.sh /tmp/plugin-suite.patch.yml
#
# On success state is written under ${DSH_E2E_ROOT}/state:
#   web.pid, web.url (tokenized readiness URL), llm.pid, llm.port, cookie
# and the logs under ${DSH_E2E_ROOT}/logs.
set -euo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

EXTRA_PATCHES=()
for arg in "$@"; do
  case "${arg}" in
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "e2e start: unknown option ${arg}" >&2; exit 2 ;;
    *) EXTRA_PATCHES+=("${arg}") ;;
  esac
done

e2e_assert_ports
e2e_require_launcher
e2e_mkdirs

# A partial start (bad overlay, port race, failed readiness) must not leak the
# processes this script already spawned. Only clear the trap after success.
E2E_START_OK=0
cleanup_failed_start() {
  local code=$?
  if (( code != 0 && E2E_START_OK == 0 )); then
    "${E2E_DIR}/stop-web.sh" >/dev/null 2>&1 || true
  fi
  return "${code}"
}
trap cleanup_failed_start EXIT

if [[ -f "${STATE_DIR}/web.pid" ]] && kill -0 "$(cat "${STATE_DIR}/web.pid" 2>/dev/null || echo 0)" 2>/dev/null; then
  echo "e2e: Web instance already running (pid $(cat "${STATE_DIR}/web.pid")); run stop-web.sh first" >&2
  exit 1
fi
# Clean stale state from an interrupted previous run.
rm -f "${STATE_DIR}/web.pid" "${STATE_DIR}/llm.pid" "${STATE_DIR}/web.url" "${STATE_DIR}/llm.port" "${STATE_DIR}/cookie"

eprofile="${DSH_HOME}/profiles/${DSH_E2E_PROFILE}"
if [[ ! -f "${eprofile}/cordis.patch.yml" ]]; then
  echo "e2e: profile '${DSH_E2E_PROFILE}' missing; running bootstrap.sh"
  "${E2E_DIR}/bootstrap.sh"
fi
e2e_require_file "${CONFIG_DIR}/mock-llm.patch.yml"
e2e_require_file "${CONFIG_DIR}/isolation.patch.yml"
e2e_require_file "${CONFIG_DIR}/trivial-plugin.patch.yml"

e2e_assert_ports_free

SCENARIO="${DSH_E2E_SCENARIO:-${CONFIG_DIR}/scenario.json}"
if [[ ! -f "${SCENARIO}" ]]; then
  echo "e2e: scenario file not found: ${SCENARIO}" >&2
  exit 2
fi

# Validate every extra overlay before spawning anything, so a typo cannot leak
# a mock-LLM process.
PATCH_ARGS=(
  --patch "${CONFIG_DIR}/mock-llm.patch.yml"
  --patch "${CONFIG_DIR}/isolation.patch.yml"
  --patch "${CONFIG_DIR}/trivial-plugin.patch.yml"
)
if (( ${#EXTRA_PATCHES[@]} > 0 )); then
  for extra in "${EXTRA_PATCHES[@]}"; do
    e2e_require_file "${extra}"
    PATCH_ARGS+=(--patch "${extra}")
  done
fi

# ------------------------------------------------------------- mock LLM ----
echo "e2e: starting mock LLM on http://${DSH_E2E_HOST}:${DSH_E2E_LLM_PORT}"
: >"${LOG_DIR}/mock-llm.log"
: >"${LOG_DIR}/mock-llm-requests.jsonl"
(
  cd "${WORKSPACE_DIR}"
  exec "${DSH_E2E_NODE}" "${E2E_DIR}/mock-llm.mjs" \
    --host "${DSH_E2E_HOST}" \
    --port "${DSH_E2E_LLM_PORT}" \
    --scenario "${SCENARIO}" \
    --log "${LOG_DIR}/mock-llm-requests.jsonl"
) >"${LOG_DIR}/mock-llm.log" 2>&1 &
echo $! >"${STATE_DIR}/llm.pid"
echo "${DSH_E2E_LLM_PORT}" >"${STATE_DIR}/llm.port"

if ! e2e_wait_http "http://${DSH_E2E_HOST}:${DSH_E2E_LLM_PORT}/health" 20; then
  echo "e2e: mock LLM did not become ready; see ${LOG_DIR}/mock-llm.log" >&2
  tail -n 40 "${LOG_DIR}/mock-llm.log" >&2 || true
  "${E2E_DIR}/stop-web.sh" || true
  exit 1
fi

# --------------------------------------------------------- DSH web boot ----
echo "e2e: booting DSH profile '${DSH_E2E_PROFILE}' with DSH_HOME=${DSH_HOME}"
: >"${LOG_DIR}/web.log"
(
  cd "${WORKSPACE_DIR}"
  exec env \
    DSH_HOME="${DSH_HOME}" \
    DSH_PERMISSION_MODE=danger-full-access \
    MOCK_LLM_API_KEY=sk-e2e-placeholder \
    NO_COLOR=1 \
    "${DSH_BIN}" "${DSH_E2E_PROFILE}" \
    "${PATCH_ARGS[@]}" \
    --no-open \
    --host "${DSH_E2E_HOST}" \
    --port "${DSH_E2E_WEB_PORT}"
) >"${LOG_DIR}/web.log" 2>&1 &
echo $! >"${STATE_DIR}/web.pid"

# The URL line printed after the Loader tree settles is the readiness signal:
#   dsh web: http://127.0.0.1:<port>/?token=<launch-token>
if ! e2e_wait_log_line "${LOG_DIR}/web.log" 'dsh web: http://' 180 "dsh web readiness"; then
  echo "e2e: DSH web failed to start; see ${LOG_DIR}/web.log" >&2
  "${E2E_DIR}/stop-web.sh" || true
  exit 1
fi

WEB_URL="$(grep -Eo 'dsh web: http://[^[:space:]]+' "${LOG_DIR}/web.log" | tail -n 1 | sed -E 's/^dsh web: //')"
echo "${WEB_URL}" >"${STATE_DIR}/web.url"

# Exchange the launch token for the signed browser cookie once, so scripts and
# the browser MCP check share the same documented login procedure.
"${DSH_E2E_NODE}" --input-type=module -e '
  const { login } = await import(process.argv[1])
  const { writeFileSync } = await import("node:fs")
  const { origin, cookie } = await login(process.argv[2])
  writeFileSync(process.argv[3], cookie)
  console.log("e2e: authenticated " + origin)
' "${E2E_DIR}/lib/web-client.mjs" "${WEB_URL}" "${STATE_DIR}/cookie" || {
  echo "e2e: token login failed; see ${LOG_DIR}/web.log" >&2
  "${E2E_DIR}/stop-web.sh" || true
  exit 1
}

# Host fixture route proves an externally inserted host plugin activated.
if [[ "${DSH_E2E_INCLUDE_TRIVIAL_PLUGIN:-1}" == "1" ]]; then
  if ! e2e_wait_http "http://${DSH_E2E_HOST}:${DSH_E2E_WEB_PORT}/e2e-trivial/health" 10; then
    echo "e2e: fixture host plugin route not reachable (/e2e-trivial/health)" >&2
    tail -n 60 "${LOG_DIR}/web.log" >&2 || true
    "${E2E_DIR}/stop-web.sh" || true
    exit 1
  fi
fi

echo "e2e: DSH web ready"
echo "e2e:   url      ${WEB_URL}"
echo "e2e:   logs     ${LOG_DIR}/web.log"
echo "e2e:   mock log ${LOG_DIR}/mock-llm-requests.jsonl"
echo "e2e:   stop with tools/e2e/stop-web.sh"

E2E_START_OK=1
