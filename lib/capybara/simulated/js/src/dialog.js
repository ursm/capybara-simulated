// The dialog element (HTML §4.11.4), the bindings' share: HTMLDialogElement's members, as dom-class-aliases.js installs
// them with the generated binding, and the exceptions they throw; the write of a dialog's `open` attribute its
// algorithms make. show() and "show a modal dialog", "close the dialog", "request to close the dialog", its command steps,
// its focusing steps, its open dialogs list and its close watcher are the engine's (dialogs.rs, close_watchers.rs), which
// fires the events through the host steps (`fireToggleEvent`, `fireSimpleEvent`).

import { hostSteps, dom } from './engine.js';
import { DOMException } from './dom-exception.js';
import { removeAttribute, setAttribute } from './dom-nodes.js';

// What show() and showModal() refuse, by the engine's codes (dialogs.rs): open as the other kind, not connected, showing
// as a popover, of a document not fully active — an InvalidStateError each (Chrome's messages).
function shown(code, modal) {
  if (!code) return;
  const method = modal ? 'showModal' : 'show';
  const message = code === 1 ? `The dialog is already open as a ${modal ? 'non-modal' : 'modal'} dialog, and therefore cannot be opened as a ${modal ? 'modal' : 'non-modal'} dialog.`
    : code === 2 ? 'The element is not in a Document.'
    : code === 3 ? 'The dialog is already open as a Popover, and therefore cannot be opened as a modal dialog.'
    : 'Invalid for dialogs within documents that are not fully active.';
  throw new DOMException(`Failed to execute '${method}' on 'HTMLDialogElement': ${message}`, 'InvalidStateError');
}

// The `open` attribute an algorithm of the engine's adds (empty) or removes — its attribute change steps (attributes.rs)
// running the dialog's setup or cleanup steps.
hostSteps.setDialogOpen = (dialog, open) => {
  if (open) setAttribute(dialog, 'open', '');
  else removeAttribute(dialog, 'open');
};

export const htmlDialogElementMembers = {
  get_returnValue: (dialog) => dom.dialogReturnValue(dialog),
  set_returnValue(dialog, value) { dom.dialogReturnValue(dialog, value); },
  get_closedBy: (dialog) => dom.dialogClosedBy(dialog),
  show: (dialog) => shown(dom.dialogShow(dialog, false), false),
  showModal: (dialog) => shown(dom.dialogShow(dialog, true), true),
  // (…its result the argument — none when it is left out)
  close(dialog, returnValue) { dom.dialogClose(dialog, returnValue ?? null); },
  requestClose(dialog, returnValue) { dom.dialogRequestClose(dialog, returnValue ?? null); }
};
