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
- **事件溯源**：所有变更写入 Session 日志（`infini-goal/change`），严格回放校验，可跨重启/恢复/fork。
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

### 从 npm 安装（发布后）

在 **Plugins → Add plugin** 输入 `@yankeguo/dsh-infini-goal-bundle` 安装并启用；
或：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle
```

### 本地 checkout 安装

```sh
pnpm install && pnpm build
pnpm install:profile            # 链接到 ~/.dsh/profiles/desktop 并启用 bundle
```

或直接 `--patch` 调试（不写 profile）：

```sh
pnpm dev:patch
dsh web --patch .tmp/cordis.patch.yml --port 34000 --no-open
```

## 配置

```yaml
- id: infini-goal
  config:
    defaultMinIntervalMs: 60000     # 默认最小触发间隔，1s ~ 30d
    defaultQuietWindows: []         # 默认静默时段 [{ days: [1..7], start: 'HH:mm', end: 'HH:mm' }]
    timezone: Asia/Shanghai         # 默认静默时区，缺省取宿主系统时区

- id: infini-goal-driver
  config:
    autoContinueOnStart: true       # 启动/会话恢复时自动继续 active 目标；false 则 durably pause 等人工 resume
    pollFloorMs: 1000               # agent 暂不空闲时的安全轮询间隔

- id: infini-goal-tool
  config:
    blockedAfterConsecutiveRounds: 3  # 模型在自动轮次中标记 blocked 前的最少轮次
```

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

静默时段语法：分号分隔多条，每条 `[days ]HH:mm-HH:mm`；`days` 支持 `Mo-Fr`、`Sa,Su`、`1-5`，
缺省=每天；`end <= start` 表示跨午夜；覆盖全天的配置会被拒绝。

## 行为与限制

- 节奏：`max(now, lastRoundAt + minIntervalMs)`，落在静默时段内则推到时段结束。
- 自动轮次遇到 `max-tokens` / turn error / agent error / 队列失败会 `block`；人类打断正在
  运行的自动轮次会 `pause`。
- `active` 是持久化状态：DSH 重启、会话恢复后会继续；fork 的子会话也会继续，不需要时先 pause。
- 每个 Session 同时只有一个 infini-goal；与官方 `dsh-goal` 的 `/goal`、`get_goal` 等互不冲突。
- 兼容性：`engines.dsh: >=0.2.2-rc.1 <0.3.0`。

## 配套 bundle

如果想让本套件成为唯一的目标系统，安装可选伴生 bundle 关闭系统自带的 dsh-goal
（可在 Plugins 页面开关，profile patch 保持干净）：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle
```

详见 [`@yankeguo/dsh-disable-goal-bundle`](../disable-goal-bundle/README.md)。

完整文档与设计说明见仓库 README 与 `docs/DESIGN.md`。
