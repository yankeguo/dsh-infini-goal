---
description: "Companion bundle for @yankeguo/dsh-infini-goal: disables the built-in dsh-goal mode so the endless infini-goal suite is the only goal system. Toggle it from Plugins; no profile patch editing."
kind: "package-bundle"
---

# @yankeguo/dsh-disable-goal-bundle

[`@yankeguo/dsh-infini-goal-bundle`](../bundle/README.md) 的**可选伴生 bundle**：
把 DSH 自带的官方 goal 模式（自动轮次、GoalBar、`/goal` 命令、`get_goal` /
`create_goal` / `update_goal` 工具）关掉，让无限目标套件成为唯一的目标系统。

它由一层 **bundle patch**（`cordis.patch.yml`）和一个很小的 **`preset-filter` 运行时插件**组成：

- 启用（install / select）→ 官方 goal 模式关闭；
- 禁用（deselect）→ 官方 goal 模式恢复；
- profile 的 `cordis.patch.yml` **保持干净**，不再需要粘贴一大段 preset 重写。

运行时插件只在启动时做一件事：读取**已安装的** shipped preset 声明，过滤掉
`command-goal` / `tool-goal` 后挂载真正的 `@deepseek-ai/dsh-agent-preset`。因此它不是纯数据层，
但也不会复制任何 preset 子列表。

## 安装与开关

```sh
# 从 npm 安装（发布后）
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle

# 本地 checkout
pnpm build
pnpm install:profile --disable-builtin-goal
```

`pnpm build` 会把 `src/preset-filter.js` 逐字节复制为 `lib/preset-filter.js`（运行时资产，不转译），`install-profile.mjs` 会检查它是否存在。

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
只用于重新生成/校验这个 patch 文件本身（默认输出动态版本、`--check` 检查是否最新；CI 目前
不运行该校验，发布前建议手动执行）。

如果未来 DSH 改动了 Loader / preset 内部机制导致动态 filter 失效，可用快照回退：

```sh
node scripts/build-disable-goal-bundle.mjs --static   # 用已安装 app.asar 生成完整快照
```

`--static` 会冻结 shipped preset 子插件列表，之后每次 DSH 升级都需要重新生成。

## 限制

- 动态 filter 依赖 Loader 的 `!!js`/模块解析与 shipped preset 文件布局；DSH 大版本升级后
  建议先跑一次隔离验证，必要时用 `--static` 回退（快照会冻结 preset 子插件列表）。
- 官方 `goal` 服务仍然挂载；已存在的官方 goal 会变成惰性状态。需要清理时先禁用本
  bundle、用 `/goal clear` 清空，再重新启用。
- 与 `@yankeguo/dsh-infini-goal-bundle` 配套使用；单独启用没有意义（只是关掉官方 goal）。
