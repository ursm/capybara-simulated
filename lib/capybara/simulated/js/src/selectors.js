// css-select v7 adapter speaking our Node / Element model. Compiled
// selectors are memoised because Capybara emits a small recurring
// set per suite.
//
// The cascade-rule engine in `bridge.entry.js` still uses the
// hand-rolled `parseSelector` / `matchOne` pair — that path will
// migrate alongside subsequent modular splits.

import { NODE_ELEMENT }       from './constants.js';
import { walk, walkFind }     from './walk.js';
import { focusPseudoMatchers } from './selector-parser.js';

const cssSelect     = globalThis.__csimVendor.cssSelect;
const compiledCache = new Map();

const adapter = {
  isTag: (n) => n && n.nodeType === NODE_ELEMENT,
  existsOne(test, elems)        { return this.findOne(test, elems) !== null; },
  getAttributeValue: (el, name) => el._attrs[name] == null ? undefined : el._attrs[name],
  getChildren:       (n)        => n._children,
  getName:           (el)       => el._tag,
  getParent:         (n)        => n._parent,
  getSiblings:       (n)        => n._parent ? n._parent._children : [n],
  prevElementSibling:(n)        => n.previousElementSibling,
  getText:           (n)        => n.textContent,
  hasAttrib:         (el, name) => Object.prototype.hasOwnProperty.call(el._attrs, name),
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
  isActive:  () => false
};

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
  target: (el) => {
    const id = el._attrs.id;
    if (!id) return false;
    const hash = (globalThis.location && globalThis.location.hash) || '';
    return hash.length > 1 && hash.slice(1) === id;
  },
  'placeholder-shown': (el) => {
    if (el._tag !== 'input' && el._tag !== 'textarea') return false;
    if (el._attrs.placeholder == null) return false;
    const v = el._attrs.value;
    return v == null || v === '';
  },
  default: (el) => {
    if (el._tag === 'option') return el._attrs.selected != null;
    if (el._tag === 'input') {
      const t = (el._attrs.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return el._attrs.checked != null;
      if (t === 'submit' || t === 'image') return true;
    }
    if (el._tag === 'button') return (el._attrs.type || 'submit').toLowerCase() === 'submit';
    return false;
  },
  indeterminate: (el) => el._indeterminate === true,
  valid:        () => true,
  invalid:      () => false,
  'user-valid':   () => true,
  'user-invalid': () => false
};

// Selectors that start with a combinator (`> *`, `+ li`, `~ span`)
// are relative to the context — jQuery's `.find('> *')` exercises
// this. css-select expects `:scope <combinator> …`; normalise here
// so callers don't have to remember.
function normaliseScopedSelector(sel) {
  if (typeof sel !== 'string') return sel;
  const trimmed = sel.replace(/^\s+/, '');
  if (trimmed.startsWith('>') || trimmed.startsWith('+') || trimmed.startsWith('~')) {
    return ':scope ' + trimmed;
  }
  return sel;
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

function compile(sel, scopeRoot) {
  // CSS "filter code points" preprocessing: a literal NULL in the selector
  // string becomes U+FFFD (css-what doesn't preprocess the input stream).
  // Lone surrogates are left alone here to avoid splitting a valid pair.
  if (typeof sel === 'string' && sel.indexOf('\x00') !== -1) sel = sel.replace(/\x00/g, '\uFFFD');
  const key = normaliseScopedSelector(sel);
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
  fn = compileRaw(key, [scopeRoot]);
  perKey.set(key, fn);
  return fn;
}

function compileRaw(key, context) {
  try {
    return cssSelect.compile(key, {adapter, pseudos: userPseudos, cacheResults: false}, context);
  } catch (e) {
    // Rethrow with a `csim:` prefix so Ruby's
    // `syntax_or_invalid_selector_error?` catches it uniformly.
    throw new Error('csim: ' + (e && e.message ? e.message : e));
  }
}

export function selectAll(roots, sel, scopeRoot) {
  return adapter.findAll(compile(sel, scopeRoot), roots);
}
export function selectFirst(roots, sel, scopeRoot) {
  return adapter.findOne(compile(sel, scopeRoot), roots);
}
export function matchesSelector(el, sel) {
  return el && el.nodeType === NODE_ELEMENT && compile(sel)(el);
}
export function closestSelector(el, sel) {
  const fn = compile(sel);
  for (let cur = el; cur; cur = cur._parent) {
    if (cur.nodeType === NODE_ELEMENT && fn(cur)) return cur;
  }
  return null;
}
