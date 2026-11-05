/**
 * Browser half of the trivial E2E fixture plugin.
 *
 * `@deepseek-ai/dsh-client-modules` serves a package's `exports["./client"]`
 * file verbatim and expects the lazy-CJS registration protocol below: running
 * the script only registers a factory under the package name, and the module
 * body runs when the browser module system materializes it. This hand-written
 * bundle proves a plugin inserted by absolute filesystem path can reach the
 * browser boot graph and execute in the page, without a build step.
 *
 * Observable evidence for the harness:
 *   - `window.__DSH_BOOT__.entries` contains the row `e2e-trivial-plugin`,
 *   - `window.__E2E_TRIVIAL_CLIENT__` is set to `true`, and
 *   - a hidden `#e2e-trivial-client-marker` element is appended to the DOM.
 */
window.__ModuleLoader__.load({
  id: 'e2e-trivial-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    exports.name = 'e2e-trivial-client'

    exports.apply = function apply() {
      globalThis.__E2E_TRIVIAL_CLIENT__ = true
      var doc = globalThis.document
      if (doc && doc.body && !doc.getElementById('e2e-trivial-client-marker')) {
        var marker = doc.createElement('div')
        marker.id = 'e2e-trivial-client-marker'
        marker.setAttribute('data-e2e-plugin', 'e2e-trivial-plugin')
        marker.style.display = 'none'
        marker.textContent = 'e2e-trivial-client loaded'
        doc.body.appendChild(marker)
      }
    }

    return module.exports
  },
})
