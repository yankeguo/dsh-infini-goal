# 关闭系统自带的 dsh-goal（主 bundle 默认行为）

DSH 默认自带官方 goal 模式（`dsh-goal` / `dsh-tool-goal` / `dsh-command-goal` /
`dsh-goal-round-driver` / `dsh-client-ui-goal`）。本插件套件与它可以共存（工具名、命令名、
状态条都不同名），但从**主 bundle 默认内嵌了关闭层**开始：

- 安装 [`@yankeguo/dsh-infini-goal-bundle`](../packages/bundle/README.md) 就会把官方
  goal 模式关掉，**不需要**再单独安装任何伴生 bundle；
- 关闭层是普通 bundle 层的一部分，没有任何 preset 内容被复制；
- 主 bundle 贡献的每一行（5 个 infini-goal 行 + 3 个生成的 `preset-*-filter` 行）都可以在
  **Plugins** 页面单独开关；关掉整个 bundle 即恢复官方 goal 模式。

独立 bundle [`@yankeguo/dsh-disable-goal-bundle`](../packages/disable-goal-bundle/README.md)
仍然保留，适用于「只想关闭官方 goal、不安装 infini-goal 套件」的 profile：它的 patch 与主
bundle 内嵌层**逐字节相同**，两者由同一生成器输出。

想先了解机制？见下面"为什么不能直接禁用 `goal` 服务""bundle 里是什么"和"三种使用方式"。

## 为什么不能直接禁用 `goal` 服务

官方 Web 组合里，`goal` **服务**留在 host 平面，而 `command-goal` / `tool-goal`
是按 **agent preset** 挂载的（`dsh-web-app/presets/*.patch.yml`）。如果直接
`- id: goal / disabled: true`，preset 绑定会失败：

```
agent-preset/invalid: command-goal (@deepseek-ai/dsh-command-goal): waiting for goals
tool-goal (@deepseek-ai/dsh-tool-goal): waiting for goals
```

所以关闭层保留 `goal` 服务（惰性、无害，历史 `goal/change` 事件仍能回放），只去掉：

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

本方案选择后者：停用 shipped preset 声明，改挂一个运行时 `preset-filter`，由它读取
**已安装的** preset 再过滤，从而不冻结任何子列表。

## 三种使用方式

### 方式 A：主 bundle（默认，推荐）

```sh
# 从 npm 安装（发布后）
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle

# 本地 checkout
pnpm build
pnpm install:profile
```

主 bundle 的 `dsh.bundle.patch` 是一个有序数组：
`./cordis.patch.yml`（5 个 infini-goal 行）后接生成的
`./cordis.disable-goal.patch.yml`（关闭层）。因此安装主 bundle 后：

- 官方 goal 模式默认关闭，profile 的 `cordis.patch.yml` 保持干净；
- Plugins 页面 → 主 bundle 详情页：可以单独开关它贡献的每一行（例如只关掉状态条 UI，
  保留 `/infini-goal` 与自动轮次）；
- 关掉整个 bundle → 官方 goal 模式恢复；重新打开 → 再次关闭。

`pnpm install:profile` 还会取消旧 profile 里伴生 bundle 的选择，并清掉 profile patch 里
旧脚本写入的同功能块。`--disable-builtin-goal` 仍被接受，但已废弃且无效果。

### 方式 B：独立 bundle（只想关掉官方 goal）

如果 profile 里不装 infini-goal 套件、只想关闭官方 goal，安装独立 bundle：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle
```

它的内容与主 bundle 内嵌层相同，启用即关闭、禁用即恢复。

> **不要同时启用主 bundle 与独立 bundle。** 两者故意共用同一批 row id：DSH 组合时会得到
> 重复的 insert 行，但 Loader 每个 id 只保留一个 entry（后插入者生效），所以 preset filter
> 仍然只挂载一次、不会报错；代价是 Plugins 页面无法再单独开关这 3 个 filter 行
> （显示为 `unaddressable`），且 `--dump-config` 里会出现重复行。用不同的 id 反而会挂载
> 两份 filter 并以 `Duplicate agent preset` 失败，所以 id 必须保持相同。

### 方式 C：脚本写 profile patch（自定义 profile / 不装 bundle）

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
默认是静态快照（自包含、需随 DSH 升级重新生成）；加 `--dynamic` 可输出和 bundle 相同的
小动态块（要求 `@yankeguo/dsh-disable-goal-bundle` 在该 profile 可解析）。
**不要和方式 A / B 同时用**：bundle 已提供同样的层，重复的 insert 行会让对应 row 变成
不可单独开关；`install-profile.mjs` 会自动清掉旧块。

## bundle 里是什么（动态，不复制 preset）

[`packages/disable-goal-bundle/cordis.patch.yml`](../packages/disable-goal-bundle/cordis.patch.yml)
与主 bundle 的
[`packages/bundle/cordis.disable-goal.patch.yml`](../packages/bundle/cordis.disable-goal.patch.yml)
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
主 bundle 在 `dependencies` 里声明了 `@yankeguo/dsh-disable-goal-bundle`，所以即使不启用
独立 bundle，这个运行时模块也会随主 bundle 一起安装。

包信息见 [`packages/bundle/README.md`](../packages/bundle/README.md) 与
[`packages/disable-goal-bundle/README.md`](../packages/disable-goal-bundle/README.md)。

## 维护：通常无需重新生成

动态 patch 不随 DSH 版本变化，**DSH 升级后不需要重新生成**。
`scripts/build-disable-goal-bundle.mjs` 从同一份生成器输出**两个文件**（独立 bundle 的
`cordis.patch.yml` 与主 bundle 内嵌的 `cordis.disable-goal.patch.yml`），并校验
`packages/bundle/package.json` / `packages/disable-goal-bundle/package.json` 的接线
（`dsh.bundle.patch`、`files`、`exports`、依赖）。`pnpm test` 会 spawn 这项校验；
发布前也建议手动执行：

```sh
node scripts/build-disable-goal-bundle.mjs          # 重新生成两个文件
node scripts/build-disable-goal-bundle.mjs --check  # 检查两个文件与 bundle manifest 是否最新
```

如果未来 DSH 改动了 Loader 模块解析或 preset 文件布局，导致 filter 失效，可用快照回退：

```sh
node scripts/build-disable-goal-bundle.mjs --static   # 从已安装 app.asar 生成完整快照（两个文件）
```

`--static` 会复制 shipped 子列表，之后 DSH 升级需要重新生成。

## 注意事项

- 动态 filter 依赖 Loader 的模块解析与 shipped preset 文件布局；DSH 大版本升级后建议先跑
  一次隔离验证，必要时用 `--static` 回退。`minimal` preset 没有 goal 行，不需要替换。
- 已有官方 goal 会变成惰性状态（服务在、driver/工具/UI 不在）。需要清理时先停用关闭层、
  用 `/goal clear` 清空，再重新启用。
- `goal` 服务仍挂载（preset 激活需要它）。如果未来 DSH 把 goal 从 preset 中移走，
  这层自然变成 no-op（filter 只是原样挂载 preset），可以直接停用。
- preset 变更只影响之后创建的 Agent；彻底生效建议重启一次 DSH。
- bundle 顺序：本 bundle 必须排在 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 之后
  （Plugins 安装与 `install-profile.mjs` 都会追加到 `dsh.profile.bundles` 末尾）。若手工把它放到
  这两个 data/UI bundle 之前，`goal-round-driver` / `ui-goal` / `preset-*` 的 override 会因为
  目标行尚未插入而跳过（DSH 只告警），随后 filter 与未停用的 preset 同时挂载会触发
  `Duplicate agent preset`。
