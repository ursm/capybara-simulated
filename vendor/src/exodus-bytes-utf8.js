// Aliased in for @exodus/bytes at vendor-build time. @exodus/bytes ships ~190KB
// of legacy multibyte encoding tables (shift_jis / euc-jp / big5 / gb18030 / …)
// so whatwg-url can honour a non-UTF-8 query `encoding`. We ALWAYS parse with
// UTF-8 (the WHATWG default — `__csim_parseUrl` never passes an encoding), so we
// drop all of that and reimplement only the UTF-8 `percentEncodeAfterEncoding`
// path whatwg-url's url-state-machine actually calls (for the query component).
//
// Per the spec "percent-encode after encoding": UTF-8-encode the input, then for
// each byte percent-encode it when it's a C0 control (<0x20), above `~` (>0x7e,
// i.e. every non-ASCII byte), or in `percentEncodeSet` (a sorted string of
// 0x20–0x7e code points). `spaceAsPlus` maps 0x20 → '+'.
'use strict';
const HEX = '0123456789ABCDEF';
exports.percentEncodeAfterEncoding = function percentEncodeAfterEncoding(encoding, input, percentEncodeSet, spaceAsPlus) {
  const bytes = new TextEncoder().encode(String(input));
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (spaceAsPlus && b === 0x20) { out += '+'; continue; }
    if (b < 0x20 || b > 0x7e || percentEncodeSet.indexOf(String.fromCharCode(b)) !== -1) {
      out += '%' + HEX[b >> 4] + HEX[b & 0xf];
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
};
