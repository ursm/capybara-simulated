// Form-control helpers shared between Element class methods and the
// form-field mutation block (send_keys / set / select). Pure
// node-shape queries plus the `<dialog>.close` event dispatch.

import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, HTML_NS } from './constants.js';
import { isConnected, walkFind } from './walk.js';
import { Event }              from './events.js';
import { selectFirst }        from './selectors.js';
import { recordAttrMutation } from './mutation-observer.js';
import { dispatchEvent }      from './dispatch.js';

// Spec-minimal `<dialog>.close(returnValue)` — strip `open`,
// dispatch a non-bubbling, non-cancelable `close` event. Turbo's
// `confirm` flow waits on this event and reads `dialog.returnValue`
// to decide whether to proceed.
export function closeDialog(dlg, returnValue) {
  if (!dlg || dlg._tag !== 'dialog') return;
  dlg._modal = false;   // closing (incl. method=dialog submit) drops modal-ness (:modal)
  dlg.returnValue = String(returnValue == null ? '' : returnValue);
  if (Object.prototype.hasOwnProperty.call(dlg._attrs, 'open')) {
    const old = dlg._attrs.open;
    delete dlg._attrs.open;
    recordAttrMutation(dlg, 'open', old == null ? null : old);
  }
  try { dispatchEvent(dlg, new Event('close', { bubbles: false, cancelable: false })); } catch (_) {}
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
    if (c.nodeType !== NODE_ELEMENT) continue;
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
      return n._attrs.href != null;
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
  while (cur && cur.nodeType === NODE_ELEMENT) {
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
  while (cur && cur.nodeType === NODE_ELEMENT) {
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

// Whether a click landing on `n` activates `n` itself (it has click activation
// behaviour), so the walk for the nearest activatable element stops here. Used to
// honour single-activation: a click on a button's plain descendant activates the
// button, but a click on a closer activatable (link / summary / label / nested
// control) activates THAT instead. (Hyperlinks need an href to navigate.)
export function isClickActivatable(n) {
  if (n._ns !== HTML_NS) return false;   // only HTML elements have these activation behaviours
  const t = n._tag;
  if (t === 'button' || t === 'input' || t === 'select') return true;
  // A <summary> activates (toggles) only as the summary of a <details> parent; a
  // <label> activates only when it has an associated control. Without those, the
  // element has NO activation behaviour, so the walk must continue past it (e.g. to
  // an enclosing submit button) rather than stop here.
  if (t === 'summary') return n._parent != null && n._parent._tag === 'details';
  if (t === 'label')   return labeledControlFor(n) != null;
  if ((t === 'a' || t === 'area') && n._attrs.href != null) return true;
  return false;
}

export function ancestorForm(n) {
  let cur = n._parent;
  while (cur && cur.nodeType === NODE_ELEMENT) {
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
  n._checkedness = !!on;
}

export function toggleChecked(n) {
  setCheckedness(n, !getCheckedness(n));
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
    if (c && (c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA)) out += (c.data != null ? c.data : '');
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
  const root  = n.getRootNode ? n.getRootNode() : globalThis.document;
  const candidates = root && root.querySelectorAll ? root.querySelectorAll('input') : [];
  for (const o of candidates) {
    if (o === n) continue;
    if ((o._attrs.type || '').toLowerCase() !== 'radio') continue;
    if (o._attrs.name !== name) continue;
    if (formForControl(o) !== owner) continue;   // same form owner (querySelectorAll already scoped to n's root)
    fn(o);
  }
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
