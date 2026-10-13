// The dialog element (HTML §4.11.4): HTMLDialogElement's members, as dom-class-aliases.js installs them with the
// generated binding; "close the dialog", which a `method=dialog` form submission runs too; a close request (the
// Escape key) and light dismiss, which close the dialog last opened where its `closedby` lets them. Its open state is its
// `open` attribute; its modal-ness the arena's state bit (`:modal`); its return value a string of its own; where it is
// among the open dialogs, its document's list.

import { Event, eventState } from './events.js';
import { fireEvent } from './dispatch.js';
import { queueTask } from './timers.js';
import { flatTreeParent, isConnected } from './walk.js';
import { styleEngineDialogFocusingSteps } from './cascade.js';
import { autofocusProcessed } from './autofocus.js';
import { bumpStyleState } from './mutation-observer.js';
import { hasState, setStateBit, STATE_MODAL } from './native-query-shadow.js';
import { fireBeforeToggle, queueToggleTask } from './form-helpers.js';
import { hideAllPopoversUntil } from './popover.js';
import { HTML_NS, NODE_DOC, NODE_ELEMENT } from './constants.js';

const isOpen = (dialog) => dialog._attrs.open != null;
const isDialog = (node) => node._nodeType === NODE_ELEMENT && node._tag === 'dialog' && node._ns === HTML_NS;
const invalidState = (method, message) =>
  new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLDialogElement': ${message}`, 'InvalidStateError');

// HTML "close the dialog": a dialog that is not open stays as it is; an open one fires its (uncancelable)
// `beforetoggle` and queues its `toggle`, loses `open` and modal-ness (:modal), takes the result as its returnValue
// unless it is null, gives focus back to the element focused as it opened where it was modal or holds focus, and queues
// a task that fires `close` (as Chrome and Firefox do). Turbo's `confirm` flow waits on
// it and reads `dialog.returnValue` to decide whether to proceed.
export function closeDialog(dialog, result, source = null) {
  if (!dialog || dialog._tag !== 'dialog' || !isOpen(dialog)) return;
  fireBeforeToggle(dialog, false, source);
  if (!isOpen(dialog)) return;
  queueToggleTask(dialog, 'open', 'closed', source);
  // (…its `open` removed, which takes it off the open dialogs: its attribute change steps)
  dialog._removeAttribute('open');
  const wasModal = hasState(dialog, STATE_MODAL);
  if (wasModal) {
    bumpStyleState();
    setStateBit(dialog, STATE_MODAL, false);
  }
  if (result != null) globalThis.__dom.dialogReturnValue(dialog, result);
  if (dialog._nid != null) globalThis.__dom.dialogFocusRestore(dialog._nid, wasModal)?.[0]?._focus();
  queueTask(() => {
    try { fireEvent(dialog, new Event('close', { bubbles: false, cancelable: false })); } catch (_) {}
  }, 0);
}

// The `closedby` attribute's state's keyword, the engine's (dialogs.rs `dialogClosedBy`): a missing or invalid one is
// the Auto state, whose keyword is the one it computes — a modal dialog closes on a close request, any other on none.
const closedBy = (dialog) => globalThis.__dom.dialogClosedBy(dialog);

// A document's open dialogs list (HTML §4.11.4), in the order they opened: a dialog's `open` attribute set — by show(),
// showModal(), a script's, a parser's or a clone's — adds it; closing it, its `open` attribute removed, and its removal
// from the tree (its removing steps) take it out. The close requests and light dismiss go to its last — a connected one.
// The list is the engine's (dialogs.rs), by the document's slot: a dialog goes on it as it opens connected, or is
// connected open (HTML "dialog setup steps"), with its close watcher in a group of its own where the window has had a
// user activation since the last group was made (`__csimUserActivations`: a user's activation-triggering input event
// counts, dispatch.js `activationNotification`, and `test_driver.bless`) — its document's window's, whichever realm's
// script showed it.
export function dialogOpened(dialog) {
  const doc = dialog._ownerDocument;
  if (!doc || !isConnected(dialog)) return;
  let activations = 0;
  try { activations = doc.defaultView?.__csimUserActivations | 0; } catch (_) {}
  globalThis.__dom.dialogOpened(doc._nid, dialog._nid, activations);
}
export function dialogClosed(dialog) {
  globalThis.__dom.dialogClosed(dialog._nid);
}
// (…an entry connected in another document's tree — one that moved there — dropped as it is met)
function topmostDialog(doc) {
  return globalThis.__dom.topmostDialog(doc._nid);
}

// HTML "process close watchers", for a document's dialogs: the dialog opened last gets the close request where its
// `closedby` takes one — a cancelable `cancel` first (the request is a user's), which a listener cancels to keep it
// open; else it closes. One whose `closedby` is none keeps it, and the dialogs under it, open.
// (…HTML "process close watchers": the last group's, the last first — one whose `closedby` is none passes it on, a
// cancel a listener cancels stops it)
export function closeRequest(doc) {
  for (const dialog of globalThis.__dom.closeWatcherGroup(doc._nid)) {
    if (closedBy(dialog) === 'none') continue;
    if (!requestClose(dialog, null)) return;
  }
}

// HTML "light dismiss open dialogs", for a user's `pointerdown` / `pointerup`: a press and release on the same dialog —
// the nearest open one the target is in, none for one outside them all or on a dialog's backdrop — that is not the
// dialog opened last closes that one, where its `closedby` is any.
export function lightDismissOpenDialogs(event, target) {
  const doc = target && (target._nodeType === NODE_DOC ? target : target.ownerDocument);
  if (!doc || topmostDialog(doc) === null) return;
  const clicked = nearestClickedDialog(event, target);
  if (eventState(event).type === 'pointerdown') { doc._dialogPointerdownTarget = clicked; return; }
  const same = clicked === doc._dialogPointerdownTarget;
  doc._dialogPointerdownTarget = null;
  if (!same) return;
  const topmost = topmostDialog(doc);
  if (topmost && topmost !== clicked && closedBy(topmost) === 'any') requestClose(topmost, null);
}
// (…the open dialog the event's target is in — a modal dialog itself only where the point is within its box, else its
// backdrop's)
function nearestClickedDialog(event, target) {
  if (isDialog(target) && isOpen(target) && hasState(target, STATE_MODAL)) {
    const r = target.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  }
  for (let node = target; node; node = flatTreeParent(node)) if (isDialog(node) && isOpen(node)) return node;
  return null;
}

// HTML's requestClose(): an open dialog's close request, whatever its `closedby` — a cancelable `cancel` first, which a
// listener cancels to keep it open; else it closes with the result given.
// (…whether it was not cancelled)
function requestClose(dialog, returnValue, source = null) {
  if (!isOpen(dialog)) return true;
  const watcher = globalThis.__dom.closeWatcherOf(dialog);
  const cancel = new Event('cancel', { bubbles: false, cancelable: true });
  fireEvent(dialog, cancel);
  if (cancel.defaultPrevented) return false;
  // (…a listener that took it out of its document destroyed its close watcher — its removing steps — which a request
  // to close then no longer closes, whatever watcher a re-insertion gave it: HTML "request to close", Chrome)
  if (!isConnected(dialog) || globalThis.__dom.closeWatcherOf(dialog) !== watcher) return true;
  closeDialog(dialog, returnValue, source);
  return true;
}
// What show() and showModal() may do with a dialog, the engine's to say (dialogs.rs `dialogShowCheck`): show it; nothing,
// open already as it would be shown; or refuse, an InvalidStateError — open as the other kind, not connected (a modal
// one), showing as a popover (a modal one) — each with its message.
const SHOW = 0, SHOWN = 1, OPEN_AS_OTHER = 2, NOT_CONNECTED = 3;
// (…whether to go on showing it: false for one shown already as it would be, an InvalidStateError for one it refuses)
function mayShow(dialog, modal) {
  const check = globalThis.__dom.dialogShowCheck(dialog, modal);
  if (check === SHOW || check === SHOWN) return check === SHOW;
  throw invalidState(modal ? 'showModal' : 'show',
    check === OPEN_AS_OTHER ? `The dialog is already open as a ${modal ? 'non-modal' : 'modal'} dialog, and therefore cannot be opened as a ${modal ? 'modal' : 'non-modal'} dialog.`
      : check === NOT_CONNECTED ? 'The element is not in a Document.'
      : 'The dialog is already open as a Popover, and therefore cannot be opened as a modal dialog.');
}
// HTML's "show a modal dialog": an open one of the same kind left as it is, of the other kind an InvalidStateError, as
// a disconnected one or one showing as a popover; a cancelable `beforetoggle` first, which a listener cancels — or
// answers by opening it itself, or leaving it no dialog to show — then its `toggle` queued, `open` set and modal-ness.
// `source` the invoker, if one.
function showModal(dialog, source = null) {
  if (!mayShow(dialog, true)) return;
  if (!fireBeforeToggle(dialog, true, source) || globalThis.__dom.dialogShowCheck(dialog, true) !== SHOW) return;
  queueToggleTask(dialog, 'closed', 'open', source);
  dialog._setAttribute('open', '');
  // Modal-ness is internal state (`:modal`), distinct from the `open` content attribute that show() also sets. An
  // atomic move (moveBefore) preserves it because the same element object is relocated.
  if (!hasState(dialog, STATE_MODAL)) bumpStyleState();
  setStateBit(dialog, STATE_MODAL, true);
  hidePopoversBelow(dialog);
  dialogFocusingSteps(dialog);
}
// The showing popovers hidden as a dialog opens — down to one the dialog is in, which stays: HTML's "hide all popovers
// until" its topmost popover ancestor, else the document (show() and showModal() alike).
function hidePopoversBelow(dialog) {
  const doc = dialog.ownerDocument;
  hideAllPopoversUntil(doc, globalThis.__dom.popoverAncestor(dialog, null, 2) ?? globalThis.__dom.popoverAncestor(dialog, null, 1));
}
// The focus a dialog takes as it opens: the element focused before it is kept, for closing it to give focus back to,
// and HTML's "dialog focusing steps" run — the dialog itself where it carries `autofocus`, else its focus delegate (its
// first `autofocus` descendant that can take focus, else its first that can), else the dialog — and the top-level
// document's autofocus is processed: no candidate takes focus from it after.
function dialogFocusingSteps(dialog) {
  styleEngineDialogFocusingSteps(dialog)._focus();
  autofocusProcessed(dialog.ownerDocument);
}

// A dialog's command steps (HTML §4.11.4), for a command invoker's built-in command: `show-modal` a closed one shows
// modally, `close` and `request-close` an open one closes, its result the invoker's value (or none).
export function dialogCommandSteps(dialog, command, invoker) {
  const result = invoker._attrs.value ?? null;
  if (command === 'show-modal') {
    if (globalThis.__dom.dialogShowCheck(dialog, true) === SHOW) showModal(dialog, invoker);
  } else if (isOpen(dialog)) {
    if (command === 'close') closeDialog(dialog, result, invoker);
    else requestClose(dialog, result, invoker);
  }
}

export const htmlDialogElementMembers = {
  get_returnValue: (dialog) => globalThis.__dom.dialogReturnValue(dialog),
  set_returnValue(dialog, value) { globalThis.__dom.dialogReturnValue(dialog, value); },
  get_closedBy: closedBy,
  // HTML's show() and showModal(): an open dialog of the other kind an InvalidStateError (one of the same kind left as
  // it is); a cancelable `beforetoggle` first, which a listener cancels — or answers by opening it itself — then its
  // `toggle` queued and `open` set; a modal one also connected and no showing popover.
  show(dialog) {
    if (!mayShow(dialog, false)) return;
    if (!fireBeforeToggle(dialog, true) || globalThis.__dom.dialogShowCheck(dialog, false) !== SHOW) return;
    queueToggleTask(dialog, 'closed', 'open');
    dialog._setAttribute('open', '');
    hidePopoversBelow(dialog);
    dialogFocusingSteps(dialog);
  },
  showModal: (dialog) => showModal(dialog),
  // (…its result the argument — none when it is left out)
  close(dialog, returnValue) {
    closeDialog(dialog, returnValue ?? null);
  },
  requestClose(dialog, returnValue) {
    requestClose(dialog, returnValue ?? null);
  }
};
