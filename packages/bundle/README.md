# @yankeguo/dsh-infini-goal-bundle

The main bundle for [dsh-infini-goal](https://github.com/yankeguo/dsh-infini-goal/blob/main/README.md):
it installs the endless-goal suite for DeepSeek Harness — core service, automatic-continuation
driver, model tools, the `/infini-goal` command, and the status bar — and switches the built-in
`dsh-goal` mode off by default.

An endless goal has **no round cap**, starts each automatic round at least a configured **minimum
trigger interval** apart, and suppresses automatic rounds inside configurable **quiet windows**.

## Install

```sh
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle
```

You can also install it from the Web UI: **Plugins → Add plugin**, then enter the package name.

After installing, confirm on the **Plugins** page that the bundle is enabled (newly installed
bundles are usually enabled by default; if it shows as disabled, tick it), then refresh the Web
page. One bundle is enough: it embeds the same built-in-goal disable layer as the standalone
`@yankeguo/dsh-disable-goal-bundle`, so that companion bundle is not required.

```sh
# Upgrade to a specific version
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle@<version>

# Uninstall
dsh plugin --profile desktop remove @yankeguo/dsh-infini-goal-bundle
```

## What it provides

| Row | Purpose |
| --- | --- |
| `infini-goal` | Core service: durable goal state and the `infiniGoal` Session projection |
| `infini-goal-driver` | Automatic-continuation driver: minimum interval / quiet windows / round injection |
| `infini-goal-tool` | Model tools `get_infini_goal` / `create_infini_goal` / `update_infini_goal` |
| `infini-goal-command` | The `/infini-goal` human command |
| `infini-goal-ui` | The status bar above the composer |

The bundle also applies a generated disable layer that turns DSH's official goal mode off (automatic
rounds, GoalBar, `/goal`, and the goal tools). Every contributed row — the five rows above and the
three generated `preset-*-filter` rows — can be switched individually on the bundle's page under
**Plugins**; switching the whole bundle off restores the official goal mode live.

The deploy-level configuration keys (`defaultMinIntervalMs`, `defaultQuietWindows`, `timezone`,
`autoContinueOnStart`, `pollFloorMs`, `blockedAfterConsecutiveRounds`) and the quiet-window syntax
are documented in the
[main README's configuration section](https://github.com/yankeguo/dsh-infini-goal/blob/main/README.md#configuration).

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | `>=0.2.2-rc.1 <0.3.0` (the 0.2.2 release line); DSH skips a bundle outside its declared `engines.dsh` |
| DSH surface | Desktop app or `dsh web`; the status bar only renders in the Web UI |
| Dependencies | None beyond DSH: this bundle depends on (and installs) all suite packages; no extra API keys |

## Documentation

- [Main README](https://github.com/yankeguo/dsh-infini-goal/blob/main/README.md) — features, install,
  usage, configuration, limitations, troubleshooting
- [Disabling the built-in dsh-goal](https://github.com/yankeguo/dsh-infini-goal/blob/main/docs/DISABLE-BUILTIN-GOAL.md) —
  why and how the official goal mode is switched off
- [Design notes](https://github.com/yankeguo/dsh-infini-goal/blob/main/docs/DESIGN.md)
- [DSH compatibility](https://github.com/yankeguo/dsh-infini-goal/blob/main/docs/COMPATIBILITY.md)
- [Release notes](https://github.com/yankeguo/dsh-infini-goal/tree/main/docs/releases)

## License

[MIT](https://github.com/yankeguo/dsh-infini-goal/blob/main/LICENSE)
