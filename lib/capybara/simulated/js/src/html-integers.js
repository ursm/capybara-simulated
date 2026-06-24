// HTML "rules for parsing integers" / "rules for parsing non-negative
// integers" (https://html.spec.whatwg.org/#rules-for-parsing-integers). Shared
// low-level parsers so every numeric content-attribute reflection — and the
// selectedness algorithm's display-size check — uses ONE faithful implementation
// rather than a per-call regex that drifts (e.g. forgetting the optional leading
// sign). dom-nodes.js layers its clamping `reflect*Get` getters on top of these.

// Leading ASCII whitespace [ \t\n\f\r] (NOT other Unicode spaces / vertical
// tab), optional sign, require >= 1 ASCII digit, then read the digit run.
// Returns a number, or null on failure.
export function parseHtmlInteger(s) {
  const str = String(s);
  const n = str.length;
  let i = 0;
  while (i < n) { const c = str[i]; if (c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r') i++; else break; }
  let sign = 1;
  if (i < n && (str[i] === '-' || str[i] === '+')) { if (str[i] === '-') sign = -1; i++; }
  if (i >= n || str[i] < '0' || str[i] > '9') return null;
  let v = 0;
  while (i < n && str[i] >= '0' && str[i] <= '9') { v = v * 10 + (str.charCodeAt(i) - 48); i++; }
  // Normalize zero to +0 — HTML's parse rules (and the WPT harness's same_value
  // comparison, which distinguishes -0 from +0) treat any parsed zero as positive.
  return v === 0 ? 0 : sign * v;
}

export function parseHtmlNonneg(s) {
  const v = parseHtmlInteger(s);
  return (v === null || v < 0) ? null : v;
}
