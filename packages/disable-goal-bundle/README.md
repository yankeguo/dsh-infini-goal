---
description: "Standalone bundle that disables the built-in dsh-goal mode as an ordinary toggleable layer. The main infini-goal bundle embeds the same layer by default; keep this one for profiles that only want the built-in goal off."
kind: "package-bundle"
---

# @yankeguo/dsh-disable-goal-bundle

把 DSH 自带的官方 goal 模式（自动轮次、GoalBar、`/goal` 命令、`get_goal` /
`create_goal` / `update_goal` 工具）关掉的**独立 bundle**。

> **通常不需要单独安装它。** [`@yankeguo/dsh-infini-goal-bundle`](../bundle/README.md)
> 默认内嵌了与本 bundle **完全相同**的关闭层（`dsh.bundle.patch` 依次应用
> `cordis.patch.yml` 与生成的 `cordis.disable-goal.patch.yml`），安装主 bundle 即自动关闭
> 官方 goal。本 bundle 只用于「**只想关闭官方 goal、不安装 infini-goal 套件**」的 profile。
> 两个 bundle 不要同时启用（同一批 row id；DSH 能容忍重复行且每类 filter 只挂载一次，但
> Plugins 页面会无法单独开关那 3 个 filter 行）。

它由一层 **bundle patch**（`cordis.patch.yml`，由生成器输出）和一个很小的
**`preset-filter` 运行时插件**组成：

- 启用（install / select）→ 官方 goal 模式关闭；
- 禁用（deselect）→ 官方 goal 模式恢复；
- profile 的 `cordis.patch.yml` **保持干净**，不再需要粘贴一大段 preset 重写。

运行时插件只在启动时做一件事：读取**已安装的** shipped preset 声明，过滤掉
`command-goal` / `tool-goal` 后挂载真正的 `@deepseek-ai/dsh-agent-preset`。因此它不是纯数据层，
但也不会复制任何 preset 子列表。

## 安装与开关

```sh
# 从 npm 安装（发布后）；只想要「关闭官方 goal」时才需要
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle
```

本地 checkout：先用 `pnpm build` 构建（`pnpm build` 会把 `src/preset-filter.js` 逐字节复制为
`lib/preset-filter.js`，运行时资产不转译），再手动把本 bundle 加进 profile 的
`dsh.profile.bundles`；`pnpm install:profile` 是主 bundle 的安装路径，会**取消**本 bundle 的选择。
`--disable-builtin-goal` 仍被接受，但已废弃且无效果（主 bundle 默认就关闭官方 goal）。

然后在 **Plugins** 页面里勾选/取消 `@yankeguo/dsh-disable-goal-bundle` 即可实时切换
（HMR 重新组合；preset 变更只影响之后创建的 Agent，彻底生效建议重启一次 DSH）。

## 它到底改了什么

一个 bundle patch 层，**不复制任何 preset 子插件列表**：

| 条目 | 作用 |
| --- | --- |
| `goal-round-driver` / `disabled: true` | 关闭官方自动续跑驱动器 |
| `ui-goal` / `disabled: true` | 关闭 composer 上方的官方 GoalBar |
| `preset-standard` / `preset-ptc` / `preset-cordis` / `disabled: true` | 停用 shipped preset 声明 |
| `insert` 三个 `preset-*-filter` 行 | 挂载本包的 `preset-filter` 插件：启动时通过 Loader 的模块解析读取**已安装的** shipped preset 声明（支持 app.asar），过滤掉 `command-goal` / `tool-goal` 后挂载真正的 `@deepseek-ai/dsh-agent-preset` |

这样只"禁用要禁用的"，不冻结 preset 内容：DSH 升级后的 shipped preset 变化会自动生效，
**不需要重新生成 bundle**。

为什么不能直接关掉 `goal` 服务：官方 Web 组合把 `goal` 服务留在 host 平面，
`command-goal` / `tool-goal` 按 agent preset 挂载；服务缺失会让 preset 激活失败
（`agent-preset/invalid: ... waiting for goals`）。所以服务保留（惰性），只去掉
驱动器、UI 与 per-preset 的命令/工具行。详细原理见
[`docs/DISABLE-BUILTIN-GOAL.md`](../../docs/DISABLE-BUILTIN-GOAL.md)。

## 维护

默认的 bundle patch 是**动态**的：只有 2 个 host 行禁用、3 个 preset 声明禁用和 3 个
filter 行，不随 DSH 版本变化，**DSH 升级后无需重新生成**。`scripts/build-disable-goal-bundle.mjs`
用于重新生成/校验 patch 文件本身：它**同时**输出本 bundle 的 `cordis.patch.yml` 与主 bundle
内嵌的 `packages/bundle/cordis.disable-goal.patch.yml`（同一份生成器，避免两处漂移），
默认输出动态版本、`--check` 检查两个文件与 bundle manifest 是否最新
（`pnpm test` 也会 spawn 该校验；发布前建议手动执行一次）。

如果未来 DSH 改动了 Loader / preset 内部机制导致动态 filter 失效，可用快照回退：

```sh
node scripts/build-disable-goal-bundle.mjs --static   # 用已安装 app.asar 生成完整快照（两个文件）
```

`--static` 会冻结 shipped preset 子插件列表，之后每次 DSH 升级都需要重新生成。

## 限制

- 动态 filter 依赖 Loader 的 `!!js`/模块解析与 shipped preset 文件布局；DSH 大版本升级后
  建议先跑一次隔离验证，必要时用 `--static` 回退（快照会冻结 preset 子插件列表）。
- 官方 `goal` 服务仍然挂载；已存在的官方 goal 会变成惰性状态。需要清理时先禁用本
  bundle、用 `/goal clear` 清空，再重新启用。
- 本 bundle 与主 bundle 内嵌的关闭层共用同一批 row id：同时启用两个 bundle 时，Loader 每个
  id 只保留一个 entry（后插入者生效），不会重复挂载 preset filter；但 Plugins 页面无法再单独
  开关这 3 个 filter 行。请只启用其中一个（主 bundle 已默认包含）。
- 本包同时是主 bundle 的运行时依赖：主 bundle 的 filter 行 import 本包的
  `./preset-filter` 模块，因此即使不启用本 bundle，它的包文件也需要保持安装。
