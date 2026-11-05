#!/usr/bin/env bash
# Shared environment and helpers for the isolated E2E harness under tools/e2e/.
#
# Every script sources this file after `set -euo pipefail`:
#
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
#
# It never touches the user's live DSH app or `~/.dsh`: all state lives below
# ${DSH_E2E_ROOT} and every process is spawned/killed by the harness itself.
#
# Environment defaults (all overridable):
#   DSH_E2E_ROOT      /tmp/dsh-e2e   scratch root (isolated DSH_HOME etc.)
#   DSH_E2E_HOME      $DSH_E2E_ROOT/home        (derived; isolated DSH_HOME)
#   DSH_E2E_PROFILE   e2e            custom profile name under $DSH_HOME/profiles
#   DSH_E2E_WEB_PORT  34000          Web port (must be >= 34000)
#   DSH_E2E_LLM_PORT  34100          mock LLM port (must be >= 34000)
#   DSH_E2E_HOST      127.0.0.1      bind address (concrete literal)
#   DSH_E2E_NODE      node           Node.js used by the harness scripts
#   DSH_BIN           packaged DeepSeek Harness launcher (desktop app)
#   DSH_HOME          $DSH_E2E_ROOT/home        (exported for the CLI)
#
# Derived paths:
#   CONFIG_DIR  $DSH_E2E_ROOT/config   LOG_DIR  $DSH_E2E_ROOT/logs
#   STATE_DIR   $DSH_E2E_ROOT/state    WORKSPACE_DIR $DSH_E2E_ROOT/workspace
#
# Helper summary:
#   e2e_assert_ports        validate port pair (numeric, distinct, >= 34000)
#   e2e_require_launcher    fail unless $DSH_BIN and $DSH_E2E_NODE are runnable
#   e2e_mkdirs              create the scratch root and its standard subdirs
#   e2e_have_profile        true when the custom profile already exists
#   e2e_require_file <p>    fail unless one required file exists
#   e2e_port_free <port>    true when nothing is listening on host:port
#   e2e_assert_ports_free   fail when a harness port already has a listener
#   e2e_wait_http <url> <secs>
#   e2e_wait_log_line <file> <pattern> <secs> <label>
#   e2e_stop_pid <web|llm>  SIGTERM the recorded PID, SIGKILL after 15 s
#
# shellcheck shell=bash

# ---------------------------------------------------------------- locations --
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${E2E_DIR}/../.." && pwd)"

# ------------------------------------------------------------ environment ----
DSH_E2E_ROOT="${DSH_E2E_ROOT:-/tmp/dsh-e2e}"
DSH_E2E_PROFILE="${DSH_E2E_PROFILE:-e2e}"
DSH_E2E_WEB_PORT="${DSH_E2E_WEB_PORT:-34000}"
DSH_E2E_LLM_PORT="${DSH_E2E_LLM_PORT:-34100}"
DSH_E2E_HOST="${DSH_E2E_HOST:-127.0.0.1}"
DSH_E2E_NODE="${DSH_E2E_NODE:-node}"
DSH_BIN="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
DSH_HOME="${DSH_E2E_ROOT}/home"

CONFIG_DIR="${DSH_E2E_ROOT}/config"
LOG_DIR="${DSH_E2E_ROOT}/logs"
STATE_DIR="${DSH_E2E_ROOT}/state"
WORKSPACE_DIR="${DSH_E2E_ROOT}/workspace"

# Children (bootstrap.sh/start-web.sh/... spawn each other) must see the same
# scratch root, ports and profile.
export DSH_E2E_ROOT DSH_E2E_PROFILE DSH_E2E_WEB_PORT DSH_E2E_LLM_PORT
export DSH_E2E_HOST DSH_E2E_NODE DSH_BIN DSH_HOME
export CONFIG_DIR LOG_DIR STATE_DIR WORKSPACE_DIR

# ---------------------------------------------------------------- helpers ----

# Print one helper error and exit 2 (usage/configuration mistake).
e2e_usage_error() {
  echo "e2e: $*" >&2
  exit 2
}

# Validate the harness port pair: integers in the reserved range, distinct.
e2e_assert_ports() {
  local name value
  for name in DSH_E2E_WEB_PORT DSH_E2E_LLM_PORT; do
    value="${!name}"
    if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
      e2e_usage_error "${name}=${value} is not a TCP port number (set ${name}; default range >= 34000)"
    fi
    if (( value < 34000 || value > 65535 )); then
      e2e_usage_error "${name}=${value} is outside the harness range (>= 34000 and <= 65535); ports below 34000 are reserved"
    fi
  done
  if (( DSH_E2E_WEB_PORT == DSH_E2E_LLM_PORT )); then
    e2e_usage_error "DSH_E2E_WEB_PORT and DSH_E2E_LLM_PORT must differ"
  fi
  if [[ -z "${DSH_E2E_HOST}" ]]; then
    e2e_usage_error "DSH_E2E_HOST is empty; use a concrete literal such as 127.0.0.1"
  fi
}

# Fail unless the packaged launcher and the Node.js binary are runnable.
e2e_require_launcher() {
  local node_path
  node_path="$(command -v "${DSH_E2E_NODE}" 2>/dev/null || true)"
  if [[ -z "${node_path}" ]]; then
    e2e_usage_error "Node.js not found: '${DSH_E2E_NODE}' is not on PATH (set DSH_E2E_NODE to a node >= 20 binary)"
  fi
  if [[ ! -x "${DSH_BIN}" ]]; then
    e2e_usage_error "DeepSeek Harness launcher not found or not executable: ${DSH_BIN} (set DSH_BIN)"
  fi
}

# Create the scratch root and every directory the harness writes into.
e2e_mkdirs() {
  mkdir -p "${DSH_E2E_ROOT}" "${DSH_HOME}" "${CONFIG_DIR}" "${LOG_DIR}" "${STATE_DIR}" "${WORKSPACE_DIR}"
}

# True when the custom profile has already been created in this isolated home.
e2e_have_profile() {
  [[ -f "${DSH_HOME}/profiles/${DSH_E2E_PROFILE}/package.json" ]]
}

# Fail unless one required file exists (generated patches, fixtures, overlays).
e2e_require_file() {
  local path="${1:?e2e_require_file: path required}"
  if [[ ! -f "${path}" ]]; then
    e2e_usage_error "required file not found: ${path}"
  fi
}

# True when nothing is listening on ${DSH_E2E_HOST}:<port>. Uses bash's /dev/tcp
# so the harness needs no external port-probing tool.
e2e_port_free() {
  local port="${1:?e2e_port_free: port required}"
  if (exec 3<>"/dev/tcp/${DSH_E2E_HOST}/${port}") 2>/dev/null; then
    return 1
  fi
  return 0
}

# Fail unless both harness ports are free: never attach to a foreign listener.
e2e_assert_ports_free() {
  local name port
  for name in DSH_E2E_WEB_PORT DSH_E2E_LLM_PORT; do
    port="${!name}"
    if ! e2e_port_free "${port}"; then
      e2e_usage_error "${name}=${port} is already in use; refusing to attach to a foreign listener (choose another port pair >= 34000)"
    fi
  done
}

# Poll an HTTP URL until it answers 2xx/3xx, up to <seconds>.
e2e_wait_http() {
  local url="${1:?e2e_wait_http: url required}"
  local timeout="${2:-10}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 2 -o /dev/null "${url}" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# Wait for one log line matching an extended regular expression.
e2e_wait_log_line() {
  local file="${1:?e2e_wait_log_line: file required}"
  local pattern="${2:?e2e_wait_log_line: pattern required}"
  local timeout="${3:-60}"
  local label="${4:-log line}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if [[ -f "${file}" ]] && grep -Eq -- "${pattern}" "${file}" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  echo "e2e: timed out after ${timeout}s waiting for ${label} in ${file}" >&2
  return 1
}

# Stop one harness process recorded in STATE_DIR/<name>.pid: SIGTERM, then
# SIGKILL after 15 s. The PID file is removed either way; a missing process is
# not an error (an earlier run may have exited on its own).
e2e_stop_pid() {
  local name="${1:?e2e_stop_pid: name required}"
  local pid_file="${STATE_DIR}/${name}.pid"
  local pid
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  rm -f "${pid_file}"
  if [[ -z "${pid}" ]]; then
    return 0
  fi
  if ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi
  kill -TERM "${pid}" 2>/dev/null || true
  local waited=0
  while kill -0 "${pid}" 2>/dev/null; do
    if (( waited >= 150 )); then
      echo "e2e: ${name} (pid ${pid}) ignored SIGTERM for 15s; sending SIGKILL" >&2
      kill -KILL "${pid}" 2>/dev/null || true
      break
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  return 0
}
