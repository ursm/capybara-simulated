// The popover API's algorithms (HTML §6.12), the bindings' share: "show popover" and "hide popover" fire their
// `beforetoggle` events, set `:popover-open` and queue the `toggle`; which popovers an auto one's showing, hiding, a
// modal dialog, a light dismiss and a close request hide is the engine's — the document's showing auto popover list
// (popovers.rs) — each hidden here, the topmost first, the list read again after each hide's events.

import { bumpStyleState } from './mutation-observer.js';
import { hasState, setStateBit, STATE_POPOVER_OPEN } from './native-query-shadow.js';
import { fireBeforeToggle, queueToggleTask } from './form-helpers.js';
import { NODE_DOC } from './constants.js';

// HTML "check popover validity", the engine's (popovers.rs `popoverCheck`): false where the popover already is as asked
// (shown, or hidden); a NotSupportedError for an element with no `popover`, an InvalidStateError for one disconnected or
// a modal `<dialog>`.
// (…`throws` false for an invoker's: a check that fails is then no exception, only a false — HTML's "check popover
// validity" with throwExceptions false)
const POPOVER_VALID = 0, POPOVER_AS_ASKED = 1, NOT_A_POPOVER = 2;
export function checkPopoverValidity(el, expectedToBeShowing, method, throws = true) {
  const check = globalThis.__dom.popoverCheck(el, expectedToBeShowing);
  if (check === POPOVER_VALID) return true;
  if (check === POPOVER_AS_ASKED || !throws) return false;
  if (check === NOT_A_POPOVER) {
    throw new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLElement': Not supported on elements that do not have a valid value for the 'popover' attribute.`, 'NotSupportedError');
  }
  throw new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLElement': Invalid on disconnected popover elements.`, 'InvalidStateError');
}

// The popovers in the middle of being shown or hidden (HTML's "popover showing or hiding" flag): a show or a hide of one
// begun from inside its own — a listener's — is nested, and fires no events for what it hides.
const changing = new WeakSet();
// The lists a popover is kept on (popovers.rs `popoverKind`): auto, hint.
const AUTO = 1, HINT = 2;

// HTML "show popover": a cancelable `beforetoggle` first — which a listener cancels, or leaves it no longer valid to
// show — then the showing ones above its topmost popover ancestor (its nearest showing ancestor's, or its invoker's)
// hidden: for an auto popover every hint and the autos above its ancestor; for a hint the hints above its hint
// ancestor, else — where it is in an auto popover — everything above that one, else every hint, leaving the autos be.
// Then `:popover-open`, its place on top of its list, and a queued `toggle`. `source` the invoker that shows it, if one
// did — whose checks throw no exception.
export function showPopover(el, method, source = null) {
  const throws = source === null;
  if (!checkPopoverValidity(el, false, method, throws)) return;
  // (…one in the middle of being shown or hidden already — a listener of its own `beforetoggle` showing it — no popover
  // to show again: Chrome's InvalidStateError)
  if (changing.has(el)) {
    if (!throws) return;
    throw new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLElement': The popover is already being shown or hidden.`, 'InvalidStateError');
  }
  changing.add(el);
  try {
    if (!fireBeforeToggle(el, true, source) || !checkPopoverValidity(el, false, method, throws)) return;
    const kind = globalThis.__dom.popoverKind(el);
    if (kind !== 0) {
      const state = el._attrs.popover, doc = el.ownerDocument;
      if (kind === AUTO) {
        hideAllPopoversUntil(doc, globalThis.__dom.popoverAncestor(el, source, AUTO));
      } else {
        const hint = globalThis.__dom.popoverAncestor(el, source, HINT);
        const auto = hint ? null : globalThis.__dom.popoverAncestor(el, source, AUTO);
        if (hint) hidePopoverStackUntil(doc, hint, HINT, true);
        else if (auto) hideAllPopoversUntil(doc, auto);
        else hidePopoverStackUntil(doc, null, HINT, true);
      }
      // (…a listener of what that hid that changed its `popover` makes it no popover to show as it was asked)
      if (el._attrs.popover !== state) {
        if (!throws) return;
        throw new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLElement': The popover attribute changed while the popover was being shown.`, 'InvalidStateError');
      }
      if (!checkPopoverValidity(el, false, method, throws)) return;
    }
    setPopoverState(el, true, source);
    globalThis.__dom.popoverShown(el);
  } finally {
    changing.delete(el);
  }
}
// HTML "hide popover": an auto or hint popover's showing ones above it hidden first; then an uncancelable
// `beforetoggle`, then no `:popover-open`, off its list, and a queued `toggle` — no events for a hide nested in its own
// show or hide, or one asked for with none (`events`).
export function hidePopover(el, method, source = null, throws = source === null, events = true) {
  if (!checkPopoverValidity(el, true, method, throws)) return;
  const nested = changing.has(el);
  changing.add(el);
  if (nested) events = false;
  try {
    if (globalThis.__dom.popoverKind(el) !== 0) {
      hideAllPopoversUntil(el.ownerDocument, el, events);
      if (!checkPopoverValidity(el, true, method, throws)) return;
    }
    if (events) {
      fireBeforeToggle(el, false, source);
      if (!checkPopoverValidity(el, true, method, throws)) return;
    }
    setPopoverState(el, false, source);
    globalThis.__dom.popoverHidden(el);
  } finally {
    if (!nested) changing.delete(el);
  }
}
function setPopoverState(el, open, source = null) {
  setStateBit(el, STATE_POPOVER_OPEN, open);
  bumpStyleState();                                   // `:popover-open`, backed by no attribute
  queueToggleTask(el, open ? 'closed' : 'open', open ? 'open' : 'closed', source);
}

// HTML's `popover` attribute change steps: a showing popover whose attribute's state changed — auto, hint, manual (any
// other value), none — hidden, with its events.
const popoverState = (value) => {
  if (value == null) return 'none';
  const v = String(value).toLowerCase();
  return v === '' || v === 'auto' ? 'auto' : v === 'hint' ? 'hint' : 'manual';
};
// (…one whose attribute is gone no popover to hide as one: it stops showing, quietly — Chrome)
export function popoverAttributeChanged(el, old, next) {
  if (!hasState(el, STATE_POPOVER_OPEN) || popoverState(old) === popoverState(next)) return;
  if (next == null) {
    setPopoverState(el, false);
    globalThis.__dom.popoverHidden(el);
  } else {
    hidePopover(el, 'hidePopover', null, false);
  }
}

// HTML "hide all popovers until": the showing popovers of `doc` above `endpoint` hidden — for none, every hint then every
// auto; for a hint, the hints above it; for an auto, every hint then the autos above it — none where `endpoint` shows
// no more.
export function hideAllPopoversUntil(doc, endpoint, events = true) {
  if (!doc || (endpoint && !hasState(endpoint, STATE_POPOVER_OPEN))) return;
  if (endpoint && globalThis.__dom.popoverKind(endpoint) === HINT) {
    hidePopoverStackUntil(doc, endpoint, HINT, events);
    return;
  }
  hidePopoverStackUntil(doc, null, HINT, events);
  hidePopoverStackUntil(doc, endpoint, AUTO, events);
}
// HTML "hide popover stack until": the showing popovers of `doc`'s `kind` list above `endpoint` — all of them, for none —
// hidden, the topmost first, the list read again after each (its events may show or hide others); one its events kept
// showing stops it.
function hidePopoverStackUntil(doc, endpoint, kind, events) {
  for (;;) {
    const top = globalThis.__dom.popoverTopmost(endpoint || doc, kind);
    if (!top || top === endpoint) return;
    hidePopover(top, 'hidePopover', null, false, events);
    if (hasState(top, STATE_POPOVER_OPEN)) return;
  }
}

// HTML "light dismiss open popovers", for a user's `pointerdown` / `pointerup`: a press and release on the same
// topmost clicked popover (the showing one the target is in, or its invoker's) hide the ones above it — all of them for
// a press outside them all.
export function lightDismissOpenPopovers(event, target) {
  const doc = target && (target._nodeType === NODE_DOC ? target : target.ownerDocument);
  if (!doc || !globalThis.__dom.popoverTopmost(doc, 0)) return;
  const clicked = target._nodeType === NODE_DOC ? null : globalThis.__dom.popoverClicked(target);
  if (event.type === 'pointerdown') { doc._popoverPointerdownTarget = clicked; return; }
  const same = clicked === doc._popoverPointerdownTarget;
  doc._popoverPointerdownTarget = null;
  if (same) hideAllPopoversUntil(doc, clicked);
}

// A close request (the Escape key) to the topmost showing popover of `doc`, where its close watcher is newer than
// the open dialogs' (popovers.rs `closeRequestTarget`): it hides — whether the request went to it, else it is the
// dialogs'.
const CLOSE_POPOVER = 1;
export function closeTopmostPopover(doc) {
  if (!doc || globalThis.__dom.closeRequestTarget(doc) !== CLOSE_POPOVER) return false;
  hidePopover(globalThis.__dom.popoverTopmost(doc, 0), 'hidePopover', null, false);
  return true;
}
