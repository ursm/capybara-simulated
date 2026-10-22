// `window.alert` / `confirm` / `prompt` route through
// `__modalDialog` (Ruby host fn). The Ruby side checks the active
// `accept_modal` / `dismiss_modal` handler stack and returns
// whatever the handler produced — true/false for confirm, the
// response string for prompt, null for alert.
import { logError } from './console.js';

// HTML "cannot show simple dialogs" (and `print()`'s step 1): a document sandboxed against modals — no `allow-modals`,
// the engine's (realm_location.rs `modalsSandboxed`) — shows none, the call ignored and said so, in Chrome's words
// (measured).
function modalRefused(name) {
  if (!globalThis.__dom.modalsSandboxed()) return false;
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
