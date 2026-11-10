# dsh-infini-goal 设计说明

一套 DeepSeek Harness（DSH）插件，参考官方 `dsh-goal` 的领域模型、模型工具与 UI 形态，
但把"自动续跑"改造成一个**无轮次上限 + 最小触发间隔 + 可配置静默时段**的无限目标。

## 1. 与官方 dsh-goal 的差异

| 维度 | 官方 `dsh-goal` | 本插件 `dsh-infini-goal` |
| --- | --- | --- |
| 轮次上限 | `maxGoalRounds`（默认 256），用尽后 `resume` 被拒绝 | **无上限**，目标保持 `active` 直到被 pause / block / complete / clear |
| 续跑节流 | 无：一旦 agent 空闲立即进入下一轮，空循环会疯狂重试 | **最小触发间隔** `minIntervalMs`：两次自动轮次的开始时间至少相隔这么久 |
| 静默时段 | 无 | **静默时段** `quietWindows`：配置的本地时间段内不自动触发（免打扰、专注时段、非工作时段、夜间等任意场景） |
| 激活模型 | 进程内 `armed`/`disarmed`，session 恢复/派生后自动解除武装 | 纯持久化：`phase === 'active'` 即自动续跑（进程重启、会话恢复后继续），节流与静默时段兜底 |
| 远程 API | Typert Remote（`ctx.remote.goals`） | 不需要自定义 Remote：UI 读 Session projection，操作通过 `/infini-goal` 命令 |
| 工具 | `get_goal` / `create_goal` / `update_goal` | `get_infini_goal` / `create_infini_goal` / `update_infini_goal` |
| 命令 | `/goal` | `/infini-goal` |

静默时段只约束"自动触发"：在该时段内目标保持 `active`，人类的普通对话、工具调用照常工作，
但插件不会自动注入新一轮续跑消息；时段结束后按节奏继续推进。
这是一种通用机制，具体怎么用由使用者决定，例如：免打扰时段、专注工作时段、非工作时间、
夜间、值班交接时间等。

## 2. 包结构

pnpm workspace，`packages/*`：

| 目录 | 包名 | 角色 |
| --- | --- | --- |
| `protocol` | `@yankeguo/dsh-infini-goal-protocol` | 纯类型 + 时间/间隔/静默时段数学（host 与浏览器共用） |
| `infini-goal` | `@yankeguo/dsh-infini-goal` | 核心 Service `ctx.infiniGoals`：事件溯源状态、CAS 变更、Session projection `infiniGoal` |
| `driver` | `@yankeguo/dsh-infini-goal-driver` | 续跑驱动器：按最小间隔/静默时段调度自动轮次，注入 round message |
| `tool` | `@yankeguo/dsh-tool-infini-goal` | 模型工具：`get_infini_goal` / `create_infini_goal` / `update_infini_goal` + system prompt 指导 |
| `command` | `@yankeguo/dsh-command-infini-goal` | 人类命令 `/infini-goal` |
| `client-ui` | `@yankeguo/dsh-client-ui-infini-goal` | 浏览器 UI：composer 上方的 InfiniGoalBar（状态、倒计时、静默提示、pause/resume/clear） |
| `bundle` | `@yankeguo/dsh-infini-goal-bundle` | bundle 包：`dsh.bundle.patch` 依次应用 `cordis.patch.yml`（5 个 infini-goal 行）与生成的 `cordis.disable-goal.patch.yml`（默认关闭系统自带 dsh-goal）+ 依赖声明 |
| `disable-goal-bundle` | `@yankeguo/dsh-disable-goal-bundle` | 独立 bundle（主 bundle 已内嵌同一层）：生成的 patch + 小型 `preset-filter` 运行时插件，关闭系统自带 dsh-goal（可在 Plugins 开关）；主 bundle 以运行时依赖引用其 filter 模块 |

构建：`pnpm build` 用 esbuild：
- host 入口 `src/index.ts` → `lib/index.js`，external `@deepseek-ai/*`、`@yankeguo/*` 与
  `node:*`：官方包由 DSH 安装解析，工作区包由 bundle 依赖安装进同一 profile，使整个进程
  共享同一份 protocol/core 实例（`instanceof` 语义正确），其余依赖打进产物；
- 浏览器入口 `src/client/index.tsx` → `lib/client.js`，esbuild 打成 CJS 后包进
  `window.__ModuleLoader__.load({ id, factory: (require) => ... })`，external 为
  浏览器 shell 的 platform modules（react、react/jsx-runtime、
  `@deepseek-ai/dsh-client-ui-primitives` 等）；
- `bundle` 不产出 JS，只发布 patch 与包元数据；`disable-goal-bundle` 另含小型
  `preset-filter` 运行时插件（`src/preset-filter.js` 逐字节复制到 `lib/preset-filter.js`，
  不做转译），用于启动时过滤 shipped preset 的 goal 行（见 §10）；
- `pnpm build` 共产出 9 个 `lib/*.js`（protocol、core、driver、tool、command、client-ui、
  disable-goal-bundle）；缺少入口或资产时构建直接失败（不再警告跳过），`--only <dirs>` 可只构建部分包。

## 3. 领域模型（`packages/protocol/src/types.ts`）

```ts
interface QuietWindow { days: number[]; start: string; end: string }  // days: ISO 1=周一..7=周日，空=每天；HH:mm；end<start 跨午夜，start==end 拒绝
interface InfiniGoalSettings { minIntervalMs: number; quietWindows: QuietWindow[]; timezone: string }
interface InfiniGoalSnapshot extends InfiniGoalSettings {
  id: string; revision: number; objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason?: { code: string; message: string }
}
interface InfiniGoalView extends InfiniGoalSnapshot {
  roundsStarted: number; lastRoundAt: number | null; createdAt: number; updatedAt: number
}
interface InfiniGoalProjection {         // Session projection key: 'infiniGoal'，无目标时为 null
  goal: InfiniGoalSnapshot; roundsStarted: number; lastRoundAt: number | null
  createdAt: number; updatedAt: number
}
```

调度语义（`packages/protocol/src/schedule.ts`，两端共用，勿重复实现）：

- `nextTriggerAt(settings, lastRoundAt, now)`：
  `candidate = max(now, lastRoundAt === null ? now : lastRoundAt + minIntervalMs)`；
  若 candidate 落在静默时段内，则推进到该静默时段的结束（可连续推进，直到不在任何静默时段内）。
- `planTrigger(...)` 返回 `{ now, nextAt, quietUntil, delayMs, reason }`：
  - `candidate = max(now, lastRoundAt === null ? now : lastRoundAt + minIntervalMs)`；
  - `reason = 'ready'` 当且仅当 `nextAt === now`；`nextAt > candidate`（被静默时段延后）为
    `'quiet-window'`；其余为 `'interval'`；
  - `quietUntil` 只在静默延后时非 `null`，且恒等于 `nextAt`（不是“当前所在静默窗口的结束”）；
  - `delayMs = max(0, nextAt - now)`。
- 静默时段语义：单条窗口 `start` 含、`end` 不含；`end < start` 跨午夜；`start == end` 被
  `validateQuietWindow` 拒绝；`days` 过滤的是窗口**开始日**；多条窗口取并集；
  `none|off|空` 清空、`always|all` 被拒绝；数值星期区间必须升序（`Fr-Mo` 需写成 `Fr,Mo`）。
- 静默时段覆盖全部本地时间时抛 `RangeError`，由服务端配置校验（创建 / 编辑 / 部署默认值）
  转为 `INFINI_GOAL_INVALID_SETTINGS` 拒绝。
- DST（夏令时）：不存在的墙钟时间向前归一到 gap 结束；重复的墙钟时间中，静默窗口的
  **开始取较早一次、结束取较晚一次**（保守包络，每年可能多覆盖约 1 小时，属实现的
  已知取舍）；`resolveLocalInstant(tz, date, minutes, occurrence?: 'earliest'|'latest')`
  默认 `earliest`。
- 协议 API 的硬化（0.1.0 之后）：`canonicalTimeZone` 拒绝 `±HH:MM` offset 形式（Host 与浏览器
  `Intl` 行为不同，只接受命名时区）；`weekdayOf`/`addDays` 对 0-99 年正确；`formatClockTime`
  仅接受 0-1439 整数分钟；`parseDurationMs` 接受 token 间空白（`2h 15m`）并拒绝 `1m s`，
  溢出报 "duration is too large"；`parseWeekdays` 数值 token 必须是纯数字；
  `validateQuietWindows` 拒绝稀疏数组（array holes）；新增导出类型 `LocalOccurrence`。

## 4. 持久化记录与严格回放

**持久化表示（0.1.0 之后的 P0 修复）**：目标变更以**可忽略的插件记录**
`plugin:infini-goal/change` 写入 Session（`appendPluginRecord(session, INFINI_GOAL_RECORD_TYPE,
change)`，常量 `INFINI_GOAL_RECORD_TYPE`），payload 形状不变，仍是 `InfiniGoalSnapshotChange`
或 `InfiniGoalClearChange` 两种：

```ts
// 全量快照变更
{ kind: 'infini-goal/change', version: 1,
  operation: 'create'|'edit'|'pause'|'resume'|'complete'|'block',
  goal: InfiniGoalSnapshot, roundsStarted: number, lastRoundAt: number | null,
  createdAt: number, updatedAt: number }
// clear 墓碑
{ kind: 'infini-goal/change', version: 1, operation: 'clear', cleared: InfiniGoalRef, clearedAt: number }
```

为什么必须这样：0.1.0 使用自定义 Session 事件类型 `infini-goal/change`。DSH 0.2.2-rc.1 的持久化
读取路径 `validateStoredEvents` 只接受仓库内置词表（repo-generated
`KNOWN_SESSION_EVENT_TYPES`）里的 event type，除非记录带 `ignorable: true`；而 out-of-tree
插件无法扩充该词表。结果是**用 0.1.0 写过目标的 Session 在重启后无法恢复**（报
"refusing to interpret the log — it was likely written by a newer harness"）。`plugin:` 命名空间
的插件记录是 DSH 给插件持久状态留的正式通道：每条读取路径都会保留并重放它，但不会进入
模型可见的对话面。

- 该记录在 resume / fork / transport 中都会被保留并重放；payload 与旧表示一致。
- 严格 fold 仍**只读**接受退役的 `infini-goal/change` 事件类型（用于插件热重载后继续回放
  已有内存日志），但**永远不会再 append**；`isInfiniGoalChangeEvent(event)` 同时识别两种表示。
- `infiniGoal` projection 的 `stateVersion` 从 1 升到 2：旧 unit 折叠的行会整体丢弃重放，
  避免把“忽略 plugin 记录”的旧 checkpoint 前向应用。
- **0.1.0 旧日志不会自动迁移**：升级后如遇无法恢复的旧 Session，先退出 DSH，再运行
  `scripts/repair-session-log.mjs`（默认 dry-run；`--write` 只把 `infini-goal/change` 行改写为
  `plugin:infini-goal/change` + `ignorable: true`，保留时间戳备份，幂等，默认拒绝仍带
  `session.lock` 的 Session）。详见 README「从 0.1.0 升级 / 修复旧会话」。

轮次推进：自动轮次是 `user/message` 事件，其 `source` 为
`{ kind: 'infini-goal', goalId, revision, round }`；strict fold 校验
`round === roundsStarted + 1` 且 `goalId/revision` 匹配当前目标、phase 为 active，
随后 `roundsStarted = round`、`lastRoundAt = event.time`。

合法迁移：

- `create`：revision=1、phase=active、roundsStarted=0、lastRoundAt=null；当前无目标或当前目标已 `complete`；id 未出现过。
- `edit`：只允许改 objective / minIntervalMs / quietWindows / timezone，revision+1，其余不变。
- `pause`：active → paused。
- `resume`：paused | blocked → active（无轮次上限，因此永远可 resume）。blocked 原因清除。
- `complete`：active | paused | blocked → complete。
- `block`：active → blocked，必须携带 `blockedReason`。
- `clear`：墓碑，revision = 当前+1，清空计数器。
- 时间戳单调不回退；`roundsStarted`、`lastRoundAt` 在非轮次事件中保持不变；严格解码非法字段直接让 replay 失败。

Projection unit：key `infiniGoal`，state 保存 `{ current, seenGoalIds, failure }`，
`wire.view` 输出 `current`（`InfiniGoalProjection | null`）。回放错误保留在 `failure`，host 读取时抛错。

## 5. 核心 Service `ctx.infiniGoals`

```ts
class InfiniGoalService extends Service {
  static inject = ['agents', 'sessionProjections']
  static Config: z.object({
    defaultMinIntervalMs: z.number().default(60_000),
    defaultQuietWindows: ...,        // 默认 []
    timezone: ...,                   // 默认系统时区
  })

  get(agent: Agent): InfiniGoalView | undefined
  create(agent, request: InfiniGoalCreateRequest): InfiniGoalView
  edit(agent, ref, request: InfiniGoalEditRequest): InfiniGoalView
  pause(agent, ref): InfiniGoalView
  resume(agent, ref): InfiniGoalView
  complete(agent, ref): InfiniGoalView
  block(agent, ref, reason: InfiniGoalBlockReason): InfiniGoalView
  clear(agent, ref): InfiniGoalRef
  plan(agent): TriggerPlan | undefined          // nextTriggerAt/planTrigger 的便捷封装
}
```

- `assertLive(agent)`：`ctx.agents.get(agent.id) === agent`，否则 `InfiniGoalError('INFINI_GOAL_AGENT_NOT_LIVE')`。
- 所有变更 CAS：`ref` 必须等于当前 `{id, revision}`，否则 `INFINI_GOAL_STALE_REVISION`。
- 创建时合并 config 默认值并校验（`validateMinIntervalMs`、`validateQuietWindows`、
  `canonicalTimeZone`）；同时用 `nextTriggerAt(settings, null, Date.now())` 验证静默时段可调度。
- 变更后 `appendPluginRecord(agent.session, 'plugin:infini-goal/change', change)`，然后
  `agentEvents(ctx, agent).emit('infini-goal/changed', { agent, change })`，
  payload `change = { operation, ref, goal?: InfiniGoalView }`（clear 时无 goal）。
- 错误类型 `InfiniGoalError extends HarnessError extends Error`（`HarnessError` 来自
  `@deepseek-ai/dsh-llm`，`code` 透传给工具 / 命令层），`code` 取值：
  `INFINI_GOAL_AGENT_NOT_LIVE` / `INFINI_GOAL_NOT_FOUND` / `INFINI_GOAL_ALREADY_EXISTS` /
  `INFINI_GOAL_STALE_REVISION` / `INFINI_GOAL_INVALID_OBJECTIVE` / `INFINI_GOAL_INVALID_SETTINGS` /
  `INFINI_GOAL_INVALID_TRANSITION` / `INFINI_GOAL_INVALID_BLOCK_REASON`。
- 事件类型通过 module augmentation 合并进 `cordis` 的 `Events`（agent 作用域：`Scoped<Agent>`），
  `user/message` 的 source 通过 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 合并 `infini-goal`；
  持久化载荷通过 `@deepseek-ai/dsh-session/types` 的 `PluginRecordMap` 合并
  `plugin:infini-goal/change`。退役的 `SessionEventMap` 声明 `infini-goal/change` 仅为 fold
  兼容而保留（`@deprecated`，绝不 append）。

## 6. 驱动器 `@yankeguo/dsh-infini-goal-driver`

`inject = ['agents', 'infiniGoals', 'sessions']`，自身 Config：`{ autoContinueOnStart?: boolean, pollFloorMs?: number }`。
`autoContinueOnStart` 默认 true：插件加载 / Agent 创建（含会话恢复、fork）时，已有 `active` 目标
立即按调度规则继续；设为 false 时，驱动器在插件加载与每个 `agent/created` 时把 active 目标
**持久化暂停**（写入一条 pause 记录），状态条显示可恢复的 paused，人类 `/infini-goal resume`
后才重新开始；若这条 pause 写入本身失败，驱动器会退化为自动续跑（避免目标 active 却永远静默）。
`pollFloorMs` 默认 1000（最小 100）：agent 暂不空闲或有竞争输入时的安全轮询间隔；
所有 timer 都 `unref()` 并在卸载时清除。

每个 agent 维护状态：`armed`、`timer` / `retryTimer`、`attempt`（已排队 / 已声明 / 已接纳的
round 消息，带自己的 turn 身份）、`requested`、`competingQueued`、`needsCheckpoint`、`stopping`。

流程：

1. `reconsider(agent)`：读 `ctx.infiniGoals.get(agent)`；未 armed、已有 attempt 在途或正在停止
   → 清 timer 返回。用 `planTrigger` 计算 `nextAt`：已到点 → 立即 `drive`；否则 `setTimeout`
   到该时刻（超过 `2^31-1` ms 则按片重排）。
2. `drive(agent)`：agent 不空闲 / 有竞争用户消息 → 用 `pollFloorMs` 定时重试；有 attempt 残留
   → 撤回并重新排程；需要 checkpoint 时先 flush Session 日志（失败 → block
   `checkpoint-failed`，本轮不注入）。随后核对 goal id / revision 未变化，构造
   `createUserMessage({ content: renderRoundPrompt(goal, round),
   source: { kind: 'infini-goal', goalId, revision, round } })`，`agent.followup(message)`，
   记录 attempt（状态 queued）。`followup` 抛错 → block（`queue-failed`）。
3. `agent/pre-step`：只有当前 attempt 的 round 消息才允许进入 step（校验 goalId / revision /
   round、live agent、armed、未 stale、phase 仍 active），返回
   `{ ...decision, startsRequestSeries: true }`；否则 `reject`，并把同一 step 中被 claim 的
   无关消息放回 inbox。
4. 监听（关键：结果只归属“该轮次自己的 turn”，后续人类 turn 的结束 / 失败不影响目标）：
   - `session/event` 中 `user/message` 且是本 attempt 的消息 → `attempt.phase = 'admitted'`；
   - `agent/status` idle → 清竞争标志；未 admitted 的 queued round 从 inbox 撤回；被 cancelled /
     discarded 的 round → pause（内部 code `round-cancelled`，不落盘 reason）；标记
     `needsCheckpoint` 后重新 `reconsider`；
   - `turn/end`（仅当 `turn === attempt.turn`）：`max-tokens` → block（`max-tokens`）；
     `error` → block（`turn-error`）；`aborted` 且 cause 是 `user` / `hook` / legacy → pause
     （`disposed` 只 disarm；`parent` 是卸载 / 内部取消，不 pause）；
   - `agent/error`（仅当属于本 attempt 的 turn）→ block（`agent-error`，带错误消息）；
     失败轮次里它通常先于 `turn/end` 到达，因此常是最终 code；
   - 驱动循环内部异常 → block（`driver-error`）；pre-step 下游 hook 拒绝 → block（`prompt-rejected`）；
   - `infini-goal/changed` → 重新排程；pause / complete / block / clear 会 disarm、取消 timer、
     撤回未进入的 round，并**只 abort 正在运行的自动轮次**（人类 turn 不动；模型在自身 turn 内
     用工具 pause 时不 abort 当前 turn）；`edit` 会 abort / 撤回 claimed-but-unadmitted 的 round，
     下一轮使用新 revision；
   - `agent/inbox/inserted` 出现其它用户消息 → `competingQueued = true`，等 idle 后再排程；
   - `agent/inbox/claimed` / `agent/inbox/discarded` → 记录 attempt 的 turn / 声明 / 丢弃。
5. `agent/created` 时先撤回上一代 queued round，再应用 `autoContinueOnStart`（false 时持久化
   pause）；插件加载时对已有 agent 同样处理；`agent/disposed` 清理状态与 timer。
6. 卸载时清除所有 timer、停止后续排程，撤回 queued-never-admitted 的 round，只 abort 正在运行的
   自动轮次（绝不 abort 人类 turn），并等待 idle；**卸载本身从不 pause**，之后不会再注入新 round。

block 码全集（`blockedReason.code`）：`max-tokens` / `turn-error` / `agent-error` /
`queue-failed` / `driver-error` / `prompt-rejected` / `checkpoint-failed`。
pause 不写 `blockedReason`（phase 本身表达结果）。

Round prompt（模型可见）：`<infini_goal_round>` 块，包含 objective、round 序号、
最小间隔与静默时段说明、不要空转、完成时 `update_infini_goal action="complete"`、
阻塞时按策略 `action="blocked"`，并提醒两轮之间到达的人类消息优先。

## 7. 模型工具（`tool` 包）

`inject = ['agents', 'infiniGoals', 'tools', 'systemPrompt']`，注册 system prompt section
`tool:infini-goal`（解释无限续跑、最小间隔、静默时段对自动触发的抑制、完成/阻塞纪律）。
自身 Config 只有一个键：`blockedAfterConsecutiveRounds`（默认 3，正整数）。

- `get_infini_goal`：无参数，返回 `{ goal: null }` 或
  `{ goal: {id, revision, objective, phase, roundsStarted, lastRoundAt, minIntervalMs,
  quietWindows, timezone, blockedReason?}, schedule: {nextTriggerAt, nextTriggerInMs,
  quietUntil} | null }`；非 active 目标没有计划中的自动轮次，`schedule` 为 `null`。
  `nextTriggerInMs = delayMs`；`quietUntil` 只在静默延后触发时非 `null`（且等于
  `nextTriggerAt`），因此模型能区分“等最小间隔”和“等静默结束”。
- `create_infini_goal`：`objective` 必填；`min_interval`（如 `5m`）、`quiet_windows`
  （如 `Mo-Fr 09:00-18:00`）、`timezone` 可选。要求 direct human 授权。
- 参数解析：`quiet_windows` 为空或仅空白会被拒绝（严格 schema 里 `""` 表示“未提供”，
  要关闭静默时段用 `"none"`）；时长允许 token 间空白（`2h 15m`）但拒绝 `1m s`。
- `update_infini_goal`：`goal_id`、`revision`、`action`（`edit|pause|resume|complete|blocked|config`），
  `objective` / `min_interval` / `quiet_windows` / `timezone` / `blocked_reason` 可选。

| action | 授权 | 语义 |
| --- | --- | --- |
| `edit` | direct human | 改 objective 和/或 pacing 字段 |
| `config` | direct human | 只改 pacing 字段；带 objective 会被拒绝 |
| `pause` / `resume` | direct human | 生命周期 |
| `complete` | direct human 或当前 goal round | 从 active / paused / blocked 进入 complete |
| `blocked` | direct human 或当前 goal round | 从 active 进入 blocked；goal round 授权时要求 `roundsStarted >= blockedAfterConsecutiveRounds`，否则报 `INFINI_GOAL_TOOL_BLOCK_THRESHOLD`；direct human 不受该阈值限制 |

- **direct human** 的判定：当前 runtime root agent 的 open turn 内存在 host-attested 的
  `source.kind === 'user'` 用户消息；同时要求调用方是 `ctx.agents.get()` 返回的同一实例、
  `agent.status === 'running'`、`ctx.agents.currentInitiator() === agent` 且存在 open model turn。
- **goal round** 的判定：open turn 内存在 `source.kind === 'infini-goal'` 且
  `goalId` / `revision` / `round === roundsStarted` 与当前目标完全匹配的自动轮次消息。
  goal round 授权只覆盖 `complete` / `blocked`，不覆盖 create / edit / config / pause / resume。
- `complete` / `blocked` 在 goal round 授权下会 `exec.deferContext(createUserMessage({ source:
  {kind:'tool-infini-goal', form:'notice', summary} }))` 注入收尾提示；direct human 授权不注入。
- 工具错误码（`HarnessError.code`，工具层自有）：

  | code | 含义 |
  | --- | --- |
  | `INFINI_GOAL_TOOL_AGENT_REQUIRED` | 工具调用没有 calling agent |
  | `INFINI_GOAL_TOOL_DRIVER_REQUIRED` | 不是精确的 live agent / 非 running / 不是 currentInitiator / 没有 open model turn |
  | `INFINI_GOAL_TOOL_AUTHORITY_REQUIRED` | 缺少 direct human（create/edit/config/pause/resume）或 direct human 与 goal round 都没有（complete/blocked） |
  | `INFINI_GOAL_TOOL_INVALID_ARGUMENT` | objective 为空、时长 / 静默时段 / 时区不可解析或越界、goal_id / revision 非法、edit/config 没有实际变更、config 带 objective、blocked_reason 缺失或为空 |
  | `INFINI_GOAL_TOOL_BLOCK_THRESHOLD` | goal round 授权下 `roundsStarted < blockedAfterConsecutiveRounds` 却要求 blocked |

  领域错误（`INFINI_GOAL_ALREADY_EXISTS` / `NOT_FOUND` / `STALE_REVISION` / `INVALID_TRANSITION` /
  `INVALID_OBJECTIVE` / `INVALID_SETTINGS` / `INVALID_BLOCK_REASON` / `AGENT_NOT_LIVE`）原样透传；
  工具注册表的 `INVALID_ARGS` / `INVALID_TOOL_OUTPUT` / `ABORTED` 由 DSH 自身产生。
- 授权判定全部基于 Session 事件与 agent 注册表，不采信模型在自然语言里的自我声明。

## 8. 命令 `/infini-goal`

`inject = ['commands', 'infiniGoals']`，注册 `name: 'infini-goal'`，不接受附件（有附件时返回
友好错误）。解析规则：整行恰好是 `status|pause|resume|complete|clear` 时按无参数子命令；
首 token 是 `edit|block|interval|quiet|timezone` 时按子命令解析并消费余下文本；否则整行
作为 objective（因此 `pause the deployment` 会被当成 objective，而不是残缺的 pause）。
子命令参数可以包一层匹配的单 / 双引号（如 `/infini-goal quiet "Mo-Fr 09:00-18:00"`），
引号属于语法、会被剥掉；带引号的控制词仍按 objective 处理。

```
/infini-goal                                  → 状态
/infini-goal status                           → 上一行的显式别名
/infini-goal <objective>                      → 创建（若无目标或旧目标已 complete）
/infini-goal edit <objective>                 → 修改 objective；当前目标已 complete 时改为创建新目标
/infini-goal pause | resume | complete        → 生命周期
/infini-goal block <message>                  → 阻塞，blockedReason.code = 'human-reported'
/infini-goal clear                            → 清除
/infini-goal interval <duration>              → 设置最小触发间隔（如 5m、90s）
/infini-goal quiet <windows|none>             → 设置静默时段
/infini-goal timezone <IANA|system>           → 设置时区
```

状态输出（文本为英文，如 `Status: active`、`Min interval: 1m`，便于脚本/截图对照）：
phase、objective、roundsStarted、min interval、quiet windows（含时区）、下一次可触发时间
（用 `planTrigger`）、静默中时的结束时间，以及当前相态下可用的子命令提示；`complete`
相态不显示 settings 提示。命令错误以 `{ kind: 'error', text }` 返回：
`INFINI_GOAL_COMMAND_INVALID_INPUT` 与领域错误都会被翻译成人类可读文本（NOT_FOUND /
ALREADY_EXISTS / STALE_REVISION / INVALID_TRANSITION / INVALID_SETTINGS / INVALID_OBJECTIVE /
INVALID_BLOCK_REASON / AGENT_NOT_LIVE），未预期的异常继续抛出。`interval` / `quiet` /
`timezone` 在目标已 `complete` 时返回友好错误（complete 后节奏已无意义，需先创建新目标）。

## 9. 浏览器 UI（`client-ui` 包）

- 包声明：`"dsh": { "client": { "platform": "web", "inject": [...] } }`，
  `exports["./client"] = "./lib/client.js"`，host 侧 `src/index.ts` 导出空 `apply()`。
- 客户端插件 `inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']`。
- 注册 `conversation.input.dock` 槽位条目：`{ name, id: 'infini-goal', order: 11, locale: 'infiniGoal', inject: (sessionId) => ({ executeCommand: (line) => ctx.remote.commands.execute(sessionId, line, []) }) }`。
- `InfiniGoalDock` 通过 `useProjection('infiniGoal')`（`PropsRuntime` 提供）读取投影；
  用 `planTrigger` 每秒刷新倒计时（`useEffect` + `setInterval`）。
- 展示：
  - 加载中（projection 尚未就绪）、无目标 / complete → 不渲染；
  - active：图标 + "自动推进中" + objective + 轮次 + 节奏行，节奏行按优先级显示：
    静默时段内 "静默时段 · 至 18:00"；最小间隔未到 "最小间隔 1m"；否则
    "下一轮 00:42"（mm:ss，超过 1 小时为 h:mm:ss，每秒刷新）；
  - paused / blocked：状态标签 +（blocked 时）reason，不显示节奏行，显示 resume 按钮；
  - 命令失败会内联显示错误文本（`role="alert"`），覆盖两层失败：Remote 传输失败（`ok:false`，
  用 `error.command`）与 Host 命令逻辑失败（`ok:true` 但 `CommandResult.kind === 'error'`，
  用新 locale key `error.rejected`：zh `命令被拒绝：{message}` / en `Command rejected: {message}`）；
  clear 只在真正成功时隐藏状态条，逻辑拒绝时保留状态条与错误；
  - 操作按钮：pause / resume / clear（全部通过 `executeCommand('/infini-goal pause')` 等命令执行，
    UI 不实现自己的 Remote API）。
- 倒计时在 projection 变化（轮次 / revision / lastRoundAt / 间隔设置）时立即重算，不等下一秒 tick。
- DOM 契约：根节点 `class="infini-goal-dock" data-infini-goal-bar="true"
  data-infini-goal-phase="<phase>"`；样式标签 `<style data-plugin-css="infini-goal">`，
  HMR 复用已有标签时会刷新其 CSS 文本。
- 样式：不引入 CSS Modules 构建链，`styles.ts` 导出 CSS 字符串，`apply()` 里注入
  `<style data-plugin-css="infini-goal">`；颜色用 CSS 变量/主题兼容值。
- 文案：`ctx.locale.register('infiniGoal', { zh, en })` 提供中/英字典（阶段标签、轮次、
  节奏行、按钮 aria-label、命令错误）；`locale/zh.json`、`locale/en.json` 提供 meta title/description。
- 图标：从 `@deepseek-ai/dsh-client-ui-primitives` 导入（该包是 platform module，可 require）。

## 10. bundle 与安装

`packages/bundle/cordis.patch.yml`：

```yaml
- insert:
    - id: infini-goal
      name: '@yankeguo/dsh-infini-goal'
      config:
        defaultMinIntervalMs: 60000
        defaultQuietWindows: []
    - id: infini-goal-driver
      name: '@yankeguo/dsh-infini-goal-driver'
    - id: infini-goal-tool
      name: '@yankeguo/dsh-tool-infini-goal'
    - id: infini-goal-command
      name: '@yankeguo/dsh-command-infini-goal'
    - id: infini-goal-ui
      name: '@yankeguo/dsh-client-ui-infini-goal'
```

bundle 的 `package.json` 声明 `dsh.bundle.patch` 与 `dsh.bundle.listedByDefault: false`：
安装后在 profile 的 `dsh.profile.bundles` 中选中即生效，未选中时不会出现在默认 bundle 列表。
核心服务行通过 `config` 覆盖部署默认值；驱动器 / 工具行如需覆盖也按同样方式加 `config`
（bundle 默认不写，等于使用插件内默认值）。

本地开发/验收：`--patch` overlay 用**绝对路径**指向各包的 `lib/index.js`，
避免安装步骤（DSH 支持 insert name 为绝对文件路径）。

主 bundle 的 `dsh.bundle.patch` 是**有序文件数组**：先 `cordis.patch.yml`（上面的 5 行），
再生成的 `cordis.disable-goal.patch.yml`（默认关闭系统自带 dsh-goal）。后者与独立 bundle
`packages/disable-goal-bundle/cordis.patch.yml` 由同一个生成器输出、内容逐字节相同：停用官方
`goal-round-driver` / `ui-goal` 与 `preset-*` 声明，并用小型 `preset-filter` 运行时插件
在启动时过滤 shipped preset 的 `command-goal` / `tool-goal` 行（见
[`DISABLE-BUILTIN-GOAL.md`](DISABLE-BUILTIN-GOAL.md)）。两个 bundle 共用同一批 row id 是
刻意的：同时启用时 Loader 每个 id 只保留一个 entry（后插入者生效），preset filter 不会重复挂载。

## 11. 验证（已实测，冻结版本）

- `pnpm typecheck` 全绿；`pnpm test`：**23 个测试文件 / 381 个用例**（v0.1.1 基线 22 / 376；新增 bundle 组合一致性检查，其余覆盖
  protocol 时间数学、core fold/service/持久化记录、driver 状态机与生命周期、tool/command
  解析与授权、client-ui 结果处理与样式注入）。
- `pnpm build` 产出 **9 个 `lib/*.js`**：protocol 的 `index`/`client`、core、driver、tool、
  command、client-ui 的 `index`/`client`、disable-goal-bundle 的 `preset-filter.js`；
  `node scripts/build-disable-goal-bundle.mjs --check` → up to date。
- 隔离 DSH 0.2.2-rc.1 + 确定性 mock LLM（`/tmp/dsh-e2e-final`，不触碰用户 `~/.dsh`）：
  - `tools/e2e/suite.sh --fresh` → **SUITE PASS (9 steps)**：5 行 dev-patch、隔离 profile + linked
    root、`ctx.infiniGoals` 挂载、浏览器 client row + bundle HTTP 200；三个场景：
    ① `minIntervalMs=2000` 时轮次间隔 `[2021, 2011]ms`，`roundsStarted` 1→2→3；
    ② 静默窗口 16:44–16:48（Asia/Shanghai）内 0 个自动轮次，窗口结束后 27ms 出现下一轮；
    ③ paused 后 `roundsBeforeWait=1`、`roundsAfterWait=1`，view 为 paused/roundsStarted=1；
    干净关停。
  - **持久化 / 恢复验证（P0 修复）**：三个 e2e Session 日志均通过**安装版**
    `@deepseek-ai/dsh-session-persistence` 的 `validateStoredEvents`（189/347/63/19 事件，
    包含 `plugin:infini-goal/change` ignorable 记录，无旧 event type）。同一隔离 home 重启
    DSH 后：paused 目标 Session 正常重载并恢复 `{phase:'paused', revision:2, roundsStarted:1}`；
    active 目标 Session 恢复后驱动器继续自动轮次（`roundsStarted` 31→38）。
  - 真实 0.1.0 坏日志（`~/.dsh/sessions/...superhive...`）被安装版 validator 拒绝（seq 544,
    "unknown … not marked ignorable"）——确认旧表示确实是 P0 根因。
  - `scripts/repair-session-log.mjs`：对上述坏日志 dry-run 报告 7 行；`--write` 输出通过安装版
    `validateStoredEvents`；幂等；存在 `session.lock` 时默认拒绝（`--force` 才继续）。
  - 浏览器 UI（隔离实例 + 真实 Chrome/Browser MCP，用户标签页未受影响）：`/infini-goal
    浏览器端审计验证目标` 渲染成功，DOM 断言 active、`data-infini-goal-bar="true"`、轮次 1、
    `最小间隔 1m`、按钮 `暂停目标`/`清除目标`；点击暂停 → paused、无节奏行、按钮变为
    `恢复目标`/`清除目标`；点击清除 → 状态条移除。`data-infini-goal-bar="true"` 确认保留。
  - `tools/e2e/probe-install.sh`（安装模式，无 dev patch）→ **PROBE INSTALL PASS**：
    `install-profile.mjs` 链接 8 个包并选中 bundle、无加载错误；client entry + bundle HTTP 200；
    `commands/list` 有 `infini-goal`；创建 / status / pause 经真实 commands Remote；驱动器跑出
    round 1（seq 13）且 pause 持久化；工具行 advertise 三个 `*_infini_goal` 工具。
  - `tools/e2e/probe-bundles.sh`（bundle 打包回归，隔离 home）→ **PROBE BUNDLES PASS (61 checks)**：
    A) 主 bundle 单独安装即含关闭层：`--dump-config` 204 行、id 全唯一、5 个官方行 `disabled: true`、
    8 个 infini-goal / preset-filter 行各 1 次；boot 图无 `@deepseek-ai/dsh-client-ui-goal` client
    entry、无 `/goal` 命令与官方 goal 工具，infini-goal 命令 / 驱动器 / 工具全部可用；安装脚本在
    旧 profile 上自动取消伴生 bundle 的选择（迁移路径）。
    B) 旧 profile 仍同时选中主 bundle + 伴生 bundle：`--dump-config` 207 行、仅 3 个
    `preset-*-filter` id 各出现 2 次（Loader 每个 id 只挂载一次）；启动无重复 preset /
    `waiting for goals` 错误，运行时行为与 A 相同。
- 截图见 `docs/screenshots/`。

## 12. 实现记录与偏差

- **依赖外部化**：host bundle 外部化 `@deepseek-ai/*`、`@yankeguo/*`、`node:*`，其余内联。
  因此 core 的 `zod` 被内联（`packages/infini-goal/lib/index.js` 约 580KB），其余 host 包只有几十 KB；
  换来的是 `@yankeguo` 各包共享同一份 core/protocol 实例（`instanceof InfiniGoalError` 等语义正确）。
- **持久化表示变更（0.1.0 → 当前）**：从自定义 `infini-goal/change` Session 事件改为可忽略的
  `plugin:infini-goal/change` 插件记录，payload 不变，`stateVersion` 升为 2；旧事件类型只为热重载
  兼容而保留读取，不再写入。0.1.0 旧日志不会被自动迁移，需要 `scripts/repair-session-log.mjs`
  （见 §4）。
- **DST 取舍**：静默窗口的开始取重复墙钟的较早一次、结束取较晚一次（保守包络），每年夏令时
  回拨日可能多覆盖约 1 小时；行为确定且两端一致，属已知实现取舍。
- **配置**：`static Config` 未标注 `z<Config>`（`exactOptionalPropertyTypes` 下 Schemastery 嵌套
  数组型变不兼容），运行时默认值/校验由单测覆盖。
- **更严格的 fold**：payload 内 `roundsStarted`/`lastRoundAt` 一致性、替换 complete 目标时
  `createdAt >= 前一目标 updatedAt`、轮次事件时间戳单调、quiet window/timezone 规范化、
  clear 时间戳单调。
- **edit 也做可调度性校验**；空 edit 请求报 `INFINI_GOAL_INVALID_SETTINGS`（无单独错误码）。
- **resume 不接受 active→active**：`active` 即自动续跑；`autoContinueOnStart=false` 的启动场景
  由驱动器改写成持久化 pause，因此 UI 永远能看到可 resume 的状态。
- **UI**：v1 不含 objective 内联编辑（命令 `edit` 覆盖），按钮只做 pause/resume/clear；
  等待最小间隔时状态条显示 `最小间隔 1m`（来自 `planTrigger.reason='interval'`），
  静默时段显示 `静默时段 · 至 HH:mm`；`nextRoundIn` 在已可触发时显示 `00:00`。
- **命令**：`/infini-goal status` 为无参数形式的显式别名；命令不接受附件（返回友好错误）；
  对已 complete 的目标执行 `edit` 会创建新目标。
- **失败语义**：自动轮次的 block code 全集见 §6（含 `driver-error` / `prompt-rejected`）；
  人类打断 / 取消运行中的自动轮次会 `pause`；Host 命令侧 pause 会 abort 正在运行的自动 turn。
- **工具阈值**：`blockedAfterConsecutiveRounds` 只在 goal round 授权下生效，direct human 的
  block 不受阈值限制；工具错误码见 §7。
