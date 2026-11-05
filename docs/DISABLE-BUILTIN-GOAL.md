# 关闭系统自带的 dsh-goal（可选）

DSH 默认自带官方 goal 模式（`dsh-goal` / `dsh-tool-goal` / `dsh-command-goal` /
`dsh-goal-round-driver` / `dsh-client-ui-goal`）。装了本插件后两套目标系统可以共存
（工具名、命令名、状态条都不同名），但如果你希望 **infini-goal 成为唯一的目标系统**，
推荐安装可选的伴生 bundle：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle
```

启用即关闭官方 goal，**禁用（在 Plugins 里取消勾选）即恢复**，profile 的
`cordis.patch.yml` 保持干净。本地 checkout 用 `pnpm install:profile --disable-builtin-goal`。

想先了解机制再决定？见下面"为什么不能直接禁用 `goal` 服务"和"bundle 里是什么"。

## 为什么不能直接禁用 `goal` 服务

官方 Web 组合里，`goal` **服务**留在 host 平面，而 `command-goal` / `tool-goal`
是按 **agent preset** 挂载的（`dsh-web-app/presets/*.patch.yml`）。如果直接
`- id: goal / disabled: true`，preset 绑定会失败：

```
agent-preset/invalid: command-goal (@deepseek-ai/dsh-command-goal): waiting for goals
tool-goal (@deepseek-ai/dsh-tool-goal): waiting for goals
```

所以 bundle 保留 `goal` 服务（惰性、无害，历史 `goal/change` 事件仍能回放），只去掉：

- `goal-round-driver`：不再有官方自动轮次；
- `ui-goal`：composer 上方不再有官方 GoalBar；
- 三个 shipped preset（`standard` / `ptc` / `cordis`）子插件列表中的
  `command-goal` 与 `tool-goal`：新 Agent 不再有 `/goal` 命令和
  `get_goal` / `create_goal` / `update_goal` 工具。

为什么不能只覆盖 preset 的子行：profile patch 只能按 **loader 行 id** 覆盖，
preset 里的 `plugins` 是那一行的 **config 数据**（Session 绑定时才插进 registry 自己的
Loader tree），不是 profile 的 loader 行；patch 的 `config` 又是**整体替换**而非深合并，
所以想让 preset 的子列表少两行，只能整段重写或者换一种加载方式。这是
`@deepseek-ai/dsh-agent-preset-registry` 的已知取舍：

> *"A user override replaces the complete child list and does not automatically merge future
> changes to the builtin list."*

本 bundle 选择后者：停用 shipped preset 声明，改挂一个运行时 `preset-filter`，由它读取
**已安装的** preset 再过滤，从而不冻结任何子列表。

## 方式 A：伴生 bundle（推荐）

### 安装（发布到 npm 后）

```sh
# CLI 安装（安装后在 Plugins 页面确认已启用）
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle

# 或在 Web：Plugins → Add plugin → 输入 @yankeguo/dsh-disable-goal-bundle
```

### 本地 checkout

```sh
pnpm build
node scripts/install-profile.mjs --disable-builtin-goal
```

该命令会：链接全部 8 个 workspace 包到 profile `node_modules`、选中主 bundle 与
disable-goal bundle、并把之前脚本写进 profile patch 的旧块自动移除（有备份）。

### 开关

- **关闭官方 goal**：Plugins 页面勾选 `@yankeguo/dsh-disable-goal-bundle`（或保留在
  profile `dsh.profile.bundles` 里）；
- **恢复官方 goal**：取消勾选 / 从 `dsh.profile.bundles` 移除，HMR 会移除该层；
- preset 变更只影响**之后创建的 Agent**，彻底生效建议重启一次 DSH。

### 验证

- 新建会话 → `/` 菜单没有 `/goal`，只有 `/infini-goal`；
- 模型工具列表没有 `get_goal` / `create_goal` / `update_goal`，有 `*_infini_goal`；
- composer 上方只有 infini-goal 状态条。

## 方式 B：脚本写 profile patch（自定义 profile / 不装 bundle）

适合没有走 bundle 安装、或想给非 desktop profile 单个开关的场景：

```sh
# 预览生成的 patch 块
node scripts/disable-builtin-goal.mjs --print

# 写入 profile patch（默认 ~/.dsh/profiles/desktop/cordis.patch.yml，自动备份）
node scripts/disable-builtin-goal.mjs --write

# 撤销（只删除生成块，保留你自己的其它 patch）
node scripts/disable-builtin-goal.mjs --remove

# 其它 profile
node scripts/disable-builtin-goal.mjs --write --profile-patch ~/.dsh/profiles/<name>/cordis.patch.yml
```

生成块用 `# BEGIN dsh-infini-goal: disable builtin dsh-goal` 与
`# END dsh-infini-goal: disable builtin dsh-goal` 两行标记包住，`--write` 会替换旧块、
`--remove` 精确删除；`--exclude ptc,cordis` 可只覆盖部分 preset。
默认是静态快照（自包含、需随 DSH 升级重新生成）；加 `--dynamic` 可输出和伴生 bundle 相同的
小动态块（要求 `@yankeguo/dsh-disable-goal-bundle` 已链接进该 profile）。
**不要和方式 A 同时用**（内容相同但重复）；`install-profile.mjs --disable-builtin-goal`
会自动清掉旧块。

## bundle 里是什么（动态，不复制 preset）

[`packages/disable-goal-bundle/cordis.patch.yml`](../packages/disable-goal-bundle/cordis.patch.yml)
只有几十行，**不复制任何 preset 子插件列表**：

```yaml
- id: goal-round-driver     # 关闭官方自动轮次
  disabled: true
- id: ui-goal                # 关闭官方 GoalBar
  disabled: true
- id: preset-standard        # 停用 shipped preset 声明
  disabled: true
- id: preset-ptc
  disabled: true
- id: preset-cordis
  disabled: true
- insert:                    # 每个 preset 用一个很小的 filter 行替代
    - id: preset-standard-filter
      name: '@yankeguo/dsh-disable-goal-bundle/preset-filter'
      config: { preset: standard, remove: [command-goal, tool-goal] }
    # ... ptc / cordis
```

`preset-filter` 在启动时通过 Loader 自己的模块解析读取**已安装的** shipped preset 声明
（能读 `app.asar`），把 `command-goal` / `tool-goal` 过滤掉后，挂载真正的
`@deepseek-ai/dsh-agent-preset`。因此只禁用两个子项，preset 的其余内容仍来自 DSH 本身。
该运行时插件由 `@yankeguo/dsh-disable-goal-bundle/preset-filter` 导出（见包 `package.json`
的 `exports` 与 `packages/disable-goal-bundle/src/preset-filter.js`；`pnpm build` 会把该文件
逐字节复制为 `lib/preset-filter.js`，`install-profile.mjs` 会检查它存在）。

包信息见 [`packages/disable-goal-bundle/README.md`](../packages/disable-goal-bundle/README.md)。

## 维护：通常无需重新生成

动态 patch 不随 DSH 版本变化，**DSH 升级后不需要重新生成**。`scripts/build-disable-goal-bundle.mjs`
仅用于重新生成/校验这个 patch 文件本身；CI 目前不运行该校验，发布前建议手动执行：

```sh
node scripts/build-disable-goal-bundle.mjs          # 重新生成（默认动态版本）
node scripts/build-disable-goal-bundle.mjs --check  # 发布前手动检查是否最新（不是 CI 步骤）
```

如果未来 DSH 改动了 Loader 模块解析或 preset 文件布局，导致 filter 失效，可用快照回退：

```sh
node scripts/build-disable-goal-bundle.mjs --static   # 从已安装 app.asar 生成完整快照
```

`--static` 会复制 shipped 子列表，之后 DSH 升级需要重新生成。

## 注意事项

- 动态 filter 依赖 Loader 的模块解析与 shipped preset 文件布局；DSH 大版本升级后建议先跑
  一次隔离验证，必要时用 `--static` 回退。`minimal` preset 没有 goal 行，不需要替换。
- 已有官方 goal 会变成惰性状态（服务在、driver/工具/UI 不在）。需要清理时先禁用本
  bundle、用 `/goal clear` 清空，再重新启用。
- `goal` 服务仍挂载（preset 激活需要它）。如果未来 DSH 把 goal 从 preset 中移走，
  这个 bundle 自然变成 no-op（filter 只是原样挂载 preset），可以直接禁用。
