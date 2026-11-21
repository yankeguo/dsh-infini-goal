# Contributing and development

This page is for contributors. User-facing documentation lives in
[README.md](../README.md) / [README.zh.md](../README.zh.md); architecture and
authorization semantics are in [DESIGN.md](DESIGN.md); the release runbook is
[PUBLISHING.md](PUBLISHING.md).

## Repository layout

This is a pnpm workspace. The publishable packages live under `packages/`;
`tools/e2e` is the development-only isolated verification harness (never
published), and `scripts/` holds build, install, repair, and release helpers.

| Directory | Package | Role |
| --- | --- | --- |
| `packages/protocol` | `@yankeguo/dsh-infini-goal-protocol` | Pure types + interval / time-zone / quiet-window math (shared by host and browser) |
| `packages/infini-goal` | `@yankeguo/dsh-infini-goal` | Core service `ctx.infiniGoals`: event-sourced state, CAS changes, `infiniGoal` Session projection |
| `packages/driver` | `@yankeguo/dsh-infini-goal-driver` | Automatic-continuation driver (minimum interval / quiet windows) |
| `packages/tool` | `@yankeguo/dsh-tool-infini-goal` | Model tools + system-prompt guidance |
| `packages/command` | `@yankeguo/dsh-command-infini-goal` | The `/infini-goal` human command |
| `packages/client-ui` | `@yankeguo/dsh-client-ui-infini-goal` | Browser status bar |
| `packages/bundle` | `@yankeguo/dsh-infini-goal-bundle` | Bundle: `cordis.patch.yml` + generated `cordis.disable-goal.patch.yml` + dependencies |
| `packages/disable-goal-bundle` | `@yankeguo/dsh-disable-goal-bundle` | Standalone bundle that only switches the built-in `dsh-goal` off (also provides the main bundle's `preset-filter` runtime module) |

`pnpm build` produces nine `lib/*.js` files: protocol's `index`/`client`, core,
driver, tool, command, client-ui's `index`/`client`, plus the
`disable-goal-bundle` runtime asset `preset-filter.js`; the `bundle` package
only contains patch files and emits no JS. Build details (esbuild externals,
browser CJS wrapper, byte-for-byte copied runtime asset) are in
[DESIGN.md §2](DESIGN.md#2-包结构).

## Prerequisites

| Item | Requirement |
| --- | --- |
| Node.js | ≥ 24.9 (`engines.node` in the root `package.json`) |
| pnpm | 12.x; CI pins `pnpm@12.16.1` |
| Git | any recent version |

The devDependencies pin the DSH SDK to `0.2.2-rc.3`; unit tests, typecheck, and
build do **not** require an installed DeepSeek Harness. The whole supported
range is exercised with real installed DSH releases by the E2E harness (see
[COMPATIBILITY.md](COMPATIBILITY.md)).

## Setup and checks

```sh
pnpm install
pnpm verify        # typecheck + unit tests + build; run before pushing
```

Individual commands:

```sh
pnpm typecheck     # TypeScript check across the monorepo
pnpm test          # unit tests, including generated-bundle composition and plugin-metadata checks
pnpm build         # esbuild outputs (9 lib/*.js files)
pnpm clean         # remove build output

pnpm dev:patch     # generate .tmp/cordis.patch.yml (absolute-path insertion; debug without installing)
node scripts/build-disable-goal-bundle.mjs --check   # generated bundle patches + manifests are current
```

The CI publishing workflow runs, in order: the tag/version gate
(`node scripts/stage-release.mjs --release-tag <tag> --gate`), `pnpm install
--frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
`node scripts/build-disable-goal-bundle.mjs --check`, then the staging run.
Local equivalents of the release checks are:

```sh
pnpm release:check        # release plan + build artifacts, no network, no upload
pnpm release:stage:dry    # build + `pnpm stage publish --dry-run` for every package
```

Do not bump versions, tag, or publish from a documentation change; versions
and releases follow [PUBLISHING.md](PUBLISHING.md).

## Installing a local checkout for acceptance

```sh
pnpm install
pnpm build
pnpm install:profile                  # defaults to --profile desktop
# or specify a profile / home
node scripts/install-profile.mjs --profile desktop --dsh-home ~/.dsh
```

The script:

1. symlinks all 8 workspace packages (6 plugin packages + 2 bundle packages)
   into `$DSH_HOME/profiles/<profile>/node_modules/@yankeguo/`;
2. appends `@yankeguo/dsh-infini-goal-bundle` to the profile's
   `dsh.profile.bundles`. The bundle embeds the built-in-goal disable layer, so
   the official goal is off by default; a profile that still selected the old
   companion bundle has it deselected (the package stays installed because the
   main bundle imports its `preset-filter` module), and a leftover generated
   disable-goal block in the profile patch is removed;
3. backs up the profile's `package.json` before writing (when there are
   changes).

DSH's profile HMR loads host plugins live; the status bar appears after
refreshing the browser page. Uninstall with `pnpm uninstall:profile`.

`--disable-builtin-goal` is still accepted as a deprecated no-op for scripts
written against older releases.

For a quick overlay without touching a profile (DSH supports absolute file
paths as `insert` names), run `pnpm dev:patch` and pass the generated patch:

```sh
dsh web --patch .tmp/cordis.patch.yml --port 34000 --no-open
```

## End-to-end verification

The E2E harness is isolated: it uses its own `DSH_HOME`, a deterministic mock
LLM (no API tokens), and never touches the running desktop app, its profile, or
`~/.dsh`. It lives under `tools/e2e/`; see
[tools/e2e/README.md](../tools/e2e/README.md) for the full harness reference.

```sh
tools/e2e/bootstrap.sh          # create an isolated profile under /tmp
tools/e2e/smoke.sh              # infrastructure smoke (plugin / session / mock LLM insertion)
tools/e2e/suite.sh --fresh      # end-to-end scenarios for this suite (minimum interval / quiet windows / pause)
tools/e2e/probe-tools.sh        # scripted model-tool path (create + update, policy prompt, tool row)
tools/e2e/probe-install.sh      # installed-profile proof: built-in goal off by default, /infini-goal works
tools/e2e/probe-bundles.sh      # bundle packaging: main-only install, legacy-companion migration, duplicate-id tolerance
```

`suite.sh` builds the repo and generates the development overlay itself;
`probe-tools.sh` needs a fresh `pnpm build` plus `node scripts/dev-patch.mjs`. The default launcher
is the installed desktop DSH; set `DSH_BIN` to test an npm-installed release. Scratch state
defaults to `/tmp/dsh-e2e`; `DSH_E2E_ROOT` and `TMPDIR` can point at a cache directory on hosts
where tmpfs pressure is a concern.

Record the new evidence in [COMPATIBILITY.md](COMPATIBILITY.md) when verifying a
new DSH release, and widen/narrow `engines.dsh` plus the host peer ranges in all
eight `package.json` files only after the probes pass.

## Plugin display metadata

Every published package ships DSH plugin display text in `locale/en.json` and
`locale/zh.json` (`{"meta":{"title":"…","description":"…"}}`), wired through
`"locale/*.json"` in `files` and `"./locale/*.json": "./locale/*.json"` in
`exports`. DSH reads these files without evaluating plugin code, so the Plugins
page and the plugin market show a friendly title and one-line description
instead of the npm package name. If a locale omits a field, DSH falls back to
the package `description` (then the package name for the title).
`packages/bundle/tests/plugin-metadata.spec.ts` (picked up by `pnpm test`)
enforces en/zh parity, non-empty titles/descriptions, the manifest wiring, the
`description` ↔ English-locale sync rule, and keeps list copy free of marketing
superlatives. When adding a package, add both locale files, the
`files`/`exports` entry, and the package to that spec's expected table.

## Documentation conventions

- **README files are user-facing.** Root `README.md` / `README.zh.md` cover what
  the plugin is, requirements, install, configuration, usage, limitations, and
  troubleshooting. Development details (repository layout, build/test commands,
  release/CI, E2E evidence, internal architecture) belong here, in
  [DESIGN.md](DESIGN.md), or in [PUBLISHING.md](PUBLISHING.md) — not in the
  README.
- **Version history stays out of the README.** Release notes live in
  `docs/releases/` and on GitHub Releases; the README only links to them.
- **No YAML frontmatter in README files.** npm does not render a leading `---`
  metadata block on the package page; it shows up as literal text (a stray
  `---` and `description:`/`kind:` lines). The frontmatter convention comes from
  DSH-internal documentation pipelines and does not apply to third-party
  packages published to npm. The bundle package READMEs are plain Markdown; the
  release check (`assertPackageContents` in `scripts/lib/release.mjs`) rejects a
  packaged README that starts with frontmatter, while still requiring every
  literal `files` entry (including `README.md` for packages that ship one) to
  exist; glob entries such as `locale/*.json` are validated from the packed
  tarball.
- **Links in README files must be absolute.** npm renders README files outside
  this repository, so links to repo docs use
  `https://github.com/yankeguo/dsh-infini-goal/blob/main/…` and images use
  `https://raw.githubusercontent.com/yankeguo/dsh-infini-goal/main/…`. Avoid
  relative paths and markdown features that npm does not render.
- Keep [AGENTS.md](../AGENTS.md) in sync when changing authorization behavior,
  compatibility range, or the release process.

## License

[MIT](../LICENSE)
