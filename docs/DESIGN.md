# dsh-infini-goal 设计说明

一套 DeepSeek Harness（DSH）插件，参考官方 `dsh-goal` 的领域模型、模型工具与 UI 形态，
但把"自动续跑"改造成一个**无轮次上限 + 最小触发间隔 + 可配置静默时段**的无限目标。

## 1. 与官方 dsh-goal 的差异

| 维度 | 官方 `dsh-goal` | 本插件 `dsh-infini-goal` |
| --- | --- | --- |
| 轮次上限 | `maxGoalRounds`（默认 256），用尽后 `resume` 被拒绝 | **无上限**，目标保持 `active` 直到被 pause / block / complete / clear |
| 续跑节流 | 无：一旦 agent 空闲立即进入下一轮，空循环会疯狂重试 | **最小触发间隔** `minIntervalMs`：两次自动轮次的开始时间至少相隔这么久 |
| 触发时段 | 无 | **静默时段** `quietWindows`：配置的本地时间段内不自动触发（免打扰、专注时段、非工作时段、夜间等任意场景） |
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
| `protocol` | `@yankeguo/dsh-infini-goal-protocol` | 纯类型 + 时间/间隔/静默时段数学（host 与浏览器共用），已实现 |
| `infini-goal` | `@yankeguo/dsh-infini-goal` | 核心 Service `ctx.infiniGoals`：事件溯源状态、CAS 变更、Session projection `infiniGoal` |
| `driver` | `@yankeguo/dsh-infini-goal-driver` | 续跑驱动器：按最小间隔/静默时段调度自动轮次，注入 round message |
| `tool` | `@yankeguo/dsh-tool-infini-goal` | 模型工具：`get_infini_goal` / `create_infini_goal` / `update_infini_goal` + system prompt 指导 |
| `command` | `@yankeguo/dsh-command-infini-goal` | 人类命令 `/infini-goal` |
| `client-ui` | `@yankeguo/dsh-client-ui-infini-goal` | 浏览器 UI：composer 上方的 InfiniGoalBar（状态、倒计时、静默提示、pause/resume/clear） |
| `bundle` | `@yankeguo/dsh-infini-goal-bundle` | bundle 包：`cordis.patch.yml` 把所有插件插入 profile + 依赖声明 |

构建：`pnpm build` 用 esbuild：
- host 入口 `src/index.ts` → `lib/index.js`，只 external `@deepseek-ai/*` 与 `node:*`，
  工作区包内联，产物自包含；
- 浏览器入口 `src/client/index.tsx` → `lib/client.js`，esbuild 打成 CJS 后包进
  `window.__ModuleLoader__.load({ id, factory: (require) => ... })`，external 为
  浏览器 shell 的 platform modules（react、react/jsx-runtime、
  `@deepseek-ai/dsh-client-ui-primitives` 等）。

## 3. 领域模型（`packages/protocol/src/types.ts`）

```ts
interface QuietWindow { days: number[]; start: string; end: string }  // days: ISO 1=周一..7=周日，空=每天；HH:mm；end<=start 跨午夜
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
- `planTrigger(...)`：返回 `{ nextAt, quietUntil, delayMs, reason: 'ready' | 'interval' | 'quiet-window' }`。
- 静默时段覆盖全天时抛 `RangeError`（配置校验阶段应拒绝）。

## 4. 持久化事件与严格回放

Session 事件：`infini-goal/change`，payload 两种：

```ts
// 全量快照变更
{ kind: 'infini-goal/change', version: 1,
  operation: 'create'|'edit'|'pause'|'resume'|'complete'|'block',
  goal: InfiniGoalSnapshot, roundsStarted: number, lastRoundAt: number | null,
  createdAt: number, updatedAt: number }
// clear 墓碑
{ kind: 'infini-goal/change', version: 1, operation: 'clear', cleared: InfiniGoalRef, clearedAt: number }
```

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
- 变更后 `agent.session.append('infini-goal/change', change)`，然后
  `agentEvents(ctx, agent).emit('infini-goal/changed', { agent, change })`，
  payload `change = { operation, ref, goal?: InfiniGoalView }`（clear 时无 goal）。
- 错误类型 `InfiniGoalError extends Error`，`code` 取值：
  `INFINI_GOAL_AGENT_NOT_LIVE` / `INFINI_GOAL_NOT_FOUND` / `INFINI_GOAL_ALREADY_EXISTS` /
  `INFINI_GOAL_STALE_REVISION` / `INFINI_GOAL_INVALID_OBJECTIVE` / `INFINI_GOAL_INVALID_SETTINGS` /
  `INFINI_GOAL_INVALID_TRANSITION` / `INFINI_GOAL_INVALID_BLOCK_REASON`。
- 事件类型通过 module augmentation 合并进 `cordis` 的 `Events`（agent 作用域：`Scoped<Agent>`），
  `user/message` 的 source 通过 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 合并 `infini-goal`；
  session event 通过 `@deepseek-ai/dsh-session/types` 的 `SessionEventMap` 合并 `infini-goal/change`。

## 6. 驱动器 `@yankeguo/dsh-infini-goal-driver`

`inject = ['agents', 'infiniGoals', 'sessions']`，自身 Config：`{ autoContinueOnStart?: boolean, pollFloorMs?: number }`。
`autoContinueOnStart` 默认 true：插件加载/会话恢复时，已有 `active` 目标立即按调度规则继续；
设为 false 时，驱动器在启动时把 `active` 目标**持久化地 pause**（写入一条 pause 事件），
状态条显示可恢复的 paused，人类 `/infini-goal resume` 后才重新开始。
`pollFloorMs` 默认 1000：agent 暂不空闲时的安全轮询间隔；所有 timer 都 `unref()` 并在卸载时清除。

每个 agent 维护状态：`timer`、`attempt`（已排队/声明/已接纳的 round 消息）、`requested`、`competingQueued`。

流程：

1. `schedule(agent)`：读 `ctx.infiniGoals.get(agent)`；phase 非 active → 取消 timer。
   计算 `nextTriggerAt(view, view.lastRoundAt, Date.now())`；`setTimeout` 到该时刻
   （超过 `2^31-1` ms 则分段，回调里重新 `schedule`）。
2. timer 到点 → `drive(agent)`：若 agent 不空闲、有竞争的用户消息、或目标已变化 → 重新 `schedule`。
   空闲且满足条件时，构造 `createUserMessage({ content: renderRoundPrompt(goal, round),
   source: { kind: 'infini-goal', goalId, revision, round } })`，`agent.followup(message)`，
   记录 attempt（状态 queued）。
3. `agent/pre-step`：只有当前 attempt 的 round 消息才允许进入 step（校验 goalId/revision/round、
   live agent、未 stale），返回 `{ ...decision, startsRequestSeries: true }`；否则 `reject`。
4. 监听：
   - `session/event` 中 `user/message` 且是本 attempt 的消息 → `attempt.phase = 'admitted'`；
   - `agent/status` idle → 若 attempt 已 admitted / 已被丢弃 → 清 attempt，`schedule(agent)`；
   - `turn/end` `max-tokens` → block（code `max-tokens`）；`aborted` → pause（人类打断时就地暂停）；
   - `agent/error` → block（code `agent-error`，带错误消息）；
   - `infini-goal/changed` → `schedule(agent)`（pause/complete/clear 会取消 timer）；
   - `agent/inbox/inserted` 有其他用户消息 → `competingQueued = true`，等 idle 后再排程。
5. `agent/created` 时套用 `autoContinueOnStart` 配置（false 则不自动续跑，等待人类 `/infini-goal resume`）；插件加载时对已有 agent 同样处理。
6. 卸载时清除所有 timer、把未进入的 round 消息从 inbox 移除。

Round prompt（模型可见）：`<infini_goal_round>` 块，包含 objective、round 序号、
最小间隔与静默时段说明、要求做真实进展、不要空转、完成时 `update_infini_goal action=complete`、
阻塞时按阈值 `blocked`。

## 7. 模型工具（`tool` 包）

`inject = ['agents', 'infiniGoals', 'tools', 'systemPrompt']`，注册 system prompt section
`tool:infini-goal`（解释无限续跑、最小间隔、静默时段对自动触发的抑制、完成/阻塞纪律）。

- `get_infini_goal`：无参数，返回 `{ goal: null }` 或 `{ goal: {id, revision, objective, phase,
  roundsStarted, lastRoundAt, minIntervalMs, quietWindows, timezone, blockedReason?},
  schedule: { nextTriggerAt, nextTriggerInMs, quietUntil } }`。
- `create_infini_goal`：`objective` 必填；`min_interval`（如 `5m`）、`quiet_windows`
  （如 `Mo-Fr 09:00-18:00`）、`timezone` 可选。要求 direct human 授权。
- `update_infini_goal`：`goal_id`、`revision`、`action`（`edit|pause|resume|complete|blocked|config`），
  `objective` / `min_interval` / `quiet_windows` / `timezone` / `blocked_reason` 可选。
  - `edit`/`pause`/`resume`/`config` 需要 direct human 授权；
  - `complete` / `blocked` 允许 direct human 或"当前 goal round"授权；
  - `blocked` 要求 `blockedAfterConsecutiveRounds`（默认 3）阈值；
  - 完成/阻塞时在 goal round 中 `exec.deferContext(createUserMessage({ source: {kind:'tool-infini-goal', form:'notice', summary} }))` 收尾提示。
- 权限校验复用官方 `authority.ts` 模式：`ctx.agents.currentInitiator()`、open turn 事件、
  `source.kind === 'user'` 判定 direct human，`source.kind === 'infini-goal'` 且 round 匹配判定 goal round。

## 8. 命令 `/infini-goal`

`inject = ['commands', 'infiniGoals']`，注册 `name: 'infini-goal'`。

```
/infini-goal                                  → 状态
/infini-goal <objective>                      → 创建（若无目标或旧目标已 complete）
/infini-goal edit <objective>                 → 修改 objective
/infini-goal pause | resume | complete        → 生命周期
/infini-goal block <message>                  → 阻塞
/infini-goal clear                            → 清除
/infini-goal interval <duration>              → 设置最小触发间隔（如 5m、90s）
/infini-goal quiet <windows|none>             → 设置静默时段
/infini-goal timezone <IANA|system>           → 设置时区
```

状态输出包含：phase、objective、rounds、`minInterval`、静默时段、
下一次可触发时间（用 `planTrigger`）、静默中时的结束时间、可用子命令提示。

## 9. 浏览器 UI（`client-ui` 包）

- 包声明：`"dsh": { "client": { "platform": "web", "inject": [...] } }`，
  `exports["./client"] = "./lib/client.js"`，host 侧 `src/index.ts` 导出空 `apply()`。
- 客户端插件 `inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']`。
- 注册 `conversation.input.dock` 槽位条目：`{ name, id: 'infini-goal', order: 11, locale: 'infiniGoal', inject: (sessionId) => ({ executeCommand: (line) => ctx.remote.commands.execute(sessionId, line, []) }) }`。
- `InfiniGoalDock` 通过 `useProjection('infiniGoal')`（`PropsRuntime` 提供）读取投影；
  用 `planTrigger` 每秒刷新倒计时（`useEffect` + `setInterval`）。
- 展示：
  - 无目标 / complete → 不渲染；
  - active：图标 + "自动推进中" + objective + 轮次 + "下一轮 00:42"；
    静默时段内显示 "静默时段 · 至 18:00"；间隔等待显示 "最小间隔 01:00"；
  - paused / blocked：状态标签 + reason，显示 resume 按钮；
  - 操作按钮：pause / resume / clear（全部通过 `executeCommand('/infini-goal pause')` 等命令执行，
    UI 不实现自己的 Remote API）。
- 样式：不引入 CSS Modules 构建链，`styles.ts` 导出 CSS 字符串，`apply()` 里注入
  `<style data-plugin-css="infini-goal-ui">`；颜色用 CSS 变量/主题兼容值。
- 图标：从 `@deepseek-ai/dsh-client-ui-primitives` 导入（该包是 platform module，可 require）。

## 10. bundle 与安装

`packages/bundle/cordis.patch.yml`：

```yaml
- insert:
    - id: infini-goal
      name: '@yankeguo/dsh-infini-goal'
      config: { defaultMinIntervalMs: 60000 }
    - id: infini-goal-driver
      name: '@yankeguo/dsh-infini-goal-driver'
    - id: infini-goal-tool
      name: '@yankeguo/dsh-tool-infini-goal'
    - id: infini-goal-command
      name: '@yankeguo/dsh-command-infini-goal'
    - id: infini-goal-ui
      name: '@yankeguo/dsh-client-ui-infini-goal'
```

本地开发/验收：`--patch` overlay 用**绝对路径**指向各包的 `lib/index.js`，
避免安装步骤（DSH 支持 insert name 为绝对文件路径）。

## 11. 验证（已实测）

- `pnpm typecheck` 全绿；`pnpm test`：16 个测试文件、243 个用例（protocol 数学、core fold/service、
  tool/command 解析与渲染、driver prompt、client-ui 格式化）；
- `pnpm build` 产出全部 8 个 `lib` 入口；
- `tools/e2e/suite.sh --fresh`（隔离 DSH_HOME + 确定性 mock LLM，插入绝对路径插件）**SUITE PASS**：
  1. 自动轮次：`minIntervalMs=2000`，实际轮次间隔 `[2025, 2015]ms`，`roundsStarted` 1→2→3；
  2. 静默时段覆盖当前时间：时段内 0 个自动轮次；时段结束后 34ms 出现下一轮；
  3. paused：等待 5s 无新轮次；
  4. 浏览器 boot graph 含 `@yankeguo/dsh-client-ui-infini-goal`，client bundle HTTP 200 可服务；
  5. 真实浏览器验证：`/infini-goal` 命令创建目标后状态条出现（active/轮次/最小间隔），
     pause/resume/quiet 命令生效，静默时段显示"静默时段 · 至 18:00"；
  6. `scripts/install-profile.mjs` 安装模式（profile bundle + node_modules 链接，非 --patch）
     同样能加载全部插件、命令与 UI。
- 截图见 `docs/screenshots/`。

## 12. 实现记录与偏差

- **依赖外部化**：host bundle 外部化 `@deepseek-ai/*`、`@yankeguo/*`、`node:*`，其余内联。
  因此 core 的 `zod` 被内联（`packages/infini-goal/lib/index.js` 约 578KB），其余 host 包只有几十 KB；
  换来的是 `@yankeguo` 各包共享同一份 core/protocol 实例（`instanceof InfiniGoalError` 等语义正确）。
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
  静默时段显示 `静默时段 · 至 HH:mm`。
- **命令**：`/infini-goal status` 为无参数形式的显式别名；命令不接受附件（返回友好错误）。
