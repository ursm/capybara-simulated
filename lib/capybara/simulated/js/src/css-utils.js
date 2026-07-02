// Small CSS / selector parsing primitives shared between the
// cascade resolver, @media evaluator, and selector tokenizer.

// Decode a `data:text/css[;base64],<data>` URL (RFC 2397) to its CSS text, or
// null when `href` is not a data: URL with an explicit `text/css` media type —
// callers fall back to a network/asset fetch. A missing media type defaults to
// text/plain (RFC 2397), which a real browser does NOT apply as a stylesheet, so
// it (and any non-CSS type like `data:image/png;base64,…`) yields null. base64
// payloads are atob-decoded; otherwise the body is percent-decoded (a malformed
// escape falls back to the raw bytes). Shared by the cascade collector and the
// CSSOM `.sheet` getters so both agree — and both handle base64, which the old
// inline `.sheet` decoders did not. (The byte-returning decoders in xhr.js /
// fetch.js are separate: they need arbitrary media types + raw bytes.)
export function decodeDataUrlCss(href) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(String(href || ''));
  if (!m) return null;
  const meta = m[1];
  const mediaType = meta.replace(/;base64\s*$/i, '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'text/css') return null;
  if (/;base64\s*$/i.test(meta)) { try { return globalThis.atob(m[2]); } catch (_) { return ''; } }
  try { return decodeURIComponent(m[2]); } catch (_) { return m[2]; }
}

// CSSOM serialization of a declaration block: each declaration as `name: value;`
// joined by a single space, so a non-empty block ends in `;` (matches browsers:
// `color: green; background-color: blue;`). An empty block serializes to ''.
// Shared by `Element.style` (style-proxy) and rule/style CSSOM (cssom.js) so both
// agree on the canonical form.
export function serializeStyleDecls(decls) {
  return Object.entries(decls).map(([k, v]) => k + ': ' + v + ';').join(' ');
}

// Char-walking parser that tolerates inputs missing `;` between declarations. We
// scan `name: value` pairs, terminating each value at `;` *or* at a look-ahead
// `<word>:` pattern (which can only be the start of the next declaration). Existing
// CSS values never contain `:` outside of `url(...)` parens, so peeking for an
// unparenthesised `<word>:` is safe. A declaration whose value begins with a colon
// (`color:: invalid`) is dropped as malformed. Property names fold to lower case.
export function parseStyleDecls(css) {
  const out = {};
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && (css[i] === ';' || /\s/.test(css[i]))) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n && /[a-zA-Z-]/.test(css[i])) i++;
    if (i === nameStart) { i++; continue; }
    const name = css.slice(nameStart, i).toLowerCase();
    while (i < n && /\s/.test(css[i])) i++;
    if (css[i] !== ':') continue;
    i++;
    while (i < n && /\s/.test(css[i])) i++;
    let value = '';
    let parenDepth = 0;
    while (i < n) {
      const c = css[i];
      if (c === '(') parenDepth++;
      else if (c === ')') parenDepth--;
      else if (c === ';' && parenDepth === 0) { i++; break; }
      else if (parenDepth === 0 && /\s/.test(c)) {
        let j = i + 1;
        while (j < n && /\s/.test(css[j])) j++;
        const wStart = j;
        while (j < n && /[a-zA-Z-]/.test(css[j])) j++;
        if (j > wStart) {
          let k = j;
          while (k < n && /\s/.test(css[k])) k++;
          if (css[k] === ':') break; // next declaration begins
        }
      }
      value += c;
      i++;
    }
    const v = value.trim();
    if (name && v[0] !== ':') out[name] = v;
  }
  return out;
}

// Split `s` on top-level occurrences of single-char `sep`, respecting
// `[]` / `()` nesting. Used to slice comma-separated selector lists
// (`'input, textarea'`) and media-query lists without splitting on
// commas that appear inside attribute selectors or `:where(a, b)`
// pseudo-class arguments.
export function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}
