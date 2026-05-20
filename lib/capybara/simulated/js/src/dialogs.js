// `window.alert` / `confirm` / `prompt` route through
// `__modalDialog` (Ruby host fn). The Ruby side checks the active
// `accept_modal` / `dismiss_modal` handler stack and returns
// whatever the handler produced — true/false for confirm, the
// response string for prompt, null for alert.

export function alert(message) {
  globalThis.__modalDialog('alert', String(message == null ? '' : message), null);
}

export function confirm(message) {
  return !!globalThis.__modalDialog('confirm', String(message == null ? '' : message), null);
}

export function prompt(message, def) {
  return globalThis.__modalDialog('prompt', String(message == null ? '' : message),
                                  def == null ? '' : String(def));
}
