// CSS math functions — `calc()`, `min()`, `max()`, `clamp()` — evaluated to a single value.
//
// A math function that RESOLVES collapses to a plain value in a computed style: Chrome reports
// `calc(10px + 5px)` as `15px`, not as `calc(15px)` (measured). Everything here reported '' before,
// which is the "we can't know" answer for something a browser knows exactly.
//
// The evaluator is deliberately unit-agnostic: it works in two dimensions only — LENGTH (carried in
// px) and NUMBER — and the caller supplies `toPx(n, unit)`, so this module needs no element context
// and no font/viewport model of its own. A PERCENTAGE is not resolvable without a per-property
// basis, so any expression containing one bails; the caller keeps the author's text, which is what
// downstream already treats as "needs layout".
//
// Type rules (CSS Values 4 §10.6, the subset that matters): length ± length -> length,
// number ± number -> number, length * number -> length, length / number -> length. Anything else —
// `calc(1px + 1)`, `calc(1px * 1px)`, division by a length — is INVALID, and an invalid math
// function makes the whole declaration invalid (Chrome computes the property's initial for it).

const MATH_FN_RE = /\b(calc|min|max|clamp)\(/i;
export function hasMathFunction(value) { return MATH_FN_RE.test(String(value)); }

// A resolved result carries its dimension so the caller can serialize it correctly: a LENGTH
// becomes `<n>px`, a NUMBER stays bare (`opacity: calc(0.5 * 2)` -> `1`).
const LENGTH = 'length', NUMBER = 'number';
const INVALID = { invalid: true };
const UNRESOLVABLE = null;              // contains a percentage (or something we don't model)

// ── tokenizer ───────────────────────────────────────────────────────────────
// Numbers (with an optional unit), the four operators, parens and commas. Anything else makes the
// expression unresolvable rather than invalid — being conservative here keeps a value we merely
// don't understand from being reported as a browser-visible error.
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;
const IDENT_RE = /^[a-z%]+/i;

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ t: c }); i++; continue; }
    if (c === '*' || c === '/') { out.push({ t: c }); i++; continue; }
    // `+` and `-` are operators only when SEPARATED by whitespace (CSS requires it, and it is what
    // disambiguates them from a sign): `calc(1px -2px)` is invalid, `calc(1px - 2px)` is not. A
    // sign directly against a number is consumed by NUM_RE below.
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
    return null;                        // something we don't tokenize → unresolvable
  }
  return out;
}

// ── parser / evaluator ──────────────────────────────────────────────────────
// One recursive-descent pass over the token list, evaluating as it goes. `toPx(n, unit)` returns a
// px number for a length unit, or null when the unit isn't one it can convert.
function makeParser(toks, toPx) {
  let i = 0;
  const peek = () => toks[i];
  const val = (type, n) => ({ type, n });

  // A comma-separated argument list, up to the matching ')'.
  function args() {
    const list = [];
    if (peek() && peek().t === ')') { i++; return list; }
    for (;;) {
      const v = sum();
      if (!v || v.invalid) return v === INVALID ? INVALID : UNRESOLVABLE;
      list.push(v);
      const t = peek();
      if (!t) return UNRESOLVABLE;
      i++;
      if (t.t === ')') return list;
      if (t.t !== ',') return UNRESOLVABLE;
    }
  }

  function primary() {
    const t = peek();
    if (!t) return UNRESOLVABLE;
    if (t.t === 'v') {
      i++;
      if (t.unit === '') return val(NUMBER, t.n);
      if (t.unit === '%') return UNRESOLVABLE;                 // needs a per-property basis
      const px = toPx(t.n, t.unit);
      return px == null ? UNRESOLVABLE : val(LENGTH, px);
    }
    if (t.t === '(') { i++; const v = sum(); if (!v || v.invalid) return v; const c = peek(); if (!c || c.t !== ')') return UNRESOLVABLE; i++; return v; }
    if (t.t === 'fn') {
      const name = t.name; i++;
      const open = peek();
      if (!open || open.t !== '(') return UNRESOLVABLE;
      i++;
      const list = args();
      if (!list || list.invalid) return list;
      return applyFn(name, list);
    }
    // A leading sign directly in front of a parenthesised term (`calc(-(1px))`) isn't modelled.
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
        // At most one side may carry a dimension.
        if (left.type === LENGTH && right.type === LENGTH) return INVALID;
        left = val(left.type === LENGTH || right.type === LENGTH ? LENGTH : NUMBER, left.n * right.n);
      } else {
        if (right.type !== NUMBER) return INVALID;             // division by a dimension
        if (right.n === 0) return INVALID;
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
      if (left.type !== right.type) return INVALID;             // `calc(1px + 1)`
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
    else if (name === 'clamp') { if (list.length !== 3) return INVALID; n = Math.min(Math.max(ns[1], ns[0]), ns[2]); }
    else return UNRESOLVABLE;                                   // a math function we don't model
    return val(list[0].type, n);
  }

  // An INVALID result is returned as-is: the parser bails where it found the type error, so the
  // trailing-token check below would otherwise downgrade a real error to "unresolvable" and the
  // declaration would be kept instead of dropped.
  return { run() { const v = sum(); if (v === INVALID) return v; return i === toks.length ? v : UNRESOLVABLE; } };
}

// Round away the float noise `2em + 4px` style arithmetic leaves, the same way the rest of the
// driver serializes computed lengths.
const round = (n) => Math.round(n * 1e4) / 1e4;

// Evaluate a value that CONTAINS a math function. Returns:
//   a string  — the resolved value, ready to serialize (`15px`, or a bare number)
//   'invalid' — a type error, so the whole declaration is invalid (the caller reports the initial)
//   null      — not resolvable here (a percentage, an unmodelled unit or function): keep the text
export function evaluateMath(value, toPx) {
  const src = String(value).trim();
  const toks = tokenize(src);
  if (!toks || !toks.length) return null;
  const v = makeParser(toks, toPx).run();
  if (v === INVALID) return 'invalid';
  if (!v) return null;
  return v.type === LENGTH ? `${round(v.n)}px` : String(round(v.n));
}
