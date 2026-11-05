/**
 * InfiniGoalBar: the infini-goal status strip docked above the message
 * composer (`conversation.input.dock`).
 *
 * A present goal shows a goal glyph, its localized phase label, the truncated
 * objective, the admitted-round count, and one live schedule line:
 * - active inside a quiet window → "waiting for assigned work until HH:mm"
 *   (the employee-waits-for-assignment semantics);
 * - active while the minimum interval has not elapsed → "min interval 05:00";
 * - active otherwise → "next round in mm:ss", ticking once per second.
 *
 * Paused and blocked goals show the phase label (blocked also its short
 * reason) and a resume action. Loading (`undefined`), no goal (`null`), and
 * complete goals render nothing. Lifecycle actions execute the Host
 * `/infini-goal` slash command through the injected command face: this dock
 * ships no Remote API of its own.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconGoalOutlineRegular,
  IconPauseOutlineRegular,
  IconPlayOutlineRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formatQuietWindows } from '@yankeguo/dsh-infini-goal-protocol/client'
import { describeSchedule, phaseLabelKey } from './format.ts'

/** Settled outcome of one `/infini-goal` command admission. */
export type InfiniGoalCommandResult = RemoteResult<object | undefined>

/** Injected business face of the dock entry: command admission bound to this session. */
export interface InfiniGoalDockInjected {
  /**
   * Execute one `/infini-goal` line against the dock's Session.
   * @param line - the full command line, leading slash included.
   * @returns the Host admission result.
   */
  readonly executeCommand: (line: string) => Promise<InfiniGoalCommandResult>
}

/** Full props of the dock entry: runtime share + injected face + locale seat. */
export type InfiniGoalDockProps =
  PropsRuntime<'conversation.input.dock'> & InjectFace<InfiniGoalDockInjected> & PropsLocale<'infiniGoal'>

/** Re-render cadence of the live countdown, in milliseconds. */
const TICK_MS = 1_000

/**
 * Tick once per second while the strip is visible and counting down.
 * @param enabled - whether a countdown is currently rendered.
 * @returns the latest local instant in epoch milliseconds.
 */
function useLiveNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
    }, TICK_MS)
    return () => {
      clearInterval(timer)
    }
  }, [enabled])
  return now
}

/** The infini-goal strip above the composer. */
export function InfiniGoalDock({ useProjection, executeCommand, t }: InfiniGoalDockProps) {
  const projection = useProjection('infiniGoal')
  const currentGoal = projection?.goal
  const visible = currentGoal !== undefined && currentGoal.phase !== 'complete'
  const now = useLiveNow(visible && currentGoal?.phase === 'active')

  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [clearedGoalId, setClearedGoalId] = useState<string | null>(null)
  // React state disables the buttons on the next render; the ref closes the
  // same-render window so a rapid double click cannot admit two commands.
  const pendingRef = useRef(false)

  // A new goal identity (cleared/completed/replaced externally) invalidates
  // feedback that belonged to the previous goal.
  useEffect(() => {
    setActionError(null)
    setClearedGoalId(null)
  }, [currentGoal?.id])

  const runCommand = useCallback(async (line: string): Promise<InfiniGoalCommandResult | undefined> => {
    if (pendingRef.current) return undefined
    pendingRef.current = true
    setPending(true)
    setActionError(null)
    try {
      const result = await executeCommand(line)
      if (!result.ok) {
        setActionError(t('error.command', { message: result.error.message, code: result.error.code }))
      }
      return result
    } catch (error) {
      setActionError(t('error.unknown', { message: error instanceof Error ? error.message : String(error) }))
      return undefined
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }, [executeCommand, t])

  // Loading, absent, complete, and locally-cleared goals have no strip at all.
  if (projection === undefined || projection === null || projection.goal.phase === 'complete') return null
  const goal = projection.goal
  if (goal.id === clearedGoalId) return null

  const active = goal.phase === 'active'
  const blockedReason = goal.phase === 'blocked' ? goal.blockedReason?.message : undefined
  const schedule = active ? describeSchedule(projection, now) : null
  // Technical tooltip: the pacing configuration the schedule line follows.
  const settingsTitle = `${formatQuietWindows(goal.quietWindows)} · ${goal.timezone}`

  const clear = (): void => {
    void runCommand('/infini-goal clear').then((result) => {
      if (result?.ok === true) setClearedGoalId(goal.id)
    })
  }
  const pause = (): void => {
    void runCommand('/infini-goal pause')
  }
  const resume = (): void => {
    void runCommand('/infini-goal resume')
  }

  return (
    <div className="infini-goal-dock" data-infini-goal-bar data-infini-goal-phase={goal.phase}>
      <div className="infini-goal-bar" title={blockedReason}>
        <span className="infini-goal-glyph" aria-hidden="true">
          <IconGoalOutlineRegular size={14} />
        </span>
        <span className="infini-goal-label">{t(phaseLabelKey(goal.phase))}</span>
        <span className="infini-goal-objective" title={goal.objective}>{goal.objective}</span>
        {blockedReason !== undefined && (
          <span className="infini-goal-reason" title={blockedReason}>{blockedReason}</span>
        )}
        <span className="infini-goal-rounds">{t('rounds', { count: projection.roundsStarted })}</span>
        {schedule !== null && (
          <span className="infini-goal-schedule" title={settingsTitle} aria-live="off">
            {t(schedule.key, { ...schedule.params })}
          </span>
        )}
        {actionError !== null && <span className="infini-goal-error" role="alert">{actionError}</span>}
        <div className="infini-goal-actions">
          {active ? (
            <button
              type="button"
              className="infini-goal-button"
              disabled={pending}
              onClick={pause}
              aria-label={t('action.pause')}
              title={t('action.pause')}
            >
              <IconPauseOutlineRegular size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="infini-goal-button"
              disabled={pending}
              onClick={resume}
              aria-label={t('action.resume')}
              title={t('action.resume')}
            >
              <IconPlayOutlineRegular size={14} />
            </button>
          )}
          <button
            type="button"
            className="infini-goal-button"
            disabled={pending}
            onClick={clear}
            aria-label={t('action.clear')}
            title={t('action.clear')}
          >
            <IconTrashOutlineRegular size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
