---
description: "Endless goal mode for DeepSeek Harness: no round cap, a configurable minimum trigger interval, and quiet time windows that suppress automatic rounds."
kind: "package-bundle"
---

# @yankeguo/dsh-infini-goal-bundle

参考官方 `dsh-goal` 的领域模型、模型工具与 UI 形态，但把"自动续跑"改造成一个
**无轮次上限、按最小间隔推进、可配置静默时段**的无限目标的 DSH 插件套件。

## 特性

- **无限轮次**：没有 `maxGoalRounds`，目标保持 `active` 直到被 pause / block / complete / clear。
- **最小触发间隔**：两次自动轮次的开始时间至少相隔 `minIntervalMs`（默认 1 分钟，最小 1 秒），
  空循环不会出现"秒回秒触发"。
- **静默时段**：配置本地时间段（支持跨午夜、按星期过滤、IANA 时区），时段内不自动触发；
  人类对话、工具调用照常工作，时段结束后自动继续。可用于免打扰、专注时段、非工作时段、夜间等任意场景。
- **事件溯源**：所有变更以可忽略的 `plugin:infini-goal/change` Session 插件记录持久化，严格回放校验，可跨重启/恢复/fork。
- **模型工具**：`get_infini_goal` / `create_infini_goal` / `update_infini_goal`。
- **人类命令**：`/infini-goal`（状态、创建、编辑、暂停、恢复、完成、阻塞、清除、interval/quiet/timezone）。
- **状态条 UI**：composer 上方显示阶段、轮次、触发节奏、静默时段提示，以及暂停/恢复/清除按钮。

## 本 bundle 包含的插件行

| entry id | 包 | 作用 |
| --- | --- | --- |
| `infini-goal` | `@yankeguo/dsh-infini-goal` | 核心服务 `ctx.infiniGoals`：事件溯源状态、CAS 变更、`infiniGoal` Session projection |
| `infini-goal-driver` | `@yankeguo/dsh-infini-goal-driver` | 自动续跑驱动器：最小间隔 + 静默时段 + 注入 round 消息 |
| `infini-goal-tool` | `@yankeguo/dsh-tool-infini-goal` | 模型工具与 system prompt 指导 |
| `infini-goal-command` | `@yankeguo/dsh-command-infini-goal` | `/infini-goal` 人类命令 |
| `infini-goal-ui` | `@yankeguo/dsh-client-ui-infini-goal` | 浏览器状态条 |

## 安装

### 从 npm 安装（发布后，推荐）

在 **Plugins → Add plugin** 输入 `@yankeguo/dsh-infini-goal-bundle` 安装并启用；
或：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle
```

安装后在 Plugins 页面确认 bundle 已启用（新安装的 bundle 通常默认启用；若显示未启用，
勾选一次即可），刷新 Web 页面。升级 / 卸载：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle@0.2.0   # 升级到指定版本
dsh plugin --profile desktop remove @yankeguo/dsh-infini-goal-bundle     # 卸载
```

### 本地 checkout 安装

```sh
pnpm install && pnpm build
pnpm install:profile            # 链接到 ~/.dsh/profiles/desktop 并启用 bundle
```

或直接 `--patch` 调试（不写 profile，先 `pnpm build`）：

```sh
pnpm build
pnpm dev:patch
dsh web --patch .tmp/cordis.patch.yml --port 34000 --no-open
```

### 前置条件

- DSH `0.2.2-rc.1`（bundle 声明 `engines.dsh: >=0.2.2-rc.1 <0.3.0`）；
- 从 npm 安装不需要本机 Node；本地构建 / 发布需要 Node.js ≥ 24.9 与 pnpm 12。

## 配置

bundle 的 patch 行已写入一组部署默认值；要覆盖时在 profile 的 `cordis.patch.yml` 里按
loader row id 覆盖该行 `config`（DSH 的 patch 是整体替换该行 config，需写全要保留的字段）。

```yaml
- id: infini-goal
  config:
    defaultMinIntervalMs: 60000     # 默认最小触发间隔，1000 ~ 2592000000 ms（1s ~ 30d）
    defaultQuietWindows: []         # 默认静默时段 [{ days: [1..7], start: 'HH:mm', end: 'HH:mm' }]
    timezone: Asia/Shanghai         # 默认静默时区，缺省取宿主系统时区

- id: infini-goal-driver
  config:
    autoContinueOnStart: true       # 启动/Agent 创建时自动继续 active 目标；false 则持久化 pause 等人工 resume
    pollFloorMs: 1000               # agent 暂不空闲/有竞争输入时的安全轮询间隔（最小 100）

- id: infini-goal-tool
  config:
    blockedAfterConsecutiveRounds: 3  # 自动轮次中模型报告 blocked 前的最少轮次
```

bundle 里的 `infini-goal-tool` 行没有显式写 `blockedAfterConsecutiveRounds`，等价于默认值 `3`；
`blockedAfterConsecutiveRounds` 只在“当前自动轮次”授权下生效，人类直接 block 不受此限。

## 使用

```
/infini-goal <目标>                     # 创建
/infini-goal                            # 状态 + 下一次触发时间
/infini-goal interval 10m               # 最小触发间隔
/infini-goal quiet "Mo-Fr 09:00-18:00"  # 示例：该时段静默
/infini-goal quiet none                 # 取消静默
/infini-goal timezone Asia/Shanghai
/infini-goal edit <新目标>
/infini-goal pause | resume | complete | clear
/infini-goal block <原因>
```

静默时段语法：分号分隔多条，每条 `[days ]HH:mm-HH:mm`；`days` 支持 `Mo-Fr`、`Sa,Su`、`1-5`
（过滤窗口开始日），缺省=每天；`start` 含、`end` 不含，`end < start` 表示跨午夜；
覆盖全部本地时间（永远无法触发）的配置会被拒绝；`none` 表示关闭。

## 行为与限制

- 节奏：`max(now, lastRoundAt + minIntervalMs)`，落在静默时段内则推到时段结束；首轮创建后
  按 agent 空闲与静默时段尽快触发。
- 自动轮次失败会 `block` 目标（`blockedReason.code`：`max-tokens` / `turn-error` /
  `agent-error` / `queue-failed` / `driver-error` / `prompt-rejected` / `checkpoint-failed`）；
  人类 / hook 打断或取消该轮次自己的 turn 会 `pause`，Host 命令侧 pause 只 abort 正在运行的
  自动 turn（人类 turn 不受影响）。
- 静默时段只抑制自动轮次：`/infini-goal` 状态、人类对话、工具调用照常工作。
- `active` 是持久化状态：DSH 重启、会话恢复后会继续；`autoContinueOnStart: false` 时启动 /
  Agent 创建会把 active 目标持久化为 paused，需要人类 `/infini-goal resume`。
  fork 的子会话也会继续，不需要时先 pause。
- 每个 Session 同时只有一个 infini-goal；与官方 `dsh-goal` 的 `/goal`、`get_goal` 等互不冲突。
- 从 0.1.0 升级：0.1.0 写入的旧表示不会被自动迁移；若旧 Session 重启后无法恢复，先退出 DSH，
  再用仓库的 `scripts/repair-session-log.mjs` 修复（见仓库 README「从 0.1.0 升级 / 修复旧会话」）。
- 权限：创建 / 编辑 / pause / resume / 节奏配置需要 direct human 授权；`complete` / `blocked`
  额外允许当前自动轮次授权（自动轮次中 block 还要求达到 `blockedAfterConsecutiveRounds`）。
- 兼容性：`engines.dsh: >=0.2.2-rc.1 <0.3.0`；本地构建 / 发布需要 Node.js ≥ 24.9、pnpm 12。

## 文档

- 仓库 [README](../../README.md)：功能、安装、配置、行为与故障排查
- [DESIGN](../../docs/DESIGN.md)：领域模型、事件溯源、驱动器与权限模型
- [DISABLE-BUILTIN-GOAL](../../docs/DISABLE-BUILTIN-GOAL.md)：关闭系统自带 dsh-goal 的原理与维护

## 配套 bundle

如果想让本套件成为唯一的目标系统，安装可选伴生 bundle 关闭系统自带的 dsh-goal
（可在 Plugins 页面开关，profile patch 保持干净）：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle
```

详见 [`@yankeguo/dsh-disable-goal-bundle`](../disable-goal-bundle/README.md) 的 README。
