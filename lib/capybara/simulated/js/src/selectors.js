// css-select v7 adapter speaking our Node / Element model. Compiled
// selectors are memoised because Capybara emits a small recurring
// set per suite.
//
// The cascade-rule engine in `bridge.entry.js` still uses the
// hand-rolled `parseSelector` / `matchOne` pair — that path will
// migrate alongside subsequent modular splits.

import { NODE_ELEMENT }       from './constants.js';
import { walk }               from './walk.js';
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
    let hit = null;
    const visit = el => { if (!hit && test(el)) hit = el; };
    for (const n of nodes) {
      if (hit) break;
      walk(n, visit);
    }
    return hit;
  },
  equals: (a, b) => a === b,
  // No real layout → :hover/:visited/:active never apply at the
  // matcher level. The cascade has its own `:hover` propagation.
  isHovered: () => false,
  isVisited: () => false,
  isActive:  () => false
};

// CSS Selectors-4 user-action pseudos. `:scope` is intentionally NOT
// overridden — css-select v7 has its own internal `:scope` handling
// that `:has()`'s relative-selector mode depends on; an override
// here would break `:has(.main > span)`-style selectors. Pass a
// `context` array to `cssSelect.compile` when the caller supplied a
// scope root (jQuery UI's `.find('> *')` after normalising).
const userPseudos = { ...focusPseudoMatchers };

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

function compile(sel, scopeRoot) {
  const key = normaliseScopedSelector(sel);
  if (scopeRoot == null) {
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
