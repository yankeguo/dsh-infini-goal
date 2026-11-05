---
description: "Companion bundle for @yankeguo/dsh-infini-goal: disables the built-in dsh-goal mode so the endless infini-goal suite is the only goal system. Toggle it from Plugins; no profile patch editing."
kind: "package-bundle"
---

# @yankeguo/dsh-disable-goal-bundle

[`@yankeguo/dsh-infini-goal-bundle`](../bundle/README.md) 的**可选伴生 bundle**：
把 DSH 自带的官方 goal 模式（自动轮次、GoalBar、`/goal` 命令、`get_goal` /
`create_goal` / `update_goal` 工具）关掉，让无限目标套件成为唯一的目标系统。

它只是一个 **bundle 层**（`cordis.patch.yml`），没有运行时代码：

- 启用（install / select）→ 官方 goal 模式关闭；
- 禁用（deselect）→ 官方 goal 模式恢复；
- profile 的 `cordis.patch.yml` **保持干净**，不再需要粘贴一大段 preset 重写。

## 安装与开关

```sh
# 从 npm 安装（发布后）
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle

# 本地 checkout
pnpm build
pnpm install:profile --disable-builtin-goal
```

然后在 **Plugins** 页面里勾选/取消 `@yankeguo/dsh-disable-goal-bundle` 即可实时切换
（HMR 重新组合；preset 变更只影响之后创建的 Agent，彻底生效建议重启一次 DSH）。

## 它到底改了什么

一个 bundle patch 层，包含 5 个 patch 条目：

| 条目 | 作用 |
| --- | --- |
| `goal-round-driver` / `disabled: true` | 关闭官方自动续跑驱动器 |
| `ui-goal` / `disabled: true` | 关闭 composer 上方的官方 GoalBar |
| `preset-standard` / `preset-ptc` / `preset-cordis` 覆盖 | 用 shipped 子插件列表去掉 `command-goal`、`tool-goal` 后覆盖 |

为什么不能直接关掉 `goal` 服务：官方 Web 组合把 `goal` 服务留在 host 平面，
`command-goal` / `tool-goal` 按 agent preset 挂载；服务缺失会让 preset 激活失败
（`agent-preset/invalid: ... waiting for goals`）。所以服务保留（惰性），只去掉
驱动器、UI 与 per-preset 的命令/工具行。详细原理见
[`docs/DISABLE-BUILTIN-GOAL.md`](../../docs/DISABLE-BUILTIN-GOAL.md)。

## 维护

bundle 里的 preset 覆盖是 DSH shipped preset 的快照（当前按 **DSH 0.2.2-rc.1** 生成）。
DSH 升级后重新生成并发布：

```sh
node scripts/build-disable-goal-bundle.mjs          # 重新生成 cordis.patch.yml
node scripts/build-disable-goal-bundle.mjs --check  # CI / 发布前检查是否过期
```

脚本直接从已安装的 DSH `app.asar` 读取 shipped preset（Electron-as-Node，无需解包）。
如果升级后 preset 文件改名，脚本会报错退出，不会写坏 patch。

## 限制

- 它冻结 `standard` / `ptc` / `cordis` 三个 preset 的子插件列表：DSH 升级后新增的
  shipped 插件不会自动出现在这些 preset 里，需要重新生成 bundle。
- 官方 `goal` 服务仍然挂载；已存在的官方 goal 会变成惰性状态。需要清理时先禁用本
  bundle、用 `/goal clear` 清空，再重新启用。
- 与 `@yankeguo/dsh-infini-goal-bundle` 配套使用；单独启用没有意义（只是关掉官方 goal）。
