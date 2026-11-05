/**
 * Infini-goal surface plugin, browser half: the `conversation.input.dock`
 * entry carrying the InfiniGoalBar strip.
 *
 * The durable goal arrives through `useProjection('infiniGoal')` (the host
 * pushes it from the Session log); lifecycle mutations ride the Host
 * `/infini-goal` command executor. This plugin therefore ships no Remote API of
 * its own — the injected face only binds the command submission to the dock's
 * Session identity.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Client Remote merge (ctx.remote, ctx.remote.commands) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the Client Session Controller service (ctx.sessions) into this program.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Conversation service and the `conversation.input.dock` declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard kit (`useProjection` seat) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import { InfiniGoalDock, type InfiniGoalDockInjected } from './InfiniGoalBar.tsx'
import { en, zh, type InfiniGoalKey } from './locales.ts'
import { ensureStyleTag } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The infini-goal strip's copy. */
    infiniGoal: InfiniGoalKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'infiniGoal'

/** Required services: slot registration, Session scope, Remote commands, and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']

/**
 * Client plugin body: dictionaries, the plugin stylesheet, and the InfiniGoalBar
 * dock entry with its command-admission face.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'infini-goal: dictionaries')
  ctx.effect(() => ensureStyleTag(), 'infini-goal: styles')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'infini-goal',
    order: 11,
    locale: NS,
    inject: (sessionId: SessionIdOf): InfiniGoalDockInjected => ({
      executeCommand: line => ctx.remote.commands.execute(sessionId, line, []),
    }),
  }, InfiniGoalDock))
}
