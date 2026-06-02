// css-select v7 adapter speaking our Node / Element model. Compiled
// selectors are memoised because Capybara emits a small recurring
// set per suite.
//
// The cascade-rule engine in `bridge.entry.js` still uses the
// hand-rolled `parseSelector` / `matchOne` pair — that path will
// migrate alongside subsequent modular splits.

import { NODE_ELEMENT }       from './constants.js';
import { walk, walkFind }     from './walk.js';
import { splitTopLevel }      from './css-utils.js';

const cssSelect     = globalThis.__csimVendor.cssSelect;
const cssWhat       = globalThis.__csimVendor.cssWhat;
const cssTree       = globalThis.__csimVendor.cssTree;

// Selector strings that have already passed strict (css-tree) validation.
// Validity is a property of the string alone, independent of the scope root,
// so this lets the per-scopeRoot compile path (`compiledCacheScoped`) skip the
// css-tree re-parse when the same `:scope`-bearing selector is compiled against
// many different roots (`within(row) { find(':scope > .cell') }` × N rows).
const strictValidated = new Set();

// CSS Selectors-4 user-action pseudos that key off `document._activeElement`.
// css-select has no focus state, so these are fed in via the `pseudos` option.
const focusPseudoMatchers = {
  focus:           (el) => globalThis.document && globalThis.document._activeElement === el,
  'focus-visible': (el) => globalThis.document && globalThis.document._activeElement === el,
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

// css-what (css-select's parser) is lenient where the Selectors grammar is
// strict: it accepts a class with a digit-leading or empty name (`.5cm`,
// `..test`, `.foo..quux`), a stray `<`, and a top-level leading combinator
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

function compile(sel, scopeRoot) {
  // CSS "filter code points" preprocessing: a literal NULL in the selector
  // string becomes U+FFFD (css-what doesn't preprocess the input stream).
  // Lone surrogates are left alone here to avoid splitting a valid pair.
  if (typeof sel === 'string' && sel.indexOf('\x00') !== -1) sel = sel.replace(/\x00/g, '\uFFFD');
  const key = sel;
  // An empty / whitespace-only selector is a parse error (SyntaxError), not a
  // match-nothing \u2014 css-select accepts it, so reject it here.
  if (typeof key === 'string' && key.trim() === '') {
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
  fn = compileRaw(key, [scopeRoot]);
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

function compileRaw(key, context) {
  let fn;
  try {
    fn = cssSelect.compile(key, {adapter, pseudos: userPseudos, cacheResults: false}, context);
  } catch (e) {
    // css-select rejects pseudo-element selectors. Per spec they're valid and
    // match no element, so drop any pseudo-element arm of the list and OR the
    // rest. If nothing targets a known pseudo-element, the throw is a genuine
    // syntax error — rethrow with the `csim:` prefix so Ruby's
    // `syntax_or_invalid_selector_error?` catches it uniformly.
    const f = pseudoElementFallback(key, context);
    if (f) return f;
    const nsFn = namespaceFallback(key, context);
    if (nsFn) return nsFn;
    // A DOMException named SyntaxError — what `querySelector`/`matches` must
    // throw for an invalid selector (WPT asserts `assert_throws_dom("Syntax-
    // Error", …)`). The `csim: ` message prefix is preserved so Ruby's
    // `syntax_or_invalid_selector_error?` still recognises it.
    throw new globalThis.DOMException('csim: ' + (e && e.message ? e.message : e), 'SyntaxError');
  }
  // css-select accepted the selector, but css-what's grammar is looser than the
  // spec's; reject (SyntaxError) anything css-tree's stricter lexer rejects.
  rejectInvalidStrict(key);
  return fn;
}

// css-select rejects namespaced tag names ("not yet supported"), but css-what
// parses them and we track `namespaceURI`. Per Selectors: `*|name` = any
// namespace (= match by local name), `|name` = no namespace (null
// namespaceURI), `prefix|name` = an undeclared prefix (querySelector has no
// namespace map) → invalid → SyntaxError. Strip the namespace so css-select can
// compile, and post-filter the SUBJECT for the no-namespace case.
//
// Approximations (uncovered by WPT, which only puts the namespace on the
// subject): a no-namespace constraint on a NON-subject compound (`|a div`) is
// dropped → matched as any-namespace; a namespaced arm inside a selector LIST
// (`*|div, span`) falls through and rethrows. Attribute namespaces aren't
// tracked, so `[*|attr]` matches by local name.
function namespaceFallback(key, context) {
  let groups;
  try { groups = cssWhat.parse(key); } catch (_) { return null; }
  if (groups.length !== 1) return null;          // single complex selector only
  const group = groups[0];
  let lastComb = -1;
  for (let i = 0; i < group.length; i++) if (cssWhat.isTraversal(group[i])) lastComb = i;
  let hasNs = false, subjectNoNs = false;
  for (let i = 0; i < group.length; i++) {
    const t = group[i];
    if (t.namespace == null) continue;
    hasNs = true;
    if (t.namespace !== '*' && t.namespace !== '') return null;   // undeclared prefix → rethrow → SyntaxError
    // `|tag` / `|*` on the subject compound requires the matched element itself
    // to be in no namespace. (Attribute namespaces aren't tracked — strip and
    // match by local name.)
    if (t.namespace === '' && (t.type === 'tag' || t.type === 'universal') && i > lastComb) subjectNoNs = true;
    t.namespace = null;
  }
  if (!hasNs) return null;
  let compiled;
  try { compiled = cssSelect.compile(cssWhat.stringify(groups), {adapter, pseudos: userPseudos, cacheResults: false}, context); }
  catch (_) { return null; }
  if (!subjectNoNs) return compiled;
  return (el) => compiled(el) && el.namespaceURI == null;
}

function pseudoElementFallback(key, context) {
  const arms = splitTopLevel(key, ',').map(a => a.trim()).filter(Boolean);
  if (!arms.some(targetsPseudoElement)) return null;   // not our case — rethrow
  const fns = [];
  for (const arm of arms) {
    if (targetsPseudoElement(arm)) continue;           // matches no element
    try { fns.push(cssSelect.compile(arm, {adapter, pseudos: userPseudos, cacheResults: false}, context)); }
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
  return el && el.nodeType === NODE_ELEMENT && compile(sel)(el);
}
export function closestSelector(el, sel) {
  const fn = compile(sel);
  for (let cur = el; cur; cur = cur._parent) {
    if (cur.nodeType === NODE_ELEMENT && fn(cur)) return cur;
  }
  return null;
}
