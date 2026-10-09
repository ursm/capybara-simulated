// The dialog element (HTML §4.11.4): HTMLDialogElement's members, as dom-class-aliases.js installs them with the
// generated binding; "close the dialog", which a `method=dialog` form submission runs too; and a close request (the
// Escape key), which closes the dialog last opened whose `closedby` lets one. Its open state is its `open` attribute;
// its modal-ness the arena's state bit (`:modal`); its return value a string of its own; when it opened, an order.

import { Event } from './events.js';
import { fireEvent } from './dispatch.js';
import { queueTask } from './timers.js';
import { flatTreeParent, isConnected } from './walk.js';
import { recordAttrMutation, bumpStyleState } from './mutation-observer.js';
import { hasState, setStateBit, STATE_MODAL, STATE_POPOVER_OPEN } from './native-query-shadow.js';
import { fireBeforeToggle, queueToggleTask } from './form-helpers.js';
import { asciiLower } from './ascii.js';
import { HTML_NS, NODE_DOC, NODE_ELEMENT } from './constants.js';
import { selectAll } from './selectors.js';

const isOpen = (dialog) => dialog._attrs.open != null;
const isDialog = (node) => node._nodeType === NODE_ELEMENT && node._tag === 'dialog' && node._ns === HTML_NS;
const invalidState = (method, message) =>
  new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLDialogElement': ${message}`, 'InvalidStateError');

// HTML "close the dialog": a dialog that is not open stays as it is; an open one fires its (uncancelable)
// `beforetoggle` and queues its `toggle`, loses `open` and modal-ness (:modal), takes the result as its returnValue
// unless it is null, and queues a task that fires `close` (as Chrome and Firefox do). Turbo's `confirm` flow waits on
// it and reads `dialog.returnValue` to decide whether to proceed.
export function closeDialog(dialog, result) {
  if (!dialog || dialog._tag !== 'dialog' || !isOpen(dialog)) return;
  fireBeforeToggle(dialog, false);
  if (!isOpen(dialog)) return;
  queueToggleTask(dialog, 'open', 'closed');
  const old = dialog._attrs.open;
  delete dialog._attrs.open;
  recordAttrMutation(dialog, 'open', old);
  if (hasState(dialog, STATE_MODAL)) {
    bumpStyleState();
    setStateBit(dialog, STATE_MODAL, false);
  }
  if (result != null) dialog._returnValue = result;
  queueTask(() => {
    try { fireEvent(dialog, new Event('close', { bubbles: false, cancelable: false })); } catch (_) {}
  }, 0);
}

// The `closedby` attribute's states, by keyword; a missing or invalid one is the Auto state.
const CLOSED_BY = new Set(['any', 'closerequest', 'none']);
// (…the keyword of its state — the Auto state's the one it computes: a modal dialog closes on a close request, any
// other on none)
function closedBy(dialog) {
  const value = dialog._attrs.closedby;
  const state = value == null ? null : asciiLower(value);
  if (CLOSED_BY.has(state)) return state;
  return hasState(dialog, STATE_MODAL) ? 'closerequest' : 'none';
}

// The order dialogs opened in: a dialog's `open` attribute set — by show(), showModal(), a script's or the parser's —
// stamps it, and a close request goes to the latest.
let openings = 0;
export function dialogOpened(dialog) {
  dialog._openedAt = ++openings;
  const doc = dialog.ownerDocument;
  if (doc) doc._dialogsOpened = true;
}
// A document's open dialogs, in the order they opened.
const openDialogs = (doc) => selectAll(doc, 'dialog[open]').filter((d) => d._openedAt !== undefined).sort((a, b) => a._openedAt - b._openedAt);

// HTML "process close watchers", for a document's dialogs: the dialog opened last gets the close request where its
// `closedby` takes one — a cancelable `cancel` first (the request is a user's), which a listener cancels to keep it
// open; else it closes. One whose `closedby` is none keeps it, and the dialogs under it, open.
export function closeRequest(doc) {
  const open = openDialogs(doc);
  const topmost = open[open.length - 1];
  if (topmost && closedBy(topmost) !== 'none') requestClose(topmost, null);
}

// HTML "light dismiss open dialogs", for a user's `pointerdown` / `pointerup`: a press and release on the same dialog —
// the nearest open one the target is in, none for one outside them all or on a dialog's backdrop — that is not the
// dialog opened last closes that one, where its `closedby` is any.
export function lightDismissOpenDialogs(event, target) {
  const doc = target && (target._nodeType === NODE_DOC ? target : target.ownerDocument);
  if (!doc || !doc._dialogsOpened) return;
  const clicked = nearestClickedDialog(event, target);
  if (event._type === 'pointerdown') { doc._dialogPointerdownTarget = clicked; return; }
  const same = clicked === doc._dialogPointerdownTarget;
  doc._dialogPointerdownTarget = null;
  if (!same) return;
  const open = openDialogs(doc);
  const topmost = open[open.length - 1];
  if (topmost && topmost !== clicked && closedBy(topmost) === 'any') requestClose(topmost, null);
}
// (…the open dialog the event's target is in — the dialog itself only where the point is within its box, else its
// backdrop's)
function nearestClickedDialog(event, target) {
  if (isDialog(target) && isOpen(target)) {
    const r = target.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  }
  for (let node = target; node; node = flatTreeParent(node)) if (isDialog(node) && isOpen(node)) return node;
  return null;
}

// HTML's requestClose(): an open dialog's close request, whatever its `closedby` — a cancelable `cancel` first, which a
// listener cancels to keep it open; else it closes with the result given.
function requestClose(dialog, returnValue) {
  if (!isOpen(dialog)) return;
  const cancel = new Event('cancel', { bubbles: false, cancelable: true });
  fireEvent(dialog, cancel);
  if (cancel.defaultPrevented) return;
  closeDialog(dialog, returnValue);
}

export const htmlDialogElementMembers = {
  get_returnValue: (dialog) => dialog._returnValue ?? '',
  set_returnValue(dialog, value) { dialog._returnValue = value; },
  get_closedBy: closedBy,
  // HTML's show() and showModal(): an open dialog of the other kind an InvalidStateError (one of the same kind left as
  // it is); a cancelable `beforetoggle` first, which a listener cancels — or answers by opening it itself — then its
  // `toggle` queued and `open` set; a modal one also connected and no showing popover.
  show(dialog) {
    if (isOpen(dialog) && !hasState(dialog, STATE_MODAL)) return;
    if (isOpen(dialog)) {
      throw invalidState('show', 'The dialog is already open as a modal dialog, and therefore cannot be opened as a non-modal dialog.');
    }
    if (!fireBeforeToggle(dialog, true) || isOpen(dialog)) return;
    queueToggleTask(dialog, 'closed', 'open');
    dialog._setAttribute('open', '');
  },
  showModal(dialog) {
    if (isOpen(dialog) && hasState(dialog, STATE_MODAL)) return;
    const invalid = isOpen(dialog) ? 'The dialog is already open as a non-modal dialog, and therefore cannot be opened as a modal dialog.'
      : !isConnected(dialog) ? 'The element is not in a Document.'
      : hasState(dialog, STATE_POPOVER_OPEN) ? 'The dialog is already open as a Popover, and therefore cannot be opened as a modal dialog.'
      : null;
    if (invalid) throw invalidState('showModal', invalid);
    if (!fireBeforeToggle(dialog, true) || isOpen(dialog) || !isConnected(dialog) || hasState(dialog, STATE_POPOVER_OPEN)) return;
    queueToggleTask(dialog, 'closed', 'open');
    dialog._setAttribute('open', '');
    // Modal-ness is internal state (`:modal`), distinct from the `open` content attribute that show() also sets. An
    // atomic move (moveBefore) preserves it because the same element object is relocated.
    if (!hasState(dialog, STATE_MODAL)) bumpStyleState();
    setStateBit(dialog, STATE_MODAL, true);
  },
  // (…its result the argument — none when it is left out)
  close(dialog, returnValue) {
    closeDialog(dialog, returnValue ?? null);
  },
  requestClose(dialog, returnValue) {
    requestClose(dialog, returnValue ?? null);
  }
};
