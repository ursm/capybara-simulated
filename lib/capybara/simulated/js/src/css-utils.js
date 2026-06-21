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
