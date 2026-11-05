/** Protocol constants shared by every infini-goal plugin package. */

/** Session-projection key carrying the current durable goal to the browser. */
export const INFINI_GOAL_PROJECTION_KEY = 'infiniGoal'

/** Session event type carrying one durable full-snapshot mutation or clear tombstone. */
export const INFINI_GOAL_EVENT_TYPE = 'infini-goal/change'

/** Version of the durable change payload carried by {@link INFINI_GOAL_EVENT_TYPE}. */
export const INFINI_GOAL_CHANGE_VERSION = 1

/** Model message source kind attributed to an admitted automatic round. */
export const INFINI_GOAL_MESSAGE_KIND = 'infini-goal'

/** Cordis event emitted after one durable goal mutation commits. */
export const INFINI_GOAL_CHANGED_EVENT = 'infini-goal/changed'

/** Slash command name (without the leading slash). */
export const INFINI_GOAL_COMMAND_NAME = 'infini-goal'

/** Default minimum delay between two automatic round starts (one minute). */
export const DEFAULT_MIN_INTERVAL_MS = 60_000

/** Hard lower bound of any configured minimum trigger interval (one second). */
export const MIN_MIN_INTERVAL_MS = 1_000

/** Hard upper bound of any configured minimum trigger interval (30 days). */
export const MAX_MIN_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000

/** Default process-start behavior for an already-active durable goal. */
export const DEFAULT_AUTO_CONTINUE_ON_START = true
