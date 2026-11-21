# @yankeguo/dsh-disable-goal-bundle

A standalone bundle that turns the built-in `dsh-goal` mode off in DeepSeek Harness (automatic
rounds, GoalBar, the `/goal` command, and the `get_goal` / `create_goal` / `update_goal` tools).

## When to use it

**Most users do not need this package.** The main
[`@yankeguo/dsh-infini-goal-bundle`](https://github.com/yankeguo/dsh-infini-goal/blob/main/packages/bundle/README.md)
embeds the same disable layer by default, so installing the infini-goal suite already turns the
official goal off. Install this bundle only for a profile that should switch the built-in goal off
**without** the infini-goal suite.

Do not enable both bundles in one profile: they deliberately share the same row ids, so DSH
tolerates the duplicate rows and mounts each preset filter once, but the Plugins page can then no
longer switch those three filter rows individually. Prefer one bundle.

## Install

```sh
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle
```

Then tick or untick `@yankeguo/dsh-disable-goal-bundle` on the **Plugins** page to switch the
official goal mode off or back on live. Preset changes only affect agents created afterwards, so a
DSH restart is recommended for a fully clean state.

```sh
# Uninstall
dsh plugin --profile desktop remove @yankeguo/dsh-disable-goal-bundle
```

## What it changes

A bundle patch layer that disables the official rows instead of copying preset content:

| Row | Effect |
| --- | --- |
| `goal-round-driver` / `ui-goal` | Official automatic-round driver and GoalBar disabled |
| `preset-standard` / `preset-ptc` / `preset-cordis` | Shipped preset declarations disabled |
| `preset-*-filter` (three inserted rows) | Re-mount the shipped agent presets without `command-goal` / `tool-goal` |

Because the filter reads the installed presets at startup and only removes the two goal rows, a DSH
upgrade does not require regenerating the patch. The rationale, maintenance, and fallback details
are in
[Disabling the built-in dsh-goal](https://github.com/yankeguo/dsh-infini-goal/blob/main/docs/DISABLE-BUILTIN-GOAL.md).

## Requirements

DSH `>=0.2.2-rc.1 <0.3.0`; no extra dependencies. The package is also a runtime dependency of the
main bundle (which imports its `preset-filter` module), so it must stay installed even when this
bundle itself is not selected.

## Documentation

- [Main README](https://github.com/yankeguo/dsh-infini-goal/blob/main/README.md)
- [Disabling the built-in dsh-goal](https://github.com/yankeguo/dsh-infini-goal/blob/main/docs/DISABLE-BUILTIN-GOAL.md)

## License

[MIT](https://github.com/yankeguo/dsh-infini-goal/blob/main/LICENSE)
