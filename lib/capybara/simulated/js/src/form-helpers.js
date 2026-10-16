// Form-control helpers shared between Element class methods and the
// form-field mutation block (send_keys / set / select). Pure
// node-shape queries plus the toggle tasks and `beforetoggle`.

import { NODE_ELEMENT } from './constants.js';
import { ToggleEvent, eventState } from './events.js';
import { bumpSettleGen, bumpStyleState, engineWritten } from './mutation-observer.js';
import { fireEvent } from './dispatch.js';
import { cancelTask, queueTask } from './timers.js';
import {
  hasState, htmlAncestorOf, markShownText, setStateBit, actuallyDisabledOf, typeIntoValue, editValue, TYPE_AT_CARET, TYPED_LENGTH_SHIFT,
  STATE_USER_INTERACTED, TYPED_VALUE, TYPED_SELECTION
} from './native-query-shadow.js';

// HTML's details, popover and dialog toggle tasks: a `toggle` ToggleEvent from the state before a run of changes to the state
// after it, fired from a task — one for the run, a change while one is pending updating its new state (the toggle task
// tracker), so open-then-close fires closed → closed. `source` the invoker that made the change, if one did.
// (…the tracker the engine's: toggle_tasks.rs)
export function queueToggleTask(el, oldState, newState, source = null) {
  const pending = globalThis.__dom.toggleTask(el._nid);
  if (pending) {
    // (…its task removed and a new one queued, keeping the old state: behind whatever was queued since)
    cancelTask(pending[0]);
    oldState = pending[1] ? 'open' : 'closed';
  }
  const key = queueTask(() => {
    globalThis.__dom.setToggleTask(el._nid, null, false);
    try { fireEvent(el, new ToggleEvent('toggle', { oldState, newState, source })); } catch (_) {}
  }, 0);
  globalThis.__dom.setToggleTask(el._nid, key, oldState === 'open');
}
// …and the `beforetoggle` before a popover's or a dialog's change, from its state to the other: cancelable when it
// opens.
export function fireBeforeToggle(el, opening, source = null) {
  const ev = new ToggleEvent('beforetoggle', {
    cancelable: opening, oldState: opening ? 'closed' : 'open', newState: opening ? 'open' : 'closed', source
  });
  fireEvent(el, ev);
  return !eventState(ev).canceled;
}

// Labels (HTML §4.10.4), the engine's (element_state.rs): whether an element is labelable — a button, an input but a
// hidden one, a meter, output, progress, select or textarea, or a form-associated custom element; a label's labeled
// control — its `for` id's element in its tree where that is labelable, else its first labelable descendant.
export const isLabelableControl = (n) => globalThis.__dom.isLabelable(n._nid);
export const labeledControlFor = (label) => globalThis.__dom.labeledControl(label._nid)[0] ?? null;
// …and a labelable element's labels, in tree order.
export const labelsFor = (control) => globalThis.__dom.labelsOf(control._nid);

// `n`'s editing host — itself or its nearest ancestor element whose `contenteditable` is in the true or plaintext-only
// state, none where the nearest one that says is false — or null: the engine's (element_state.rs `editing_host`), which
// `:read-write` matches by too.
export function contenteditableHost(n) {
  if (!n || n._nodeType !== NODE_ELEMENT) return null;
  return globalThis.__dom.editingHost(n._nid)[0] ?? null;
}

export function isContenteditable(n) {
  return !!n && n._nodeType === NODE_ELEMENT && globalThis.__dom.isEditable(n._nid);
}

// An `<input>`'s type STATE: its `type` attribute's keyword, ASCII case-insensitively, and Text where it names none —
// and what applies to an input in it, HTML's table of them: the engine's (input_types.rs), by these codes.
export const inputTypeState = (el) => globalThis.__dom.inputType(el);
export const INPUT_READONLY = 1, INPUT_FREE_TEXT = 1 << 1, INPUT_NUMERIC = 1 << 2, INPUT_DATE = 1 << 3, INPUT_LIST = 1 << 4;
export const INPUT_TYPED = 1 << 5, INPUT_TEXTUAL = 1 << 6, INPUT_BUTTON = 1 << 7;
export const inputFacts = (el) => globalThis.__dom.inputFacts(el);
export const inputHas = (el, fact) => (inputFacts(el) & fact) !== 0;
// …and its value mode ("value", "default", "default/on", "filename").
export const VALUE_MODES = ['value', 'default', 'default/on', 'filename'];
export const inputValueMode = (el) => VALUE_MODES[inputFacts(el) >>> 16];

// A form's listed elements (HTML "listed"), in tree order — what its `elements` holds, read here so a control NAMED
// `elements` cannot shadow it: the engine's (element_state.rs `form_listed`) — in the form's tree, its root's when
// connected, else its own subtree, its listed controls whose form owner it is, an image button not.
export function formControlElements(form) {
  return globalThis.__dom.formListed(form._nid);
}

// HTML "user validity": set once the user has committed a change to the control (its `change` from a user edit) or
// submitted its form interactively — from then on `:user-valid` / `:user-invalid` match it.
export function markUserValidity(el) {
  if (hasState(el, STATE_USER_INTERACTED)) return;
  setStateBit(el, STATE_USER_INTERACTED, true);
  bumpStyleState();
}

// An image button's selected coordinate (HTML §4.10.5.1.20): where a click selected it — the point's offset in the
// button, as Chrome measures it, a dispatched click event's too (WPT) — for the submission that click makes, and the
// origin for any other: a synthetic click's (`click()`, a key's activation: Chrome 0,0), a script's requestSubmit.
const selectedCoordinates = new WeakMap();
export const selectedCoordinateOf = (button) => selectedCoordinates.get(button) ?? [0, 0];
export function selectCoordinate(button, x, y) { selectedCoordinates.set(button, [Math.trunc(x), Math.trunc(y)]); }
export function forgetSelectedCoordinate(button) { selectedCoordinates.delete(button); }

// HTML "actually disabled" — the arena's (element_state.rs `is_actually_disabled`), the answer `:disabled` matches
// by too, so the `disabled?` driver query and the pseudo-class cannot disagree (Capybara asserts `:disabled` ⟺
// `disabled?`): a form control (a form-associated custom element included) by its own `disabled` or a disabled
// `<fieldset>` ancestor it is not in the first `<legend>` of; an `<optgroup>` / `<option>` by its own, or a disabled
// `<optgroup>` / `<select>` it belongs to.

export function isActuallyDisabled(el) {
  return !!el && el._nodeType === NODE_ELEMENT && actuallyDisabledOf(el);
}

// A submit button (HTML): a submit or image input, or a button in the Submit state — element_state.rs's answer.
export function isSubmitButton(n) {
  return n._nid != null && globalThis.__dom.isSubmitButton(n._nid);
}

// A form's DEFAULT BUTTON (HTML): the first submit button in tree order whose form owner is the form — a control
// outside it with `form=` included, one a `<select>` holds (its display button) not — or null: the engine's
// (element_state.rs `default_button_of`), which `:default` matches by too. What implicit submission submits with.
export function defaultButtonOf(form) {
  return globalThis.__dom.defaultButton(form._nid)[0] ?? null;
}

// Click activation, the engine's (element_state.rs): HTML's "summary for its parent details", and a click's activation
// target (DOM dispatch) — the nearest element with activation behaviour on its event path from `target` (a hyperlink, an
// SVG one too; a button; an input but a hidden one; the summary of its details, unless the click came through
// interactive content inside it; a label with a labeled control), so a click activates one element only — up through
// slots and out of shadow trees for a composed click, where the click bubbles (a click that bubbles and is composed where
// the two are not given), or null.
export const isSummaryForItsDetails = (summary) => globalThis.__dom.isDetailsSummary(summary._nid);
export function activationTargetOf(target, bubbles = true, composed = true) {
  return globalThis.__dom.activationTarget(target._nid, bubbles, composed);
}

export function ancestorForm(n) {
  return htmlAncestorOf(n, 'form', false);
}

// HTML "reset the form owner", the engine's (element_state.rs `form_owner`): a connected control's `form` attribute
// names its owner in its own tree — the first element with that id, where that is a form; none for an empty or
// unmatched one — else its nearest ancestor form (in a disconnected subtree too), else the form the HTML parser's form
// element pointer gave it (`<table><form>…<input>`) while that shares its tree.
export function formForControl(n) {
  return globalThis.__dom.formOwner(n._nid)[0] ?? null;
}

// ── Checkedness (internal state) vs the `checked` content attribute ──
// HTML separates a checkbox/radio's live *checkedness* from its `checked`
// content attribute (the default checkedness). We store the live state in
// `_checkedness` once a "dirty checkedness flag" is set — i.e. once the user
// clicks or script assigns `.checked`. While clean (undefined), checkedness
// tracks the content attribute, so the parser writing `checked` and a later
// `setAttribute('checked')`/`removeAttribute` are reflected for free; once
// dirtied, the attribute no longer affects it (and `<form>.reset()` clears the
// flag). Every checkedness mutation goes through setCheckedness so the dirty
// flag is set consistently across the IDL setter, the click activation paths,
// and the radio-group invariant.
export function getCheckedness(n) {
  return n._checkedness !== undefined ? n._checkedness : (n._attrs.checked != null);
}
export function setCheckedness(n, on) {
  const was = getCheckedness(n);
  n._checkedness = !!on;
  // `:checked` is a dynamic pseudo-class: the STYLE-STATE generation is what tells the cascade
  // and LAYOUT that its matches may have flipped. Bumped HERE — the one funnel every checkedness
  // mutation passes through (IDL setter, click activation, arrow keys, the radio-group
  // invariant's group-mate flips) — because bumping only in the IDL setter left a plain
  // `el.click()` on a checkbox with stale geometry under an `input:checked { height: … }` rule.
  // …and the settle generation, which the memos of what it shows (visible_text) and Capybara's settle key on.
  if (was !== !!on) {
    bumpStyleState();
    bumpSettleGen();
  }
  // (…and a radio checked unchecked the rest of its group, the engine's as it wrote the state — element_state.rs
  // `radio_steps` — which the same generations hear of)
  engineWritten();
}

// Selectedness has the same shape as checkedness — a dynamic pseudo-class (`:checked` matches
// selected options) backed by internal state with MANY writers (the selectedness-setting
// algorithm, IDL setters, the parser, ask-for-reset) — and it had the same hole: nothing moved
// the style-state generation, so a `:checked`-driven layout rule kept stale boxes across
// `select.value = …`. One funnel, every `_selectedness` assignment routes through it.
export function setSelectedness(o, on) {
  const was = o._selectedness === true;
  o._selectedness = !!on;
  if (was !== !!on) bumpStyleState();
}
// …and the options whose selectedness the engine changed (validity.rs `selectedness`, `select_option`,
// `initialise_options`): what their select shows, laid out in it, and what `:checked` matches.
export function optionsChanged(options) {
  for (const o of options) markShownText(o);
  if (options.length) bumpStyleState();
}

// An option's value (HTML "option's value"): its `value` attribute, else its text, collapsed and trimmed — the engine's.
export function optionValue(option) {
  return option._getAttributeNS(null, 'value') ?? globalThis.__dom.optionText(option._nid);
}
// A text control's selection, the engine's (text_selection.rs) — `start` and `end` where it has one, else none: where
// the driver's typing goes (to the end of the value, as a WebDriver focus puts it).
export function textSelectionOf(n) {
  const sel = n._nid == null ? null : globalThis.__dom.textSelection(n._nid, false);
  return sel !== null && sel[3] ? { start: sel[0], end: sel[1] } : null;
}
// A text control's text entry cursor moved to `start`..`end` by the user or by its value changing — not "set the
// selection range" (no `select`): its offsets, its direction ('none' unless the user extended it one way), and where
// that changed its selection, a selectionchange scheduled at the control (Selection API).
export function moveTextEntryCursor(n, start, end = start, direction = 'none') {
  if (n._nid != null && globalThis.__dom.setTextSelection(n._nid, start, end, direction)) globalThis.__csimScheduleSelectionChange(n);
}

// ── Live value (internal state) vs the `value` content attribute ──
// Like checkedness, HTML separates an input/textarea's live *value* from its
// default (the `value` content attribute for <input>, the child text for
// <textarea>). The live value is stored in `_value` once the dirty value flag is
// set — i.e. once script assigns `.value`, the user types, or setRangeText runs.
// While clean (undefined) the value tracks the default, so the parser writing
// `value` and a later setAttribute('value')/removeAttribute are reflected for
// free; once dirtied, the attribute no longer affects it (and `<form>.reset()`
// clears the flag by deleting `_value`). This returns the live value the user EDITS — what the text selection's
// offsets index (text_selection.rs, its "relevant value"): a dirty one as typed (the IDL `.value` getter still runs it
// through per-type sanitization: an email field's typed " foo@bar " reads "foo@bar"), a clean input's attribute
// sanitized for its type (a url field's "  http://a  " is "http://a" to type into), a clean textarea's child text.
export function controlLiveValue(n) {
  return globalThis.__dom.relevantValue(n);
}

// The one way to WRITE a control's live value. The live value is a cascade input —
// `:placeholder-shown`, `:valid` / `:invalid`, `:in-range` and their `:user-` variants all read it
// — and it is stored on `_value` without touching the `value` content attribute, so no attribute
// mutation and no other generation moves for it. `bumpStyleState` is what tells the cascade and the
// layout memos that a selector's answer may have changed; every path that edited `_value` in place
// instead (setRangeText, paste, typing, the re-sanitize after a `type` change) left them serving
// the state from before the edit — a `#t:placeholder-shown { width: 300px }` box stayed 300px, in
// `getBoundingClientRect` as much as in the CSSOM, after the field was filled.
export function setControlLiveValue(n, next) {
  if (n._value === next) return false;
  n._value = next;
  bumpStyleState();
  return true;
}
// …and the user typing `text` into it — where `at` says (`TYPE_*`), a number field refusing a keystroke that makes its
// text no number being entered, `maxlength` cutting it short — the engine's (text_selection.rs `type_text`), which moves
// the text entry cursor past it: what of `text` went in.
export function typeIntoControl(n, text, at = TYPE_AT_CARET) {
  const changed = typeIntoValue(n, text, at);
  controlEdited(n, changed);
  return text.slice(0, changed >>> TYPED_LENGTH_SHIFT);
}
// …or pressing an editing key in it (`EDIT_*`): Backspace / Delete, the arrows, Home / End, as Chrome takes them —
// whether that changed its value.
export function editControl(n, key) {
  const changed = editValue(n, key);
  controlEdited(n, changed);
  return (changed & TYPED_VALUE) !== 0;
}
function controlEdited(n, changed) {
  if (changed & TYPED_VALUE) bumpStyleState();
  if (changed & TYPED_SELECTION) globalThis.__csimScheduleSelectionChange(n);
}
// The textarea "raw value": the concatenation, in tree order, of the data of its
// DIRECT child Text nodes — NOT textContent (which also flattens descendant
// elements). A CDATASection is a Text node (it extends Text), so XHTML CDATA
// children count too. This is what `defaultValue` reflects and the API value
// normalizes: the engine's (`__dom.childText`).
export function textareaRawValue(n) {
  return globalThis.__dom.childText(n);
}

// A radio button checked: the rest of its group unchecked, the engine's as it writes the checkedness (HTML "set the
// checkedness of all the OTHER elements in the radio button group to false": element_state.rs `radio_steps`).
export function setRadio(n) {
  setCheckedness(n, true);
}
