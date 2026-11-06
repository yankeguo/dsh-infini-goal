# dsh-infini-goal

一套面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件：
参考官方 `dsh-goal` 的领域模型、模型工具与 UI 形态，但把"自动续跑"改造成一个
**无轮次上限、按最小间隔推进、可配置静默时段**的无限目标。

- **没有最大轮次**：目标保持 `active` 直到被完成、暂停、阻塞或清除；
- **最小触发间隔**：两次自动轮次的开始时间至少相隔 `minIntervalMs`，空循环不会疯狂重试；
- **静默时段**（`quietWindows`）：配置的本地时间段内不自动触发；人类对话与工具调用照常工作，
  时段结束后自动继续。可用于免打扰、专注时段、非工作时段、夜间等任意场景。

文档导航：[设计说明](docs/DESIGN.md) · [发布指南](docs/PUBLISHING.md) ·
[关闭系统自带的 dsh-goal](docs/DISABLE-BUILTIN-GOAL.md) ·
[E2E 验证工具](tools/e2e/README.md) · [v0.1.0 release notes](docs/releases/v0.1.0.md)

## 特性

| 能力 | 说明 |
| --- | --- |
| 无限续跑 | 无 `maxGoalRounds`；`roundsStarted` 只增不减，可以一直跑下去 |
| 最小触发间隔 | 每轮自动触发至少间隔可配置时长（默认 1 分钟，最小 1 秒，最大 30 天），专门抑制空循环 |
| 静默时段 | 支持跨午夜、按 ISO 星期过滤、IANA 时区；时段内不触发自动轮次 |
| 事件溯源 | 所有变更以可忽略的 `plugin:infini-goal/change` Session 插件记录持久化，严格回放校验，可 resume / fork |
| Session projection | `infiniGoal` projection 把当前目标同步到浏览器，UI 无需自定义 Remote API |
| 模型工具 | `get_infini_goal` / `create_infini_goal` / `update_infini_goal` |
| 人类命令 | `/infini-goal`，可在不消耗模型轮次的情况下查看状态、配置节奏、暂停/恢复 |
| 状态条 UI | composer 上方的 InfiniGoalBar：阶段、轮次、触发节奏、静默时段提示、暂停/恢复/清除 |
| 权限模型 | 所有变更都需要人类授权或当前自动轮次授权，模型无法自说自话改目标（见[权限模型](#权限模型)） |
| 可共存 | 与官方 `dsh-goal` 的工具、命令、状态条互不同名；也可用伴生 bundle 关掉官方 goal |

## 界面

状态条固定在 composer 上方，与官方 goal 的 GoalBar 同槽位（`conversation.input.dock`）：

| 自动推进中（显示轮次与节奏） | 静默时段（不自动触发） |
| --- | --- |
| ![自动推进中](docs/screenshots/infini-goal-active.jpg) | ![静默时段](docs/screenshots/infini-goal-waiting.jpg) |

状态条各状态（左侧为阶段标签，中间为 objective 与轮次，右侧为节奏行和按钮）：

| 目标状态 | 状态条显示 | 按钮 |
| --- | --- | --- |
| `active`，距上一轮已满最小间隔 | 自动推进中 · objective · 轮次 N · `下一轮 mm:ss`（每秒刷新） | 暂停 / 清除 |
| `active`，最小间隔尚未到 | 自动推进中 · objective · 轮次 N · `最小间隔 1m` | 暂停 / 清除 |
| `active`，当前处于静默时段 | 自动推进中 · objective · 轮次 N · `静默时段 · 至 HH:mm` | 暂停 / 清除 |
| `paused` / `blocked` | 已暂停 / 已阻塞（blocked 附原因）· 轮次 N，不显示节奏行 | 恢复 / 清除 |
| `complete` 或无目标 | 不渲染 | — |

按钮只发送 `/infini-goal ...` 命令，不引入自定义 Remote API；故障时状态条内联显示命令错误。

## 与官方 dsh-goal 的差异

| 维度 | 官方 `dsh-goal` | 本插件 |
| --- | --- | --- |
| 轮次上限 | `maxGoalRounds`（默认 256） | 无上限 |
| 触发节流 | 无，空闲立即续跑 | 最小触发间隔 + 静默时段 |
| 激活模型 | 进程内 `armed`/`disarmed`，恢复/派生后需人工 resume | 持久化 `phase`：应用重启、会话恢复后继续（可配置 `autoContinueOnStart: false`，此时启动时持久化为 paused） |
| 工具/命令 | `get_goal` / `create_goal` / `update_goal`，`/goal` | `*_infini_goal`，`/infini-goal`，可与官方 goal 共存 |
| 远程 API | Typert Remote | 不需要：UI 读 Session projection，操作经 `/infini-goal` 命令 |

## 包结构

```
packages/
  protocol/    @yankeguo/dsh-infini-goal-protocol   纯类型 + 间隔/时区/静默时段数学（host 与浏览器共用）
  infini-goal/ @yankeguo/dsh-infini-goal            核心服务 ctx.infiniGoals + 严格回放 fold + projection
  driver/      @yankeguo/dsh-infini-goal-driver     自动续跑驱动器（最小间隔 / 静默时段）
  tool/        @yankeguo/dsh-tool-infini-goal       模型工具
  command/     @yankeguo/dsh-command-infini-goal    /infini-goal 人类命令
  client-ui/   @yankeguo/dsh-client-ui-infini-goal  浏览器状态条
  bundle/      @yankeguo/dsh-infini-goal-bundle     bundle：cordis.patch.yml + 依赖
  disable-goal-bundle/  @yankeguo/dsh-disable-goal-bundle  可选伴生 bundle：关闭系统自带 dsh-goal
```

`pnpm build` 产出 9 个 `lib/*.js`：protocol 的 `index`/`client`、core、driver、tool、command、
client-ui 的 `index`/`client`，以及 `disable-goal-bundle` 的运行时资产 `preset-filter.js`；
`bundle` 包只有 patch 文件，不产出 JS。构建用 esbuild：host 入口把 `@deepseek-ai/*`、
`@yankeguo/*` 与 `node:*` 保持为外部依赖——工作区包互相外置，确保整个进程共享同一份
protocol/core 实例——其余依赖（例如 core 内联的 `zod`）打进产物；`preset-filter.js` 是
逐字节复制的运行时资产，不做转译。

## 快速开始

### 前置条件

| 项 | 要求 |
| --- | --- |
| DSH | `0.2.2-rc.1`（插件 / bundle 包声明 `engines.dsh: >=0.2.2-rc.1 <0.3.0`） |
| Node.js | ≥ 24.9（仅本地构建 / 发布 / E2E 需要；从 npm 安装插件不需要本机 Node） |
| pnpm | 12.x（CI 固定 `pnpm@12.16.1`） |
| Web UI | DSH 桌面端或 `dsh web`；状态条只在 Web 端渲染 |

### 安装：从 npm（发布后，推荐）

```sh
# 主 bundle：核心服务 + 驱动器 + 模型工具 + 命令 + 状态条
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle

# 可选伴生 bundle：关闭系统自带的 dsh-goal
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle
```

安装后在 **Plugins** 页面确认对应 bundle 已启用（新安装的 bundle 通常默认启用；
若显示为未启用，勾选即可），然后刷新 Web 页面。进阶用法也可以单独安装某个插件包，并在
profile 的 `cordis.patch.yml` 里自行插入对应的 loader row；日常使用推荐直接装主 bundle。

### 安装：本地 checkout（开发 / 验收）

```sh
pnpm install
pnpm build
pnpm install:profile                  # 默认 --profile desktop
# 或指定 profile / home；--disable-builtin-goal 同时关闭官方 goal
node scripts/install-profile.mjs --profile desktop --dsh-home ~/.dsh
pnpm install:profile --disable-builtin-goal
```

脚本做三件事：

1. 把全部 8 个 workspace 包（6 个插件包 + 2 个 bundle 包）符号链接到
   `$DSH_HOME/profiles/<profile>/node_modules/@yankeguo/`；
2. 把 `@yankeguo/dsh-infini-goal-bundle` 追加进 profile 的 `dsh.profile.bundles`
   （带 `--disable-builtin-goal` 时再追加伴生 bundle，并清掉旧脚本写进 profile patch 的同功能块）；
3. 写入前备份 profile 的 `package.json`（有改动时）。

DSH 的 profile HMR 会实时加载 Host 插件；浏览器侧刷新页面后出现状态条。
卸载：`pnpm uninstall:profile`。

### 升级 / 卸载

```sh
# 升级到指定版本（发布到 npm 后）
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle@0.2.0

# 卸载（DSH 下次加载 profile 时会清理已移除 bundle 的选择）
dsh plugin --profile desktop remove @yankeguo/dsh-infini-goal-bundle
dsh plugin --profile desktop remove @yankeguo/dsh-disable-goal-bundle

# 本地 checkout
pnpm install:profile                  # 先 pnpm build，再重新链接即生效
pnpm uninstall:profile                # 移除链接与 bundle 选择
```

升级 DSH 大版本（0.3）前需要更新插件 / bundle 包的 `engines.dsh` 并回归；不兼容的 bundle 会被 DSH 跳过。

### 从 0.1.0 升级 / 修复旧会话

0.1.0 把目标变更写成了自定义 Session 事件 `infini-goal/change`。DSH 0.2.2-rc.1 的持久化读取
只接受它自己词表内的 event type（或带 `ignorable` 标记的插件记录），所以**用 0.1.0 写过目标的
Session 重启后会拒绝被解释**（报 "refusing to interpret the log — it was likely written by a
newer harness"）。当前版本改用可忽略的 `plugin:infini-goal/change` 记录，但**不会自动迁移**
0.1.0 的旧日志；需要时用仓库脚本一次性修复：

```sh
# 先退出所有可能写这些 Session 的 DSH 实例；默认 dry-run，只打印报告
node scripts/repair-session-log.mjs --dry-run --dsh-home ~/.dsh

# 确认报告（例如 "DRY-RUN ... rewrote 7 row(s)"）后再写入
node scripts/repair-session-log.mjs --write --dsh-home ~/.dsh
```

脚本只把 `infini-goal/change` 行改写为 `plugin:infini-goal/change` + `ignorable: true`，其余
行与字节保持不变；写入前在旁边保留带时间戳的 `*.bak-repair-*` 备份；默认拒绝修复仍带
`session.lock` 的 Session（确认属主进程已退出时可加 `--force`）；重复执行是幂等的。
要求 Node.js ≥ 24.9 且已 `pnpm install`；也可以用 `--write <session-dir|log-file>...`
只修复指定日志。

### 使用

```
/infini-goal 修完所有 failed 的文档校验并保持 CI 绿色   # 创建目标
/infini-goal                                          # 查看状态与下一次触发时间
/infini-goal status                                   # 上一条的显式别名
/infini-goal interval 10m                             # 最小触发间隔改成 10 分钟
/infini-goal quiet "Mo-Fr 09:00-18:00"                # 示例：该时段不自动触发
/infini-goal quiet none                               # 取消静默时段
/infini-goal timezone Asia/Shanghai                   # 设置静默时段时区（system 用本机时区）
/infini-goal pause | resume | complete | clear
/infini-goal block 供应商配额耗尽                       # 标记阻塞
/infini-goal edit <新目标>
```

也可以直接让模型创建目标：当人类请求是一个长期目标时，模型会调用 `create_infini_goal`
（需要当前轮次里有直接的人类消息）。目标 `complete` 之后再执行 `/infini-goal edit <新目标>`
会创建一个新目标，而不是修改已完成的目标。命令参数支持成对引号（如
`/infini-goal quiet "Mo-Fr 09:00-18:00"` 中的引号会被剥掉一层，不会进入参数值）；
`interval` / `quiet` / `timezone` 在目标已 `complete` 时会被拒绝，需要先创建新目标。

## 配置

部署级配置写在加载该插件的 profile patch 行里（bundle 已经给出默认值；要改就在 profile 的
`cordis.patch.yml` 里按 loader row id 覆盖 `config`，注意 DSH 的 patch 对该行 config 是整体替换）。

### 部署默认值（核心服务）

```yaml
- id: infini-goal
  name: '@yankeguo/dsh-infini-goal'
  config:
    defaultMinIntervalMs: 60000        # 默认最小触发间隔
    defaultQuietWindows: []            # 默认静默时段，元素 { days: [1..7], start: 'HH:mm', end: 'HH:mm' }
    timezone: Asia/Shanghai            # 默认静默时区；缺省取宿主系统时区
```

| 键 | 默认 | 范围 / 说明 |
| --- | --- | --- |
| `defaultMinIntervalMs` | `60000` | `1000` ~ `2592000000`（1s ~ 30d），整数毫秒 |
| `defaultQuietWindows` | `[]` | 每个元素 `{ days, start, end }`；创建时校验语法与可调度性 |
| `timezone` | 宿主系统时区 | IANA 名称，缺省取 `Intl` 解析的系统时区 |

### 驱动器

```yaml
- id: infini-goal-driver
  name: '@yankeguo/dsh-infini-goal-driver'
  config:
    autoContinueOnStart: true          # 插件加载 / Agent 创建时是否自动继续 active 目标
    pollFloorMs: 1000                  # agent 暂不空闲 / 有竞争输入时的安全轮询间隔
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `autoContinueOnStart` | `true` | `false` 时，启动时把已有 `active` 目标**持久化 pause**（写入 pause 事件），等待人类 `/infini-goal resume` |
| `pollFloorMs` | `1000` | 整数，最小 `100`；agent 暂时不可驱动时的重试间隔 |

### 模型工具策略

```yaml
- id: infini-goal-tool
  name: '@yankeguo/dsh-tool-infini-goal'
  config:
    blockedAfterConsecutiveRounds: 3   # 自动轮次中，模型报告 blocked 前的最少轮次
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `blockedAfterConsecutiveRounds` | `3` | 正整数；只在“当前自动轮次”授权下生效，人类直接 block 不受此限（详见[权限模型](#权限模型)） |

bundle 里的工具行没有显式写这项配置，等价于使用默认值 `3`。

### 目标级覆盖

`create_infini_goal` / `/infini-goal interval` / `/infini-goal quiet` / `/infini-goal timezone`
写入的是每个目标自己的持久化设置，优先于部署默认值；`/infini-goal` 状态与状态条展示的也是
目标级设置。

### 语法

- **时长**：`500ms`、`90s`、`5m`、`1h30m`、`2d`，可组合；作为最小触发间隔时必须在
  `1s` ~ `30d` 之间。
- **静默时段**：分号分隔多条，每条 `[days ]HH:mm-HH:mm`，例如
  `Mo-Fr 09:00-18:00; Sa-Su 10:00-12:00; 22:00-06:00`。
  - `days` 为空 = 每天；ISO 星期 1=周一 … 7=周日，支持 `Mo-Fr`、`Sa,Su`、`1-5`；
    `daily` / `everyday` / `*` 等价于每天；
  - 窗口的 `start` 含、`end` 不含；`end < start` 表示跨午夜（如 `22:00-06:00`），
    `start == end` 会被拒绝；
  - `days` 过滤的是窗口**开始日**，例如 `Sa-Su 22:00-06:00` 覆盖周六 22:00→周日 06:00
    与周日 22:00→周一 06:00；
  - 多条窗口取并集；时区由 `timezone` 决定，跨夏令时按本地墙钟时间推进；
  - `none` / `off` / 空文本表示没有静默时段；`always` / `all` 会被拒绝；
  - 若静默时段覆盖全部本地时间（永远无法触发自动轮次），配置会被拒绝。

## 行为细节

- **节奏**：`nextAt = max(now, lastRoundAt + minIntervalMs)`（首轮不受间隔限制，创建后按
  agent 空闲与静默时段尽快触发）；若落在静默时段内，则推进到该时段结束（可连续推进），
  直到不落在任何静默时段。`planTrigger` 的 `quietUntil` 只在静默延后触发时非 `null`，且
  等于 `nextAt`；UI 的 `静默时段 · 至 HH:mm` 与命令输出都用它判断静默等待。
- **空循环**：每轮都是一次正常 turn；轮次间隔由最小触发间隔保证，不会出现"秒回秒触发"。
- **人类优先**：人类消息、其它工具调用照常进行；有竞争输入时驱动器会让路，等 agent 空闲
  且节奏满足后再注入下一轮。
- **持久化检查点**：每轮注入前驱动器会 flush 当前 Session 日志，保证下一轮看到的是已落盘的
  历史（flush 失败时记录日志并轮询重试）。
- **静默时间只限制自动触发**：`/infini-goal` 状态、人类对话、工具调用不受影响。

### 自动轮次失败处理

自动轮次失败会 `block` 目标，`blockedReason.code` 如下：

| code | 触发条件 |
| --- | --- |
| `max-tokens` | 自动轮次达到输出 token 上限 |
| `turn-error` | turn 以 error 结束 |
| `agent-error` | 自动轮次期间 agent 报错 |
| `queue-failed` | round 消息无法入队 |
| `driver-error` | 驱动器内部异常 |
| `prompt-rejected` | round 消息在进入 step 前被下游 hook 拒绝 |
| `checkpoint-failed` | 注入下一轮前 flush Session 日志失败（durability checkpoint） |

`agent-error` 通常是失败轮次实际记录到的 code（`agent/error` 先于 `turn/end` 到达，两者都属于
该轮次自己的 turn）。人类 / hook 打断或取消**该轮次自己的 turn** 会 `pause`（pause 不记录
reason）；`parent` 取消（卸载、stale round、终止性目标变更）与 `disposed` 不会写 pause。
Host 命令侧 pause / complete / block / clear 只 abort 正在运行的自动轮次，不影响人类 turn；
`edit` 会撤回尚未 admitted 的 round，下一轮使用新 revision。blocked 目标 `resume` 后
`blockedReason` 清除。

## 权限模型

目标变更要么来自人类，要么来自“当前目标的自动轮次”，模型无法仅凭自己的判断创建或改写目标：

- **人类**：`/infini-goal ...` 命令可以执行创建、编辑、暂停、恢复、完成、阻塞、清除，
  以及 `interval` / `quiet` / `timezone` 等节奏配置。
- **模型工具**：
  - `create_infini_goal` 需要当前 turn 中存在来自 runtime root agent 的**直接人类消息**；
  - `update_infini_goal` 的 `edit`、`config`、`pause`、`resume` 同样需要直接人类消息；
  - `complete` 与 `blocked` 额外允许“当前目标的自动轮次”本身授权；
  - 在自动轮次中报告 `blocked` 时，还要求已达到 `blockedAfterConsecutiveRounds`（默认 3）；
  - 授权判定基于 Session 事件（open turn 内的 `user/message` source、root agent 身份），
    不采信模型的自我声明。
- **UI**：状态条按钮只是提交 `/infini-goal ...` 命令，没有独立 Remote API 或更高权限。
- **安全边界**：插件运行在 Host 进程内，安装第三方插件等同于信任其代码；本套件不改变 DSH
  的沙箱 / 权限模式，也不额外提供任何提权入口。

## 已知限制

- **单目标**：每个 Session 同时只有一个 infini-goal。
- **恢复即续跑**：`active` 是持久化状态，DSH 重启或会话恢复后会继续；`autoContinueOnStart: false`
  时驱动器在启动 / Agent 创建时把 active 目标**持久化为 paused**，状态条显示 paused 并可
  恢复，需要人类 `/infini-goal resume`。
- **fork 也会续跑**：fork 出的子会话包含目标历史，默认继续推进；不需要时先 `pause` 再 fork。
- **UI 操作经命令**：状态条按钮发送 `/infini-goal ...` 命令，不引入自定义 Typert Remote。
- **倒计时是本地计算**：状态条按 projection 与本地每秒计算节奏行，允许秒级显示偏差；
  实际是否触发由驱动器用同一份 `planTrigger` 计算。
- **兼容性**：插件 / bundle 包声明 `engines.dsh: >=0.2.2-rc.1 <0.3.0`；DSH 升级到 0.3 前需要更新插件。
- **单 Session 语义**：目标与轮次属于当前 Session；本插件不提供跨 Session 共享或汇总目标。

## 故障排查

| 现象 | 可能原因 / 处理 |
| --- | --- |
| 安装后没有状态条 | bundle 未启用（Plugins 页面勾选）、页面未刷新、或 DSH 未重启使 preset 变更生效 |
| 没有 `/infini-goal` 命令或 `*_infini_goal` 工具 | bundle 未启用 / 被 DSH 跳过（检查 DSH 版本与 `engines.dsh`）；本地 checkout 需先 `pnpm build` |
| 本地安装脚本报 `run "pnpm build" first` | 先执行 `pnpm build` 再 `pnpm install:profile` |
| 目标不自动续跑 | 相态不是 `active`；命中静默时段或最小间隔未到；`autoContinueOnStart: false` 下被持久 pause；agent 正忙或有竞争输入 |
| `/infini-goal quiet ...` 报“覆盖全天”类错误 | 静默时段并集覆盖了全部本地时间，会永久阻止自动轮次；改为部分时段或 `none` |
| 状态条显示 paused 但没有自动恢复 | 这是 `autoContinueOnStart: false` 的预期行为；执行 `/infini-goal resume` |
| fork 后目标继续跑 | 预期行为；fork 前先 `/infini-goal pause` |
| 重启后 Session 无法恢复，日志报 "refusing to interpret the log" | 该 Session 由 0.1.0 的旧表示写入；退出 DSH 后运行 `node scripts/repair-session-log.mjs --write --dsh-home ~/.dsh`（见「从 0.1.0 升级 / 修复旧会话」） |
| `repair-session-log.mjs` 报 session.lock | 对应 Session 仍被 DSH 打开；退出 DSH / 关闭 Session 后重跑，或确认属主进程已退出后加 `--force` |
| 关闭官方 goal 后仍看到 `/goal` | preset 变更只影响新 Agent，重启一次 DSH 并新建会话 |

## 发布

包已推送到 npm 时可一条命令安装：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-infini-goal-bundle
```

CI 发布采用 **npm Trusted Publishing（Keyless OIDC）**：推 `v*` tag 触发
[`.github/workflows/publish.yml`](.github/workflows/publish.yml)，由 GitHub Actions 的
`id-token: write` 换取 npm 短时 token，**不需要 `NPM_TOKEN` secret**，公开仓库下自动附带
provenance。CI 还会先校验 `v*` tag 与全部 8 个可发布包（含根 `package.json`）的 `version`
完全一致，不一致直接失败，避免 tag 与 npm 版本错位。每个包需一次性配置 trusted publisher：

```sh
npm login
scripts/trusted-publishers.sh          # 批量配置全部 8 个包（--dry-run / --list 可选）
```

完整发版流程（版本升级、dry-run、本地/CI 发布、GitHub Release、故障处理）见
[`docs/PUBLISHING.md`](docs/PUBLISHING.md)。

## 关闭系统自带的 dsh-goal（可选）

DSH 自带官方 goal 模式，与本插件可以共存（工具、命令、状态条都不同名）。若希望
infini-goal 成为唯一目标系统，安装可选的伴生 bundle 即可，profile 的
`cordis.patch.yml` 保持干净：

```sh
dsh plugin --profile desktop add @yankeguo/dsh-disable-goal-bundle   # 发布后
pnpm install:profile --disable-builtin-goal                          # 本地 checkout
```

随后在 **Plugins** 页面勾选/取消该 bundle 即可实时开关官方 goal 模式。
该 bundle **不复制 preset 内容**：它停用 shipped preset 声明，并用一个很小的运行时
filter 读取已安装 preset、只过滤掉 `command-goal` / `tool-goal`，因此 DSH 升级后无需重新生成。
原理（为什么不能直接禁 `goal` 服务、preset patch 粒度等）、生效时机（preset 变更只影响
新 Agent，建议重启一次 DSH）、脚本方式与升级后维护见
[`docs/DISABLE-BUILTIN-GOAL.md`](docs/DISABLE-BUILTIN-GOAL.md)。

## 开发与验证

```sh
pnpm typecheck     # 全仓 TS 检查
pnpm test          # 协议数学 / fold / 工具与命令解析 / driver 状态机 / UI 格式化等单测（22 个文件 / 376 个用例）
pnpm build         # esbuild 产物（9 个 lib/*.js）
pnpm dev:patch     # 生成 .tmp/cordis.patch.yml（绝对路径插入，免安装调试）
```

端到端验证（隔离 DSH_HOME + mock LLM，不触碰当前运行中的 DSH）：

```sh
tools/e2e/bootstrap.sh          # 创建 /tmp 下的隔离 profile
tools/e2e/smoke.sh              # 基础设施 smoke（插入 plugin / session / mock LLM）
tools/e2e/suite.sh --fresh      # 本插件套件的端到端场景（最小间隔 / 静默时段 / 暂停）
```

设计说明与数据结构见 [`docs/DESIGN.md`](docs/DESIGN.md)，E2E 工具与已知限制见
[`tools/e2e/README.md`](tools/e2e/README.md)。

## License

[MIT](LICENSE)
