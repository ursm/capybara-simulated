// `window.alert` / `confirm` / `prompt` route through
// `__modalDialog` (Ruby host fn). The Ruby side checks the active
// `accept_modal` / `dismiss_modal` handler stack and returns
// whatever the handler produced — true/false for confirm, the
// response string for prompt, null for alert.
import { logError } from './console.js';
import { SANDBOXED_MODALS, sandboxed } from './document-origin.js';

// HTML "cannot show simple dialogs" (and `print()`'s step 1): a document sandboxed against modals — no `allow-modals`,
// the engine's (realm_location.rs `sandboxed`) — shows none, the call ignored and said so, in Chrome's words
// (measured).
// (…none either while the document is being unloaded, or asked whether it may be: HTML's dialogs return while its unload
// counter is above 0 — Chrome's "Blocked alert() during unload")
function modalRefused(name) {
  if (globalThis.__dom.unloading(globalThis.__csimRealmId())) {
    logError(`Blocked ${name}() during unload.`);
    return true;
  }
  if (!sandboxed(SANDBOXED_MODALS)) return false;
  logError(`Ignored call to '${name}()'. The document is sandboxed, and the 'allow-modals' keyword is not set.`);
  return true;
}

export function alert(message) {
  if (modalRefused('alert')) return;
  globalThis.__modalDialog('alert', String(message == null ? '' : message), null);
}

export function confirm(message) {
  if (modalRefused('confirm')) return false;
  return !!globalThis.__modalDialog('confirm', String(message == null ? '' : message), null);
}

export function prompt(message, def) {
  if (modalRefused('prompt')) return null;
  return globalThis.__modalDialog('prompt', String(message == null ? '' : message),
                                  def == null ? '' : String(def));
}

// `print()` — which prints nothing here, but says so where a sandbox refuses it.
export function print() {
  modalRefused('print');
}
