// Aliased in for @exodus/bytes at vendor-build time. @exodus/bytes ships ~190KB
// of legacy MULTIBYTE encoding tables (shift_jis / euc-jp / big5 / gb18030 / …)
// so whatwg-url can honour a non-UTF-8 query `encoding`. We drop all of that and
// reimplement only the `percentEncodeAfterEncoding` path whatwg-url's
// url-state-machine actually calls (the query component), covering UTF-8 (the
// default) plus the WHATWG SINGLE-byte encodings via a bridge-side encoder
// (globalThis.__csimSingleByteEncoder) that reuses the driver's decode tables —
// no 190KB of multibyte tables. A non-modeled (multibyte) encoding falls back to
// UTF-8 (those URL-encoding subtests stay out of scope).
//
// Per the spec "percent-encode after encoding": encode the input with `encoding`,
// then for each byte percent-encode it when it's a C0 control (<0x20), above `~`
// (>0x7e), or in `percentEncodeSet`. `spaceAsPlus` maps 0x20 → '+'. A code point
// the (non-UTF-8) encoding can't represent becomes its decimal numeric character
// reference, percent-encoded: "%26%23" + decimal + "%3B" (i.e. `&#DDD;`).
'use strict';
const HEX = '0123456789ABCDEF';
function pctByte(b, percentEncodeSet, spaceAsPlus) {
  if (spaceAsPlus && b === 0x20) return '+';
  if (b < 0x20 || b > 0x7e || percentEncodeSet.indexOf(String.fromCharCode(b)) !== -1) {
    return '%' + HEX[b >> 4] + HEX[b & 0xf];
  }
  return String.fromCharCode(b);
}
exports.percentEncodeAfterEncoding = function percentEncodeAfterEncoding(encoding, input, percentEncodeSet, spaceAsPlus) {
  const str = String(input);
  const enc = String(encoding || 'utf-8').toLowerCase();
  if (enc !== 'utf-8' && enc !== 'utf8') {
    const sb = globalThis.__csimSingleByteEncoder && globalThis.__csimSingleByteEncoder(encoding);
    if (sb) {
      let out = '';
      for (const ch of str) {               // iterate by code point
        const code = ch.codePointAt(0);
        const b = sb(code);
        out += (b == null) ? ('%26%23' + code + '%3B') : pctByte(b, percentEncodeSet, spaceAsPlus);
      }
      return out;
    }
    // Non-single-byte non-UTF-8 (legacy multibyte) is not modeled → UTF-8.
  }
  const bytes = new TextEncoder().encode(str);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += pctByte(bytes[i], percentEncodeSet, spaceAsPlus);
  return out;
};
