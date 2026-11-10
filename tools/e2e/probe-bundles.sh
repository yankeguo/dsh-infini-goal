#!/usr/bin/env bash
# Bundle-packaging regression: installing the main bundle ALONE must switch
# DSH's built-in `dsh-goal` mode off by default, and a profile that still
# selects the legacy companion bundle must keep working after the upgrade.
#
# Mechanism under test: `@yankeguo/dsh-infini-goal-bundle` declares
#   dsh.bundle.patch: ["./cordis.patch.yml", "./cordis.disable-goal.patch.yml"]
# where the generated second file carries EXACTLY the same rows (and the same
# row ids) as the legacy companion `@yankeguo/dsh-disable-goal-bundle`.
# Installing the main bundle alone therefore disables `goal-round-driver`,
# `ui-goal` and the three shipped preset declarations, and mounts one
# `preset-*-filter` row per preset that re-mounts the shipped preset with
# `command-goal`/`tool-goal` removed.
#
# How the Loader handles the resulting duplicate ids (when both bundles are
# enabled) is the tolerated-caveat part of the contract:
#   - the composed config keeps one row per insert (no dedupe at composition);
#   - the Loader keeps ONE mounted entry per id (last row wins, no error);
# so the preset filters mount exactly once. Distinct ids would register two
# agent presets with the same preset id and log "Duplicate agent preset".
#
# Two phases against a fresh isolated DSH_HOME under ${DSH_E2E_ROOT} (/tmp):
#
#   Phase A — main bundle only (the new default):
#     A1 `bootstrap.sh --fresh`
#     A2 `node scripts/install-profile.mjs --dsh-home <scratch> --profile e2e`
#     A3 migration: manually select the legacy companion immediately before the
#        main bundle (the shape of a profile installed before this change),
#        rerun install-profile.mjs: it must exit 0, print
#        "deselected @yankeguo/dsh-disable-goal-bundle", leave only the main
#        bundle selected, and the composed config must have no duplicate ids
#     A4 `--disable-builtin-goal` is accepted as a deprecated no-op with a notice
#     A5 installed main bundle: ordered two-file patch layer, generated file
#        shipped, companion package still installed as a runtime dependency
#     A6 boot-free `dsh <profile> --dump-config`: five infini-goal rows and the
#        three preset-filter rows mounted once each, five built-in-goal rows
#        disabled, every top-level row id unique
#     A7 boot the isolated Web instance: no plugin load/startup errors and no
#        "waiting for goals"; the boot graph has the infini-goal client row and
#        NOT the built-in goal client row; probe-install.mjs passes and
#        `commands/list` has no `/goal` while the model tool list has no
#        `get_goal`/`create_goal`/`update_goal`
#
#   Phase B — main bundle + legacy companion both enabled (upgrade path of a
#   profile installed before this change):
#     B1 put the companion back immediately before the main bundle
#     B2 `--dump-config`: exit 0, exactly 2 rows for each of the three
#        preset-*-filter ids (tolerated duplicate ids), disable overrides and
#        infini-goal rows still present
#     B3 boot: same runtime behavior as Phase A, no `plugin tree failed` /
#        `StartupError` / `inactive entry` / `Duplicate agent preset` /
#        `waiting for goals` in web.log; probe-install.mjs passes
#
# The composed duplicate preset-filter rows become `unaddressable` in the
# Plugins page (per-row switch locked) — that is a documented caveat, not a
# test failure; this script asserts runtime behavior and log cleanliness only.
#
# Usage:
#   pnpm build                     # once: build artifacts the install path links
#   tools/e2e/probe-bundles.sh
#   DSH_E2E_KEEP_RUNNING=1 tools/e2e/probe-bundles.sh   # keep the phase-B instance
#
# Artifacts: ${DSH_E2E_ROOT}/bundles/ (one log per step).
# Requires: repo built (`pnpm build`), the packaged launcher, ports >= 34000 free.
# This script only ever touches the isolated DSH_HOME below ${DSH_E2E_ROOT}.
set -euo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

MAIN_BUNDLE='@yankeguo/dsh-infini-goal-bundle'
COMPANION_BUNDLE='@yankeguo/dsh-disable-goal-bundle'
BUNDLES_DIR="${DSH_E2E_ROOT}/bundles"
CONTROL_PATCH="${CONFIG_DIR}/control-plugin.patch.yml"
SCENARIO="${CONFIG_DIR}/scenario-bundles.json"
PROFILE_DIR="${DSH_HOME}/profiles/${DSH_E2E_PROFILE}"
HELPER="${E2E_DIR}/probe-bundles.mjs"

# Every pattern is a plugin-composition or built-in-goal failure signature: web.log
# must contain none of them in either phase.
LOG_ERROR_PATTERN='plugin tree failed|StartupError|Duplicate agent preset|waiting for goals|agent-preset/invalid|inactive entry|failed to (load|import|start) plugin'

PASS_COUNT=0
FAIL_COUNT=0
FAILED_CHECKS=()

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo "PASS $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_CHECKS+=("$*"); echo "FAIL $*" >&2; }

cleanup() {
  local code=$?
  if [[ "${DSH_E2E_KEEP_RUNNING:-0}" == "1" ]]; then
    return "${code}"
  fi
  "${E2E_DIR}/stop-web.sh" >/dev/null 2>&1 || true
  return "${code}"
}
trap cleanup EXIT

# ------------------------------------------------------------- preflight ----
[[ -f "${REPO_ROOT}/packages/infini-goal/lib/index.js" ]] || {
  echo "e2e bundles: built host packages missing; run (cd ${REPO_ROOT} && pnpm build)" >&2
  exit 2
}
[[ -f "${REPO_ROOT}/packages/disable-goal-bundle/lib/preset-filter.js" ]] || {
  echo "e2e bundles: built preset-filter module missing; run (cd ${REPO_ROOT} && pnpm build)" >&2
  exit 2
}
[[ -f "${REPO_ROOT}/scripts/install-profile.mjs" ]] || {
  echo "e2e bundles: scripts/install-profile.mjs missing" >&2
  exit 2
}
e2e_require_file "${E2E_DIR}/fixtures/e2e-control-plugin/index.js"
e2e_require_file "${HELPER}"
e2e_require_launcher
e2e_assert_ports

# ------------------------------------------------------------------ helpers --

# Boot-free composition dump: `dsh <profile> --dump-config` under the scratch home.
dump_config() {
  local label="$1" dump="$2" err="$3"
  if ( cd "${WORKSPACE_DIR}" && DSH_HOME="${DSH_HOME}" "${DSH_BIN}" "${DSH_E2E_PROFILE}" --dump-config ) >"${dump}" 2>"${err}"; then
    pass "${label}: --dump-config exits 0"
  else
    fail "${label}: --dump-config failed (exit non-zero, see ${err})"
    tail -n 20 "${err}" >&2 || true
    return 1
  fi
  local rows
  rows="$(grep -c '^- id: ' "${dump}" || true)"
  if [[ -s "${dump}" ]]; then
    pass "${label}: --dump-config wrote the composed config (${rows} top-level rows)"
  else
    fail "${label}: --dump-config wrote no config"
  fi
  if [[ ! -s "${err}" ]]; then
    pass "${label}: --dump-config wrote nothing to stderr"
  elif grep -Eiq 'error|failed|duplicate|invalid|not found' "${err}"; then
    fail "${label}: --dump-config reported errors on stderr"
    sed 's/^/  /' "${err}"
  else
    pass "${label}: --dump-config stderr carries warnings only"
    sed 's/^/  /' "${err}"
  fi
  return 0
}

# Run the Node assertion helper and fold its PASS/FAIL lines into the summary.
run_config_assertions() {
  local phase="$1" label="$2" dump="$3" log="$4"
  local args=(--phase "${phase}" --profile-dir "${PROFILE_DIR}" --dump "${dump}")
  if [[ "${phase}" == "a" ]]; then
    args+=(--repo-root "${REPO_ROOT}")
  fi
  if "${DSH_E2E_NODE}" "${HELPER}" "${args[@]}" >"${log}" 2>&1; then
    local passed
    passed="$(grep -c '^PASS ' "${log}" || true)"
    PASS_COUNT=$((PASS_COUNT + passed))
    sed 's/^/  /' "${log}"
    return 0
  fi
  local passed failed
  passed="$(grep -c '^PASS ' "${log}" || true)"
  failed="$(grep -c '^FAIL ' "${log}" || true)"
  PASS_COUNT=$((PASS_COUNT + passed))
  FAIL_COUNT=$((FAIL_COUNT + failed))
  FAILED_CHECKS+=("${label}: profile/composition assertions")
  sed 's/^/  /' "${log}"
  return 0
}

# Boot the installed composition with only the observability control plugin.
boot_phase() {
  local label="$1" prefix="$2"
  cat >"${CONTROL_PATCH}" <<EOF
# Generated by tools/e2e/probe-bundles.sh — observability only.
- insert:
    - id: e2e-control-plugin
      name: ${E2E_DIR}/fixtures/e2e-control-plugin/index.js
EOF
  printf '{"responses": []}\n' >"${SCENARIO}"
  local log="${BUNDLES_DIR}/${prefix}-start-web.log"
  if DSH_E2E_SCENARIO="${SCENARIO}" "${E2E_DIR}/start-web.sh" "${CONTROL_PATCH}" >"${log}" 2>&1; then
    pass "${label}: isolated Web instance booted ($(cat "${STATE_DIR}/web.url"))"
    return 0
  fi
  fail "${label}: isolated Web instance failed to boot (see ${log})"
  tail -n 40 "${log}" >&2 || true
  "${E2E_DIR}/stop-web.sh" >/dev/null 2>&1 || true
  return 1
}

# Runtime assertions on the running instance: log hygiene, boot graph, installed API.
run_runtime_assertions() {
  local label="$1" prefix="$2"
  local errors
  errors="$(grep -Ein "${LOG_ERROR_PATTERN}" "${LOG_DIR}/web.log" 2>/dev/null || true)"
  if [[ -z "${errors}" ]]; then
    pass "${label}: web.log has no plugin load/startup/duplicate-preset errors"
  else
    fail "${label}: web.log contains a plugin load/startup/duplicate-preset error"
    printf '%s\n' "${errors}" | head -n 20 >&2
  fi

  local web_log="${BUNDLES_DIR}/${prefix}-probe-web.log"
  if "${DSH_E2E_NODE}" "${E2E_DIR}/probe-web.mjs" \
    --state-dir "${STATE_DIR}" \
    --assert-client-entry @yankeguo/dsh-client-ui-infini-goal \
    --assert-client-bundle @yankeguo/dsh-client-ui-infini-goal \
    --assert-no-client-entry @deepseek-ai/dsh-client-ui-goal \
    >"${web_log}" 2>&1; then
    pass "${label}: boot graph has the infini-goal client row and no built-in goal client row"
  else
    fail "${label}: boot-graph client assertions failed (see ${web_log})"
  fi
  if grep -Eq '^PASS ' "${web_log}"; then
    grep -E '^PASS ' "${web_log}" | sed 's/^/  /'
  fi
  if grep -Eq '^FAIL ' "${web_log}"; then
    grep -E '^FAIL ' "${web_log}" >&2
  fi

  local install_log="${BUNDLES_DIR}/${prefix}-probe-install.log"
  if "${DSH_E2E_NODE}" "${E2E_DIR}/probe-install.mjs" \
    --state-dir "${STATE_DIR}" \
    --workspace "${WORKSPACE_DIR}" \
    --assert-no-command goal \
    --assert-no-tool get_goal \
    --assert-no-tool create_goal \
    --assert-no-tool update_goal \
    >"${install_log}" 2>&1; then
    pass "${label}: installed-composition probe passes; /goal command and built-in goal tools are absent"
  else
    fail "${label}: installed-composition probe failed (see ${install_log})"
  fi
  if grep -Eq '^PASS |^PROBE INSTALL PASS' "${install_log}"; then
    grep -E '^PASS |^PROBE INSTALL PASS' "${install_log}" | sed 's/^/  /'
  fi
  if grep -Eq '^FAIL |^PROBE INSTALL FAIL' "${install_log}"; then
    grep -E '^FAIL |^PROBE INSTALL FAIL' "${install_log}" >&2
  fi
}

# One full runtime phase: boot, assert, stop (keep the last phase on request).
run_phase() {
  local label="$1" prefix="$2" keep="${3:-0}"
  if ! boot_phase "${label}" "${prefix}"; then
    return 0
  fi
  run_runtime_assertions "${label}" "${prefix}"
  # Keep each phase's host log: the next start-web.sh truncates ${LOG_DIR}/web.log.
  cp "${LOG_DIR}/web.log" "${BUNDLES_DIR}/${prefix}-web.log" 2>/dev/null || true
  if [[ "${DSH_E2E_KEEP_RUNNING:-0}" == "1" && "${keep}" == "1" ]]; then
    echo "e2e bundles: DSH_E2E_KEEP_RUNNING=1 — leaving the phase-B instance running: $(cat "${STATE_DIR}/web.url" 2>/dev/null || echo '<none>')"
    return 0
  fi
  "${E2E_DIR}/stop-web.sh" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------- phase A ----
echo "e2e bundles: root       ${DSH_E2E_ROOT}"
echo "e2e bundles: DSH_HOME   ${DSH_HOME}"
echo "e2e bundles: profile    ${DSH_E2E_PROFILE}"
echo "e2e bundles: web port   ${DSH_E2E_WEB_PORT}"
echo "e2e bundles: llm port   ${DSH_E2E_LLM_PORT}"
echo
echo "=== Phase A — main bundle only (default install) ==="

echo "--- A1 prepare a fresh isolated DSH_HOME (bootstrap.sh --fresh) ---"
if BOOTSTRAP_OUT="$("${E2E_DIR}/bootstrap.sh" --fresh 2>&1)"; then
  mkdir -p "${BUNDLES_DIR}"
  printf '%s\n' "${BOOTSTRAP_OUT}" >"${BUNDLES_DIR}/phase-a-bootstrap.log"
  pass "A1: bootstrap --fresh prepared ${DSH_HOME}"
else
  printf '%s\n' "${BOOTSTRAP_OUT:-}" >&2 || true
  echo "e2e bundles: FAIL — bootstrap.sh --fresh failed" >&2
  exit 1
fi
mkdir -p "${BUNDLES_DIR}"

echo "--- A2 user-facing install (scripts/install-profile.mjs) ---"
if ( cd "${REPO_ROOT}" && "${DSH_E2E_NODE}" scripts/install-profile.mjs \
  --dsh-home "${DSH_HOME}" --profile "${DSH_E2E_PROFILE}" ) >"${BUNDLES_DIR}/phase-a-install.log" 2>&1; then
  pass "A2: node scripts/install-profile.mjs succeeded"
  grep -E '^(linked|enabled|kept|note|built-in)' "${BUNDLES_DIR}/phase-a-install.log" | head -n 20 | sed 's/^/  /' || true
else
  fail "A2: node scripts/install-profile.mjs failed"
  tail -n 40 "${BUNDLES_DIR}/phase-a-install.log" >&2 || true
fi

echo "--- A3 migration: deselect a legacy companion selection ---"
if "${DSH_E2E_NODE}" "${HELPER}" --edit-add-legacy-companion --profile-dir "${PROFILE_DIR}" \
  >"${BUNDLES_DIR}/phase-a-migration-edit.log" 2>&1; then
  pass "A3: simulated pre-change profile selects ${COMPANION_BUNDLE} immediately before ${MAIN_BUNDLE}"
  sed 's/^/  /' "${BUNDLES_DIR}/phase-a-migration-edit.log"
else
  fail "A3: could not simulate the pre-change profile shape"
  cat "${BUNDLES_DIR}/phase-a-migration-edit.log" >&2 || true
fi
if ( cd "${REPO_ROOT}" && "${DSH_E2E_NODE}" scripts/install-profile.mjs \
  --dsh-home "${DSH_HOME}" --profile "${DSH_E2E_PROFILE}" ) \
  >"${BUNDLES_DIR}/phase-a-migration-install.log" 2>&1; then
  pass "A3: rerunning install-profile.mjs on the pre-change profile exits 0"
else
  fail "A3: rerunning install-profile.mjs on the pre-change profile failed"
  tail -n 40 "${BUNDLES_DIR}/phase-a-migration-install.log" >&2 || true
fi
if grep -qF "deselected ${COMPANION_BUNDLE}" "${BUNDLES_DIR}/phase-a-migration-install.log"; then
  pass "A3: install-profile.mjs reports 'deselected ${COMPANION_BUNDLE}'"
  grep -F "deselected ${COMPANION_BUNDLE}" "${BUNDLES_DIR}/phase-a-migration-install.log" | sed 's/^/  /'
else
  fail "A3: install-profile.mjs did not report the companion deselection"
fi

echo "--- A4 deprecated --disable-builtin-goal flag ---"
if ( cd "${REPO_ROOT}" && "${DSH_E2E_NODE}" scripts/install-profile.mjs \
  --dsh-home "${DSH_HOME}" --profile "${DSH_E2E_PROFILE}" --disable-builtin-goal ) \
  >"${BUNDLES_DIR}/phase-a-deprecated-flag.log" 2>&1; then
  pass "A4: --disable-builtin-goal is accepted (exit 0)"
else
  fail "A4: --disable-builtin-goal now fails"
  tail -n 40 "${BUNDLES_DIR}/phase-a-deprecated-flag.log" >&2 || true
fi
if grep -Eqi 'deprecated' "${BUNDLES_DIR}/phase-a-deprecated-flag.log"; then
  pass "A4: --disable-builtin-goal prints a deprecation notice"
  grep -Ei 'deprecated' "${BUNDLES_DIR}/phase-a-deprecated-flag.log" | sed 's/^/  /'
else
  fail "A4: --disable-builtin-goal printed no deprecation notice"
fi

echo "--- A5/A6 boot-free composition (dsh --dump-config) ---"
DUMP_A="${BUNDLES_DIR}/phase-a-dump-config.yml"
ERR_A="${BUNDLES_DIR}/phase-a-dump-config.err"
if dump_config "A6" "${DUMP_A}" "${ERR_A}"; then
  run_config_assertions a "A5/A6" "${DUMP_A}" "${BUNDLES_DIR}/phase-a-config.log"
fi

echo "--- A7 boot the installed composition ---"
run_phase "A7" "phase-a"

# ---------------------------------------------------------------- phase B ----
echo
echo "=== Phase B — main bundle + legacy companion bundle both selected ==="

echo "--- B1 restore the legacy companion immediately before the main bundle ---"
if "${DSH_E2E_NODE}" "${HELPER}" --edit-add-legacy-companion --profile-dir "${PROFILE_DIR}" \
  >"${BUNDLES_DIR}/phase-b-edit.log" 2>&1; then
  pass "B1: profile selects ${COMPANION_BUNDLE} immediately before ${MAIN_BUNDLE}"
  sed 's/^/  /' "${BUNDLES_DIR}/phase-b-edit.log"
else
  fail "B1: could not restore the legacy companion selection"
  cat "${BUNDLES_DIR}/phase-b-edit.log" >&2 || true
fi

echo "--- B2 boot-free composition (dsh --dump-config) ---"
DUMP_B="${BUNDLES_DIR}/phase-b-dump-config.yml"
ERR_B="${BUNDLES_DIR}/phase-b-dump-config.err"
if dump_config "B2" "${DUMP_B}" "${ERR_B}"; then
  run_config_assertions b "B2" "${DUMP_B}" "${BUNDLES_DIR}/phase-b-config.log"
fi

echo "--- B3 boot the both-bundles composition ---"
run_phase "Phase B" "phase-b" 1

# ---------------------------------------------------------------- summary ----
echo
echo "=== Summary ==="
if (( FAIL_COUNT == 0 )); then
  echo "PROBE BUNDLES PASS (${PASS_COUNT} checks)"
  echo "  isolated home : ${DSH_HOME}"
  echo "  artifacts     : ${BUNDLES_DIR}"
  exit 0
fi
echo "PROBE BUNDLES FAIL (${FAIL_COUNT} failed, ${PASS_COUNT} passed)"
if (( ${#FAILED_CHECKS[@]} > 0 )); then
  for failed_check in "${FAILED_CHECKS[@]}"; do
    echo "  - ${failed_check}"
  done
fi
echo "  artifacts: ${BUNDLES_DIR}"
exit 1
