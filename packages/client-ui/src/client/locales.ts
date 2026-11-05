/** `infiniGoal` namespace dictionaries. */

/**
 * Simplified Chinese dictionary: the key-set source of truth. Template
 * placeholders are `{name}` tokens interpolated by the locale runtime.
 */
export const zh = {
  'meta.title': '无限目标',
  'meta.description': '在输入框上方展示无限续跑目标的阶段、轮次、触发节奏与静默时段状态。',
  'phase.active': '自动推进中',
  'phase.paused': '已暂停',
  'phase.blocked': '已阻塞',
  'phase.complete': '已完成',
  'rounds': '轮次 {count}',
  'nextRoundIn': '下一轮 {time}',
  'waitingUntil': '静默时段 · 至 {time}',
  'minInterval': '最小间隔 {interval}',
  'objective.aria': '目标内容',
  'action.pause': '暂停目标',
  'action.resume': '恢复目标',
  'action.clear': '清除目标',
  'error.command': '命令失败：{message}（{code}）',
  'error.rejected': '命令被拒绝：{message}',
  'error.unknown': '命令执行失败：{message}',
} satisfies Record<string, string>

/** The `infiniGoal` namespace key union. */
export type InfiniGoalKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'meta.title': 'Infini Goal',
  'meta.description': 'Shows the endless goal phase, rounds, trigger pacing, and quiet-window state above the composer.',
  'phase.active': 'Auto-continuing',
  'phase.paused': 'Paused',
  'phase.blocked': 'Blocked',
  'phase.complete': 'Complete',
  'rounds': 'Rounds: {count}',
  'nextRoundIn': 'next round in {time}',
  'waitingUntil': 'quiet window · until {time}',
  'minInterval': 'min interval {interval}',
  'objective.aria': 'Goal objective',
  'action.pause': 'Pause goal',
  'action.resume': 'Resume goal',
  'action.clear': 'Clear goal',
  'error.command': 'Command failed: {message} ({code})',
  'error.rejected': 'Command rejected: {message}',
  'error.unknown': 'Command failed: {message}',
} satisfies Record<InfiniGoalKey, string>
