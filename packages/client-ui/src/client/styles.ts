/**
 * Plugin-owned CSS for the InfiniGoalBar dock.
 *
 * The package deliberately ships no CSS Modules build chain: `apply()` injects
 * this string once into `document.head` as a `<style data-plugin-css="infini-goal">`
 * tag. Class names are plain, globally unique hyphenated names. Colors lean on
 * the harness theme tokens (`--dsw-*` / `--dsh-*`) with neutral CSS fallbacks so
 * the strip follows light/dark themes, and degrades to readable browser colors
 * if a token is ever missing.
 */

/** Attribute marking this plugin's injected style tag. */
const STYLE_ATTRIBUTE = 'data-plugin-css'

/** Value of {@link STYLE_ATTRIBUTE} owned by this plugin. */
const STYLE_KEY = 'infini-goal'

/** Global stylesheet of the InfiniGoalBar dock. */
export const styles = `
.infini-goal-dock {
  box-sizing: border-box;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance, 16px) -
    var(--dsh-composer-side-clearance, 16px) -
    var(--dsh-composer-dock-inset, 4px) -
    var(--dsh-composer-dock-inset, 4px) -
    var(--dsh-composer-dock-inset, 4px) -
    var(--dsh-composer-dock-inset, 4px)
  );
  max-width: calc(var(--dsh-composer-card-max-width, 960px) - 4 * var(--dsh-composer-dock-inset, 4px));
  margin: 0 auto;
}

.infini-goal-bar {
  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  margin: 0 auto;
  padding: 4px 6px 4px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-specific-menu, Canvas);
  box-shadow: var(--dsw-elevation-panel, 0 1px 2px rgba(0, 0, 0, 0.08));
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 13px;
  line-height: 20px;
  font-family: inherit;
}

.infini-goal-glyph {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: var(--dsw-alias-label-tertiary, GrayText);
}

.infini-goal-label {
  flex: none;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, CanvasText);
  white-space: nowrap;
}

.infini-goal-objective {
  flex: 1 1 auto;
  min-width: 40px;
  overflow: hidden;
  color: var(--dsw-alias-label-primary-dimmed, rgba(127, 127, 127, 0.9));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.infini-goal-reason {
  flex: 0 1 auto;
  max-width: 30%;
  overflow: hidden;
  color: var(--dsw-alias-state-error-primary, #c0392b);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.infini-goal-rounds {
  flex: none;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.infini-goal-schedule {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-secondary, GrayText);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.infini-goal-error {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-state-error-primary, #c0392b);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.infini-goal-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
}

.infini-goal-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, GrayText);
  cursor: pointer;
}

@media (hover: hover) {
  .infini-goal-button:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16));
    color: var(--dsw-alias-label-secondary, GrayText);
  }
}

.infini-goal-button:focus-visible {
  outline: 2px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.5));
  outline-offset: 1px;
}

.infini-goal-button:disabled {
  opacity: 0.4;
  cursor: default;
}
`

/**
 * Inject the plugin stylesheet once, unless an instance already exists.
 *
 * The returned disposer removes only the tag this call created: a second
 * plugin instance (or a hot reload) leaves the existing tag alone.
 * @returns idempotent disposer removing the style tag, if it was created here.
 */
export function ensureStyleTag(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.head.querySelector(`style[${STYLE_ATTRIBUTE}="${STYLE_KEY}"]`)
  if (existing !== null) return () => {}
  const element = document.createElement('style')
  element.setAttribute(STYLE_ATTRIBUTE, STYLE_KEY)
  element.textContent = styles
  document.head.appendChild(element)
  return () => {
    element.remove()
  }
}
