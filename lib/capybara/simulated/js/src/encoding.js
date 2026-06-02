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
// Avo's `filter_controller` round-trips its encoded_filters payload
// via `btoa(String.fromCodePoint(...new TextEncoder().encode(...)))`
// and `new TextDecoder().decode(Uint8Array.from(atob(...), ...))`;
// without these the controller throws on `changeFilter`, the
// redirect-target href stays stale, and the filters panel never
// navigates → "User names filter" stays visible in
// filters_panel_open_spec's "keeps the panel closed on selection".

export class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(input) {
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
      // WHATWG UTF-8 encoder: an unpaired surrogate becomes U+FFFD (not WTF-8).
      if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
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
  }
  // WHATWG `encodeInto`: UTF-8-encode `source` into the `destination`
  // Uint8Array, never writing a partial code point. Returns
  // `{read, written}` — `read` counts UTF-16 code units consumed,
  // `written` counts bytes emitted. Stops at the first code point that
  // wouldn't fit in the remaining space.
  encodeInto(source, destination) {
    if (!(destination instanceof Uint8Array)) {
      throw new TypeError("Failed to execute 'encodeInto' on 'TextEncoder': destination is not a Uint8Array.");
    }
    const s   = String(source == null ? '' : source);
    const cap = destination.length;
    let read = 0, written = 0;
    for (let i = 0; i < s.length;) {
      let cp = s.charCodeAt(i);
      let units = 1;
      if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length) {
        const low = s.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
          units = 2;
        }
      }
      if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD; // unpaired surrogate
      const need = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (written + need > cap) break;
      if (need === 1) {
        destination[written++] = cp;
      } else if (need === 2) {
        destination[written++] = 0xC0 | (cp >> 6);
        destination[written++] = 0x80 | (cp & 0x3F);
      } else if (need === 3) {
        destination[written++] = 0xE0 | (cp >> 12);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3F);
        destination[written++] = 0x80 | (cp & 0x3F);
      } else {
        destination[written++] = 0xF0 | (cp >> 18);
        destination[written++] = 0x80 | ((cp >> 12) & 0x3F);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3F);
        destination[written++] = 0x80 | (cp & 0x3F);
      }
      read += units;
      i   += units;
    }
    return {read, written};
  }
}

// Encoding-label aliases → canonical name. Covers the WHATWG-spec
// labels apps actually pass. shift_jis (and other multibyte legacy
// CJK encodings) need large lookup tables we don't ship and no in-VM
// polyfill exists for them, so they degrade to the UTF-8 path with a
// note rather than producing a hard failure.
const ENCODING_ALIASES = {
  'unicode-1-1-utf-8': 'utf-8', 'utf-8': 'utf-8', 'utf8': 'utf-8',
  'utf-16': 'utf-16le', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be',
  'iso-8859-1': 'latin1', 'latin1': 'latin1', 'l1': 'latin1',
  'iso8859-1': 'latin1', 'iso88591': 'latin1',
  'us-ascii': 'latin1', 'ascii': 'latin1',
  'cp1252': 'windows-1252', 'windows-1252': 'windows-1252', 'x-cp1252': 'windows-1252',
  'shift_jis': 'shift_jis', 'shift-jis': 'shift_jis', 'sjis': 'shift_jis',
  'windows-31j': 'shift_jis'
};

// windows-1252 differs from iso-8859-1 only in 0x80–0x9F, where C1
// control bytes map to printable punctuation (smart quotes, euro,
// dashes …). Per the WHATWG encoding standard; the 5 undefined slots
// (0x81/0x8D/0x8F/0x90/0x9D) fall through to identity. Office / .NET
// HTML export commonly declares charset=windows-1252.
const CP1252_HIGH = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
  0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
  0x9E: 0x017E, 0x9F: 0x0178
};

function normEncoding(label) {
  const l = (label == null ? 'utf-8' : String(label)).trim().toLowerCase();
  return ENCODING_ALIASES[l] || 'utf-8';
}

function toUint8(input) {
  if (input == null) return new Uint8Array(0);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  return input;
}

function pushCodePoint(parts, cp) {
  if (cp > 0xFFFF) {
    cp -= 0x10000;
    parts.push(String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)));
  } else {
    parts.push(String.fromCharCode(cp));
  }
}

export class TextDecoder {
  constructor(label, options) {
    this.encoding   = normEncoding(label);
    this.fatal      = !!(options && options.fatal);
    this.ignoreBOM  = !!(options && options.ignoreBOM);
  }
  decode(input) {
    const buf = toUint8(input);
    switch (this.encoding) {
      case 'utf-16le': return this._decodeUtf16(buf, true);
      case 'utf-16be': return this._decodeUtf16(buf, false);
      // iso-8859-1 / latin1 / ascii: byte === codepoint across the whole
      // 0x00–0xFF range (true identity, including the C1 controls).
      case 'latin1': {
        const parts = [];
        for (let i = 0; i < buf.length; i++) parts.push(String.fromCharCode(buf[i]));
        return parts.join('');
      }
      // windows-1252: identity except 0x80–0x9F, which map to printable
      // punctuation via the cp1252 table.
      case 'windows-1252': {
        const parts = [];
        for (let i = 0; i < buf.length; i++) {
          const b = buf[i];
          parts.push(String.fromCharCode((b >= 0x80 && b <= 0x9F && CP1252_HIGH[b] !== undefined) ? CP1252_HIGH[b] : b));
        }
        return parts.join('');
      }
      // shift_jis: no in-VM table; degrade to UTF-8 decode (NOTE: a
      // genuine shift_jis payload will mojibake — table not reachable).
      case 'shift_jis':
      case 'utf-8':
      default:
        return this._decodeUtf8(buf);
    }
  }
  _decodeUtf16(buf, le) {
    const parts = [];
    let start = 0;
    // Strip a leading BOM (FF FE le / FE FF be) unless ignoreBOM.
    if (!this.ignoreBOM && buf.length >= 2) {
      if (le && buf[0] === 0xFF && buf[1] === 0xFE) start = 2;
      else if (!le && buf[0] === 0xFE && buf[1] === 0xFF) start = 2;
    }
    for (let i = start; i + 1 < buf.length; i += 2) {
      const unit = le ? (buf[i] | (buf[i + 1] << 8)) : ((buf[i] << 8) | buf[i + 1]);
      parts.push(String.fromCharCode(unit));
    }
    return parts.join('');
  }
  _decodeUtf8(buf) {
    const parts = [];
    let i = 0;
    // Strip a leading UTF-8 BOM (EF BB BF) unless ignoreBOM.
    if (!this.ignoreBOM && buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      i = 3;
    }
    for (; i < buf.length;) {
      const b1 = buf[i++];
      let cp, need = 0;
      if      (b1 < 0x80)            { cp = b1; }
      else if ((b1 & 0xE0) === 0xC0) { cp = b1 & 0x1F; need = 1; }
      else if ((b1 & 0xF0) === 0xE0) { cp = b1 & 0x0F; need = 2; }
      else if ((b1 & 0xF8) === 0xF0) { cp = b1 & 0x07; need = 3; }
      else {
        if (this.fatal) throw new TypeError('The encoded data was not valid for encoding utf-8.');
        parts.push('�'); continue;
      }
      let invalid = false;
      for (let k = 0; k < need; k++) {
        if (i >= buf.length || (buf[i] & 0xC0) !== 0x80) { invalid = true; break; }
        cp = (cp << 6) | (buf[i++] & 0x3F);
      }
      if (invalid) {
        if (this.fatal) throw new TypeError('The encoded data was not valid for encoding utf-8.');
        parts.push('�'); continue;
      }
      pushCodePoint(parts, cp);
    }
    return parts.join('');
  }
}

globalThis.btoa        = btoa;
globalThis.atob        = atob;
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
