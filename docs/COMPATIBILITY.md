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
bundle outside the range. The unit suite/dev toolchain is pinned to the newest
verified SDK (`0.2.2-rc.3`); the runtime shims below keep the older end of the
range working.

## Verified matrix

| DSH | Evidence | Result |
| --- | --- | --- |
| `0.2.2-rc.1` | v0.2.0 / v0.2.1 releases: `tools/e2e/suite.sh`, `probe-tools.sh`, `probe-install.sh`, `probe-bundles.sh` | pass |
| `0.2.2-rc.3` (installed desktop app) | this change, 2026-11-17: `pnpm verify` (typecheck + 445 tests + build), `tools/e2e/suite.sh --fresh` (pacing, quiet window, pause), `probe-tools.sh` (scripted `create_infini_goal`), `probe-install.sh` (real `install-profile.mjs` path, commands, tools, automatic round) | pass |

The 0.2.2-rc.2 / rc.3 API changes were checked against the DSH build embedded
in the installed desktop app (`0.2.2-rc.3`, build commit
`6b729fedde0c8fd03af7afdf5a711aa64fe87c3b`); the local DSH source checkout
only reaches `0.2.2-rc.1`.

## Compatibility shims

### `AgentRegistry.roots()` was removed (0.2.2-rc.2)

The model tools authorize `create_infini_goal` and mutating
`update_infini_goal` calls by "direct human input on a runtime root agent".
DSH 0.2.2-rc.1 exposed `ctx.agents.roots()` for that check. rc.2 removed it, so
on rc.3 every authorized call failed with:

```text
TypeError: ctx.agents.roots is not a function
```

`packages/tool/src/authority.ts` (`isRuntimeRoot`) now prefers `roots()` when
the registry still has it — preserving the exact rc.1 runtime-ownership
semantics — and otherwise requires the exact live agent and
`session.header.origin !== 'subagent'`, which is what the official
`dsh-tool-goal` authority does on rc.3.

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
  between 0.2.2-rc.1 and 0.2.2-rc.3 except additive entries
  (`dsh-llm`: `LLM_FAILURE_CODES`, `RETRY_CODE_CHOICES`; `dsh-tools`:
  `ToolContextUnavailableError`; `dsh-subagent`: `ROOT_AGENT_NAME`). No import
  used by this suite was removed.
- The browser shell still seeds `@deepseek-ai/dsh-client-ui-slots`,
  `-primitives`, and `-dockkit` in its platform module table, so the client
  bundle's externals and `conversation.input.dock` slot remain valid.
- `appendPluginRecord`, `pluginRecordOf`, `agentEvents`, `defineTool`,
  `ctx.tools.register`, `ctx.commands.register`, `ctx.systemPrompt.section`,
  `ctx.sessionProjections.register`, the agent/session event vocabulary, and
  `session.snapshotEvents()` / `session.header` are present in rc.3.

## Re-verifying against a new DSH

1. `pnpm install` and `pnpm verify` against that DSH's published SDK versions.
2. Boot an isolated instance with the installed DSH:
   `tools/e2e/suite.sh --fresh`, then `tools/e2e/probe-tools.sh` and
   `tools/e2e/probe-install.sh`.
3. If any API moved, add a feature-detected shim here, extend the unit tests
   with the old and new shapes, and widen/narrow `engines.dsh` plus the host
   peer ranges in all eight `package.json` files.
4. Record the new version in the matrix above before releasing.
