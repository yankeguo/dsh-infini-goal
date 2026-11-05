# 关闭系统自带的 dsh-goal（可选）

DSH 默认自带官方 goal 模式（`dsh-goal` / `dsh-tool-goal` / `dsh-command-goal` /
`dsh-goal-round-driver` / `dsh-client-ui-goal`）。装了本插件后两套目标系统可以共存
（工具名、命令名、状态条都不同名），但如果你希望 **infini-goal 成为唯一的目标系统**，
可以用本仓库的脚本把官方 goal 模式关掉。

## 为什么不能直接禁用 `goal` 服务

官方 Web 组合里，`goal` **服务**留在 host 平面，而 `command-goal` / `tool-goal`
是按 **agent preset** 挂载的（见 `dsh-web-app/presets/*.patch.yml`）。如果直接
`- id: goal / disabled: true`，创建会话会失败：

```
agent-preset/invalid: command-goal (@deepseek-ai/dsh-command-goal): waiting for goals
tool-goal (@deepseek-ai/dsh-tool-goal): waiting for goals
```

所以正确做法是保留 `goal` 服务（惰性、无害，旧会话里的 `goal/change` 事件也能正常回放），
只去掉自动续跑驱动器、状态条，以及各 preset 里的命令/工具行。

## 生成的补丁做了什么

[`scripts/disable-builtin-goal.mjs`](../scripts/disable-builtin-goal.mjs) 从**已安装的
DSH app.asar** 里读取三个 shipped preset（`standard` / `ptc` / `cordis`）的原始定义，
生成并写入一个带标记的 profile patch 块：

```yaml
- id: goal-round-driver
  disabled: true          # 关闭官方自动轮次驱动器

- id: ui-goal
  disabled: true          # 关闭 composer 上方的官方 GoalBar

- id: preset-standard     # 用官方定义去掉 command-goal / tool-goal 后覆盖
  name: '@deepseek-ai/dsh-agent-preset'
  config: { ... }

- id: preset-ptc
  ...
- id: preset-cordis
  ...
```

效果（对新创建的 Agent / 重启后的会话）：

- 模型工具列表里不再有 `get_goal` / `create_goal` / `update_goal`；
- 命令菜单里不再有 `/goal`（`/infini-goal` 保留）；
- 官方 goal 的自动续跑停止，GoalBar 不再渲染；
- `goal` 服务仍挂载，历史会话回放与 preset 激活保持正常。

## 用法

```sh
cd /Users/guoyk/Workspace/src/github.com/yankeguo/dsh-infini-goal

# 预览生成的补丁（不写文件）
node scripts/disable-builtin-goal.mjs --print

# 写入 profile patch（默认 ~/.dsh/profiles/desktop/cordis.patch.yml）
node scripts/disable-builtin-goal.mjs --write

# 自定义 profile / DSH 安装路径
node scripts/disable-builtin-goal.mjs --write \
  --profile-patch ~/.dsh/profiles/desktop/cordis.patch.yml \
  --app-asar "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"

# 撤销（移除生成块，保留你自己的其它补丁）
node scripts/disable-builtin-goal.mjs --remove
```

脚本行为：

- 写入前自动备份 profile patch（`cordis.patch.yml.bak-disable-goal-<时间戳>`）；
- 用 `# BEGIN/END dsh-infini-goal: disable builtin dsh-goal` 标记包住生成块，
  `--remove` 只删除这一块，重复 `--write` 会先替换旧块；
- 读取 app.asar 时使用 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1`），无需额外依赖；
  也可用 `--presets-dir <dir>` 直接读取解包后的 preset 目录（测试用）；
- `--exclude ptc,cordis` 可跳过某些 preset。

## 生效时机与验证

- profile patch 由 HMR 监听，保存后立即重新组合：
  `goal-round-driver` / `ui-goal` 立即卸载；
- **preset 定义的修改只影响之后创建的 Agent**：已经打开的会话仍保留启动时挂载的
  `get_goal`/`/goal`，直到会话重新创建或应用重启。建议 **重启一次 DSH Desktop**，
  之后所有新旧会话都按新 preset 创建；
- 验证：新建一个会话 → 输入 `/` 看菜单里没有 `/goal`；状态条只有 infini-goal 的；
  让模型读工具列表（或看 `request/header` 的 tools）不应出现 `get_goal`。

本仓库的隔离 E2E 已用**同一份生成补丁**验证：会话创建成功、`request/header` 工具目录
31 个工具、无 `get_goal/create_goal/update_goal`、`create_infini_goal/get_infini_goal/
update_infini_goal` 正常存在。

## 注意事项

- **DSH 升级后需要重新生成**：官方 preset 定义随版本变化，升级后重新执行
  `node scripts/disable-builtin-goal.mjs --write`（脚本会读取新版本的 preset 并替换旧块）。
  如果升级改名了 preset 文件，脚本会报错退出，不会写坏 patch。
- **已有的官方 goal**：`goal` 服务保留但不再有 UI/工具/驱动器，已有目标会处于惰性状态；
  如果之后需要清理，可 `--remove` 恢复官方 goal 后用 `/goal clear` 清掉，再重新写入。
- 其它 profile：`--profile-patch` 指向对应 profile 的 `cordis.patch.yml` 即可；默认为 desktop。
- 撤销成功后官方 goal 模式恢复，但 HMR 对 preset 的修改同样只影响新 Agent，
  彻底恢复也建议重启一次。
