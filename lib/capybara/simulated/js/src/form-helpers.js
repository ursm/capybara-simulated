// Form-control helpers shared between Element class methods and the
// form-field mutation block (send_keys / set / select). Pure
// node-shape queries plus the toggle tasks and `beforetoggle`.

import { hrefAttr } from './link-href.js';
import { asciiLower } from './ascii.js';
import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, HTML_NS, SVG_NS } from './constants.js';
import { flatTreeParent, isConnected, walk, walkFind, walkSubtree } from './walk.js';
import { ToggleEvent } from './events.js';
import { bumpSettleGen, bumpStyleState, currentNodesGen, currentStyleStateGen } from './mutation-observer.js';
import { fireEvent } from './dispatch.js';
import { clearTimer, queueTask } from './timers.js';
import { isFormAssociatedCustomElement } from './custom-elements.js';
import { hasState, setStateBit, actuallyDisabledOf, willValidateOf, STATE_USER_INTERACTED } from './native-query-shadow.js';
import { selectAll } from './selectors.js';

// HTML's details, popover and dialog toggle tasks: a `toggle` ToggleEvent from the state before a run of changes to the state
// after it, fired from a task — one for the run, a change while one is pending updating its new state (the toggle task
// tracker), so open-then-close fires closed → closed.
export function queueToggleTask(el, oldState, newState) {
  const pending = el._toggleTask;
  if (pending) {
    // (…its task removed and a new one queued, keeping the old state: behind whatever was queued since)
    clearTimer(pending.id);
    oldState = pending.oldState;
  }
  const task = el._toggleTask = { oldState, id: null };
  task.id = queueTask(() => {
    el._toggleTask = null;
    try { fireEvent(el, new ToggleEvent('toggle', { oldState, newState })); } catch (_) {}
  }, 0);
}
// …and the `beforetoggle` before a popover's or a dialog's change, from its state to the other: cancelable when it
// opens.
export function fireBeforeToggle(el, opening) {
  const ev = new ToggleEvent('beforetoggle', { cancelable: opening, oldState: opening ? 'closed' : 'open', newState: opening ? 'open' : 'closed' });
  fireEvent(el, ev);
  return !ev._canceled;
}

// Resolve a `<label>` element to its labeled form control per HTML
// spec. Preference order: `for` attribute → first labelable
// descendant (input / textarea / select / button / output / meter /
// progress, excluding `input[type=hidden]`).
export const LABELABLE = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);
export function isLabelableControl(n) {
  if (!LABELABLE.has(n._tag)) return false;
  return !(n._tag === 'input' && (n._attrs.type || '').toLowerCase() === 'hidden');
}
export function labeledControlFor(label) {
  // HTML: when the `for` attribute is PRESENT (even the empty string), the
  // labeled control is resolved ONLY by id within the label's own node tree
  // (its shadow root in a shadow tree, else the document) — there is NO
  // descendant fallback. The labeled control is the first element in tree
  // order with that id, and only if it is itself a labelable control; an empty
  // `for`, a non-matching id, an id whose first match is a non-control (e.g. a
  // `<b>`/another label) all yield null. getElementById returns the first
  // tree-order match and exists on both ShadowRoot and Document.
  if (label._attrs.for != null) {
    const forId = label._attrs.for;
    if (forId === '') return null;
    const root = label.getRootNode ? label.getRootNode() : globalThis.document;
    // getElementById exists on Document / ShadowRoot; a label in a DISCONNECTED
    // subtree roots at a plain Element, so fall back to a tree-order id walk —
    // `for` still resolves "within the label's tree" there (a label can label a
    // control in the same detached tree).
    let hit = null;
    if (root) hit = root.getElementById ? root.getElementById(forId)
                                        : walkFind(root, el => el._attrs.id === forId);
    return (hit && isLabelableControl(hit)) ? hit : null;
  }
  // `for` absent → the first labelable descendant in tree (pre-order) order.
  return firstLabelableDescendant(label);
}

// First labelable control in pre-order (= document order) within `node`'s
// subtree, or null. Pre-order DFS, not BFS: in `<label><a/><div><input/></div>
// <input/></label>` the labeled control is the nested input (it precedes the
// sibling input in tree order). We never descend INTO a labelable control (it
// is returned first); a non-control labelable tag (`<input type=hidden>`) has
// no labelable children, so recursing through it is harmless.
function firstLabelableDescendant(node) {
  for (const c of node._children) {
    if (c._nodeType !== NODE_ELEMENT) continue;
    if (isLabelableControl(c)) return c;
    const found = firstLabelableDescendant(c);
    if (found) return found;
  }
  return null;
}

// HTML "interactive content" — the full list, used for label activation: the
// spec says a label's activation behaviour for an event "targeted at
// interactive content descendants of the label, and any descendants of those"
// is to do nothing (the interactive element's own activation runs instead).
// This is DISTINCT from labelable (`isLabelableControl`): `<button>` / `<input>`
// / `<select>` / `<textarea>` are both, but `<meter>` / `<output>` / `<progress>`
// are labelable yet NOT interactive — so a click on one still hops to the label.
// (`<object>` is NOT interactive content in current HTML, even with usemap.)
export function isInteractiveContent(n) {
  // Only HTML-namespace elements are interactive content; an SVG `<details>` /
  // `<a>` (createElementNS) is not, so a click on it inside a `<label>` hops.
  if (n._ns !== HTML_NS) return false;
  switch (n._tag) {
    case 'button': case 'select': case 'textarea':
    case 'label':  case 'summary': case 'details':
    case 'embed':  case 'iframe':
      return true;
    case 'input':
      return (n._attrs.type || '').toLowerCase() !== 'hidden';
    case 'a': case 'area':
      return hrefAttr(n) != null;
    case 'audio': case 'video':
      return n._attrs.controls != null;
    case 'img':
      return n._attrs.usemap != null;
  }
  return false;
}

// True iff `n` is an HTML `<label>` element. Label identity is the HTML
// namespace + the (case-sensitive) localName 'label' — so a `createElementNS`
// uppercase 'LABEL' or an SVG `<label>` is NOT one. Single-sources the check
// shared by every label code path (control/labels/form IDL + click/focus hop).
export function isHtmlLabel(n) {
  return n._ns === HTML_NS && n._localName === 'label';
}

// Nearest `<label>` ancestor of `n` (excluding `n` itself), or null
// if none. The walk stops at any INTERACTIVE-CONTENT ancestor because
// clicking it activates that element instead of the outer label's target —
// matches HTML "click in a label" semantics (events targeted at interactive
// content descendants of a label do nothing for the label). A non-interactive
// ancestor — including a labelable-but-not-interactive `<meter>`/`<output>`/
// `<progress>` or a non-control `<input type=hidden>` — is transparent, so a
// click under it still hops. `n` itself being a label is the caller's concern.
export function enclosingLabelFor(n) {
  let cur = n._parent;
  while (cur && cur._nodeType === NODE_ELEMENT) {
    if (isHtmlLabel(cur)) return cur;
    if (isInteractiveContent(cur)) return null;
    cur = cur._parent;
  }
  return null;
}

// The `<label>` whose labeled control a click on `node` should activate (HTML
// "click in a label"), or null. A click ON the label itself, or on a
// non-interactive descendant, forwards to the label's labeled control; a click
// on interactive content (incl. the label, or a labelable interactive control)
// runs that element's own activation instead. Single-sources the decision the
// three click-activation entry points share — bare dispatchEvent (dispatch.js),
// IDL Element.click() (dom-nodes), and the Ruby UA-click resolver (bridge.entry)
// — so they cannot drift. The caller fires the click on `labeledControlFor`.
export function labelToActivateFor(node) {
  if (isHtmlLabel(node)) return node;
  if (isInteractiveContent(node)) return null;
  return enclosingLabelFor(node);
}

// Nearest contenteditable host ancestor (or `n` itself). Returns null
// when `n` is outside any editable region, or inside an explicit
// `contenteditable="false"` subtree (the `false` value short-circuits
// the walk without inheriting from a grandparent).
export function contenteditableHost(n) {
  let cur = n;
  while (cur && cur._nodeType === NODE_ELEMENT) {
    const v = cur._attrs.contenteditable;
    if (v != null) {
      const lower = String(v).toLowerCase();
      if (lower === '' || lower === 'true' || lower === 'plaintext-only') return cur;
      if (lower === 'false') return null;
    }
    cur = cur._parent;
  }
  return null;
}

export function isContenteditable(n) {
  return contenteditableHost(n) != null;
}

// An `<input>`'s type STATE: its `type` attribute ASCII-lowercased when that names one, and Text otherwise (the
// attribute's missing and invalid value default).
const INPUT_TYPE_STATES = new Set([
  'hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local',
  'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button'
]);
export function inputTypeState(el) {
  const t = el._attrs.type;
  if (t == null) return 'text';
  const lower = asciiLower(String(t));
  return INPUT_TYPE_STATES.has(lower) ? lower : 'text';
}

// The listed elements (HTML "listed"): the controls a form's `elements` holds — and one of them whose form owner is a
// form, in tree order (`form.elements`, read here so a control NAMED `elements` cannot shadow it).
const FORM_LISTED_TAGS = new Set(['input', 'button', 'fieldset', 'object', 'output', 'select', 'textarea']);
export function isListedFormControl(el) {
  return FORM_LISTED_TAGS.has(el._tag) || isFormAssociatedCustomElement(el);
}

export function formControlElements(form) {
  const out  = [];
  // The form's own ROOT NODE (getRootNode — the shadow root for a shadow-resident
  // form, else the document), NOT `_ownerDoc`: walkSubtree is light-tree-only, and
  // a connected form inside a shadow root would otherwise be walked against the
  // document and find none of its (shadow-tree) controls. A detached form scopes
  // to its own subtree. form= controls must share the form's node tree anyway.
  const root = isConnected(form) ? form.getRootNode() : form;
  walkSubtree(root, el => {
    if (el === root || el._nodeType !== NODE_ELEMENT) return;
    const t = el._tag;
    if (!isListedFormControl(el)) return;
    if (t === 'input' && (el._attrs.type || '').toLowerCase() === 'image') return;
    if (formForControl(el) === form) out.push(el);
  });
  return out;
}

// A form-associated custom element's `willValidate`: barred when actually disabled, `readonly`, or in a `<datalist>`
// (HTML, as for the built-in controls) — the arena's (validity.rs `will_validate`).
export function faceWillValidate(el) {
  return willValidateOf(el);
}

// HTML "user validity": set once the user has committed a change to the control (its `change` from a user edit) or
// submitted its form interactively — from then on `:user-valid` / `:user-invalid` match it.
export function markUserValidity(el) {
  if (hasState(el, STATE_USER_INTERACTED)) return;
  setStateBit(el, STATE_USER_INTERACTED, true);
  bumpStyleState();
}

// The `<input>` types the `readonly` attribute applies to (the text-entry states).
// Canonical home shared by dom-nodes (value mutability / validity) and selectors
// (`:read-write` / `:read-only`) so the two can't drift.
export const READONLY_INPUT_TYPES = new Set([
  'text', 'search', 'tel', 'url', 'email', 'password',
  'number', 'date', 'month', 'week', 'time', 'datetime-local'
]);

// HTML "actually disabled" — the arena's (element_state.rs `is_actually_disabled`), the answer `:disabled` matches
// by too, so the `disabled?` driver query and the pseudo-class cannot disagree (Capybara asserts `:disabled` ⟺
// `disabled?`): a form control (a form-associated custom element included) by its own `disabled` or a disabled
// `<fieldset>` ancestor it is not in the first `<legend>` of; an `<optgroup>` / `<option>` by its own, or a disabled
// `<optgroup>` / `<select>` it belongs to.
export function isActuallyDisabled(el) {
  return !!el && el._nodeType === NODE_ELEMENT && actuallyDisabledOf(el);
}

export function isSubmitButton(n) {
  if (n._tag === 'button') {
    // A `<button>` with no explicit type but a `command` / `commandfor` attribute
    // is a Command Button (its activation invokes the command, not form
    // submission) — the missing-type default is Command, not Submit.
    if (n._attrs.type == null && (n._attrs.command != null || n._attrs.commandfor != null)) return false;
    // Otherwise type defaults to submit, and an INVALID/unknown type also falls
    // back to the submit state — only an explicit `reset` / `button` is not a
    // submit button.
    const t = (n._attrs.type || '').toLowerCase();
    return t !== 'reset' && t !== 'button';
  }
  if (n._tag === 'input') {
    const t = (n._attrs.type || '').toLowerCase();
    return t === 'submit' || t === 'image';
  }
  return false;
}

// A form's DEFAULT BUTTON (HTML): the first submit button in tree order whose form owner is the form — a control
// outside it with `form=` included, one a `<select>` holds (its display button) not — or null. What implicit
// submission submits with, and the one submit button `:default` matches.
export function defaultButtonOf(form) {
  const root = isConnected(form) ? form.getRootNode() : form;
  return formFactsOf(root).defaults.get(form) || null;
}
// What those two ask of a whole tree, in ONE walk of it, kept until the DOM or an element's state moves (the tree and
// style-state generations): a pseudo-class asked of every radio or every submit button in turn was a walk per element.
const formFacts = new WeakMap();
function formFactsOf(root) {
  const tree = currentNodesGen(), state = currentStyleStateGen();
  let facts = formFacts.get(root);
  if (facts !== undefined && facts.tree === tree && facts.state === state) return facts;
  facts = { tree, state, defaults: new Map(), checkedGroups: new Map() };
  walk(root, (el) => {
    if (el._ns !== HTML_NS) return;
    if (el._tag === 'input' && isRadio(el) && el._attrs.name && getCheckedness(el)) {
      let owners = facts.checkedGroups.get(el._attrs.name);
      if (owners === undefined) facts.checkedGroups.set(el._attrs.name, owners = new Set());
      owners.add(formForControl(el));
    }
    if (isSubmitButton(el) && !inSelect(el)) {
      const form = formForControl(el);
      if (form !== null && !facts.defaults.has(form)) facts.defaults.set(form, el);
    }
  });
  formFacts.set(root, facts);
  return facts;
}
function inSelect(el) {
  for (let p = el._parent; p; p = p._parent) if (p._tag === 'select') return true;
  return false;
}

// Whether a click landing on `n` activates `n` itself (it has click activation
// behaviour), so the walk for the nearest activatable element stops here. Used to
// honour single-activation: a click on a button's plain descendant activates the
// button, but a click on a closer activatable (link / summary / label / nested
// control) activates THAT instead. (Hyperlinks need an href to navigate.)
// HTML's "summary for its parent details": the first summary child of an HTML details element — the one summary that
// opens and closes it.
export function isSummaryForItsDetails(summary) {
  const details = summary._parent;
  if (!details || details._nodeType !== NODE_ELEMENT || details._tag !== 'details' || details._ns !== HTML_NS) return false;
  return (details._children || []).find((c) => c._nodeType === NODE_ELEMENT && c._tag === 'summary' && c._ns === HTML_NS) === summary;
}
export function isClickActivatable(n) {
  // (…of the other namespaces', only an SVG link's: it follows its hyperlink as an HTML one does)
  if (n._ns !== HTML_NS) return n._ns === SVG_NS && n._tag === 'a' && hrefAttr(n) != null;
  const t = n._tag;
  if (t === 'button' || t === 'input' || t === 'select') return true;
  // A <summary> activates (toggles) only as the summary of a <details> parent; a
  // <label> activates only when it has an associated control. Without those, the
  // element has NO activation behaviour, so the walk must continue past it (e.g. to
  // an enclosing submit button) rather than stop here.
  if (t === 'summary') return isSummaryForItsDetails(n);
  if (t === 'label')   return labeledControlFor(n) != null;
  if ((t === 'a' || t === 'area') && hrefAttr(n) != null) return true;
  return false;
}

// A click's activation target (DOM dispatch): the nearest element with activation behaviour on its path from
// `target` — the element itself or, the click bubbling, an ancestor across shadow trees and slots (the flat tree's
// parents, as the composed path runs) — or null.
export function activationTargetOf(target) {
  for (let n = target; n; n = flatTreeParent(n)) if (n._nodeType === NODE_ELEMENT && isClickActivatable(n)) return n;
  return null;
}

export function ancestorForm(n) {
  let cur = n._parent;
  while (cur && cur._nodeType === NODE_ELEMENT) {
    if (cur._tag === 'form') return cur;
    cur = cur._parent;
  }
  return null;
}

// HTML 5: a form control's owning form is resolved via either the
// `form="<id>"` IDL attribute (looking up the form by id) or — when
// absent — by walking ancestors. The attribute takes precedence and
// is the only way to associate a button that lives *outside* the
// form's DOM subtree.
export function formForControl(n) {
  // HTML "reset the form owner": a PRESENT `form` content attribute (even the
  // empty string) is honoured only when the control is connected to a document.
  // Then resolve by id within the control's own node tree (its shadow root in a
  // shadow tree, else the document): the first element with that id is the owner
  // iff it is a <form>; the empty string (and any non-matching / non-form id)
  // yields no owner. Note: presence is `!= null`, so `form=""` counts (≠ absent).
  if (n._attrs.form != null && isConnected(n)) {
    const formId = n._attrs.form;
    if (formId === '') return null;
    const root = n.getRootNode ? n.getRootNode() : globalThis.document;
    const hit  = root && root.getElementById ? root.getElementById(formId) : null;
    return (hit && hit._tag === 'form') ? hit : null;
  }
  // No form attribute — OR a form attribute on a control that isn't in a
  // document: the owner is the nearest ancestor <form> (intrinsic to the tree,
  // so it holds in a disconnected subtree too). ancestorForm walks `_parent`
  // and naturally stops at a shadow-root boundary.
  //
  // When there's NO ancestor form, fall back to the owner the HTML PARSER assigned
  // via its form element pointer (`_formOwner`): a mis-nested control
  // (`<table><form>…<input>`, or an `<input>` after a `</div>` that mis-closed
  // inside a `<form>`) is owned by that form even though it isn't a DOM ancestor.
  // Ancestry takes precedence, so a later DOM move re-derives the owner. The parser
  // owner is honoured only while it shares the control's home subtree (same root) —
  // a form removed by a parse-time script, or one across a shadow boundary, is no
  // longer its owner (HTML's "reset the form owner" same-tree requirement).
  const anc = ancestorForm(n);
  if (anc) return anc;
  const fo = n._formOwner;
  if (fo && typeof n.getRootNode === 'function' && n.getRootNode() === fo.getRootNode()) return fo;
  return null;
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
}

function isRadio(n) {
  return n._tag === 'input' && String(n._attrs.type || '').toLowerCase() === 'radio';
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

export function toggleChecked(n) {
  setCheckedness(n, !getCheckedness(n));
}

// A text control's text entry cursor moved to `start`..`end` by the user or by its value changing — not "set the
// selection range" (no `select`): its offsets, its direction 'none', and where that changed its selection, a
// selectionchange scheduled at the control (Selection API).
export function moveTextEntryCursor(n, start, end = start) {
  const changed = n._selectionStart !== start || n._selectionEnd !== end || (n._selectionDirection || 'none') !== 'none';
  n._selectionStart = start;
  n._selectionEnd = end;
  n._selectionDirection = 'none';
  if (changed) globalThis.__csimScheduleSelectionChange(n);
}


// ── Live value (internal state) vs the `value` content attribute ──
// Like checkedness, HTML separates an input/textarea's live *value* from its
// default (the `value` content attribute for <input>, the child text for
// <textarea>). The live value is stored in `_value` once the dirty value flag is
// set — i.e. once script assigns `.value`, the user types, or setRangeText runs.
// While clean (undefined) the value tracks the default, so the parser writing
// `value` and a later setAttribute('value')/removeAttribute are reflected for
// free; once dirtied, the attribute no longer affects it (and `<form>.reset()`
// clears the flag by deleting `_value`). This returns the RAW live value — the
// IDL `.value` getter runs it through per-type value sanitization; internal
// readers that want the raw live value (serialization, clipboard, Capybara
// value) use this directly.
export function controlLiveValue(n) {
  if (n._value !== undefined) return n._value;
  // A clean textarea's value is its "API value": the raw value (the data of its
  // direct child Text nodes) with CR / CRLF normalized to LF. (The default value
  // — `defaultValue` — is the raw value WITHOUT that normalization.)
  if (n._tag === 'textarea') return textareaRawValue(n).replace(/\r\n?/g, '\n');
  return n._attrs.value != null ? n._attrs.value : '';
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
// …and the way to CLEAR it — `<form>.reset()` and a `type` change drop the dirty value flag, which
// hands the value back to the content attribute. That changes the live value as surely as writing
// one does (an emptied field is `:placeholder-shown` again), and a `delete` is exactly what an
// assignment helper can never catch, so it gets its own door rather than a comment asking callers
// to remember. Same for checkedness, which `:checked` reads.
export function clearControlLiveValue(n) {
  if (n._value === undefined) return false;
  n._value = undefined;
  bumpStyleState();
  return true;
}
export function clearControlCheckedness(n) {
  if (n._checkedness === undefined) return false;
  n._checkedness = undefined;
  bumpStyleState();
  return true;
}

// The textarea "raw value": the concatenation, in tree order, of the data of its
// DIRECT child Text nodes — NOT textContent (which also flattens descendant
// elements). A CDATASection is a Text node (it extends Text), so XHTML CDATA
// children count too. This is what `defaultValue` reflects and the API value
// normalizes.
export function textareaRawValue(n) {
  let out = '';
  const kids = n._children;
  if (kids) for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c && (c._nodeType === NODE_TEXT || c._nodeType === NODE_CDATA)) out += (c.data != null ? c.data : '');
  }
  return out;
}

// Invoke `fn(o)` for every OTHER radio in `n`'s radio button group. HTML: two
// radios are in the same group iff they share a root (homed in the same tree),
// have the same form owner (both null, or the same <form>), and the same
// non-empty case-sensitive name. A radio with an empty/absent name is in no
// group (only itself), so this is a no-op there. Scoped by the control's own
// tree root (shadow root in a shadow tree, else the document — NOT
// documentElement, whose querySelectorAll never crosses a shadow boundary, and
// which also misses a disconnected element/fragment root), then filtered to the
// same form owner so radios under different forms in the same root stay
// independent.
export function forEachRadioInGroup(n, fn) {
  const name = n._attrs.name;
  if (!name) return;
  const owner = formForControl(n);
  const root  = n._getRootNode();
  for (const o of selectAll(root, 'input')) {
    if (o === n) continue;
    if ((o._attrs.type || '').toLowerCase() !== 'radio') continue;
    if (o._attrs.name !== name) continue;
    if (formForControl(o) !== owner) continue;   // same form owner (the query already scoped to n's root)
    fn(o);
  }
}

// The radios in `n`'s group (including `n`) in tree order — same grouping rule as
// forEachRadioInGroup. Used for arrow-key navigation, which steps through the group
// in document order. A nameless radio is its own singleton group.
export function radioGroupMembers(n) {
  const name = n._attrs.name;
  if (!name) return [n];
  const owner = formForControl(n);
  const root  = n._getRootNode();
  const out = [];
  for (const o of selectAll(root, 'input')) {
    if ((o._attrs.type || '').toLowerCase() !== 'radio') continue;
    if (o._attrs.name !== name) continue;
    if (formForControl(o) !== owner) continue;
    out.push(o);
  }
  return out;
}

// The radio in `n`'s group (including `n`) that is currently checked, or null.
// Used to restore the group on a canceled radio click — the legacy-canceled-
// activation behavior reverts to the prior selection, not just to `n`'s own
// previous state.
export function checkedRadioInGroup(n) {
  let found = getCheckedness(n) ? n : null;
  forEachRadioInGroup(n, (o) => { if (getCheckedness(o)) found = o; });
  return found;
}

// HTML "set the checkedness of all the OTHER elements in the radio button group
// to false" — the group invariant maintained whenever a radio becomes checked.
export function uncheckOtherRadios(n) {
  forEachRadioInGroup(n, (o) => { setCheckedness(o, false); });
}

export function setRadio(n) {
  uncheckOtherRadios(n);
  setCheckedness(n, true);
}
