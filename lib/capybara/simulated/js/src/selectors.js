// css-select v7 adapter speaking our Node / Element model. Compiled
// selectors are memoised because Capybara emits a small recurring
// set per suite.
//
// The cascade-rule engine in `bridge.entry.js` still uses the
// hand-rolled `parseSelector` / `matchOne` pair — that path will
// migrate alongside subsequent modular splits.

import { NODE_ELEMENT, NODE_COMMENT, NODE_PI, NODE_DOC, HTML_NS, SVG_NS, XML_NS } from './constants.js';
import { walk, walkFind, isConnected } from './walk.js';
import { splitTopLevel }      from './css-utils.js';
import { asciiLower, asciiTokens } from './ascii.js';
import { hrefAttr } from './link-href.js';
import { isHtmlDocument } from './mime.js';
import {
  getCheckedness, controlLiveValue, isNodeActuallyDisabled, isContenteditable, isSubmitButton, inputTypeState,
  requiredAppliesToInput, defaultButtonOf, formForControl, radioGroupHasChecked, faceWillValidate, READONLY_INPUT_TYPES
} from './form-helpers.js';
import { isFormAssociatedCustomElement, elementIsDefined } from './custom-elements.js';
import { isTargetElement } from './target.js';
import { hasState, STATE_INDETERMINATE, STATE_POPOVER_OPEN, STATE_MODAL, STATE_FILTERED, STATE_USER_INTERACTED } from './native-query-shadow.js';

const cssSelect     = globalThis.__csimVendor.cssSelect;
const cssWhat       = globalThis.__csimVendor.cssWhat;
const cssTree       = globalThis.__csimVendor.cssTree;

// Attribute-name case-sensitivity is per-element, not per-selector: an HTML
// element matches `[viewBox]` / `[VIEWBOX]` / `[viewbox]` alike (names folded to
// the lowercased stored key), while an SVG / MathML element matches only the
// exact case. css-select's `lowerCaseAttributeNames` is global, so it's turned
// OFF (see the compile options) and the adapter does the per-element folding.

// Selector strings that have already passed strict (css-tree) validation.
// Validity is a property of the string alone, independent of the scope root,
// so this lets the per-scopeRoot compile path (`compiledCacheScoped`) skip the
// css-tree re-parse when the same `:scope`-bearing selector is compiled against
// many different roots (`within(row) { find(':scope > .cell') }` × N rows).
const strictValidated = new Set();

// CSS Selectors-4 user-action pseudos that key off `document._activeElement`.
// css-select has no focus state, so these are fed in via the `pseudos` option.
//
// `:focus` / `:focus-visible` both match the focused element and — per HTML
// "selector-focus" — any shadow host that is a shadow-including ancestor of it
// (so `:host(:focus)` / `:host(:focus-visible)` match when focus is delegated
// into the tree, regardless of delegatesFocus). The host-chain walk compares
// only HOSTS (DOM ancestors are :focus-within's job) and is gated on the page
// having a shadow host so the common shadow-free read stays O(1) (rule 3).
function focusMatchesEl(el) {
  const doc = globalThis.document;
  const active = doc && doc._activeElement;
  if (!active) return false;
  if (active === el) return true;
  if (!globalThis.__csimShadowHostCount) return false;
  for (let n = active; n; ) {
    if (n._isShadowRoot) {
      if (n.host === el) return true;
      n = n.host;
    } else {
      n = n._parent;
    }
  }
  return false;
}
// `:focus-visible` additionally applies the input-modality heuristic: it matches
// only when the focus ring should show — `__csimFocusVisible` is latched at
// focus() time (false only when the focus was pointer-driven and the focused
// element isn't a text-entry control). Default (undefined, e.g. initial /
// programmatic focus) = visible, so :focus-visible == :focus except right after a
// mouse-click focus. (shadow-dom/focus/focus-click-on-shadow-host.html)
function focusVisibleMatchesEl(el) {
  return focusMatchesEl(el) && globalThis.__csimFocusVisible !== false;
}
const focusPseudoMatchers = {
  focus:           focusMatchesEl,
  'focus-visible': focusVisibleMatchesEl,
  'focus-within':  (el) => {
    const active = globalThis.document && globalThis.document._activeElement;
    if (!active) return false;
    for (let cur = active; cur; cur = cur._parent) if (cur === el) return true;
    return false;
  }
};

const adapter = {
  isTag: (n) => n && n.nodeType === NODE_ELEMENT,
  existsOne(test, elems)        { return this.findOne(test, elems) !== null; },
  getAttributeValue: (el, name) => {
    const attrs = el._attrs;
    // hasOwnProperty (not `attrs[name]`) so a selector like `[toString]` /
    // `[constructor]` can't read an Object.prototype member — and so it stays
    // consistent with `hasAttrib`. Exact first (SVG/MathML, or an HTML lowercase
    // selector); then the lowercased key for an HTML mixed-case selector.
    if (Object.prototype.hasOwnProperty.call(attrs, name)) return attrs[name];
    if (el._ns === HTML_NS && /[A-Z]/.test(name)) {
      const k = asciiLower(name);
      if (Object.prototype.hasOwnProperty.call(attrs, k)) return attrs[k];
    }
    return undefined;
  },
  getChildren:       (n)        => n._children,
  getName:           (el)       => el._tag,
  // The two css-select patches that ask whether an element is what the selectors spec calls "an HTML element in an
  // HTML document" (the document half is the compile-time `htmlDocument`): a type selector compares the element's
  // LOCAL name lowercased only then, and as written otherwise — an SVG `foreignObject` is not `foreignobject`, an
  // XHTML `DIV` made by `createElementNS` is neither `div` nor `DIV` (Selectors 4 §5.1; Chrome and Firefox) — and
  // HTML's case-insensitive attribute values are so only then.
  isHtmlElement:     (el) => el._ns === HTML_NS,
  matchesTagName:    (el, name, lower, htmlDocument) => el._localName === (htmlDocument && el._ns === HTML_NS ? lower : name),
  getParent:         (n)        => n._parent,
  getSiblings:       (n)        => n._parent ? n._parent._children : [n],
  prevElementSibling:(n)        => n.previousElementSibling,
  // domutils-style "rendered text": "" for comment / PI nodes (their data is
  // NOT content), the node's text otherwise. Pairs with our LOCAL css-select
  // `:empty` patch, which makes a whitespace-only text child disqualify :empty
  // to match real browsers (`<p> </p>` is not :empty in Chrome). That patch is
  // deliberately LOCAL-ONLY — do NOT upstream it: css-select allows whitespace
  // in :empty on purpose (maintainer PR #795, Selectors-4 wording), so reversing
  // it is a spec-vs-impl policy change, not a bug fix. This getText shim lets a
  // comment/PI child not disqualify while a text node does (a Comment's DOM
  // `textContent` is its data, which would wrongly fail `<p><!--x--></p>`).
  getText:           (n)        => (n.nodeType === NODE_COMMENT || n.nodeType === NODE_PI) ? '' : n.textContent,
  hasAttrib: (el, name) => {
    const attrs = el._attrs;
    if (Object.prototype.hasOwnProperty.call(attrs, name)) return true;   // exact: SVG/MathML or HTML lowercase selector
    return el._ns === HTML_NS && /[A-Z]/.test(name) &&                    // HTML: names are case-insensitive
      Object.prototype.hasOwnProperty.call(attrs, asciiLower(name));
  },
  // Drop nodes whose ancestor is also in the list (css-select calls
  // this to dedup before iterating; e.g. `:has(...)` results).
  removeSubsets(nodes) {
    const out = nodes.slice();
    let i = out.length;
    while (--i >= 0) {
      let p = out[i]._parent;
      while (p) {
        if (out.includes(p)) { out.splice(i, 1); break; }
        p = p._parent;
      }
    }
    return out;
  },
  findAll(test, nodes) {
    const out = [];
    const visit = el => { if (test(el)) out.push(el); };
    for (const n of nodes) walk(n, visit);
    return out;
  },
  findOne(test, nodes) {
    // `walkFind` short-circuits at the first match; the compiled css-select
    // `test` is a self-contained per-node predicate, so the first pre-order
    // (= document-order) match is exactly `querySelector`'s answer.
    for (const n of nodes) {
      const hit = walkFind(n, test);
      if (hit) return hit;
    }
    return null;
  },
  equals: (a, b) => a === b,
  // `:hover` applies to the hovered element AND every ancestor. We track the
  // last-moused-over node on `document._hoverElement` (set by dispatchHover);
  // `el` is hovered iff it's on that node's ancestor-or-self chain. The cascade
  // matches through css-select now, so this hook is what makes `.x:hover .y`
  // reveal rules resolve after `hover` — the matcher used to own this.
  isHovered: (el) => {
    const hov = globalThis.document && globalThis.document._hoverElement;
    let cur = hov;
    while (cur) { if (cur === el) return true; cur = cur._parent; }
    return false;
  },
  // No real layout / history → `:visited` / `:active` never apply. Their constancy is load-
  // bearing: STATIC_PSEUDOS (cascade.js) classifies both as static because of it — if a pressed
  // or history model ever lands here, the corresponding entry there must leave with it.
  isVisited: () => false,
  isActive:  () => false,
  // `:root` matches ONLY the document's root element (`documentElement`), not
  // any element that merely lacks an element parent — css-select's default
  // (`getElementParent(el) === null`) wrongly matches a DocumentFragment's top
  // child. Our patched `root` filter calls this hook.
  isDocumentRoot: (el) => {
    const doc = el && (el._ownerDoc || globalThis.document);
    return !!doc && doc.documentElement === el;
  }
};

// `:valid` / `:invalid` constraint-validation support: a candidate for constraint validation (`isValidationCandidate`)
// by its validity; a `form` / `fieldset` by whether it CONTAINS an invalid candidate.
// HTML ":read-write" — a MUTABLE control or an editing host; ":read-only" is the
// complement. An <input> of a type the `readonly` attribute applies to (not readonly
// / not actually-disabled), a <textarea> (same), or an element in an editing host.
// "Actually disabled" (own or fieldset) implies read-only, so a disabled control
// matches :read-only (input-disabled-fieldset-dynamic). The readonly-applicable
// input types are the shared READONLY_INPUT_TYPES (form-helpers).
function isReadWriteForMatch(el) {
  const t = el._ns === HTML_NS ? el._tag : null;
  if (t === 'input') return READONLY_INPUT_TYPES.has(inputTypeState(el)) && el._attrs.readonly == null && !isNodeActuallyDisabled(el);
  if (t === 'textarea') return el._attrs.readonly == null && !isNodeActuallyDisabled(el);
  return isContenteditable(el);
}
// HTML ":enabled" — a form UI element (button/input/select/textarea/optgroup/option/
// fieldset OR a form-associated custom element) that is NOT actually disabled. Unlike
// the legacy CSS definition it does NOT match a/area/link (the WPT selectors suite
// asserts :enabled matches no hyperlink elements). css-select's built-in doesn't know
// custom elements, so ":enabled" is redirected here like ":disabled".
const ENABLEABLE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'optgroup', 'option', 'fieldset']);
// The `<input>` types the `placeholder` attribute applies to.
const PLACEHOLDER_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);
function requirable(el) {
  if (el._ns !== HTML_NS) return false;
  const t = el._tag;
  return t === 'input' ? requiredAppliesToInput(el) : t === 'select' || t === 'textarea';
}
function isEnabledForMatch(el) {
  return el._ns === HTML_NS && (ENABLEABLE_TAGS.has(el._tag) || isFormAssociatedCustomElement(el)) && !isNodeActuallyDisabled(el);
}
// A candidate for constraint validation: `willValidate` (dom-nodes.js) — a control of a validating kind that is not
// disabled, not readonly, and not in a `<datalist>` — which a `<form>` reports true of itself but is none.
// A form-associated custom element is one by its internals (`faceWillValidate`).
function isValidationCandidate(el) {
  if (el._ns !== HTML_NS || el._tag === 'form') return false;
  if (isFormAssociatedCustomElement(el)) return faceWillValidate(el);
  return el.willValidate === true;
}
const RANGED_INPUT_TYPES = new Set(['number', 'range', 'date', 'month', 'week', 'time', 'datetime-local']);
function rangeLimited(el) {
  return el._ns === HTML_NS && el._tag === 'input' && RANGED_INPUT_TYPES.has(inputTypeState(el)) &&
    (el._attrs.min != null || el._attrs.max != null) && isValidationCandidate(el);
}
function outOfRange(el) {
  const v = el.validity;
  return !!v && (v.rangeUnderflow || v.rangeOverflow);
}
function controlIsInvalid(el) {
  if (!isValidationCandidate(el)) return false;
  if (isFormAssociatedCustomElement(el)) return el._internals != null && el._internals._validationMessage !== '';
  const v = el.validity;
  return !!v && v.valid === false;
}
// Does this form / fieldset hold an invalid validation candidate? A form by the controls whose form OWNER it is (a
// `form=` one outside it included, one inside it owned by another not); a fieldset by its descendants.
function hasInvalidDescendant(el) {
  if (el._tag === 'form') {
    for (const c of el.elements || []) if (controlIsInvalid(c)) return true;
    return false;
  }
  const stack = el._children ? el._children.slice() : [];
  while (stack.length) {
    const n = stack.pop();
    if (n.nodeType !== NODE_ELEMENT) continue;
    if (controlIsInvalid(n)) return true;
    if (n._children) for (const c of n._children) stack.push(c);
  }
  return false;
}

// CSS Selectors-4 user-action pseudos. `:scope` is intentionally NOT
// overridden — css-select v7 has its own internal `:scope` handling
// that `:has()`'s relative-selector mode depends on; an override
// here would break `:has(.main > span)`-style selectors. Pass a
// `context` array to `cssSelect.compile` when the caller supplied a
// scope root (jQuery UI's `.find('> *')` after normalising).
// An element's language for `:lang()`: the nearest self-or-ancestor language
// declaration walking the light-DOM `_parent` chain, crossing a shadow root to
// its host. An `xml:lang` attribute counts on any element; an unnamespaced `lang`
// attribute counts ONLY on an HTML-namespace element (so a non-HTML element's bare
// `lang` is ignored and it inherits — lang-attribute), and a shadow-tree element
// inherits the host's lang (lang-attribute-shadow). '' when undeclared (the
// Content-Language pragma default and a slotted element's flat-tree slot ancestors
// — vs its light-DOM parent — are not modelled; no vendored test exercises them).
function langOfElement(el) {
  for (let n = el; n; n = n._parent || (n.host || null)) {
    if (n.nodeType === NODE_ELEMENT) {
      const a = n._attrs;
      if (a) {
        // `lang` in the XML namespace, whatever its prefix (a `setAttribute('xml:lang', …)` is an attribute in no
        // namespace, which names no language); then an HTML or SVG element's own `lang`.
        const xml = n._attrNS ? xmlLangOf(n) : null;
        if (xml != null) return xml;
        if ((n._ns === HTML_NS || n._ns === SVG_NS) && a.lang != null) return String(a.lang);
      }
    }
  }
  return '';
}

function xmlLangOf(el) {
  for (const key in el._attrNS) {
    const m = el._attrNS[key];
    if (m && m.ns === XML_NS && m.localName === 'lang' && el._attrs[key] != null) return String(el._attrs[key]);
  }
  return null;
}

// The normalized (trimmed, unquoted, lowercased) range list of a `:lang()` argument,
// cached by argument string so a find over many elements parses it once (rule 3).
const langRangeCache = new Map();
// A `:state()` argument that is one CSS identifier (css-what hands it over with escapes resolved).
const CUSTOM_STATE_IDENT = /^(?:--|-?[A-Za-z_\u0080-\uffff])[-\w\u0080-\uffff]*$/;
function langRanges(arg) {
  let r = langRangeCache.get(arg);
  if (!r) {
    r = String(arg).split(',').map((s) => asciiLower(s.trim().replace(/^["']|["']$/g, ''))).filter(Boolean);
    langRangeCache.set(arg, r);
  }
  return r;
}

// `:lang(range, …)` — RFC 4647 basic filtering: the element's language matches a
// range when it equals it or extends it at a subtag boundary (so `en` and `en-CA`
// match lang `en-CA`, `en-NZ` does not), ASCII case-insensitively. A `*` range
// matches any non-empty language. (Subtag wildcards like `*-CH` aren't modelled.)
function matchesLang(el, arg) {
  const lang = asciiLower(langOfElement(el));
  if (!lang) return false;
  for (const range of langRanges(arg)) {
    if (range === '*' || range === lang || lang.startsWith(range + '-')) return true;
  }
  return false;
}

// css-select ships a built-in `:lang` that ignores the namespace + shadow rules
// above; rename `:lang(…)` to the private `:__csimlang(…)` so our resolver runs.
// CSS pseudo names are ASCII case-insensitive, so the gate matches `:LANG(` too.
function rewriteLang(key) {
  if (!/lang\(/i.test(key)) return null;
  let groups;
  try { groups = cssWhat.parse(key); } catch (_) { return null; }
  let found = false;
  const walk = (list) => {
    for (const tokens of list) for (const t of tokens) {
      if (t.type !== 'pseudo') continue;
      if (typeof t.name === 'string' && t.name.toLowerCase() === 'lang') { t.name = '__csimlang'; found = true; }
      else if (Array.isArray(t.data) && Array.isArray(t.data[0])) walk(t.data);
    }
  };
  walk(groups);
  return found ? cssWhat.stringify(groups) : null;
}

const userPseudos = {
  ...focusPseudoMatchers,
  // `:lang()` via our flat-tree / namespace-aware resolver (see rewriteLang).
  __csimlang: (el, arg) => matchesLang(el, arg),
  // `:state(ident)` — a custom element's custom state (the `<custom-state>` an
  // ElementInternals CustomStateSet holds via `internals.states.add(...)`). Matches
  // when the host element's state set contains the identifier.
  // (Its argument is one identifier, whitespace around it allowed — anything else names no state.)
  state: (el, arg) => {
    const name = String(arg).trim();
    if (!CUSTOM_STATE_IDENT.test(name)) return false;
    const internals = el && el._internals;
    return !!(internals && internals._states && internals._states.has(name));
  },
  // Pseudo-classes css-select doesn't implement natively (it throws "Unknown
  // pseudo-class") but the visibility cascade — and CSS-only UIs — rely on.
  // Ported from the old hand-rolled matcher; required now that the cascade
  // matches through css-select. css-select calls `fn(elem)` for these.
  // :target = the document's target element (target.js): its indicated part for its target fragment — the first
  // element of its tree with that id (else the first `<a name>`), so a second one with the same id, a shadow tree's, and a
  // DOMParser document's are none.
  target: (el) => isTargetElement(el),
  // `:placeholder-shown` — a `<textarea>`, or an `<input>` of a type the `placeholder` applies to, with one and an
  // empty value: the SANITIZED value, as it is shown (`type=number value=abc` and `type=email value="  "` show it).
  'placeholder-shown': (el) => {
    if (el._ns !== HTML_NS || el._attrs.placeholder == null) return false;
    if (el._tag === 'textarea') return controlLiveValue(el) === '';
    return el._tag === 'input' && PLACEHOLDER_INPUT_TYPES.has(inputTypeState(el)) && el.value === '';
  },
  default: (el) => {
    if (el._ns !== HTML_NS) return false;
    // `:default` on an option = the `selected` content attribute
    // (defaultSelected), NOT the live selectedness (which is `:checked` /
    // `:selected` below). Keep reading the content attribute here.
    if (el._tag === 'option') return el._attrs.selected != null;
    if (el._tag === 'input') {
      const t = inputTypeState(el);
      if (t === 'checkbox' || t === 'radio') return el._attrs.checked != null;
    }
    // …and a submit button, only its form's default one — none without a form owner (Chrome, Firefox).
    if (!isSubmitButton(el)) return false;
    const form = formForControl(el);
    return form !== null && defaultButtonOf(form) === el;
  },
  // `:defined` — every built-in element, and every custom element that has upgraded
  // to its definition (an autonomous CE or a customized built-in). A custom element
  // in the "undefined" state (a valid CE name / an `is` value with no matching, or
  // not-yet-applied, definition) does NOT match.
  defined: (el) => elementIsDefined(el),
  // `:open` — a details/dialog with the `open` content attribute. (A select's
  // picker / an input's picker can also be open, but the driver never renders one,
  // so those stay closed → false, matching synthetic interactions.)
  open: (el) => el._ns === HTML_NS && (el._tag === 'details' || el._tag === 'dialog') && el._attrs.open != null,
  // `:filtered` — a customizable-combobox option filtered out by its associated
  // filter `<input>` (set by runComboboxFilter on each input.value change).
  filtered: (el) => hasState(el, STATE_FILTERED),
  // `:disabled` — the HTML "actually disabled" state. css-select's built-in covers
  // own `[disabled]` + an option in a disabled optgroup, but NOT a control/fieldset
  // in a disabled `<fieldset>` nor an option/optgroup in a disabled `<select>`. A
  // function pseudo doesn't override css-select's built-in `:disabled`, so use the
  // STRING-redirect trick (as for `:checked`/`:selected`) to the shared
  // isNodeActuallyDisabled (form-helpers) — the same algorithm `disabled?` uses.
  // A hyperlink (`:any-link`; `:link` too — there is no history, so none is visited): an HTML `a` / `area` with an
  // `href` (HTML "selectors": not a `<link>`, whatever css-select's alias says), or an SVG `<a>` with its `href` or an
  // XLink one (link-href.js).
  'any-link': ':__csimhyperlink',
  '-webkit-any-link': ':__csimhyperlink',   // Chrome's legacy spelling of it
  link: ':__csimhyperlink',
  __csimhyperlink: (el) => (el._ns === HTML_NS
    ? (el._tag === 'a' || el._tag === 'area') && el._attrs.href != null
    : el._ns === SVG_NS && el._localName === 'a' && hrefAttr(el) != null),
  disabled: ':__csimdisabled',
  __csimdisabled: (el) => isNodeActuallyDisabled(el),
  // `:enabled` — mirror of `:disabled` that also covers form-associated custom
  // elements (see isEnabledForMatch); redirected so our resolver replaces the built-in.
  enabled: ':__csimenabled',
  __csimenabled: (el) => isEnabledForMatch(el),
  // `:read-write` / `:read-only` — css-select's built-ins don't treat a
  // fieldset-disabled control as non-editable; redirect to the spec "read-write"
  // check (and its complement) so a disabled control matches `:read-only`.
  'read-write': ':__csimreadwrite',
  __csimreadwrite: (el) => isReadWriteForMatch(el),
  'read-only': ':__csimreadonly',
  __csimreadonly: (el) => !isReadWriteForMatch(el),
  // `:selected` / `:checked` read an option's live *selectedness*, not its
  // `selected` content attribute (a user pick / IDL setter selects without
  // touching the attribute). css-select ships `:selected` / `:checked` as
  // string ALIASES keyed on `[selected]`; a STRING entry in `options.pseudos`
  // takes precedence over an alias (see compilePseudoSelector), so we redirect
  // `:selected` to the function pseudo below. `:checked`'s own alias references
  // `:selected`, so it inherits this fix transitively (its input `[checked]`
  // branch is unaffected).
  selected: ':__csimselected',
  __csimselected: (el) => el._ns === HTML_NS && el._tag === 'option' && el._selectedness === true,
  // `:checked` reads LIVE state — a checkbox/radio's *checkedness* and an
  // option's *selectedness* — not the `checked`/`selected` content attribute (a
  // user click / IDL setter changes the live state without touching the
  // attribute). css-select's built-in `:checked` alias only sees the `[checked]`
  // attribute, so override it the same way as `:selected`: a STRING redirect to
  // a function pseudo (which takes precedence over the alias).
  checked: ':__csimchecked',
  __csimchecked: (el) => {
    if (el._ns !== HTML_NS) return false;
    if (el._tag === 'option') return el._selectedness === true;
    if (el._tag === 'input') {
      const t = inputTypeState(el);
      if (t === 'checkbox' || t === 'radio') return getCheckedness(el);
    }
    return false;
  },
  // `:indeterminate` — a checkbox whose `indeterminate` is set, a radio button whose group has nothing checked, and
  // a `<progress>` with no value (HTML).
  indeterminate: (el) => {
    if (el._ns !== HTML_NS) return false;
    if (el._tag === 'progress') return el._attrs.value == null;
    if (el._tag !== 'input') return false;
    const t = inputTypeState(el);
    if (t === 'checkbox') return hasState(el, STATE_INDETERMINATE);
    return t === 'radio' && !radioGroupHasChecked(el);
  },
  // `:required` / `:optional` — an `<input>` the `required` attribute applies to, a `<select>` or a `<textarea>`, with
  // and without it. css-select's aliases take every `<input>`; an ignored `required` (a hidden or a button input) makes
  // one neither (HTML; Firefox — Chrome calls it optional).
  required: ':__csimrequired',
  __csimrequired: (el) => requirable(el) && el._attrs.required != null,
  optional: ':__csimoptional',
  __csimoptional: (el) => requirable(el) && el._attrs.required == null,
  valid: (el) => {
    if (isValidationCandidate(el)) return !controlIsInvalid(el);
    if (el._tag === 'form' || el._tag === 'fieldset') return !hasInvalidDescendant(el);
    return false;
  },
  invalid: (el) => {
    if (isValidationCandidate(el)) return controlIsInvalid(el);
    if (el._tag === 'form' || el._tag === 'fieldset') return hasInvalidDescendant(el);
    return false;
  },
  // `:user-valid` / `:user-invalid` — the validity-based `:valid` / `:invalid`, but
  // only AFTER the user has interacted with the control (changed its value via the
  // UI). `_userInteracted` is set on a `<select>` by the user-action selection paths
  // (option click, select_option / unselect_option); before any interaction neither
  // matches (select-multiple-validity-invalidation). Wiring it on text-input /
  // checkable user edits (so `input:user-invalid` works) is a follow-up — it needs
  // trusted-interaction tracking on those paths, and no gated test depends on it yet.
  // `:autofill` (and Chrome's `:-webkit-autofill`) — an input the user agent filled in, which the driver never does.
  autofill: () => false,
  '-webkit-autofill': () => false,
  // `:in-range` / `:out-of-range` — an input of a type with a range, a candidate, with a `min` or a `max`: by whether it
  // suffers an underflow or an overflow.
  'in-range':     (el) => rangeLimited(el) && !outOfRange(el),
  'out-of-range': (el) => rangeLimited(el) && outOfRange(el),
  'user-valid':   (el) => hasState(el, STATE_USER_INTERACTED) && isValidationCandidate(el) && !controlIsInvalid(el),
  'user-invalid': (el) => hasState(el, STATE_USER_INTERACTED) && controlIsInvalid(el),
  // `:popover-open` matches an element with a popover attribute whose popover is
  // showing (showPopover flips `_popoverOpen`). `:modal` matches a modal dialog
  // (showModal sets `_modal`) — distinct from a non-modal open `<dialog>`. Both
  // require the element to still be in the document; `:modal` additionally
  // requires the `open` attribute so ANY close path (close(), method=dialog
  // submit, or clearing `open` directly via the IDL setter / removeAttribute)
  // stops the match without each having to reset `_modal`.
  'popover-open': (el) => hasState(el, STATE_POPOVER_OPEN) && isConnected(el),
  modal:          (el) => hasState(el, STATE_MODAL) && el._attrs.open != null && isConnected(el),
  // `:dir(ltr|rtl)` matches an element whose HTML directionality equals the
  // argument (HTML "the directionality" — the dir attribute, dir=auto's
  // first-strong-character resolution, and inheritance — shared with
  // getComputedStyle().direction via Element#_directionality).
  dir: (el, val) => typeof el._directionality === 'function' && el._directionality() === asciiLower(String(val))
};

// css-tree is the strict validation backstop for css-what's leniency — this is
// LOAD-BEARING, do not weaken it. css-what has no ident validation, so it
// accepts forms the Selectors grammar forbids and that a real browser rejects;
// our local css-what EOF-recovery patch widens this (it accepts an unquoted
// value like `[id=0bar` because css-what's EOF throw was the only thing
// rejecting it). css-tree, which DOES validate idents, re-rejects all of these
// after css-what's lenient parse, keeping the driver correct end-to-end.
//
// css-what (css-select's parser) is lenient where the Selectors grammar is
// strict: it accepts a class with a digit-leading or empty name (`.5cm`,
// `..test`, `.foo..quux`), an unquoted attribute value that isn't an ident
// (`[id=0bar]`), a stray `<`, and a top-level leading combinator
// (`>*`, `+ li` — a *relative* selector, valid only inside `:has()` / `:is()`,
// never as a standalone querySelector argument). querySelector / matches must
// throw SyntaxError on all of these (WPT asserts `assert_throws_dom("Syntax-
// Error")`, and a real browser does the same). css-tree's lexer rejects the bad
// idents and stray characters on parse; a top-level leading combinator we catch
// on the AST — a combinator inside `:has(> b)` lives in a nested selector list,
// so only the SelectorList's DIRECT children count. Runs once per distinct
// selector (compile-cached) and only on selectors css-select already accepted —
// pseudo-element / namespaced selectors take the fallback path in `compileRaw`
// and never reach here, so css-tree never sees a form it would wrongly reject.
function rejectInvalidStrict(key) {
  if (typeof key !== 'string' || strictValidated.has(key)) return;
  // CSS tokenizer: a backslash at EOF is a *parse error* that yields U+FFFD, not
  // a syntax error — `#eof\` is the valid selector `#eof�`. css-what applies
  // this (so the actual match is correct); css-tree throws on the lone trailing
  // backslash. Mirror the tokenizer here so validation agrees: an odd run of
  // trailing backslashes ends in a lone one → replace it with U+FFFD.
  let probe = key;
  const tail = probe.match(/\\+$/);
  if (tail && tail[0].length % 2 === 1) probe = probe.slice(0, -1) + '�';
  let ast;
  try { ast = cssTree.parse(probe, {context: 'selectorList'}); }
  catch (e) { throw new globalThis.DOMException('csim: ' + (e && e.message ? e.message : e), 'SyntaxError'); }
  ast.children.forEach(sel => {
    const first = sel.children && sel.children.first;
    if (first && first.type === 'Combinator') {
      throw new globalThis.DOMException('csim: a relative selector is not allowed here', 'SyntaxError');
    }
  });
  strictValidated.add(key);
}

// Two compile caches: scope-free (most selectors) and per-scope (for
// `:scope`-bearing selectors — css-select bakes the context into the
// compiled query, so the function isn't reusable across scope roots).
// Each keyed per document MODE too, which css-select decides at compile time: in a quirks-mode document a class or
// id selector matches ASCII case-insensitively (Selectors 4 §6.6 / §6.7, `quirksMode`), and in an XML one no type
// selector or attribute value folds case (`htmlDocument`, a patched option).
const MODE_QUIRKS = 1, MODE_XML = 2;
const compiledCacheByMode  = [new Map(), new Map(), new Map(), new Map()];
const compiledCacheScoped  = new WeakMap();
// The mode of `node`'s document — what a selector matched against it is compiled for.
function modeOf(node) {
  const doc = node && (node.nodeType === NODE_DOC ? node : (node._ownerDoc || globalThis.document));
  if (!doc) return 0;
  return (doc._quirks ? MODE_QUIRKS : 0) | (isHtmlDocument(doc) ? 0 : MODE_XML);
}
function selectOptions(pseudos, mode) {
  return {adapter, pseudos, cacheResults: false, lowerCaseAttributeNames: false,
          quirksMode: (mode & MODE_QUIRKS) !== 0, htmlDocument: (mode & MODE_XML) === 0};
}

// Pass `context` to css-select only when the selector actually needs
// `:scope` semantics — passing it on a vanilla selector like
// `table tbody tr td` makes css-select prepend `:scope ` to the rule,
// which then requires the scope element to sit ABOVE the outermost
// compound. Real-browser `tr.querySelectorAll('table tbody tr td')`
// returns the descendant tds regardless of where tr sits in the
// ancestor chain (verified against Chrome 137).
function selectorNeedsScope(key) {
  return key.indexOf(':scope') !== -1;
}

// Functional pseudos that introduce a nested selector list. A literal `:scope`
// appearing inside one of these still refers to the OUTER scoping root (the
// element `closest`/`matches`/`querySelector` was scoped to), per Selectors-4.
const SCOPE_NESTING_PSEUDOS = new Set(['has', 'is', 'where', 'not', 'matches']);

// Rebind every `:scope` nested inside a functional pseudo to the private
// `:__csimscope` pseudo. css-select binds a literal `:scope` to whatever context
// the enclosing `:has()` rebinds for its own relative anchor, so `:has(> :scope)`
// resolves `:scope` to the `:has` subject instead of the scoping root and can
// never match (verified: real browsers return the scope's parent). The private
// pseudo is matched by element identity against the scope root (see the
// per-scope branch of `compile`). A top-level `:scope` is left as-is —
// css-select's native context handling is correct there, so the caller keeps
// passing the scope root as context whenever a top-level `:scope` survives.
// Returns the rewritten selector string, or null when there's no nested `:scope`
// to rebind.
//
// A nested `:scope` can only live inside a functional pseudo, which always
// serializes with a `(`; bail before the css-what parse when there's none, so
// the hot `within(row) { find(':scope > .cell') }` pattern (a fresh scope root
// per row → all cache misses) never pays an extra parse.
function rebindNestedScope(key) {
  if (key.indexOf('(') === -1) return null;
  let groups;
  try { groups = cssWhat.parse(key); } catch (_) { return null; }
  let found = false;
  const walk = (list, nested) => {
    for (const tokens of list) for (const t of tokens) {
      if (t.type !== 'pseudo') continue;
      if (nested && t.name === 'scope') { t.name = '__csimscope'; found = true; }
      if (Array.isArray(t.data) && Array.isArray(t.data[0])) {
        walk(t.data, nested || SCOPE_NESTING_PSEUDOS.has(t.name));
      }
    }
  };
  walk(groups, false);
  return found ? cssWhat.stringify(groups) : null;
}

function compile(sel, scopeRoot, mode) {
  // The selector arg is a WebIDL DOMString: `querySelector(null)` queries for
  // the type selector `"null"`, `(undefined)` for `"undefined"` \u2014 coerce here
  // (the chokepoint for querySelector / matches / closest) so a non-string
  // never reaches the string ops below as a TypeError.
  if (typeof sel !== 'string') sel = String(sel);
  // CSS "filter code points" preprocessing: a literal NULL in the selector
  // string becomes U+FFFD (css-what doesn't preprocess the input stream).
  // Lone surrogates are left alone here to avoid splitting a valid pair.
  if (sel.indexOf('\x00') !== -1) sel = sel.replace(/\x00/g, '\uFFFD');
  const key = sel;
  // An empty / whitespace-only selector is a parse error (SyntaxError), not a
  // match-nothing \u2014 css-select accepts it, so reject it here.
  if (key.trim() === '') {
    throw new globalThis.DOMException("csim: '' is not a valid selector", 'SyntaxError');
  }
  if (scopeRoot == null || !selectorNeedsScope(key)) {
    const cache = compiledCacheByMode[mode];
    const fn = cache.get(key);
    if (typeof fn === 'function') return fn;
    // Negative entry: this selector already failed to compile. Compilation is
    // deterministic per key, so rethrow the recorded SyntaxError without
    // re-running css-select + both fallbacks — the cascade probes every rule's
    // selector against every candidate element, so an invalid selector in a hot
    // stylesheet would otherwise pay the full compile-and-throw per probe. A
    // FRESH DOMException per throw: the caller can observe (and mutate) what
    // querySelector throws, so a shared instance would leak state across calls.
    if (fn) throw new globalThis.DOMException(fn.message, 'SyntaxError');
    try {
      const compiled = compileRaw(key, undefined, userPseudos, key, mode);
      cache.set(key, compiled);
      return compiled;
    } catch (e) {
      if (e instanceof globalThis.DOMException && e.name === 'SyntaxError') {
        cache.set(key, { message: e.message });
      }
      throw e;
    }
  }
  // …per mode too: a scope root can be adopted into a document of another mode.
  let perKey = compiledCacheScoped.get(scopeRoot);
  if (!perKey) { perKey = new Map(); compiledCacheScoped.set(scopeRoot, perKey); }
  const modeKey = mode + '\x04' + key;
  let fn = perKey.get(modeKey);
  if (fn) return fn;
  const rewritten = rebindNestedScope(key);
  if (rewritten != null) {
    // Resolve `:__csimscope` to the scope root by identity. Pass css-select a
    // context only when a top-level `:scope` survived the rewrite (it binds
    // natively there); with no surviving top-level `:scope`, a context would make
    // css-select absolutize the scope-free top-level compound into a
    // descendant-of-context match (wrong for `closest`, which walks ancestors).
    // Strict validation runs on the ORIGINAL key — `:__csimscope` would trip
    // css-tree's unknown-pseudo check.
    const ctx = rewritten.indexOf(':scope') !== -1 ? [scopeRoot] : undefined;
    const pseudos = { ...userPseudos, __csimscope: (el) => el === scopeRoot };
    fn = compileRaw(rewritten, ctx, pseudos, key, mode);
  } else {
    fn = compileRaw(key, [scopeRoot], userPseudos, key, mode);
  }
  perKey.set(modeKey, fn);
  return fn;
}

// Recognised pseudo-elements: VALID selectors that match no real element, so
// `querySelector('::before')` must return null (and `el.matches('::before')`
// false) — NOT throw. css-what normalises the legacy single-colon forms
// (`:before`) to pseudo-elements too, so one set covers both syntaxes. Unknown
// (`::example`) and malformed (`:::before`, `:: before`) pseudo-elements stay
// invalid and rethrow as syntax errors.
const KNOWN_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter', 'slotted']);
function targetsPseudoElement(arm) {
  let groups;
  try { groups = cssWhat.parse(arm); }
  catch (_) {
    // The ONLY css-what-unparseable selector that's still valid (matches
    // nothing) is an unclosed `::slotted(…`. Match exactly that shape — every
    // other parse failure is a genuine syntax error that must keep throwing
    // (`::before[`, `div::before)`, `::before >>>`, …).
    return /::slotted\([^)]*$/i.test(arm);
  }
  return (groups[0] || []).some(t => t.type === 'pseudo-element' && KNOWN_PSEUDO_ELEMENTS.has((t.name || '').toLowerCase()));
}

// `pseudos` defaults to the shared matcher set; the per-scope path passes a copy
// carrying the identity-bound `:__csimscope`. `strictKey` is the selector css-tree
// validates — it defaults to `key`, but the per-scope path passes the ORIGINAL
// (`:scope`) selector since the rewritten `:__csimscope` form would trip the
// unknown-pseudo check.
function compileRaw(key, context, pseudos = userPseudos, strictKey = key, mode = 0) {
  // Route `:lang(…)` through our resolver (strictKey stays the original for the
  // unknown-pseudo validation, which doesn't know `:__csimlang`).
  const langKey = rewriteLang(key);
  if (langKey != null) key = langKey;
  let fn;
  try {
    fn = cssSelect.compile(key, selectOptions(pseudos, mode), context);
  } catch (e) {
    // css-select rejects pseudo-element selectors. Per spec they're valid and
    // match no element, so drop any pseudo-element arm of the list and OR the
    // rest. If nothing targets a known pseudo-element, the throw is a genuine
    // syntax error — rethrow with the `csim:` prefix so Ruby's
    // `invalid_selector_error?` catches it uniformly.
    const f = pseudoElementFallback(key, context, pseudos, mode);
    if (f) return f;
    const nsFn = namespaceFallback(key, context, pseudos, mode);
    if (nsFn) return nsFn;
    // A DOMException named SyntaxError — what `querySelector`/`matches` must
    // throw for an invalid selector (WPT asserts `assert_throws_dom("Syntax-
    // Error", …)`). The `csim: ` message prefix is preserved so Ruby's
    // `invalid_selector_error?` still recognises it.
    throw new globalThis.DOMException('csim: ' + (e && e.message ? e.message : e), 'SyntaxError');
  }
  // css-select accepted the selector, but css-what's grammar is looser than the
  // spec's; reject (SyntaxError) anything css-tree's stricter lexer rejects.
  rejectInvalidStrict(strictKey);
  return fn;
}

// Does an attribute value satisfy a css-what attribute token's action/value?
// Mirrors css-select's substring matchers; `ignoreCase` is honoured only when
// css-what sets it (an explicit `i` flag) — namespaced attributes live on SVG /
// MathML, which are case-sensitive.
function attrValueMatches(token, value) {
  if (value == null) return false;
  if (token.action === 'exists') return true;
  let v = String(value), target = token.value;
  if (token.ignoreCase === true) { v = asciiLower(v); target = asciiLower(target); }
  switch (token.action) {
    case 'equals':  return v === target;
    case 'start':   return target !== '' && v.startsWith(target);
    case 'end':     return target !== '' && v.endsWith(target);
    case 'any':     return target !== '' && v.indexOf(target) !== -1;
    case 'element': return target !== '' && asciiTokens(v).indexOf(target) !== -1;   // ~=
    case 'hyphen':  return v === target || v.startsWith(target + '-');               // |=
    case 'not':     return v !== target;                                             // != (non-standard)
    default:        return false;
  }
}

// `[*|attr]` matches an attribute with this LOCAL NAME in any namespace. css-select
// keys attributes by their stored (qualified) name, so a namespaced attribute
// (`xlink:href`, keyed `xlink:href`) is invisible to a bare `[href]`; match by
// local name against `_attrNS` (sparse — only namespaced / prefixed attrs carry
// metadata, so a plain attribute's local name is its key).
function matchNsAttr(el, token) {
  const attrs = el._attrs, nsMeta = el._attrNS;
  // HTML elements match attribute names ASCII case-insensitively; SVG / MathML
  // (where namespaced attributes actually live) are case-sensitive.
  const html = el._ns === HTML_NS;
  const want = html ? asciiLower(token.name) : token.name;
  for (const key in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
    const meta = nsMeta && nsMeta[key];
    const ln = meta ? meta.localName : key;
    if ((html ? asciiLower(ln) : ln) !== want) continue;
    if (attrValueMatches(token, attrs[key])) return true;
  }
  return false;
}

// css-select rejects namespaced tag names AND namespaced attributes ("not yet
// supported"), but css-what parses them and we track `namespaceURI`. Per
// Selectors: `*|name` = any namespace (= match by local name), `|name` = no
// namespace (null namespaceURI — and for attributes css-what already collapses
// `[|attr]` / `[attr]` to a null namespace, the correct default), `prefix|name` =
// an undeclared prefix (querySelector has no namespace map) → invalid →
// SyntaxError. Strip the namespace from tag tokens so css-select can compile;
// match any-namespace attribute tokens (`[*|attr]`) on the SUBJECT compound with
// `matchNsAttr`; post-filter the SUBJECT for the no-namespace tag case.
//
// Approximations (uncovered by WPT, which only puts the namespace on the
// subject): a no-namespace constraint on a NON-subject compound (`|a div`) is
// dropped → matched as any-namespace; a namespaced arm inside a selector LIST
// (`*|div, span`) falls through and rethrows; an `[*|attr]` on a NON-subject
// compound (`[*|href] div`) rethrows as SyntaxError.
function namespaceFallback(key, context, pseudos = userPseudos, mode = 0) {
  let groups;
  try { groups = cssWhat.parse(key); } catch (_) { return null; }
  if (groups.length !== 1) return null;          // single complex selector only
  const group = groups[0];
  let lastComb = -1;
  for (let i = 0; i < group.length; i++) if (cssWhat.isTraversal(group[i])) lastComb = i;
  let hasNs = false, subjectNoNs = false;
  const subjectNsAttrs = [];                     // `[*|attr]` tokens on the subject compound
  for (let i = 0; i < group.length; i++) {
    const t = group[i];
    if (t.type === 'attribute' && t.namespace === '*') {
      if (i <= lastComb) return null;            // non-subject `[*|attr]` unsupported → SyntaxError
      hasNs = true;
      subjectNsAttrs.push(t);
      group[i] = null;                           // drop from what css-select compiles
      continue;
    }
    if (t.namespace == null) continue;
    hasNs = true;
    if (t.namespace !== '*' && t.namespace !== '') return null;   // undeclared prefix → rethrow → SyntaxError
    // `|tag` / `|*` on the subject compound requires the matched element itself
    // to be in no namespace.
    if (t.namespace === '' && (t.type === 'tag' || t.type === 'universal') && i > lastComb) subjectNoNs = true;
    t.namespace = null;
  }
  if (!hasNs) return null;
  // Dropping the subject's `[*|attr]` tokens can empty its compound; css-select
  // needs a universal there to match (the predicates then filter).
  const subject = group.filter(Boolean);
  if (subject.length === 0 || cssWhat.isTraversal(subject[subject.length - 1])) {
    subject.push({ type: 'universal', namespace: null });
  }
  groups[0] = subject;
  let compiled;
  try { compiled = cssSelect.compile(cssWhat.stringify(groups), selectOptions(pseudos, mode), context); }
  catch (_) { return null; }
  if (!subjectNoNs && subjectNsAttrs.length === 0) return compiled;
  return (el) => {
    if (!compiled(el)) return false;
    if (subjectNoNs && el.namespaceURI != null) return false;
    for (const t of subjectNsAttrs) if (!matchNsAttr(el, t)) return false;
    return true;
  };
}

function pseudoElementFallback(key, context, pseudos = userPseudos, mode = 0) {
  const arms = splitTopLevel(key, ',').map(a => a.trim()).filter(Boolean);
  if (!arms.some(targetsPseudoElement)) return null;   // not our case — rethrow
  const fns = [];
  for (const arm of arms) {
    if (targetsPseudoElement(arm)) continue;           // matches no element
    try { fns.push(cssSelect.compile(arm, selectOptions(pseudos, mode), context)); }
    catch (_) { return null; }                         // a non-PE arm is itself invalid → real syntax error
  }
  if (fns.length === 0) return () => false;
  if (fns.length === 1) return fns[0];
  return (el) => fns.some(f => f(el));
}

// ── namespace-aware matching for cascade rules (@namespace) ──────────────────
// The `ns` map (`{ default, prefixes }`) is round-tripped through JSON by the cross-visit
// cascade cache (rebuildCascade), so `prefixes` MUST be a plain object, not a Map — a Map
// serializes to `{}` and the namespace resolution silently breaks on a cache hit.
const ANY_NS = Symbol('any-ns');
const nsMatcherCache = new Map();
function nsSignature(ns) {
  // Delimit with control chars that can't appear in a namespace URI / prefix, so two
  // distinct prefix maps can't collide to one signature (a URI query string can hold
  // `=`/`;`, which would).
  let s = (ns.default == null ? '' : ns.default) + '\x00';
  if (ns.prefixes) { const parts = []; for (const k in ns.prefixes) parts.push(k + '\x02' + ns.prefixes[k]); s += parts.sort().join('\x03'); }
  return s;
}
function buildNsMatcher(selectorText, ns, mode) {
  let groups;
  try { groups = cssWhat.parse(selectorText); } catch (_) { return null; }
  if (groups.length !== 1) return null;
  const group = groups[0].map(t => ({ ...t }));
  let lastComb = -1;
  for (let i = 0; i < group.length; i++) if (cssWhat.isTraversal(group[i])) lastComb = i;
  let constraint = ns.default == null ? ANY_NS : ns.default;
  let bad = false;
  for (let i = 0; i < group.length; i++) {
    const t = group[i];
    if (t.namespace == null) continue;
    if (i > lastComb && (t.type === 'tag' || t.type === 'universal')) {
      if (t.namespace === '*') constraint = ANY_NS;
      else if (t.namespace === '') constraint = null;
      else { const uri = ns.prefixes && ns.prefixes[t.namespace]; if (uri == null) bad = true; else constraint = uri; }
    }
    // A namespaced ATTRIBUTE token (`[svg|href]`) has its namespace dropped here — matched
    // by qualified name in any namespace, and an undeclared attribute prefix isn't rejected.
    // A bounded limitation (namespaced-attribute CSS rules are rare); the subject-element
    // namespace above is the case the tests and real @namespace sheets exercise.
    t.namespace = null;
  }
  if (bad) return () => false;
  let compiled;
  try { compiled = cssSelect.compile(cssWhat.stringify([group]), selectOptions(userPseudos, mode)); }
  catch (_) { return null; }
  if (constraint === ANY_NS) return compiled;
  return (el) => compiled(el) && (el._ns || HTML_NS) === constraint;
}
export function matchesSelectorNS(el, selectorText, ns) {
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  const mode = modeOf(el);
  const key = mode + '\x04' + selectorText + '\x01' + nsSignature(ns);
  let fn = nsMatcherCache.get(key);
  if (fn === undefined) { fn = buildNsMatcher(selectorText, ns, mode); nsMatcherCache.set(key, fn); }
  if (fn === null) return matchesSelector(el, selectorText);
  return fn(el);
}

export function selectAll(roots, sel, scopeRoot) {
  return adapter.findAll(compile(sel, scopeRoot, modeOf(scopeRoot || roots[0])), roots);
}
export function selectFirst(roots, sel, scopeRoot) {
  return adapter.findOne(compile(sel, scopeRoot, modeOf(scopeRoot || roots[0])), roots);
}
export function matchesSelector(el, sel) {
  // `el.matches(sel)` / `el.closest(sel)` scope `:scope` to `el` itself (the
  // context object). Pass `el` as the scope root; `compile` only takes the
  // per-scope path when the selector actually contains `:scope`, so non-scoped
  // selectors keep the fast shared cache.
  return el && el.nodeType === NODE_ELEMENT && compile(sel, el, modeOf(el))(el);
}
export function closestSelector(el, sel) {
  const fn = compile(sel, el, modeOf(el));
  for (let cur = el; cur; cur = cur._parent) {
    if (cur.nodeType === NODE_ELEMENT && fn(cur)) return cur;
  }
  return null;
}
