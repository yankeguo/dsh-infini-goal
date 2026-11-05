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

为什么必须重写 preset 的整段子列表：profile patch 只能按 **loader 行 id** 覆盖，
preset 里的 `plugins` 是那一行的 **config 数据**（Session 绑定时才插进 registry 自己的
Loader tree），不是 profile 的 loader 行；patch 的 `config` 又是**整体替换**而非深合并。
这是 `@deepseek-ai/dsh-agent-preset-registry` 的已知取舍：

> *"a user override replaces the complete child list rather than merging future builtin changes."*

## 方式 A：伴生 bundle（推荐）

### 安装（发布到 npm 后）

```sh
# CLI 安装并启用
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle

# 或在 Web：Plugins → Add plugin → 输入 @yankeguo/dsh-disable-goal-bundle
```

### 本地 checkout

```sh
pnpm build
node scripts/install-profile.mjs --disable-builtin-goal
```

该命令会：链接所有 workspace 包到 profile `node_modules`、选中主 bundle 与
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

生成块用 `# BEGIN/END dsh-infini-goal: disable builtin dsh-goal` 标记包住，
`--write` 会替换旧块、`--remove` 精确删除；`--exclude ptc,cordis` 可只覆盖部分 preset。
**不要和方式 A 同时用**（内容相同但重复）；`install-profile.mjs --disable-builtin-goal`
会自动清掉旧块。

## bundle 里是什么

[`packages/disable-goal-bundle/cordis.patch.yml`](../packages/disable-goal-bundle/cordis.patch.yml)
是一个普通 bundle 层（无运行时代码），由脚本从**已安装的 DSH app.asar** 读取 shipped
preset 后生成：

```yaml
- id: goal-round-driver
  disabled: true
- id: ui-goal
  disabled: true
- id: preset-standard      # config.plugins = shipped 列表去掉 command-goal/tool-goal
  name: '@deepseek-ai/dsh-agent-preset'
  config: { ... }
- id: preset-ptc
- id: preset-cordis
```

包信息见 [`packages/disable-goal-bundle/README.md`](../packages/disable-goal-bundle/README.md)。

## 维护：DSH 升级后重新生成

bundle 的 preset 覆盖是 DSH shipped preset 的**快照**（生成头里记录了 DSH 版本，当前
`0.2.2-rc.1`）。DSH 升级后：

```sh
cd /Users/guoyk/Workspace/src/github.com/yankeguo/dsh-infini-goal
node scripts/build-disable-goal-bundle.mjs          # 重新生成 cordis.patch.yml
node scripts/build-disable-goal-bundle.mjs --check  # 发布前/CI 检查是否过期
```

脚本用 Electron 自带 Node 读 app.asar（`ELECTRON_RUN_AS_NODE=1`），无需解包、无额外依赖；
preset 文件改名时会报错退出而不是写坏 patch。生成后按 semver 升 patch 版本发布即可，
插件市场/Plugins 页会提示更新。

## 注意事项

- bundle 会冻结 `standard` / `ptc` / `cordis` 的子插件列表：DSH 升级后新增的 shipped
  插件不会自动出现在这些 preset 里，直到重新生成。`minimal` preset 没有 goal 行，
  不需要覆盖。
- 已有官方 goal 会变成惰性状态（服务在、driver/工具/UI 不在）。需要清理时先禁用本
  bundle、用 `/goal clear` 清空，再重新启用。
- `goal` 服务仍挂载；如果未来 DSH 改变 preset 布局（比如把 goal 移到独立 plugin group），
  重新生成脚本会感知到并更新覆盖方式。
