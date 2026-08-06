// CSS math functions — `calc()`, `min()`, `max()`, `clamp()` — reduced in place.
//
// A math function that RESOLVES collapses to a plain value in a computed style: Chrome reports
// `calc(10px + 5px)` as `15px`, not as `calc(15px)` (measured). These all reported '' before, which
// is the driver's "we can't know" answer for something a browser knows exactly.
//
// Reduction is IN PLACE, over each math function's own token range, because a property value is not
// one expression: `aspect-ratio: calc(1 + 1) / 2` has a top-level `/` that is a value-syntax
// separator, not division (Chrome: `2 / 2`), and `background-position: calc(10px + 5px) 0` has two
// components (`15px 0px`). Parsing the whole value as one sum ate both.
//
// The evaluator is DIMENSIONED — number, length (carried in px), angle (deg), time (s) — because
// mixing dimensions is what makes an expression invalid, and a driver that treats every unit as a
// length silently answers `calc(1s + 500ms)` with `501px`. A unit outside the table makes the
// expression unresolvable (the caller keeps the author's text), never a wrong number.
//
// Type rules (CSS Values 4 §10.6, the subset that matters): A ± A -> A for one dimension A;
// A * number -> A; A / number -> A. Anything else — `calc(1px + 1)`, `calc(1px * 1px)`, division by
// a dimension — is INVALID, and an invalid math function invalidates the whole declaration.

const MATH_FN_RE = /(^|[^\w-])(calc|min|max|clamp)\(/i;
// Cheap pre-gate for the driver's hottest read: no `(` at all means no math function, and that is
// the overwhelmingly common case. (`resolveCssVars` guards itself the same way.)
export function hasMathFunction(value) {
  const s = String(value);
  return s.indexOf('(') >= 0 && MATH_FN_RE.test(s);
}

// ── dimensions ──────────────────────────────────────────────────────────────
// Each is carried in a canonical unit and serializes back into it. `null` for a unit we don't
// place: the expression is then unresolvable rather than wrong.
const NUMBER = 'number', LENGTH = 'length', ANGLE = 'angle', TIME = 'time';
const ANGLE_TO_DEG = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
const TIME_TO_S    = { s: 1, ms: 0.001 };
const SUFFIX = { [LENGTH]: 'px', [ANGLE]: 'deg', [TIME]: 's', [NUMBER]: '' };

const INVALID = { invalid: true };
const UNRESOLVABLE = null;

// ── tokenizer ───────────────────────────────────────────────────────────────
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;
const IDENT_RE = /^[a-z%]+/i;

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',' || c === '*' || c === '/') { out.push({ t: c }); i++; continue; }
    // `+` / `-` are operators only when SURROUNDED by whitespace — CSS requires it, and it is what
    // separates them from a sign (`calc(1px -2px)` is invalid; `calc(1px - 2px)` is not).
    if ((c === '+' || c === '-') && /\s/.test(src[i - 1] || '') && /\s/.test(src[i + 1] || '')) {
      out.push({ t: c }); i++; continue;
    }
    const num = NUM_RE.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      const unit = IDENT_RE.exec(src.slice(i));
      if (unit) i += unit[0].length;
      out.push({ t: 'v', n: parseFloat(num[0]), unit: unit ? unit[0].toLowerCase() : '' });
      continue;
    }
    const id = IDENT_RE.exec(src.slice(i));
    if (id) { i += id[0].length; out.push({ t: 'fn', name: id[0].toLowerCase() }); continue; }
    return null;
  }
  return out;
}

// ── parser / evaluator ──────────────────────────────────────────────────────
// `toPx(n, unit)` converts a LENGTH unit, returning null for one it can't place.
function makeParser(toks, toPx) {
  let i = 0;
  const peek = () => toks[i];
  const val = (type, n) => ({ type, n });

  function args() {
    const list = [];
    if (peek() && peek().t === ')') { i++; return list; }
    for (;;) {
      const v = sum();
      if (!v || v.invalid) return v && v.invalid ? INVALID : UNRESOLVABLE;
      list.push(v);
      const t = peek();
      if (!t) return UNRESOLVABLE;
      i++;
      if (t.t === ')') return list;
      if (t.t !== ',') return UNRESOLVABLE;
    }
  }

  function dimension(tok) {
    if (tok.unit === '') return val(NUMBER, tok.n);
    if (tok.unit === '%') return UNRESOLVABLE;             // needs a per-property basis
    if (ANGLE_TO_DEG[tok.unit] !== undefined) return val(ANGLE, tok.n * ANGLE_TO_DEG[tok.unit]);
    if (TIME_TO_S[tok.unit] !== undefined)    return val(TIME,  tok.n * TIME_TO_S[tok.unit]);
    const px = toPx(tok.n, tok.unit);
    return px == null ? UNRESOLVABLE : val(LENGTH, px);
  }

  function primary() {
    const t = peek();
    if (!t) return UNRESOLVABLE;
    if (t.t === 'v') { i++; return dimension(t); }
    if (t.t === '(') {
      i++; const v = sum(); if (!v || v.invalid) return v;
      const c = peek(); if (!c || c.t !== ')') return UNRESOLVABLE;
      i++; return v;
    }
    if (t.t === 'fn') {
      const name = t.name; i++;
      const open = peek();
      if (!open || open.t !== '(') return UNRESOLVABLE;
      i++;
      const list = args();
      if (!list || list.invalid) return list;
      return applyFn(name, list);
    }
    return UNRESOLVABLE;
  }

  function product() {
    let left = primary();
    if (!left || left.invalid) return left;
    for (;;) {
      const t = peek();
      if (!t || (t.t !== '*' && t.t !== '/')) return left;
      i++;
      const right = primary();
      if (!right || right.invalid) return right;
      if (t.t === '*') {
        if (left.type !== NUMBER && right.type !== NUMBER) return INVALID;
        left = val(left.type === NUMBER ? right.type : left.type, left.n * right.n);
      } else {
        if (right.type !== NUMBER || right.n === 0) return INVALID;
        left = val(left.type, left.n / right.n);
      }
    }
  }

  function sum() {
    let left = product();
    if (!left || left.invalid) return left;
    for (;;) {
      const t = peek();
      if (!t || (t.t !== '+' && t.t !== '-')) return left;
      i++;
      const right = product();
      if (!right || right.invalid) return right;
      if (left.type !== right.type) return INVALID;          // `calc(1px + 1)`, `calc(10deg + 5px)`
      left = val(left.type, t.t === '+' ? left.n + right.n : left.n - right.n);
    }
  }

  function applyFn(name, list) {
    if (!list.length) return UNRESOLVABLE;
    if (!list.every(v => v.type === list[0].type)) return INVALID;
    const ns = list.map(v => v.n);
    let n;
    if (name === 'calc')       { if (list.length !== 1) return INVALID; n = ns[0]; }
    else if (name === 'min')   n = Math.min(...ns);
    else if (name === 'max')   n = Math.max(...ns);
    // CSS Values 4: `clamp(MIN, VAL, MAX)` is `max(MIN, min(VAL, MAX))` — deliberately asymmetric,
    // so a MIN above MAX wins (measured: `clamp(40px, 10px, 20px)` is `40px`, not `20px`). Writing
    // it the other way round is only equivalent while the bounds are well ordered, which two
    // `var()` design tokens under a theme override need not be.
    else if (name === 'clamp') { if (list.length !== 3) return INVALID; n = Math.max(ns[0], Math.min(ns[1], ns[2])); }
    else return UNRESOLVABLE;
    return val(list[0].type, n);
  }

  // An INVALID result is returned as-is: the parser stops where it found the type error, so the
  // trailing-token check would otherwise downgrade a real error to "unresolvable" and the caller
  // would keep a declaration a browser drops.
  return { run() { const v = sum(); if (v && v.invalid) return v; return i === toks.length ? v : UNRESOLVABLE; } };
}

const round = (n) => Math.round(n * 1e4) / 1e4;

// The end of the parenthesised group opened at `open` (the index of the `(`), or -1.
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

// Reduce every math function in `value`, leaving the rest of the value alone. Returns:
//   a string  — the value with each resolvable math function replaced by its result
//   'invalid' — one of them was a type error, so the declaration is invalid
//   the input — when nothing could be reduced (a percentage, an unmodelled unit or function)
export function reduceMathFunctions(value, toPx) {
  const src = String(value);
  let out = '', rest = src, guard = 0;
  for (;;) {
    if (++guard > 64) return src;                          // pathological input: leave it alone
    const m = MATH_FN_RE.exec(rest);
    if (!m) return out + rest;
    const start = m.index + m[1].length;                   // past the leading delimiter, at the name
    const open = rest.indexOf('(', start);
    const close = matchParen(rest, open);
    if (close < 0) return out + rest;                      // unbalanced: not ours to touch
    const expr = rest.slice(start, close + 1);
    const toks = tokenize(expr);
    const v = toks && toks.length ? makeParser(toks, toPx).run() : UNRESOLVABLE;
    if (v && v.invalid) return 'invalid';
    out += rest.slice(0, start) + (v ? round(v.n) + SUFFIX[v.type] : expr);
    rest = rest.slice(close + 1);
  }
}

// Is this value's math STATICALLY invalid — a type error visible without knowing the element?
// An invalid math function is a PARSE error: the declaration is dropped, and the cascade falls to
// the next one (Chrome measured: `div { margin-left: 7px } #e { margin-left: calc(1px + 1) }`
// computes `7px`, not the initial `0px`). Deciding that at resolved-value time is too late — by
// then the loser has already been discarded.
//
// Only ABSOLUTE units are placed here, because there is no element: a font- or viewport-relative
// term makes the expression merely unresolvable, so the declaration is kept and the funnel handles
// it (falling to the initial rather than to the next declaration — a bounded divergence). A value
// carrying a substitution is never checked: `var()` may supply the term that makes it well typed.
export function isStaticallyInvalidMath(value, absoluteToPx) {
  return hasMathFunction(value) && reduceMathFunctions(value, absoluteToPx) === 'invalid';
}
