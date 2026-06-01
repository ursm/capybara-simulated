// CSS selectors-4 subset: tokeniser + parser + matcher + finder.
//
// Used by Element querySelector / qsa / matches / closest paths (via
// the selectors.js css-select adapter for production queries) and by
// the cascade resolver for rule selectors. This is the legacy hand-
// rolled parser the cascade resolver still leans on — css-select is
// the high-throughput path; this is the spec-fallback / nth-pseudo /
// :is() / :not() / :scope resolver.
//
// `parseSelector(s)` returns a *group* — an array of *complex*
// selectors. A complex selector is an array of compounds.
//
// Compound shape:
//   { tag: string|null, id: string|null, classes: string[],
//     attrs: [{name, op?, value?}], pseudos: [{name, args?}],
//     combinator: 'descendant'|'child'|'adjacent'|'sibling'|null }
//
// Unsupported tokens / pseudos throw SyntaxError; callers that care
// (jQuery's `.is(':visible')`) catch and fall back to their own
// filter — that's preferable to silently matching everything (which
// was the pre-throw behaviour and broke Redmine's mobile probe).

import { NODE_ELEMENT, NODE_TEXT, NODE_DOC } from './constants.js';
import { walk, classes }                     from './walk.js';

function readIdent(s, i) {
  const len = s.length;
  let out = '';
  while (i < len) {
    const c = s[i];
    if (/[\w-]/.test(c)) { out += c; i++; continue; }
    if (c === '\\') {
      if (i + 1 >= len) break;
      const next = s[i + 1];
      if (/[0-9a-fA-F]/.test(next)) {
        let j = i + 1, hex = '';
        while (j < len && hex.length < 6 && /[0-9a-fA-F]/.test(s[j])) {
          hex += s[j];
          j++;
        }
        if (j < len && /\s/.test(s[j])) j++;
        // CSS "consume an escaped code point": NULL, a surrogate, or a value
        // above the maximum code point all become U+FFFD (also dodges the
        // RangeError String.fromCodePoint throws for surrogates / out-of-range).
        let cp = parseInt(hex, 16);
        if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
        out += String.fromCodePoint(cp);
        i = j;
        continue;
      }
      out += next;
      i += 2;
      continue;
    }
    break;
  }
  return [out, i];
}

function tokenizeSelector(s) {
  const tokens = [];
  let i = 0;
  const len = s.length;
  while (i < len) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      while (i < len && /\s/.test(s[i])) i++;
      tokens.push({ kind: 'ws' });
      continue;
    }
    if (c === '>') { tokens.push({ kind: 'gt' }); i++; continue; }
    if (c === '+') { tokens.push({ kind: 'plus' }); i++; continue; }
    if (c === '~') { tokens.push({ kind: 'tilde' }); i++; continue; }
    if (c === ',') { tokens.push({ kind: 'comma' }); i++; continue; }
    if (c === '*') { tokens.push({ kind: 'star' }); i++; continue; }
    if (c === '#') {
      const [name, j] = readIdent(s, i + 1);
      if (j === i + 1) throw new SyntaxError('csim: bad #id at ' + i);
      tokens.push({ kind: 'hash', value: name });
      i = j; continue;
    }
    if (c === '.') {
      const [name, j] = readIdent(s, i + 1);
      if (j === i + 1) throw new SyntaxError('csim: bad .class at ' + i);
      tokens.push({ kind: 'class', value: name });
      i = j; continue;
    }
    if (c === '[') {
      let depth = 1, j = i + 1;
      while (j < len && depth > 0) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') depth--;
        if (depth > 0) j++;
      }
      if (j >= len) throw new SyntaxError('csim: unterminated [attr] at ' + i);
      tokens.push({ kind: 'attr', value: s.slice(i + 1, j) });
      i = j + 1; continue;
    }
    if (c === ':') {
      // single `:` for pseudo-class; `::` collapses to pseudo-element
      // which we just treat as the same (we don't model rendering
      // boxes so `::before` etc. simply won't ever match a real DOM
      // element — close enough for hide-rule extraction to ignore).
      let j = i + 1;
      if (s[j] === ':') j++;
      const nameStart = j;
      while (j < len && /[\w-]/.test(s[j])) j++;
      const name = s.slice(nameStart, j);
      if (!name) throw new SyntaxError('csim: bad pseudo at ' + i);
      let args = null;
      if (s[j] === '(') {
        let depth = 1, k = j + 1;
        while (k < len && depth > 0) {
          if (s[k] === '(') depth++;
          else if (s[k] === ')') depth--;
          if (depth > 0) k++;
        }
        if (k >= len) throw new SyntaxError('csim: unterminated pseudo args at ' + i);
        args = s.slice(j + 1, k);
        j = k + 1;
      }
      tokens.push({ kind: 'pseudo', value: name, args });
      i = j; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < len && /[\w-]/.test(s[j])) j++;
      tokens.push({ kind: 'tag', value: s.slice(i, j) });
      i = j; continue;
    }
    if (c === '&') {
      // CSS nesting parent ref — only meaningful in nested-rule
      // flattening; in stand-alone selectors we treat it as a sentinel
      // the flattener will substitute before parsing. Reaching it here
      // is a programming error.
      throw new SyntaxError('csim: stray & in selector');
    }
    throw new SyntaxError('csim: unexpected selector char: ' + JSON.stringify(c) + ' at ' + i);
  }
  return tokens;
}


function parseAttrToken(s) {
  // CSS identifiers allow `\X` to escape a non-identifier char so
  // `[a:b]` can be written `[a\:b]`. Turbo's link-click observer
  // matches `a[xlink\:href]` to catch SVG `<a>` elements, so we
  // accept `(?:\\.|[\w-])+` in the name and strip the backslashes
  // before lower-casing.
  const m = /^\s*((?:\\.|[\w-])+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*([isIS])?\s*$/.exec(s);
  if (!m) throw new SyntaxError('csim: bad attr selector: ' + s);
  const flag = m[6];
  return {
    name: m[1].replace(/\\(.)/g, '$1').toLowerCase(),
    op: m[2] || null,
    value: m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] || '')),
    ci: flag === 'i' || flag === 'I'
  };
}

// Recognised pseudo-class names. `:not(...)` / `:is(...)` / `:where(...)`
// accept a nested selector group; nth-* accept an An+B expression.
const PSEUDO_NO_ARG = new Set([
  'first-child', 'last-child', 'only-child',
  'first-of-type', 'last-of-type', 'only-of-type',
  'empty', 'root', 'scope',
  'checked', 'disabled', 'enabled',
  'required', 'optional', 'read-only', 'read-write',
  'hover', 'focus', 'focus-within', 'focus-visible',
  'active', 'visited', 'link', 'target',
  'placeholder-shown', 'default', 'indeterminate',
  'valid', 'invalid', 'user-valid', 'user-invalid'
]);
const PSEUDO_NTH = new Set([
  'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type'
]);

function parsePseudoToken(name, args) {
  const n = name.toLowerCase();
  if (n === 'not' || n === 'is' || n === 'where' || n === 'has') {
    if (args == null) throw new SyntaxError('csim: ' + n + ' needs args');
    return { name: n, list: parseSelector(args) };
  }
  if (PSEUDO_NTH.has(n)) {
    if (args == null) throw new SyntaxError('csim: ' + n + ' needs args');
    // Selectors L4 extends nth-child / nth-last-child with an optional
    // "of <selector>" clause. Split on " of " (case-insensitive,
    // top-level only).
    const ofMatch = /\s+of\s+/i.exec(args);
    if (ofMatch && (n === 'nth-child' || n === 'nth-last-child')) {
      return {
        name: n,
        nth: parseNth(args.slice(0, ofMatch.index)),
        ofList: parseSelector(args.slice(ofMatch.index + ofMatch[0].length))
      };
    }
    return { name: n, nth: parseNth(args) };
  }
  if (n === 'dir' || n === 'lang') {
    if (args == null) throw new SyntaxError('csim: ' + n + ' needs args');
    return { name: n, value: args.trim().toLowerCase().replace(/['"]/g, '') };
  }
  if (PSEUDO_NO_ARG.has(n)) return { name: n };
  // Pseudo-elements (::before etc.) — drop on the floor; they can't
  // match real DOM nodes anyway.
  if (n === 'before' || n === 'after' || n === 'first-letter' || n === 'first-line' ||
      n === 'placeholder' || n === 'selection' || n === 'marker' || n === 'backdrop') {
    return { name: '__never_match__' };
  }
  throw new SyntaxError('csim: unsupported pseudo :' + n);
}

function parseNth(s) {
  const t = s.trim().toLowerCase();
  if (t === 'odd')  return { a: 2, b: 1 };
  if (t === 'even') return { a: 2, b: 0 };
  // an+b forms: -n+3, 2n, 2n+1, +3, -1, n+3, n, -n
  const m = /^([+-]?\d*)n\s*([+-]\s*\d+)?$/.exec(t);
  if (m) {
    const aStr = m[1];
    const a = aStr === '' || aStr === '+' ? 1 : aStr === '-' ? -1 : parseInt(aStr, 10);
    const b = m[2] != null ? parseInt(m[2].replace(/\s+/g, ''), 10) : 0;
    return { a, b };
  }
  const mb = /^([+-]?\d+)$/.exec(t);
  if (mb) return { a: 0, b: parseInt(mb[1], 10) };
  throw new SyntaxError('csim: bad nth expression: ' + s);
}

export function parseSelector(sel) {
  const tokens = tokenizeSelector(String(sel).trim());
  const groups = [];
  let i = 0;
  while (i < tokens.length) {
    while (i < tokens.length && (tokens[i].kind === 'ws' || tokens[i].kind === 'comma')) i++;
    if (i >= tokens.length) break;
    const parsed = parseComplex(tokens, i);
    if (parsed.complex.length) groups.push(parsed.complex);
    i = parsed.next;
  }
  return groups;
}

function parseComplex(tokens, i) {
  const seq = [];
  let pendingCombinator = null; // applied to the next compound
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === 'comma') break;
    if (t.kind === 'ws') {
      // Peek next non-ws: if it's a combinator token, the whitespace is
      // decorative; otherwise the whitespace itself is a descendant
      // combinator (assuming there's another compound after).
      let j = i + 1;
      while (j < tokens.length && tokens[j].kind === 'ws') j++;
      if (j >= tokens.length || tokens[j].kind === 'comma') { i = j; continue; }
      if (tokens[j].kind === 'gt' || tokens[j].kind === 'plus' || tokens[j].kind === 'tilde') {
        i = j; continue;
      }
      if (seq.length > 0 && pendingCombinator == null) pendingCombinator = 'descendant';
      i = j; continue;
    }
    if (t.kind === 'gt')    { pendingCombinator = 'child';    i++; continue; }
    if (t.kind === 'plus')  { pendingCombinator = 'adjacent'; i++; continue; }
    if (t.kind === 'tilde') { pendingCombinator = 'sibling';  i++; continue; }
    const parsed = parseCompound(tokens, i);
    parsed.compound.combinator = seq.length === 0 ? null : (pendingCombinator || 'descendant');
    seq.push(parsed.compound);
    pendingCombinator = null;
    i = parsed.next;
  }
  return { complex: seq, next: i };
}

function parseCompound(tokens, i) {
  const c = { tag: null, id: null, classes: [], attrs: [], pseudos: [], combinator: null };
  let consumed = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === 'tag')   { c.tag = t.value.toLowerCase(); consumed = true; i++; continue; }
    if (t.kind === 'star')  { consumed = true; i++; continue; } // universal selector
    if (t.kind === 'hash')  { c.id = t.value; consumed = true; i++; continue; }
    if (t.kind === 'class') { c.classes.push(t.value); consumed = true; i++; continue; }
    if (t.kind === 'attr')  { c.attrs.push(parseAttrToken(t.value)); consumed = true; i++; continue; }
    if (t.kind === 'pseudo'){ c.pseudos.push(parsePseudoToken(t.value, t.args)); consumed = true; i++; continue; }
    break;
  }
  if (!consumed) throw new SyntaxError('csim: empty compound selector');
  return { compound: c, next: i };
}

function matchUnit(el, u) {
  if (el.nodeType !== NODE_ELEMENT) return false;
  if (u.tag && el._tag !== u.tag) return false;
  if (u.id && el._attrs.id !== u.id) return false;
  if (u.classes && u.classes.length) {
    const cs = classes(el);
    for (const c of u.classes) if (!cs.includes(c)) return false;
  }
  if (u.attrs) for (const a of u.attrs) if (!matchAttr(el, a)) return false;
  if (u.pseudos) for (const p of u.pseudos) if (!matchPseudo(el, p)) return false;
  return true;
}

function matchAttr(el, a) {
  let v = el._attrs[a.name];
  if (a.op == null) return v != null;
  if (v == null) return false;
  let needle = a.value;
  if (a.ci) {
    v = v.toLowerCase();
    needle = needle.toLowerCase();
  }
  switch (a.op) {
    case '=':  return v === needle;
    case '~=': return v.split(/\s+/).includes(needle);
    case '^=': return needle !== '' && v.startsWith(needle);
    case '$=': return needle !== '' && v.endsWith(needle);
    case '*=': return needle !== '' && v.indexOf(needle) >= 0;
    case '|=': return v === needle || v.startsWith(needle + '-');
  }
  return false;
}

function elementSiblings(el) {
  if (!el._parent) return [];
  return el._parent._children.filter(n => n.nodeType === NODE_ELEMENT);
}
function elementSiblingsOfType(el) {
  if (!el._parent) return [];
  return el._parent._children.filter(n => n.nodeType === NODE_ELEMENT && n._tag === el._tag);
}
function prevElementSibling(el) {
  if (!el._parent) return null;
  const sibs = el._parent._children;
  const idx = sibs.indexOf(el);
  for (let i = idx - 1; i >= 0; i--) {
    if (sibs[i].nodeType === NODE_ELEMENT) return sibs[i];
  }
  return null;
}

// an + b membership: positions are 1-based per CSS. n = 0, 1, 2, ...
// so `position` must equal `a*n + b` for some non-negative integer n.
function nthMatches(position, nth) {
  const { a, b } = nth;
  if (a === 0) return position === b;
  const diff = position - b;
  if (a > 0) return diff >= 0 && diff % a === 0;
  return diff <= 0 && diff % a === 0;
}

// Shared with selectors.js (css-select user-pseudos hook). CSS Selectors-4
// user-action pseudos that key off `document._activeElement`.
export const focusPseudoMatchers = {
  focus:           (el) => globalThis.document && globalThis.document._activeElement === el,
  'focus-visible': (el) => globalThis.document && globalThis.document._activeElement === el,
  'focus-within':  (el) => {
    const active = globalThis.document && globalThis.document._activeElement;
    if (!active) return false;
    for (let cur = active; cur; cur = cur._parent) if (cur === el) return true;
    return false;
  }
};

// Walks `root`'s element descendants until `seq` matches one. Used
// by `:has()` — scope-relative descendant search. `__scopeRoot` is
// pointing at `root` so seqs starting with `>` / `+` / `~` resolve
// relative to the host. First match wins, so depth order doesn't
// matter — `pop()` (stack) is O(1) where `shift()` (queue) is O(n).
function hasMatchInDescendants(root, seq) {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (cur !== root && cur.nodeType === NODE_ELEMENT && matchComplex(cur, seq)) return true;
    if (cur._children) for (const c of cur._children) {
      if (c.nodeType === NODE_ELEMENT) stack.push(c);
    }
  }
  return false;
}

function matchPseudo(el, p) {
  switch (p.name) {
    case '__never_match__': return false;
    case 'not':   return !p.list.some(seq => matchComplex(el, seq));
    case 'is':
    case 'where': return p.list.some(seq => matchComplex(el, seq));
    case 'has': {
      // Selectors L4 :has(selector). Relative-selector matches use
      // `el` as scope so seqs that lead with `>`/`+`/`~` resolve
      // against the host element.
      const prev = __scopeRoot;
      __scopeRoot = el;
      try {
        for (const seq of p.list) {
          if (hasMatchInDescendants(el, seq)) return true;
        }
        return false;
      } finally {
        __scopeRoot = prev;
      }
    }
    case 'first-child': {
      const sibs = elementSiblings(el);
      return sibs.length > 0 && sibs[0] === el;
    }
    case 'last-child': {
      const sibs = elementSiblings(el);
      return sibs.length > 0 && sibs[sibs.length - 1] === el;
    }
    case 'only-child': {
      const sibs = elementSiblings(el);
      return sibs.length === 1 && sibs[0] === el;
    }
    case 'first-of-type': {
      const sibs = elementSiblingsOfType(el);
      return sibs.length > 0 && sibs[0] === el;
    }
    case 'last-of-type': {
      const sibs = elementSiblingsOfType(el);
      return sibs.length > 0 && sibs[sibs.length - 1] === el;
    }
    case 'only-of-type': {
      const sibs = elementSiblingsOfType(el);
      return sibs.length === 1 && sibs[0] === el;
    }
    case 'nth-child': {
      let sibs = elementSiblings(el);
      // Selectors L4: `:nth-child(An+B of selector)` filters siblings
      // by the selector before applying the nth formula.
      if (p.ofList) {
        sibs = sibs.filter(s => p.ofList.some(seq => matchComplex(s, seq)));
      }
      const idx  = sibs.indexOf(el);
      return idx >= 0 && nthMatches(idx + 1, p.nth);
    }
    case 'nth-last-child': {
      let sibs = elementSiblings(el);
      if (p.ofList) {
        sibs = sibs.filter(s => p.ofList.some(seq => matchComplex(s, seq)));
      }
      const idx  = sibs.indexOf(el);
      return idx >= 0 && nthMatches(sibs.length - idx, p.nth);
    }
    case 'nth-of-type': {
      const sibs = elementSiblingsOfType(el);
      const idx  = sibs.indexOf(el);
      return idx >= 0 && nthMatches(idx + 1, p.nth);
    }
    case 'nth-last-of-type': {
      const sibs = elementSiblingsOfType(el);
      const idx  = sibs.indexOf(el);
      return idx >= 0 && nthMatches(sibs.length - idx, p.nth);
    }
    case 'empty':
      // CSS :empty matches when the element has no children, or only
      // comment children; whitespace-only text children DO disqualify.
      for (const c of el._children) {
        if (c.nodeType === NODE_TEXT) {
          if (c.data && c.data.length > 0) return false;
        } else if (c.nodeType === NODE_ELEMENT) {
          return false;
        }
      }
      return true;
    case 'root': return el._parent && el._parent.nodeType === NODE_DOC;
    case 'checked': {
      if (el._tag === 'option') return el._attrs.selected != null;
      const t = (el._attrs.type || '').toLowerCase();
      if (el._tag === 'input' && (t === 'checkbox' || t === 'radio')) return el._attrs.checked != null;
      return false;
    }
    case 'disabled': return el._attrs.disabled != null;
    case 'enabled':  return el._attrs.disabled == null;
    case 'required': return el._attrs.required != null;
    case 'optional': return el._attrs.required == null;
    case 'read-only':  return el._attrs.readonly != null;
    case 'read-write': return el._attrs.readonly == null;
    // We don't drive a real focus/hover state machine yet, so these
    // are conservatively false. jQuery's `:hover` / `:focus` filters
    // fall back to its own DOM-state check, so this only affects
    // cascade rules that gate on them — and those rules generally
    // *reveal* content rather than hide it (so reporting false here
    // keeps the element visibility-stable until a real test cares).
    case 'scope':
      // CSS Selectors 4 :scope — matches the context element of a
      // scoped selector query. `qsa('> li', el)` is normalised to
      // `qsa(':scope > li', el)` and we set `__scopeRoot = el`
      // around the walk, so a match against `:scope` succeeds when
      // the candidate equals the root.
      return __scopeRoot != null && el === __scopeRoot;
    case 'hover': {
      // CSS `:hover` applies to the hovered element AND every
      // ancestor. We track the last-moused-over node on
      // `document._hoverElement`; matches walk up the ancestor
      // chain to decide whether `el` is on it. The hover state
      // persists across polls (no auto-clear) because Selenium
      // similarly keeps the pointer in place between user actions
      // — until the next user action moves it.
      const hov = globalThis.document && globalThis.document._hoverElement;
      if (!hov) return false;
      let cur = hov;
      while (cur) { if (cur === el) return true; cur = cur._parent; }
      return false;
    }
    case 'focus':
    case 'focus-visible':
    case 'focus-within': return focusPseudoMatchers[p.name](el);
    case 'active':        return false;
    case 'visited':       return false;
    case 'link':          return el._tag === 'a' && el._attrs.href != null;
    case 'target': {
      // Spec: matches the element whose id equals the current URL's
      // fragment (location.hash without the `#`). Floating-label /
      // sectional UIs target headings via `:target`.
      const id = el._attrs.id;
      if (!id) return false;
      const hash = (globalThis.location && globalThis.location.hash) || '';
      return hash.length > 1 && hash.slice(1) === id;
    }
    case 'placeholder-shown': {
      // Spec: matches `<input>` / `<textarea>` whose placeholder is
      // shown — equivalently, whose value is empty AND a placeholder
      // attribute exists. Tailwind's floating-label / form-validation
      // utilities key on this; without it the label stays mis-
      // positioned and `expect(label).to be_visible` checks flip.
      if (el._tag !== 'input' && el._tag !== 'textarea') return false;
      if (el._attrs.placeholder == null) return false;
      const v = el._attrs.value;
      return v == null || v === '';
    }
    case 'default': {
      // Spec: button/checkbox/radio/option marked as the default for
      // its form / fieldset / select.
      if (el._tag === 'option') return el._attrs.selected != null;
      if (el._tag === 'input') {
        const t = (el._attrs.type || '').toLowerCase();
        if (t === 'checkbox' || t === 'radio') return el._attrs.checked != null;
        if (t === 'submit' || t === 'image') return true;  // first submit button — close enough
      }
      if (el._tag === 'button') return (el._attrs.type || 'submit').toLowerCase() === 'submit';
      return false;
    }
    case 'indeterminate': return el._indeterminate === true;
    case 'valid':      return true;
    case 'invalid':    return false;
    case 'user-valid':   return true;
    case 'user-invalid': return false;
    case 'dir': {
      // :dir(ltr|rtl) — i18n-aware CSS. Walks ancestors looking for
      // an explicit `dir` attribute; defaults to ltr per spec.
      const want = (p.value || '').toLowerCase();
      let cur = el;
      while (cur && cur.nodeType === NODE_ELEMENT) {
        const d = cur._attrs && cur._attrs.dir;
        if (d) return d.toLowerCase() === want;
        cur = cur._parent;
      }
      return want === 'ltr';
    }
    case 'lang': {
      // :lang(en) matches when the element's `lang` (or any
      // ancestor's) starts with the given tag (per BCP 47 prefix
      // matching).
      const want = (p.value || '').toLowerCase();
      let cur = el;
      while (cur && cur.nodeType === NODE_ELEMENT) {
        const l = cur._attrs && cur._attrs.lang;
        if (l) {
          const v = String(l).toLowerCase();
          return v === want || v.startsWith(want + '-');
        }
        cur = cur._parent;
      }
      return false;
    }
  }
  return false;
}

export function matchComplex(el, seq) {
  if (!seq.length) return false;
  if (!matchUnit(el, seq[seq.length - 1])) return false;
  let cur = el;
  for (let i = seq.length - 2; i >= 0; i--) {
    // `combinator` on seq[i+1] describes how seq[i] connects to its
    // successor — i.e. how we step from `cur` back toward seq[i].
    const combinator = seq[i + 1].combinator;
    if (combinator === 'child') {
      cur = cur._parent;
      if (!cur || cur.nodeType !== NODE_ELEMENT || !matchUnit(cur, seq[i])) return false;
    } else if (combinator === 'adjacent') {
      cur = prevElementSibling(cur);
      if (!cur || !matchUnit(cur, seq[i])) return false;
    } else if (combinator === 'sibling') {
      let s = prevElementSibling(cur);
      while (s && !matchUnit(s, seq[i])) s = prevElementSibling(s);
      if (!s) return false;
      cur = s;
    } else {
      // descendant (the default)
      cur = cur._parent;
      while (cur && cur.nodeType === NODE_ELEMENT && !matchUnit(cur, seq[i])) cur = cur._parent;
      if (!cur || cur.nodeType !== NODE_ELEMENT) return false;
    }
  }
  return true;
}

export function matchOne(el, group) {
  for (const seq of group) if (matchComplex(el, seq)) return true;
  return false;
}

// Specificity (a, b, c) per CSS Selectors Level 4. Used by the
// display/visibility cascade resolver — last source-order wins among
// equal-specificity rules; `:not(...)` / `:is(...)` take the *max*
// specificity of their inner selector group; `:where(...)` contributes
// zero.
export function specificity(seq) {
  let a = 0, b = 0, c = 0;
  for (const u of seq) {
    if (u.id) a++;
    if (u.classes && u.classes.length) b += u.classes.length;
    if (u.attrs && u.attrs.length) b += u.attrs.length;
    if (u.pseudos) for (const p of u.pseudos) {
      if (p.name === 'where') continue;
      if (p.name === 'not' || p.name === 'is' || p.name === 'has') {
        let max = [0, 0, 0];
        for (const inner of p.list) {
          const s = specificity(inner);
          if (compareSpec(s, max) > 0) max = s;
        }
        a += max[0]; b += max[1]; c += max[2];
        continue;
      }
      b++;
    }
    if (u.tag) c++;
  }
  return [a, b, c];
}
export function compareSpec(s1, s2) {
  if (s1[0] !== s2[0]) return s1[0] - s2[0];
  if (s1[1] !== s2[1]) return s1[1] - s2[1];
  return s1[2] - s2[2];
}
// Scope root for `:scope` pseudo-class. matchPseudo reads this slot
// when resolving `:scope` so qsa with relative combinator selectors
// (`> *`, `+ li`, `~ span`) — normalised to `:scope > …` — match
// against the context element rather than every descendant.
let __scopeRoot = null;
export function findAll(root, group) {
  const out = [];
  const prev = __scopeRoot; __scopeRoot = root;
  try { walk(root, el => { if (matchOne(el, group)) out.push(el); }); }
  finally { __scopeRoot = prev; }
  return out;
}
export function findFirst(root, group) {
  let hit = null;
  const prev = __scopeRoot; __scopeRoot = root;
  try { walk(root, el => { if (!hit && matchOne(el, group)) hit = el; }); }
  finally { __scopeRoot = prev; }
  return hit;
}
// Direct id-attribute lookup, bypassing CSS selector parsing.
// The CSS-selector path (`parseSelector('#' + id)`) throws on ids
// containing characters that aren't valid CSS identifier chars
// (slashes, colons, brackets, etc.) — but per the DOM spec
// `getElementById` accepts any string verbatim. Avo names its
// index components with slashes (`avo/index/grid_item_component_<param>`)
// so Turbo's stream-replace targeting these IDs would otherwise
// throw inside `targetElementsById` and the action would silently
// no-op.
export function findById(root, id) {
  if (!root || id == null) return null;
  const target = String(id);
  if (target.length === 0) return null;
  let hit = null;
  walk(root, el => {
    if (!hit && el._attrs && el._attrs.id === target) hit = el;
  });
  return hit;
}

