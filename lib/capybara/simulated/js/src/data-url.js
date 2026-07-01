// WHATWG "data: URL processor" (URL Standard §5.2). Decodes a `data:` URL into its MIME
// type (serialized) and body bytes. Returns `null` on failure (no comma, or a base64 body
// that fails forgiving-base64 decode) — the caller turns that into a network error. Shared
// by fetch() and XHR so both parse data: identically and spec-correctly.

// Leading / trailing ASCII whitespace (tab, LF, FF, CR, space) — Infra "strip".
const DATA_ASCII_WS = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

// Percent-decode a string to a latin-1 BYTE string: `%XX` → that byte, any other code
// point → its UTF-8 bytes. (NOT decodeURIComponent, which UTF-8-decodes and throws on a
// lone byte such as `%FF`.)
function percentDecodeToBytes(str) {
  // Fast path: a string with no `%` and no non-ASCII code point IS already its own byte
  // string — percent-decoding is a no-op, and (since the URL parser has already
  // %-encoded any non-ASCII) nothing needs UTF-8 encoding. This is the common case: a
  // base64 image body or plain ASCII text. Skips the per-character rebuild below, which
  // is otherwise ~1000x slower on a multi-hundred-KB pasted `data:image/...;base64,...`.
  if (!/%|[^\x00-\x7f]/.test(str)) return str;
  const enc = new globalThis.TextEncoder();
  return str.replace(/%[0-9A-Fa-f]{2}|[\s\S]/g, (tok) => {
    if (tok.length === 3 && tok.charCodeAt(0) === 0x25) return String.fromCharCode(parseInt(tok.slice(1), 16));
    let out = '';
    for (const b of enc.encode(tok)) out += String.fromCharCode(b);
    return out;
  });
}

// Returns `{ mimeType, body }` (mimeType = serialized MIME string, body = latin-1 byte
// string) or `null` on failure.
export function processDataUrl(url) {
  url = String(url);
  let input;
  // Fast path: strip "data:" with a plain slice, skipping the (vendored, JS) URL parser —
  // which is ~200ms on a multi-hundred-KB pasted `data:image/...;base64,...` (it walks the
  // whole opaque path on parse AND re-serialize). Safe only when the parser would change
  // nothing and reject nothing: no `#` (fragment to drop), no C0 control / non-ASCII code
  // point (the opaque-path encoder %-encodes those), and no `//` authority right after
  // `data:` (only `data://…` can be a parse error, e.g. `data://h:bad-port/`). A clean
  // base64/ASCII data: URL — the hot path — hits none of these.
  if (url.startsWith('data:') && !url.startsWith('data://') && !/[#\x00-\x1f\x7f-￿]/.test(url)) {
    input = url.slice(5);
  } else {
    try {
      const u = new globalThis.URL(url);
      if (u.protocol !== 'data:') return null;
      // "URL serializer with exclude fragment": drop the #fragment (so `data:,X#X`'s body
      // is just `X`), then strip the "data:" scheme. Parsing also percent-encodes control
      // characters in the path (`data:text/plain\f,X` -> `text/plain%0c`).
      const href = u.href;
      input = (u.hash ? href.slice(0, href.length - u.hash.length) : href).slice(5);
    } catch (_) {
      return null;
    }
  }
  const comma = input.indexOf(',');
  if (comma < 0) return null;   // no "," -> failure (network error)
  let mimeType = input.slice(0, comma).replace(DATA_ASCII_WS, '');
  let body = percentDecodeToBytes(input.slice(comma + 1));
  // A trailing `;`, optional spaces, then a case-insensitive "base64" marks a base64 body;
  // strip that suffix and forgiving-base64 decode the body (a decode failure -> network error).
  const b64 = /;[\x20]*base64$/i.exec(mimeType);
  if (b64) {
    mimeType = mimeType.slice(0, b64.index);
    try { body = globalThis.atob(body); } catch (_) { return null; }
  }
  if (mimeType.charCodeAt(0) === 0x3b) mimeType = 'text/plain' + mimeType;   // leading ";" -> default type
  // Parse + re-serialize through the reference MIME parser (lowercases type/subtype/param
  // names, drops an empty trailing `;`); an unparseable type falls back to the spec default.
  const vendor = globalThis.__csimVendor && globalThis.__csimVendor.mimeType;
  let parsed = null;
  if (vendor) { try { parsed = vendor.MIMEType.parse(mimeType); } catch (_) {} }
  return { mimeType: parsed ? parsed.toString() : 'text/plain;charset=US-ASCII', body };
}
