// The popover API's algorithms (HTML §6.12), the bindings' share: "show popover" and "hide popover" fire their
// `beforetoggle` events, set `:popover-open` and queue the `toggle`; which popovers an auto one's showing, hiding, a
// modal dialog, a light dismiss and a close request hide is the engine's — the document's showing auto popover list
// (popovers.rs) — each hidden here, the topmost first, the list read again after each hide's events.

import { bumpStyleState } from './mutation-observer.js';
import { hasState, setStateBit, STATE_MODAL, STATE_POPOVER_OPEN } from './native-query-shadow.js';
import { fireBeforeToggle, queueToggleTask } from './form-helpers.js';
import { isConnected } from './walk.js';
import { HTML_NS, NODE_DOC } from './constants.js';

// HTML "check popover validity": false where the popover already is as asked (shown, or hidden); a NotSupportedError
// for an element with no `popover`, an InvalidStateError for one disconnected or an open `<dialog>`.
// (…`throws` false for an invoker's: a check that fails is then no exception, only a false — HTML's "check popover
// validity" with throwExceptions false)
export function checkPopoverValidity(el, expectedToBeShowing, method, throws = true) {
  if (el._attrs.popover == null) {
    if (!throws) return false;
    throw new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLElement': Not supported on elements that do not have a valid value for the 'popover' attribute.`, 'NotSupportedError');
  }
  if (hasState(el, STATE_POPOVER_OPEN) !== expectedToBeShowing) return false;
  if (!isConnected(el) || (el._localName === 'dialog' && el._ns === HTML_NS && hasState(el, STATE_MODAL))) {
    if (!throws) return false;
    throw new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLElement': Invalid on disconnected popover elements.`, 'InvalidStateError');
  }
  return true;
}

// HTML "show popover": a cancelable `beforetoggle` first — which a listener cancels, or leaves it no longer valid to
// show — then, for an auto popover, the showing ones above its topmost popover ancestor (its nearest showing ancestor's,
// or its invoker's) hidden; then `:popover-open`, its place on top of the list, and a queued `toggle`. `source` the
// invoker that shows it, if one did — whose checks throw no exception.
export function showPopover(el, method, source = null) {
  const throws = source === null;
  if (!checkPopoverValidity(el, false, method, throws)) return;
  if (!fireBeforeToggle(el, true, source) || !checkPopoverValidity(el, false, method, throws)) return;
  if (globalThis.__dom.popoverAuto(el)) {
    const state = el._attrs.popover;
    hideAllPopoversUntil(el.ownerDocument, globalThis.__dom.popoverAncestor(el, source));
    // (…a listener of what that hid that changed its `popover` makes it no popover to show as it was asked)
    if (el._attrs.popover !== state) {
      if (!throws) return;
      throw new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLElement': The popover attribute changed while the popover was being shown.`, 'InvalidStateError');
    }
    if (!checkPopoverValidity(el, false, method, throws)) return;
  }
  setPopoverState(el, true, source);
  globalThis.__dom.popoverShown(el);
}
// HTML "hide popover": an auto popover's showing ones above it hidden first; then an uncancelable `beforetoggle`, then
// no `:popover-open`, off the list, and a queued `toggle`.
export function hidePopover(el, method, source = null, throws = source === null) {
  if (!checkPopoverValidity(el, true, method, throws)) return;
  if (globalThis.__dom.popoverAuto(el)) {
    hideAllPopoversUntil(el.ownerDocument, el);
    if (!checkPopoverValidity(el, true, method, throws)) return;
  }
  fireBeforeToggle(el, false, source);
  if (!checkPopoverValidity(el, true, method, throws)) return;
  setPopoverState(el, false, source);
  globalThis.__dom.popoverHidden(el);
}
function setPopoverState(el, open, source = null) {
  setStateBit(el, STATE_POPOVER_OPEN, open);
  bumpStyleState();                                   // `:popover-open`, backed by no attribute
  queueToggleTask(el, open ? 'closed' : 'open', open ? 'open' : 'closed', source);
}

// HTML "hide all popovers until": the showing auto popovers of `doc` above `endpoint` — all of them, for none — hidden,
// the topmost first, the list read again after each (its events may show or hide others); none where `endpoint` shows
// no more.
export function hideAllPopoversUntil(doc, endpoint) {
  if (!doc || (endpoint && !hasState(endpoint, STATE_POPOVER_OPEN))) return;
  for (;;) {
    const top = globalThis.__dom.popoverTopmost(endpoint || doc);
    if (!top || top === endpoint) return;
    hidePopover(top, 'hidePopover', null, false);
    // (…one its events kept showing is the list's still: hidden no further)
    if (hasState(top, STATE_POPOVER_OPEN)) return;
  }
}

// HTML "light dismiss open popovers", for a user's `pointerdown` / `pointerup`: a press and release on the same
// topmost clicked popover (the showing one the target is in, or its invoker's) hide the ones above it — all of them for
// a press outside them all.
export function lightDismissOpenPopovers(event, target) {
  const doc = target && (target._nodeType === NODE_DOC ? target : target.ownerDocument);
  if (!doc || !globalThis.__dom.popoverTopmost(doc)) return;
  const clicked = target._nodeType === NODE_DOC ? null : globalThis.__dom.popoverClicked(target);
  if (event.type === 'pointerdown') { doc._popoverPointerdownTarget = clicked; return; }
  const same = clicked === doc._popoverPointerdownTarget;
  doc._popoverPointerdownTarget = null;
  if (same) hideAllPopoversUntil(doc, clicked);
}

// A close request (the Escape key) to the topmost showing auto popover of `doc`, where its close watcher is newer than
// the open dialogs' (popovers.rs `closeRequestTarget`): it hides — whether the request went to it, else it is the
// dialogs'.
const CLOSE_POPOVER = 1;
export function closeTopmostPopover(doc) {
  if (!doc || globalThis.__dom.closeRequestTarget(doc) !== CLOSE_POPOVER) return false;
  hidePopover(globalThis.__dom.popoverTopmost(doc), 'hidePopover', null, false);
  return true;
}
