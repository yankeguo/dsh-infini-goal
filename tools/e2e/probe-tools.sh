#!/usr/bin/env bash
# Tools proof: the model → tool → ctx.infiniGoals path.
#
# Boots the isolated suite composition (host packages + control plugin) with the
# mock LLM scripted to emit a `create_infini_goal` tool call for the first model
# request, then runs probe-tools.mjs:
#
#   human prompt -> model streams a create_infini_goal tool call
#                -> the bash-free tool executes ctx.infiniGoals.create
#                -> tool result returns to the model
#                -> model streams the scripted final text
#
# Assertions: request/header advertises get/create/update_infini_goal; the
# tool/call executed without error; the goal exists with the scripted objective.
#
# Usage: tools/e2e/probe-tools.sh
# Requires: repo `pnpm build` + `node scripts/dev-patch.mjs` (suite.sh does both,
# or run them manually). Uses DSH_E2E_* env (root/ports) like the other scripts.
set -euo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

SUITE_PATCH="${REPO_ROOT}/.tmp/cordis.patch.yml"

cleanup() {
  local code=$?
  if [[ "${DSH_E2E_KEEP_RUNNING:-0}" == "1" ]]; then
    echo "e2e tools: keeping the isolated instance running: $(cat "${STATE_DIR}/web.url" 2>/dev/null || true)"
    return 0
  fi
  "${E2E_DIR}/stop-web.sh" >/dev/null 2>&1 || true
  return "${code}"
}
trap cleanup EXIT

[[ -f "${REPO_ROOT}/packages/infini-goal/lib/index.js" ]] || {
  echo "e2e tools: built suite missing; run (cd ${REPO_ROOT} && pnpm build)" >&2; exit 2
}
[[ -f "${SUITE_PATCH}" ]] || {
  echo "e2e tools: ${SUITE_PATCH} missing; run (cd ${REPO_ROOT} && node scripts/dev-patch.mjs)" >&2; exit 2
}

"${E2E_DIR}/bootstrap.sh" >/dev/null
"${E2E_DIR}/link-repo-root.sh" >/dev/null
mkdir -p "${DSH_E2E_ROOT}/smoke"

cat >"${CONFIG_DIR}/control-plugin.patch.yml" <<EOF
- insert:
    - id: e2e-control-plugin
      name: ${E2E_DIR}/fixtures/e2e-control-plugin/index.js
EOF
cat >"${CONFIG_DIR}/scenario-tools.json" <<'EOF'
{
  "responses": [
    {
      "kind": "tool_call",
      "tool": "create_infini_goal",
      "arguments": { "objective": "E2E model tool goal via scripted mock" }
    },
    { "kind": "text", "text": "MODEL TOOL GOAL CREATED" }
  ]
}
EOF

DSH_E2E_SCENARIO="${CONFIG_DIR}/scenario-tools.json" \
  "${E2E_DIR}/start-web.sh" "${SUITE_PATCH}" "${CONFIG_DIR}/control-plugin.patch.yml" >/dev/null

echo "e2e tools: isolated suite instance ready: $(cat "${STATE_DIR}/web.url")"
"${DSH_E2E_NODE}" "${E2E_DIR}/probe-tools.mjs" \
  --state-dir "${STATE_DIR}" \
  --workspace "${WORKSPACE_DIR}" \
  --objective "E2E model tool goal via scripted mock" 2>&1 | tee "${DSH_E2E_ROOT}/smoke/probe-tools.log"
grep -q 'PROBE TOOLS PASS' "${DSH_E2E_ROOT}/smoke/probe-tools.log" || {
  echo "e2e tools: FAIL — see ${DSH_E2E_ROOT}/smoke/probe-tools.log" >&2
  exit 1
}
