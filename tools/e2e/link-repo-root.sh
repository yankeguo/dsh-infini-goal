#!/usr/bin/env bash
# Register the repo checkout as a "linked root" of the isolated profile.
#
# Why: a plugin inserted by ABSOLUTE PATH whose host half imports
# `@deepseek-ai/*` would otherwise resolve those imports from the repo's own
# pnpm node_modules, creating a SECOND copy of cordis/dsh-llm/... in the
# process (see probe-imports.sh baseline evidence). DSH's profile-resolution
# documentation describes the supported mechanism: a symlink under the active
# profile's `node_modules` pointing outside the profiles tree becomes a linked
# root, and at each node_modules position the current package's
# `peerDependencies` names that are present in the installation's runtime table
# are routed to the installation package instead of a physical candidate.
#
# Effect (verified): plugin imports from files below the linked target resolve
# to the installation's packages (`.../app.asar/dsh/node_modules/@deepseek-ai/...`),
# so `ctx instanceof Context` and service identity hold. The real suite packages
# declare exactly those peers, so this is enough; insertion by absolute path
# keeps working.
#
# Idempotent. The symlink lives inside the isolated DSH_HOME only.
#
# Usage: tools/e2e/link-repo-root.sh
# Env:   DSH_E2E_REPO_LINK_NAME  symlink name (default e2e-repo-root)
#        DSH_E2E_REPO_LINK_TARGET target directory (default repo root)
set -euo pipefail

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

e2e_mkdirs
LINK_NAME="${DSH_E2E_REPO_LINK_NAME:-e2e-repo-root}"
LINK_TARGET="${DSH_E2E_REPO_LINK_TARGET:-${REPO_ROOT}}"
LINK_DIR="${DSH_HOME}/profiles/${DSH_E2E_PROFILE}/node_modules"

if ! e2e_have_profile; then
  echo "e2e link: profile '${DSH_E2E_PROFILE}' does not exist; run bootstrap.sh first" >&2
  exit 2
fi
if [[ ! -d "${LINK_TARGET}" ]]; then
  echo "e2e link: target directory does not exist: ${LINK_TARGET}" >&2
  exit 2
fi

mkdir -p "${LINK_DIR}"
ln -sfn "${LINK_TARGET}" "${LINK_DIR}/${LINK_NAME}"
echo "e2e link: ${LINK_DIR}/${LINK_NAME} -> ${LINK_TARGET}"
