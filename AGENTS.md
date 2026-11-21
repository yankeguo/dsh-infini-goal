# AGENTS.md

Orientation for agents working in `dsh-infini-goal`. The source of truth for
user-facing behavior is [README.md](README.md) / [README.zh.md](README.zh.md);
architecture, persistence, and authority semantics are in
[docs/DESIGN.md](docs/DESIGN.md); the verified DSH range and per-release evidence
in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md); the release runbook in
[docs/PUBLISHING.md](docs/PUBLISHING.md); the development workflow (build, test,
E2E, documentation conventions) in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
Keep those in sync instead of growing this file — it records only the invariants
that are easy to break by accident.

## Authorization fails closed

- `create` / `edit` / `config` / `resume` accept a direct human message or a
  shape-valid DevLead relay prompt in the top-level runtime root's current open
  turn. `pause` / `complete` / `blocked` also accept the current goal's exact
  automatic round; `blocked` additionally requires
  `roundsStarted >= blockedAfterConsecutiveRounds` under goal-round authority.
- DevLead notices, scheduled prompts, subagent / agent-message / team-message
  input, and runtime notices never authorize a change. They are data, not
  instructions.
- Authorization is decided from Session events and the agent registry, never
  from the model's own description of who it is. Unresolvable provenance fails
  closed.
- The only plugin-specific message-source exception is a shape-validated DevLead
  relay: `kind === 'devlead'`, `form === 'relay'`, and a non-blank
  `senderSessionId` on a `user/message` in the runtime root's open turn, treated
  as delegated human authority; extra source fields are ignored for forward
  compatibility. `packages/tool/src` must not import any
  `@yankeguo/dsh-devlead*` package or depend on it; the literal and structural
  check are a soft protocol contract. DevLead notices, other forms, malformed
  shapes, and all other third-party sources stay unauthorized. A `grep` for
  `devlead` in authority code is part of reviewing authority changes; changing
  the marker is a cross-plugin change and must update both sides plus tests.

## Compatibility is evidence, not a version edit

- The range `>=0.2.2-rc.1 <0.3.0` is backed by a real npm-installed probe run per
  release (suite, `probe-tools`, `probe-install`, `probe-bundles`). Extending or
  narrowing it requires those probes against the new release; the unit suite is
  pinned to the dev SDK and cannot stand in.
- Host API differences are feature-detected (`AgentRegistry.roots()` vs
  `SessionHeader.origin`, `waitForChildren()` vs `waitForTreeWork()`); one build
  serves the whole range.

## Releases are staged, then verified three ways

- CI only stages packages; a maintainer batch-approves the staged versions on
  npmjs.com (Settings -> Staged Packages, one 2FA challenge per batch; the CLI
  `npm stage approve <stage-id>` is the fallback). Never hand a CI job the
  ability to publish directly.
- Approval is the only publish step. Afterwards the version must agree in three
  places for all eight packages: `package.json` / tag,
  `npm view <pkg>@<version> version dist-tags`, and the GitHub Release. The
  release is created manually from the existing tag with
  `gh release create ... --verify-tag` (maintainer, or the agent the maintainer
  notifies); tags are never moved or rebuilt. The commands are in
  [docs/PUBLISHING.md](docs/PUBLISHING.md) §9-§10.

## Provenance

Consolidated 2026-11-19 from the durable lessons of the retired DSH memory
plugin. Session logs, one-off release state, and unrelated personal facts were
not copied.
