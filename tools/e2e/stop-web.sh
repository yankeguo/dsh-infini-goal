#!/usr/bin/env bash
# Stop the isolated instance started by start-web.sh.
#
# Only PIDs recorded by start-web.sh are signalled; if the recorded process is
# gone nothing else is touched. Logs and the isolated DSH_HOME are kept so a
# failed run can be inspected; use bootstrap.sh --fresh to reset everything.
set -euo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

stopped=0
for name in web llm; do
  if [[ -f "${STATE_DIR}/${name}.pid" ]]; then
    pid="$(cat "${STATE_DIR}/${name}.pid" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      echo "e2e: stopping ${name} (pid ${pid})"
      stopped=1
    fi
    e2e_stop_pid "${name}"
  fi
done

rm -f "${STATE_DIR}/web.url" "${STATE_DIR}/llm.port" "${STATE_DIR}/cookie" "${STATE_DIR}/pids"

if (( stopped == 0 )); then
  echo "e2e: nothing to stop"
else
  echo "e2e: stopped"
fi
