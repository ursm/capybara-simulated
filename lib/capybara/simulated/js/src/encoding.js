// `btoa` / `atob` / `TextEncoder` / `TextDecoder` — WindowOrWorker
// GlobalScope base64 + UTF-8 codecs. No bridge dependencies; pure
// data conversion.

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (function () {
  const m = new Uint8Array(256);
  for (let i = 0; i < 256; i++) m[i] = 255;
  for (let i = 0; i < 64; i++) m[B64_CHARS.charCodeAt(i)] = i;
  return m;
})();

// Spec restricts input to Latin1 (each codepoint ≤ 0xFF); higher
// codepoints throw `InvalidCharacterError`. Apps that need Unicode
// base64 wrap their input through `encodeURIComponent` and the
// `%XX → char` round-trip (Forem's `base64EncodeUnicode`), so
// matching real-browser behaviour is what unlocks them.
export function btoa(data) {
  const s = String(data);
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const c1 = s.charCodeAt(i);
    const c2 = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
    const c3 = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
    if (c1 > 0xff || (i + 1 < s.length && c2 > 0xff) || (i + 2 < s.length && c3 > 0xff)) {
      throw new Error("InvalidCharacterError: 'btoa' input contained non-Latin1 char");
    }
    const b1 = c1 >> 2;
    const b2 = ((c1 & 3) << 4) | (Number.isNaN(c2) ? 0 : (c2 >> 4));
    const b3 = Number.isNaN(c2) ? 64 : (((c2 & 15) << 2) | (Number.isNaN(c3) ? 0 : (c3 >> 6)));
    const b4 = Number.isNaN(c3) ? 64 : (c3 & 63);
    out += B64_CHARS[b1] + B64_CHARS[b2] +
           (b3 === 64 ? '=' : B64_CHARS[b3]) +
           (b4 === 64 ? '=' : B64_CHARS[b4]);
  }
  return out;
}

export function atob(data) {
  let s = String(data).replace(/[\t\n\f\r ]/g, '');
  if (s.length % 4 === 1) throw new Error("InvalidCharacterError: bad 'atob' length");
  s = s.replace(/=+$/, '');
  let out = '';
  let bits = 0, value = 0;
  for (let i = 0; i < s.length; i++) {
    const idx = B64_INDEX[s.charCodeAt(i)];
    if (idx === 255) throw new Error("InvalidCharacterError: bad 'atob' char");
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

// Per spec the encoder is UTF-8 exclusive; decoder defaults to UTF-8.
// Avo's `filter_controller` round-trips its encoded_filters payload via
// `btoa(String.fromCodePoint(...new TextEncoder().encode(...)))` and
// `new TextDecoder().decode(Uint8Array.from(atob(...), ...))`; without
// these the controller throws on `changeFilter`, the redirect-target
// href stays stale, and the filters panel never navigates → "User
// names filter" stays visible in filters_panel_open_spec's "keeps
// the panel closed on selection".

export function TextEncoder() {}
TextEncoder.prototype.encoding = 'utf-8';
TextEncoder.prototype.encode = function encode(input) {
  const s = String(input == null ? '' : input);
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
        i++;
      }
    }
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    } else {
      bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
  }
  return new Uint8Array(bytes);
};

export function TextDecoder(label) {
  this.encoding = (label || 'utf-8').toString().toLowerCase();
}
TextDecoder.prototype.decode = function decode(input) {
  if (input == null) return '';
  const buf = input.buffer ? new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength) :
              input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let out = '';
  for (let i = 0; i < buf.length;) {
    const b1 = buf[i++];
    let cp;
    if      (b1 < 0x80)            cp = b1;
    else if ((b1 & 0xE0) === 0xC0) cp = ((b1 & 0x1F) << 6) | (buf[i++] & 0x3F);
    else if ((b1 & 0xF0) === 0xE0) cp = ((b1 & 0x0F) << 12) | ((buf[i++] & 0x3F) << 6) | (buf[i++] & 0x3F);
    else if ((b1 & 0xF8) === 0xF0) cp = ((b1 & 0x07) << 18) | ((buf[i++] & 0x3F) << 12) | ((buf[i++] & 0x3F) << 6) | (buf[i++] & 0x3F);
    else                           cp = 0xFFFD;
    if (cp > 0xFFFF) {
      cp -= 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
};
