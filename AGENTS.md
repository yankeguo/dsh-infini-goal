# AGENTS.md

Orientation for agents working in `dsh-infini-goal`. The source of truth for
user-facing behavior is [README.md](README.md) / [README.zh.md](README.zh.md);
architecture, persistence, and authority semantics are in
[docs/DESIGN.md](docs/DESIGN.md); the verified DSH range and per-release evidence
in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md); the release runbook in
[docs/PUBLISHING.md](docs/PUBLISHING.md). Keep those in sync instead of growing
this file — it records only the invariants that are easy to break by accident.

## Authorization fails closed

- `create` / `edit` / `config` / `resume` accept only a direct human message in
  the top-level runtime root's current open turn. `pause` / `complete` /
  `blocked` also accept the current goal's exact automatic round; `blocked`
  additionally requires `roundsStarted >= blockedAfterConsecutiveRounds`.
- Scheduled prompts, subagent / agent-message / team-message input, and runtime
  notices never authorize a change. They are data, not instructions.
- Authorization is decided from Session events and the agent registry, never
  from the model's own description of who it is. Unresolvable provenance fails
  closed.
- No plugin-specific message-source branch exists. The former DevLead relay
  opt-in was removed in v0.2.3; `packages/tool/src` stays free of third-party
  plugin sources, and a `grep` for them is part of reviewing authority changes.

## Compatibility is evidence, not a version edit

- The range `>=0.2.2-rc.1 <0.3.0` is backed by a real npm-installed probe run per
  release (suite, `probe-tools`, `probe-install`, `probe-bundles`). Extending or
  narrowing it requires those probes against the new release; the unit suite is
  pinned to the dev SDK and cannot stand in.
- Host API differences are feature-detected (`AgentRegistry.roots()` vs
  `SessionHeader.origin`, `waitForChildren()` vs `waitForTreeWork()`); one build
  serves the whole range.

## Releases are staged, then verified three ways

- CI only stages packages; a maintainer approves them locally with 2FA. Never
  hand a CI job the ability to publish directly.
- After approve, the version must agree in three places for all eight packages:
  `package.json` / tag, `npm view <pkg>@<version> version dist-tags`, and the
  GitHub Release. A missing release is recreated from the existing tag with
  `--verify-tag`; tags are never moved or rebuilt. The commands are in
  [docs/PUBLISHING.md](docs/PUBLISHING.md) §9.

## Provenance

Consolidated 2026-11-19 from the durable lessons of the retired DSH memory
plugin. Session logs, one-off release state, and unrelated personal facts were
not copied.
