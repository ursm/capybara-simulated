// The popover API (HTML §6.12), the bindings' share: HTMLElement's showPopover(), hidePopover() and togglePopover() and
// the exceptions they throw. "Show popover", "hide popover", the lists a popover is kept on, light dismiss and the
// invokers' steps are the engine's (popovers.rs), which fires `beforetoggle` and queues `toggle` through
// `hostSteps.fireToggleEvent` (form-helpers.js) and focuses through `hostSteps.focusingSteps` (dom-nodes.js).

import { hasState, STATE_POPOVER_OPEN } from './native-query-shadow.js';
import { DOMException } from './dom-exception.js';
import { dom } from './engine.js';

// What the engine's algorithms throw, by its codes (popovers.rs): no `popover`, a NotSupportedError; disconnected, of a
// document not fully active, moved to another document, a modal dialog, during another popover's show or hide, its
// `popover` changed as others were hidden — InvalidStateError (Chrome's messages).
const ERRORS = [
  null,
  ['NotSupportedError', 'Not supported on elements that are not popovers.'],
  ['InvalidStateError', 'Invalid on disconnected popover elements.'],
  ['InvalidStateError', 'Invalid for popovers within documents that are not fully active.'],
  ['InvalidStateError', 'Invalid when the document changes while showing or hiding a popover element.'],
  ['InvalidStateError', 'The dialog is already open as a dialog, and therefore cannot be opened as a popover.'],
  ['InvalidStateError', 'Invalid to show a popover during another show operation'],
  ['InvalidStateError', 'Invalid to show a popover during a hide operation'],
  ['InvalidStateError', 'The popover attribute changed while hiding other popovers.']
];
function ended(code, method) {
  if (!code) return;
  const error = ERRORS[code];
  throw new DOMException(`Failed to execute '${method}' on 'HTMLElement': ${error[1]}`, error[0]);
}

// HTMLElement's members: showPopover(options) — its `source` the invoker — hidePopover(), and togglePopover(options),
// the force a boolean's or the options' `force`, which answers whether it shows after.
export const showPopover = (el, options) => ended(dom.showPopover(el, options.source ?? null), 'showPopover');
export const hidePopover = (el) => ended(dom.hidePopover(el), 'hidePopover');
export function togglePopover(el, options) {
  const boolean = typeof options === 'boolean';
  const force = boolean ? options : options.force;
  ended(dom.togglePopover(el, force === undefined ? -1 : force ? 1 : 0, boolean ? null : options.source ?? null), 'togglePopover');
  return hasState(el, STATE_POPOVER_OPEN);
}

// An invoker's popover shown, hidden or toggled by its action: HTML "popover target attribute activation behavior" and a
// popover's command steps (popovers.rs `popoverTargetSteps`).
const ACTIONS = { __proto__: null, toggle: 0, show: 1, hide: 2 };
export const popoverTargetSteps = (popover, action, invoker) => dom.popoverTargetSteps(popover, ACTIONS[action] ?? 0, invoker);
