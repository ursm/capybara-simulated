// css-select v7 adapter speaking our Node / Element model. Compiled
// selectors are memoised because Capybara emits a small recurring
// set per suite.
//
// The cascade-rule engine in `bridge.entry.js` still uses the
// hand-rolled `parseSelector` / `matchOne` pair — that path will
// migrate alongside subsequent modular splits.

import { NODE_ELEMENT, NODE_COMMENT, NODE_PI } from './constants.js';
import { walk, walkFind, isConnected } from './walk.js';
import { splitTopLevel }      from './css-utils.js';

const cssSelect     = globalThis.__csimVendor.cssSelect;
const cssWhat       = globalThis.__csimVendor.cssWhat;
const cssTree       = globalThis.__csimVendor.cssTree;

// Attribute-name case-sensitivity is per-element, not per-selector: an HTML
// element matches `[viewBox]` / `[VIEWBOX]` / `[viewbox]` alike (names folded to
// the lowercased stored key), while an SVG / MathML element matches only the
// exact case. css-select's `lowerCaseAttributeNames` is global, so it's turned
// OFF (see the compile options) and the adapter does the per-element folding.
const HTML_NS    = 'http://www.w3.org/1999/xhtml';
const asciiLower = (s) => s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));

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
  // No real layout / history → `:visited` / `:active` never apply.
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

// `:valid` / `:invalid` constraint-validation support. A "candidate for
// constraint validation" is a form control NOT barred from validation
// (HTML §4.10.22.3): input (except hidden / reset / button types), textarea,
// select, and submit-state button — minus disabled / readonly. `form` and
// `fieldset` elements match `:invalid` when they OWN / CONTAIN such a candidate
// that doesn't satisfy its constraints, and `:valid` otherwise.
const BARRED_INPUT_TYPES  = new Set(['hidden', 'reset', 'button']);
const BARRED_BUTTON_TYPES = new Set(['reset', 'button']);
// An element is disabled if it carries `disabled`, OR it descends from a
// `<fieldset disabled>` while NOT inside that fieldset's first `<legend>` child
// (HTML "disabled element" — the same rule css-select's `:disabled` alias uses).
function isInFirstLegend(el, fieldset) {
  let legend = null;
  if (fieldset._children) {
    for (const c of fieldset._children) {
      if (c.nodeType === NODE_ELEMENT && c._tag === 'legend') { legend = c; break; }
    }
  }
  if (!legend) return false;
  for (let p = el; p; p = p._parent) {
    if (p === legend) return true;
    if (p === fieldset) return false;
  }
  return false;
}
function isEffectivelyDisabled(el) {
  if (el._attrs.disabled != null) return true;
  for (let p = el._parent; p; p = p._parent) {
    if (p._tag === 'fieldset' && p._attrs.disabled != null && !isInFirstLegend(el, p)) return true;
  }
  return false;
}
function isValidationCandidate(el) {
  const t = el._tag;
  let barred;
  if (t === 'input')       barred = BARRED_INPUT_TYPES.has((el._attrs.type || '').toLowerCase());
  else if (t === 'button') barred = BARRED_BUTTON_TYPES.has((el._attrs.type || '').toLowerCase());
  else if (t === 'textarea' || t === 'select') barred = false;
  else return false;
  if (barred) return false;
  // `readonly` bars only input / textarea (it has no effect on select / button).
  if ((t === 'input' || t === 'textarea') && el._attrs.readonly != null) return false;
  return !isEffectivelyDisabled(el);
}
function controlIsInvalid(el) {
  if (!isValidationCandidate(el)) return false;
  const v = el.validity;
  return !!v && v.valid === false;
}
// Any descendant of a form / fieldset that is an invalid validation candidate.
// Approximation: ownership is by tree containment, not the form-association
// model — a descendant whose `form=` attribute points at a DIFFERENT form, or a
// control inside a (malformed) nested form, is still counted. No app pairs that
// shape with a `:valid` / `:invalid` cascade rule.
function hasInvalidDescendant(el) {
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
const userPseudos = {
  ...focusPseudoMatchers,
  // Pseudo-classes css-select doesn't implement natively (it throws "Unknown
  // pseudo-class") but the visibility cascade — and CSS-only UIs — rely on.
  // Ported from the old hand-rolled matcher; required now that the cascade
  // matches through css-select. css-select calls `fn(elem)` for these.
  // :target = the element whose id matches the document's URL fragment. The
  // element must be IN the document (a detached / DocumentFragment clone with
  // the same id is not the target). The fragment comes from the element's OWN
  // document: a nested frame document carries its src URL (incl. #fragment) on
  // `_url`; the main document's fragment lives on the shared `location`.
  target: (el) => {
    const id = el._attrs.id;
    if (!id || !isConnected(el)) return false;
    const doc = el._ownerDoc;
    let hash = '';
    if (doc && doc._url) {
      try { hash = new URL(doc._url).hash; } catch (_) { hash = ''; }
    } else {
      hash = (globalThis.location && globalThis.location.hash) || '';
    }
    if (hash.length <= 1) return false;
    let frag = hash.slice(1);
    try { frag = decodeURIComponent(frag); } catch (_) { /* malformed %-escape: compare raw */ }
    return frag === id;
  },
  'placeholder-shown': (el) => {
    if (el._tag !== 'input' && el._tag !== 'textarea') return false;
    if (el._attrs.placeholder == null) return false;
    const v = el._attrs.value;
    return v == null || v === '';
  },
  default: (el) => {
    // `:default` on an option = the `selected` content attribute
    // (defaultSelected), NOT the live selectedness (which is `:checked` /
    // `:selected` below). Keep reading the content attribute here.
    if (el._tag === 'option') return el._attrs.selected != null;
    if (el._tag === 'input') {
      const t = (el._attrs.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return el._attrs.checked != null;
      if (t === 'submit' || t === 'image') return true;
    }
    if (el._tag === 'button') return (el._attrs.type || 'submit').toLowerCase() === 'submit';
    return false;
  },
  // `:selected` / `:checked` read an option's live *selectedness*, not its
  // `selected` content attribute (a user pick / IDL setter selects without
  // touching the attribute). css-select ships `:selected` / `:checked` as
  // string ALIASES keyed on `[selected]`; a STRING entry in `options.pseudos`
  // takes precedence over an alias (see compilePseudoSelector), so we redirect
  // `:selected` to the function pseudo below. `:checked`'s own alias references
  // `:selected`, so it inherits this fix transitively (its input `[checked]`
  // branch is unaffected).
  selected: ':__csimselected',
  __csimselected: (el) => el._tag === 'option' && el._selectedness === true,
  indeterminate: (el) => el._indeterminate === true,
  valid: (el) => {
    if (isValidationCandidate(el)) { const v = el.validity; return !v || v.valid !== false; }
    if (el._tag === 'form' || el._tag === 'fieldset') return !hasInvalidDescendant(el);
    return false;
  },
  invalid: (el) => {
    if (isValidationCandidate(el)) return controlIsInvalid(el);
    if (el._tag === 'form' || el._tag === 'fieldset') return hasInvalidDescendant(el);
    return false;
  },
  'user-valid':   () => true,
  'user-invalid': () => false,
  // `:popover-open` matches an element with a popover attribute whose popover is
  // showing (showPopover flips `_popoverOpen`). `:modal` matches a modal dialog
  // (showModal sets `_modal`) — distinct from a non-modal open `<dialog>`. Both
  // require the element to still be in the document; `:modal` additionally
  // requires the `open` attribute so ANY close path (close(), method=dialog
  // submit, or clearing `open` directly via the IDL setter / removeAttribute)
  // stops the match without each having to reset `_modal`.
  'popover-open': (el) => el._popoverOpen === true && isConnected(el),
  modal:          (el) => el._modal === true && el._attrs.open != null && isConnected(el)
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
const compiledCacheNoScope = new Map();
const compiledCacheScoped  = new WeakMap();

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

function compile(sel, scopeRoot) {
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
    let fn = compiledCacheNoScope.get(key);
    if (fn) return fn;
    fn = compileRaw(key);
    compiledCacheNoScope.set(key, fn);
    return fn;
  }
  let perKey = compiledCacheScoped.get(scopeRoot);
  if (!perKey) { perKey = new Map(); compiledCacheScoped.set(scopeRoot, perKey); }
  let fn = perKey.get(key);
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
    fn = compileRaw(rewritten, ctx, pseudos, key);
  } else {
    fn = compileRaw(key, [scopeRoot]);
  }
  perKey.set(key, fn);
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
function compileRaw(key, context, pseudos = userPseudos, strictKey = key) {
  let fn;
  try {
    fn = cssSelect.compile(key, {adapter, pseudos, cacheResults: false, lowerCaseAttributeNames: false}, context);
  } catch (e) {
    // css-select rejects pseudo-element selectors. Per spec they're valid and
    // match no element, so drop any pseudo-element arm of the list and OR the
    // rest. If nothing targets a known pseudo-element, the throw is a genuine
    // syntax error — rethrow with the `csim:` prefix so Ruby's
    // `syntax_or_invalid_selector_error?` catches it uniformly.
    const f = pseudoElementFallback(key, context, pseudos);
    if (f) return f;
    const nsFn = namespaceFallback(key, context, pseudos);
    if (nsFn) return nsFn;
    // A DOMException named SyntaxError — what `querySelector`/`matches` must
    // throw for an invalid selector (WPT asserts `assert_throws_dom("Syntax-
    // Error", …)`). The `csim: ` message prefix is preserved so Ruby's
    // `syntax_or_invalid_selector_error?` still recognises it.
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
  if (token.ignoreCase === true) { v = v.toLowerCase(); target = target.toLowerCase(); }
  switch (token.action) {
    case 'equals':  return v === target;
    case 'start':   return target !== '' && v.startsWith(target);
    case 'end':     return target !== '' && v.endsWith(target);
    case 'any':     return target !== '' && v.indexOf(target) !== -1;
    case 'element': return target !== '' && v.split(/\s+/).indexOf(target) !== -1;   // ~=
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
function namespaceFallback(key, context, pseudos = userPseudos) {
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
  try { compiled = cssSelect.compile(cssWhat.stringify(groups), {adapter, pseudos, cacheResults: false, lowerCaseAttributeNames: false}, context); }
  catch (_) { return null; }
  if (!subjectNoNs && subjectNsAttrs.length === 0) return compiled;
  return (el) => {
    if (!compiled(el)) return false;
    if (subjectNoNs && el.namespaceURI != null) return false;
    for (const t of subjectNsAttrs) if (!matchNsAttr(el, t)) return false;
    return true;
  };
}

function pseudoElementFallback(key, context, pseudos = userPseudos) {
  const arms = splitTopLevel(key, ',').map(a => a.trim()).filter(Boolean);
  if (!arms.some(targetsPseudoElement)) return null;   // not our case — rethrow
  const fns = [];
  for (const arm of arms) {
    if (targetsPseudoElement(arm)) continue;           // matches no element
    try { fns.push(cssSelect.compile(arm, {adapter, pseudos, cacheResults: false, lowerCaseAttributeNames: false}, context)); }
    catch (_) { return null; }                         // a non-PE arm is itself invalid → real syntax error
  }
  if (fns.length === 0) return () => false;
  if (fns.length === 1) return fns[0];
  return (el) => fns.some(f => f(el));
}

export function selectAll(roots, sel, scopeRoot) {
  return adapter.findAll(compile(sel, scopeRoot), roots);
}
export function selectFirst(roots, sel, scopeRoot) {
  return adapter.findOne(compile(sel, scopeRoot), roots);
}
export function matchesSelector(el, sel) {
  // `el.matches(sel)` / `el.closest(sel)` scope `:scope` to `el` itself (the
  // context object). Pass `el` as the scope root; `compile` only takes the
  // per-scope path when the selector actually contains `:scope`, so non-scoped
  // selectors keep the fast shared cache.
  return el && el.nodeType === NODE_ELEMENT && compile(sel, el)(el);
}
export function closestSelector(el, sel) {
  const fn = compile(sel, el);
  for (let cur = el; cur; cur = cur._parent) {
    if (cur.nodeType === NODE_ELEMENT && fn(cur)) return cur;
  }
  return null;
}
