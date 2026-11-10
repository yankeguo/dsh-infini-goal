#!/usr/bin/env bash
# Configure npm trusted publishing (keyless OIDC) for every package in this
# workspace, for STAGED publishing only.
#
# The CI workflow stages packages with a short-lived OIDC token; it can never
# publish directly. A human maintainer then approves the staged versions with a
# 2FA prompt (see scripts/promote-release.mjs). `--allow-stage-publish` grants
# only `npm stage publish`; `--allow-publish` is deliberately NOT granted, so a
# compromised workflow cannot put a version on npm without human approval.
#
# Run this once per package after the package's FIRST publish (npm requires the
# package to exist before a trusted publisher can be attached). The first
# version of a brand-new package is therefore published once by a maintainer
# with `npm login`; every later release goes through staged publishing.
#
# Prerequisites:
#   - npm >= 11.20.0 (staged publishing permissions and `npm stage` subcommands)
#   - 2FA enabled on the npm account
#   - npm login as an account with write access to the @yankeguo packages
#     (npm trust does not accept bypass-2FA granular tokens)
#
# Usage:
#   scripts/trusted-publishers.sh                # configure stage-only trust for all packages
#   scripts/trusted-publishers.sh --dry-run      # show what it would do
#   scripts/trusted-publishers.sh --list         # verify every package is stage-only
#   scripts/trusted-publishers.sh --migrate      # revoke old configs, then recreate stage-only
#   scripts/trusted-publishers.sh --env npm-publish   # bind a GitHub environment
#   scripts/trusted-publishers.sh --repo owner/repo --file publish.yml
#
# `--migrate` is the upgrade path from the previous `--allow-publish` setup: it
# revokes each package's existing trust configuration (2FA prompt) and recreates
# it with `--allow-stage-publish` only. `--list` exits non-zero when a package is
# missing a configuration, still grants direct publish, or binds a different
# repository/workflow/environment.
#
# The workflow filename must match .github/workflows/<file> exactly; the
# optional GitHub environment must also be set on the workflow job for the
# claims to match.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="yankeguo/dsh-infini-goal"
WORKFLOW_FILE="publish.yml"
ENVIRONMENT=""
MODE="configure"
DRY_RUN="false"

usage() {
  cat <<'USAGE'
Configure npm trusted publishing (keyless OIDC) for staged publishing.

Usage:
  scripts/trusted-publishers.sh [options]

Modes:
  (default)        configure stage-only trusted publishers for every package
  --dry-run        print the npm trust commands without changing anything
  --list           verify the current trust configuration of every package
  --migrate        revoke the existing configuration of every package, then
                   recreate it with --allow-stage-publish only

Options:
  --repo <owner/repo>       GitHub repository (default: yankeguo/dsh-infini-goal)
  --file <workflow.yml>     workflow filename under .github/workflows/
                            (default: publish.yml)
  --env <environment>       bind a GitHub environment; the workflow job must
                            declare the same environment
  -h, --help                show this help

Prerequisites: npm >= 11.20.0, 2FA enabled, npm login as a maintainer.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN="true"; shift ;;
    --list) MODE="list"; shift ;;
    --migrate) MODE="migrate"; shift ;;
    --repo) REPO="${2:?--repo needs owner/repo}"; shift 2 ;;
    --file) WORKFLOW_FILE="${2:?--file needs a filename}"; shift 2 ;;
    --env|--environment) ENVIRONMENT="${2:?--env needs a name}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---- prerequisites ---------------------------------------------------------
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 2; }
if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 2
fi

npm_version="$(npm --version)"
node_version="$(node --version)"
echo "npm ${npm_version} / node ${node_version}"
# npm trust needs a version that knows staged publishing permissions.
if [[ "$(printf '%s\n11.20.0\n' "${npm_version}" | sort -V | head -1)" != "11.20.0" ]]; then
  echo "npm >= 11.20.0 is required for staged publishing (found ${npm_version}); run: npm install -g npm@latest" >&2
  exit 2
fi

# Collect publishable package names from the workspace manifests.
# (while-read keeps this portable to bash 3.2, the default /bin/bash on macOS.)
PACKAGES=()
while IFS= read -r package_name; do
  [[ -n "${package_name}" ]] && PACKAGES+=("${package_name}")
done < <(
  node - "${REPO_ROOT}/packages" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
for (const dir of fs.readdirSync(root).sort()) {
  const manifestPath = path.join(root, dir, 'package.json')
  if (!fs.existsSync(manifestPath)) continue
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@')) continue
  if (manifest.private === true) continue
  process.stdout.write(manifest.name + '\n')
}
NODE
)

if [[ "${#PACKAGES[@]}" -eq 0 ]]; then
  echo "no publishable packages found under ${REPO_ROOT}/packages" >&2
  exit 1
fi

echo "repository: ${REPO}"
echo "workflow:   ${WORKFLOW_FILE}"
[[ -n "${ENVIRONMENT}" ]] && echo "environment: ${ENVIRONMENT}"
echo "permission: stage publish only (direct publish is not granted)"
echo "packages:   ${#PACKAGES[@]}"
printf '  - %s\n' "${PACKAGES[@]}"

# ---- helpers ---------------------------------------------------------------
# Read one package's trust configuration as plain lines (no ANSI colors).
# A missing configuration or a failed request is reported by the caller.
list_trust_raw() {
  NO_COLOR=1 npm --color=false trust list "$1" 2>/dev/null || true
}

# Extract the "permissions: ..." value from a trust list output.
permissions_of() {
  printf '%s\n' "$1" | sed -n 's/^permissions: //p' | head -1
}

# Extract every "id: ..." value from a trust list output.
trust_ids_of() {
  printf '%s\n' "$1" | sed -n 's/^id: //p'
}

# Create the stage-only trusted publisher for one package.
# Returns non-zero when npm refuses (for example when a configuration exists).
configure_package() {
  local name="$1"
  local args=(--file "${WORKFLOW_FILE}" --repo "${REPO}" --allow-stage-publish --yes)
  [[ -n "${ENVIRONMENT}" ]] && args+=(--env "${ENVIRONMENT}")
  [[ "${DRY_RUN}" == "true" ]] && args+=(--dry-run)
  echo "== configuring ${name} =="
  if npm trust github "${name}" "${args[@]}"; then
    echo "   OK ${name}: stage publish only"
  else
    echo "   FAILED ${name}" >&2
    return 1
  fi
}

# Verify that one package's trust configuration is stage-only and bound to this
# repository/workflow/environment. Returns non-zero on any deviation.
check_package() {
  local name="$1"
  local raw perms permission_lines
  raw="$(list_trust_raw "${name}")"
  echo ""
  echo "== ${name} =="
  if [[ -n "${raw}" ]]; then
    printf '%s\n' "${raw}" | sed 's/^/   /'
  fi
  if [[ -z "${raw}" ]]; then
    echo "   FAIL no response from the registry (run: npm login)" >&2
    return 1
  fi
  if printf '%s\n' "${raw}" | grep -q 'No trust configurations found'; then
    echo "   FAIL no trusted publisher configured (run this script without --list)" >&2
    return 1
  fi
  permission_lines="$(printf '%s\n' "${raw}" | grep -c '^permissions: ' || true)"
  if [[ "${permission_lines}" -ne 1 ]]; then
    echo "   FAIL expected exactly one trust configuration, found ${permission_lines}" >&2
    return 1
  fi
  if ! printf '%s\n' "${raw}" | grep -Fqx "file: ${WORKFLOW_FILE}"; then
    echo "   FAIL workflow file is not ${WORKFLOW_FILE}" >&2
    return 1
  fi
  if ! printf '%s\n' "${raw}" | grep -Fqx "repository: ${REPO}"; then
    echo "   FAIL repository is not ${REPO}" >&2
    return 1
  fi
  if [[ -n "${ENVIRONMENT}" ]]; then
    if ! printf '%s\n' "${raw}" | grep -Fqx "environment: ${ENVIRONMENT}"; then
      echo "   FAIL environment is not ${ENVIRONMENT}" >&2
      return 1
    fi
  elif printf '%s\n' "${raw}" | grep -q '^environment: '; then
    echo "   FAIL configuration binds a GitHub environment but none was requested" >&2
    return 1
  fi
  perms="$(permissions_of "${raw}")"
  case "${perms}" in
    "stage publish")
      echo "   OK stage publish only (direct publish is not allowed)"
      return 0
      ;;
    "publish")
      echo "   FAIL old direct-publish configuration; run: scripts/trusted-publishers.sh --migrate" >&2
      return 1
      ;;
    "")
      echo "   FAIL no permissions line (unexpected response; is npm logged in?)" >&2
      return 1
      ;;
    *)
      if [[ "${perms}" == *"stage publish"* ]]; then
        echo "   FAIL still grants direct publish (permissions: ${perms}); run: scripts/trusted-publishers.sh --migrate" >&2
        return 1
      fi
      echo "   FAIL unexpected permissions: ${perms}" >&2
      return 1
      ;;
  esac
}

# ---- list mode -------------------------------------------------------------
if [[ "${MODE}" == "list" ]]; then
  failed=()
  for name in "${PACKAGES[@]}"; do
    if ! check_package "${name}"; then
      failed+=("${name}")
    fi
  done
  echo ""
  if [[ "${#failed[@]}" -gt 0 ]]; then
    echo "FAILED: ${#failed[@]} of ${#PACKAGES[@]} package(s) are not stage-only: ${failed[*]}" >&2
    echo "Run 'scripts/trusted-publishers.sh --migrate' to revoke and recreate them." >&2
    exit 1
  fi
  echo "All ${#PACKAGES[@]} packages are configured for staged publishing only."
  exit 0
fi

# ---- migrate mode ----------------------------------------------------------
# Revoke every existing configuration (2FA prompt per revoke), then recreate it
# with --allow-stage-publish. This is the upgrade path from --allow-publish.
if [[ "${MODE}" == "migrate" ]]; then
  failed=()
  for name in "${PACKAGES[@]}"; do
    echo ""
    echo "== migrating ${name} =="
    raw="$(list_trust_raw "${name}")"
    ids="$(trust_ids_of "${raw}")"
    if [[ -z "${ids}" ]]; then
      echo "   no existing trust configuration"
    else
      while IFS= read -r trust_id; do
        [[ -z "${trust_id}" ]] && continue
        echo "   revoking ${trust_id}"
        revoke_args=("${name}" "--id=${trust_id}")
        [[ "${DRY_RUN}" == "true" ]] && revoke_args+=(--dry-run)
        if ! npm trust revoke "${revoke_args[@]}"; then
          echo "   FAILED to revoke ${trust_id} for ${name}" >&2
          failed+=("${name}")
          continue 2
        fi
      done <<< "${ids}"
    fi
    if ! configure_package "${name}"; then
      failed+=("${name}")
    fi
    sleep 2
  done
  echo ""
  if [[ "${#failed[@]}" -gt 0 ]]; then
    echo "FAILED: ${failed[*]}" >&2
    echo "Inspect with: npm trust list <package>" >&2
    exit 1
  fi
  echo "All ${#PACKAGES[@]} packages migrated to staged publishing only."
  echo "Verify: scripts/trusted-publishers.sh --list"
  exit 0
fi

# ---- configure mode --------------------------------------------------------
failed=()
for name in "${PACKAGES[@]}"; do
  echo ""
  if ! configure_package "${name}"; then
    failed+=("${name}")
    echo "   If the package already has a trust configuration, migrate it:" >&2
    echo "     scripts/trusted-publishers.sh --migrate" >&2
    echo "   or revoke it manually:" >&2
    echo "     npm trust list ${name}          # find the id" >&2
    echo "     npm trust revoke ${name} --id=<id>" >&2
  fi
  # npm recommends spacing bulk trust calls to avoid rate limiting.
  sleep 2
done

echo ""
if [[ "${#failed[@]}" -gt 0 ]]; then
  echo "FAILED: ${failed[*]}" >&2
  echo "Then rerun this script (or scripts/trusted-publishers.sh --migrate)." >&2
  exit 1
fi

echo "All ${#PACKAGES[@]} packages configured for STAGED publishing only."
echo "CI stages a v* tag; approve the staged versions with:"
echo "  node scripts/promote-release.mjs --version <version>"
echo "Verify the trust configuration with: scripts/trusted-publishers.sh --list"
