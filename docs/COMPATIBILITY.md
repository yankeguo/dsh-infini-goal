# DSH compatibility

`dsh-infini-goal` runs inside the DeepSeek Harness (DSH) host process and
imports the host's Cordis services and plugin SDK packages, so it is coupled to
the DSH plugin API. This page records the declared range, the verified matrix,
and the compatibility shims that let one build serve the whole range.

## Declared range

| Field | Value |
| --- | --- |
| `engines.dsh` (all eight published packages) | `>=0.2.2-rc.1 <0.3.0` |
| Host `peerDependencies` on `@deepseek-ai/dsh-*` | `>=0.2.2-rc.1 <0.3.0` |
| `@deepseek-ai/cordis` | `~4.1.0` |
| `@deepseek-ai/schemastery` | `~3.19.0` |
| `zod` | `4.6.6` (the copy DSH 0.2.2-rc.3 builds against) |

DSH checks a bundle's `engines.dsh` against the running version and skips a
bundle outside the range. The unit suite/dev toolchain stays pinned to the
installed desktop SDK (`0.2.2-rc.3`); the whole range is exercised through the
real isolated E2E harness with each npm-installed DSH release.

## Verified matrix

Verified 2026-11-18 on Node.js `26.13.0`. Each release was installed from npm
into its own temporary prefix (`npm install @deepseek-ai/dsh@0.2.2-rc.N`); no
test touched the user's `~/.dsh` or the installed desktop app.

| DSH | Evidence | Result |
| --- | --- | --- |
| `0.2.2-rc.1` (`latest`) | `suite.sh --fresh` → **9/9 steps PASS**; `probe-tools.sh` → **14/14 checks PASS** (tool registration, system prompt, `create_infini_goal`, `update_infini_goal`); `probe-install.sh` → **26/26 checks PASS**; `probe-bundles.sh` → **61/61 checks PASS** | pass |
| `0.2.2-rc.2` | same four commands, same results | pass |
| `0.2.2-rc.3` | same four commands, same results | pass |
| `0.2.2-rc.4` (`next`) | same four commands, same results | pass |

Repository checks on the rc.3-pinned dev toolchain: `pnpm verify` =
typecheck + **24 test files / 459 tests** + build of all 9 artifacts.

The installed-profile probes use `scripts/install-profile.mjs` (symlink +
bundle selection) and therefore exercise the real Loader composition,
`engines.dsh` gate, client row, command catalogue, driver rounds, projection,
and the built-in-goal disable layer on every release. The bundle probe covers
both the main-bundle-only install and the legacy-companion upgrade path.

### What actually differs across the range

| Surface | rc.1 | rc.2 | rc.3 | rc.4 | Handling |
| --- | --- | --- | --- | --- | --- |
| `AgentRegistry.roots()` | present | removed | removed | removed | feature-detect; header fallback |
| Subagent wait method | `waitForChildren()` | `waitForTreeWork()` | `waitForTreeWork()` | `waitForTreeWork()` | feature-detect; neither = nothing to wait for |
| `SessionHeader.origin` / `delegationDepth` | present | present | present | present | used by the rc.2+ root/fallback check |
| `dsh-llm` failure codes | — | — | — | adds `CONTENT_REFUSED` | additive only; no import used by this suite removed |
| Cordis / schemastery peers | `~4.1.0` / `~3.19.0` | same | same | same | no peer conflict |

## Compatibility shims

### `AgentRegistry.roots()` was removed (0.2.2-rc.2)

The model tools authorize `create_infini_goal` and mutating
`update_infini_goal` calls by "direct human input on a runtime root agent".
DSH 0.2.2-rc.1 exposed `ctx.agents.roots()` for that check. rc.2 removed it, so
on rc.3 every authorized call failed with:

```text
TypeError: ctx.agents.roots is not a function
```

`packages/tool/src/authority.ts` (`isRuntimeRoot`) prefers `roots()` when the
registry still has it — preserving the exact rc.1 runtime-ownership semantics —
and otherwise requires the exact live agent and
`session.header.origin !== 'subagent'`, which is what the official
`dsh-tool-goal` authority does on rc.2+. Both branches are exercised by the
real per-version probes (rc.1 through `roots()`, rc.2–rc.4 through the header).

### `SubagentsService.waitForChildren()` became `waitForTreeWork()` (0.2.2-rc.2)

Before reserving an automatic round the driver waits for in-process subagent
work so the round does not start only to block on descendants. rc.1 exposed
`subagents.waitForChildren(agent)`; rc.2 replaced it with
`waitForTreeWork(root)` and removed the old method. `packages/driver/src/index.ts`
(`waitForSubagentWork`) calls the old method when present and falls back to the
new one; a service that exposes neither is treated as "nothing to wait for".

### Zod type identity (0.2.2-rc.2 / rc.3)

`ProjectionDefinition.stateSchema` / `wire.viewSchema` are typed with the `zod`
version the installed DSH builds against (`4.6.6`). Building the plugin against
`zod@4.4.3` failed the `0.2.2-rc.3` typecheck with `TS2739` (missing
`validate`/`validateAsync`) and `TS2589` (excessively deep instantiation) at
the projection registration. The repo's `zod` devDependency and the
`@yankeguo/dsh-infini-goal` peer dependency are now `4.6.6`.

### Checked and unchanged

- Exported symbols of every SDK package the host plugins import are identical
  between 0.2.2-rc.1 and 0.2.2-rc.4 except additive entries (`dsh-llm`:
  `LLM_FAILURE_CODES`, `RETRY_CODE_CHOICES`, `CONTENT_REFUSED`; `dsh-tools`:
  `ToolContextUnavailableError`; `dsh-subagent`: `ROOT_AGENT_NAME`). No import
  used by this suite was removed.
- rc.2 ↔ rc.3 ↔ rc.4: no source-level change was found in the agent, session,
  tools, system-prompt, session-projection, session-controller, commands, or
  subagent packages used here; rc.4's only difference in the exercised set is
  the additive `dsh-llm` failure code above.
- The browser shell still seeds `@deepseek-ai/dsh-client-ui-slots`,
  `-primitives`, and `-dockkit` in its platform module table, so the client
  bundle's externals and `conversation.input.dock` slot remain valid.
- `appendPluginRecord`, `pluginRecordOf`, `agentEvents`, `defineTool`,
  `ctx.tools.register`, `ctx.commands.register`, `ctx.systemPrompt.section`,
  `ctx.sessionProjections.register`, the agent/session event vocabulary, and
  `session.snapshotEvents()` / `session.header` are present in all four
  releases.

## Re-verifying against a new DSH

1. `pnpm install` and `pnpm verify` against that DSH's published SDK versions.
2. Boot an isolated instance with the installed DSH:
   `tools/e2e/suite.sh --fresh`, then `tools/e2e/probe-tools.sh` and
   `tools/e2e/probe-install.sh`.
3. If any API moved, add a feature-detected shim here, extend the unit tests
   with the old and new shapes, and widen/narrow `engines.dsh` plus the host
   peer ranges in all eight `package.json` files.
4. Record the new version in the matrix above before releasing.
