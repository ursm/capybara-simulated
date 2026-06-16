// `btoa` / `atob` / `TextEncoder` / `TextDecoder` — WindowOrWorker
// GlobalScope base64 + UTF-8 codecs. No bridge dependencies; pure
// data conversion.

import { getEncoding } from './encodings.js';

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

// Map a canonical WHATWG encoding name (from getEncoding) to the decoder we
// actually implement. Byte-decoding is UTF-8 / UTF-16 / windows-1252 only by
// design; every other (legacy single/multi-byte) encoding gets a correct
// *label* via the TextDecoder ctor below but has no in-VM byte table, so it
// degrades to the UTF-8 path — those files stay in wpt_skip.yml and only
// label/encoding-name conformance is claimed. NOTE: WHATWG has no separate
// latin1/iso-8859-1 encoding; those labels canonicalize to windows-1252 (so
// 0x80–0x9F decode to cp1252 punctuation, matching real browsers).
function decodeStrategy(name) {
  switch (name) {
    case 'UTF-16LE':     return 'utf-16le';
    case 'UTF-16BE':     return 'utf-16be';
    case 'windows-1252': return 'windows-1252';
    default:             return 'utf-8';
  }
}

const EMPTY_BYTES = new Uint8Array(0);

// Copy the bytes of `input` (BufferSource) into a fresh Uint8Array. A copy is
// required by the spec so a buffer mutated after the call can't change the
// result; it also makes the "buffer detached during options conversion" case
// safe — constructing a view over a detached buffer throws, which we swallow to
// an empty input (matching the spec's "the bytes have already been read").
function toUint8Copy(input) {
  // Non-object inputs (number, string, …) aren't BufferSources — decode to
  // nothing rather than letting `new Uint8Array(5)` mint 5 zero bytes.
  if (input == null || typeof input !== 'object') return EMPTY_BYTES;
  try {
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength).slice();
    }
    // An ArrayBuffer or SharedArrayBuffer. Don't rely on `instanceof`: the WPT
    // harness mints its SharedArrayBuffer from WebAssembly.Memory, whose
    // constructor identity needn't match the global SharedArrayBuffer. Wrapping
    // in a view copies either, and throws (→ empty) for a detached buffer.
    return new Uint8Array(input).slice();
  } catch (_) {
    return EMPTY_BYTES;
  }
}

// Faithful WHATWG TextDecoder: a stateful UTF-8 / UTF-16 / windows-1252 decoder
// driven through the spec "decode" algorithm. The decoder object carries its
// partial-sequence state across `decode(..., {stream: true})` calls; a final
// non-streaming `decode()` flushes any pending bytes to U+FFFD (or throws under
// the fatal flag). BOM removal happens on the decoded U+FEFF code point in the
// serialize step — which is what makes a BOM split across stream chunks (or a
// sticky/repeated BOM) come out right. Byte-table encodings other than these
// three are out of scope (no legacy multibyte tables); see decodeStrategy.
export class TextDecoder {
  constructor(label, options) {
    // WHATWG "get an encoding": an omitted label defaults to utf-8; an explicit
    // `null` stringifies to "null" (invalid). `getEncoding` returns the canonical
    // name or null. The TextDecoder ctor rejects an unknown label AND the
    // "replacement" encoding with a RangeError (the latter is a security rule:
    // replacement is only reachable via the decode side, not this constructor).
    const name = getEncoding(label === undefined ? 'utf-8' : String(label));
    if (!name || name === 'replacement') {
      throw new RangeError("Failed to construct 'TextDecoder': The encoding label provided ('" + label + "') is invalid.");
    }
    this.encoding    = name.toLowerCase();   // IDL `encoding` is the lowercased canonical name
    this._dec        = decodeStrategy(name);
    this.fatal       = !!(options && options.fatal);
    this.ignoreBOM   = !!(options && options.ignoreBOM);
    // Only UTF-8 / UTF-16 strip a leading BOM (constant for the instance).
    this._bomEnc     = this._dec === 'utf-8' || this._dec === 'utf-16le' || this._dec === 'utf-16be';
    this._doNotFlush = false;
    this._bomSeen    = false;
    this._resetDecoder();
  }

  _resetUtf8() {
    // codepoint accumulator, bytes still needed/seen, and the current
    // continuation-byte boundary that catches overlongs / encoded surrogates.
    this._cp = 0; this._need = 0; this._seen = 0; this._lo = 0x80; this._hi = 0xBF;
  }

  _resetDecoder() {
    this._resetUtf8();
    // UTF-16 decoder state (a buffered lead byte and a pending lead surrogate).
    this._leadByte = -1; this._leadSurr = -1;
  }

  // Append one decoded code point to `out` (an array of string pieces),
  // performing the spec serialize step's one-time BOM removal: the first
  // U+FEFF of the whole output stream is dropped for UTF-8 / UTF-16 unless
  // ignoreBOM. A replacement char counts as that first item too, so a BOM that
  // follows it is no longer stripped.
  _emit(out, cp) {
    if (this._bomEnc && !this._bomSeen) {
      this._bomSeen = true;
      if (!this.ignoreBOM && cp === 0xFEFF) return;
    }
    out.push(cp > 0xFFFF
      ? String.fromCharCode(0xD800 + ((cp - 0x10000) >> 10), 0xDC00 + ((cp - 0x10000) & 0x3FF))
      : String.fromCharCode(cp));
  }

  _err(out) {
    if (this.fatal) {
      throw new TypeError('The encoded data was not valid for encoding ' + this.encoding + '.');
    }
    this._emit(out, 0xFFFD);
  }

  decode(input, options) {
    // Read `stream` first: per spec the option conversion happens before the
    // bytes are read, and a getter on `options` may detach `input`'s buffer.
    const stream = !!(options && options.stream);
    if (!this._doNotFlush) { this._resetDecoder(); this._bomSeen = false; }
    this._doNotFlush = stream;

    const bytes = toUint8Copy(input);
    const flush = !stream;
    const out   = [];
    try {
      switch (this._dec) {
        case 'utf-16le':     this._utf16(out, bytes, true,  flush); break;
        case 'utf-16be':     this._utf16(out, bytes, false, flush); break;
        case 'windows-1252': this._win1252(out, bytes);             break;
        default:             this._utf8(out, bytes, flush);         break;
      }
    } catch (e) {
      // A fatal-flag error aborts this decode. Reset so the decoder stays
      // reusable and a `_doNotFlush` left true by this call can't carry partial
      // state into a later stream decode (the spec resets on the next
      // non-streaming decode anyway).
      this._resetDecoder(); this._bomSeen = false; this._doNotFlush = false;
      throw e;
    }
    return out.join('');
  }

  // WHATWG UTF-8 decoder. Tracks bytes-needed/seen plus a per-sequence lower /
  // upper continuation boundary (0xE0→lo 0xA0, 0xED→hi 0x9F, 0xF0→lo 0x90,
  // 0xF4→hi 0x8F) so overlong encodings, encoded surrogates and >U+10FFFF are
  // rejected without a separate range check. An invalid continuation byte is
  // *not* consumed: it's left to be reprocessed as a fresh lead byte (the
  // "prepend" / restore step) — this is why e.g. `F0 41 42` → "�AB".
  _utf8(out, bytes, flush) {
    const n = bytes.length;
    let i = 0;
    for (;;) {
      if (i >= n) {
        if (flush && this._need !== 0) {
          this._resetUtf8();
          this._err(out);
        }
        return;
      }
      const b = bytes[i];
      if (this._need === 0) {
        if (b <= 0x7F) { this._emit(out, b); i++; }
        else if (b >= 0xC2 && b <= 0xDF) { this._need = 1; this._cp = b & 0x1F; i++; }
        else if (b >= 0xE0 && b <= 0xEF) {
          if (b === 0xE0) this._lo = 0xA0;
          else if (b === 0xED) this._hi = 0x9F;
          this._need = 2; this._cp = b & 0x0F; i++;
        } else if (b >= 0xF0 && b <= 0xF4) {
          if (b === 0xF0) this._lo = 0x90;
          else if (b === 0xF4) this._hi = 0x8F;
          this._need = 3; this._cp = b & 0x07; i++;
        } else { this._err(out); i++; }   // 0x80–0xC1, 0xF5–0xFF: invalid lead
      } else if (b < this._lo || b > this._hi) {
        // Invalid continuation: reset and emit error, then reprocess `b`.
        this._resetUtf8();
        this._err(out);
      } else {
        this._lo = 0x80; this._hi = 0xBF;
        this._cp = (this._cp << 6) | (b & 0x3F);
        this._seen++; i++;
        if (this._seen === this._need) {
          this._emit(out, this._cp);
          this._cp = 0; this._need = 0; this._seen = 0;
        }
      }
    }
  }

  // WHATWG shared UTF-16 decoder. Buffers a lead byte to form 16-bit code units,
  // pairs a lead surrogate with a following trail. An unmatched lead surrogate
  // emits an error and the following code unit is reprocessed as fresh (handled
  // by falling through with `cu` already assembled). A lone trail is an error.
  _utf16(out, bytes, le, flush) {
    const n = bytes.length;
    let i = 0;
    for (;;) {
      if (i >= n) {
        if (flush && (this._leadByte >= 0 || this._leadSurr >= 0)) {
          this._leadByte = -1; this._leadSurr = -1;
          this._err(out);
        }
        return;
      }
      const b = bytes[i++];
      if (this._leadByte < 0) { this._leadByte = b; continue; }
      const cu = le ? (b << 8) | this._leadByte : (this._leadByte << 8) | b;
      this._leadByte = -1;
      if (this._leadSurr >= 0) {
        const ls = this._leadSurr; this._leadSurr = -1;
        if (cu >= 0xDC00 && cu <= 0xDFFF) {
          this._emit(out, 0x10000 + ((ls - 0xD800) << 10) + (cu - 0xDC00));
          continue;
        }
        this._err(out);   // unmatched lead surrogate; fall through to reprocess cu
      }
      if (cu >= 0xD800 && cu <= 0xDBFF) { this._leadSurr = cu; continue; }
      if (cu >= 0xDC00 && cu <= 0xDFFF) { this._err(out); continue; }
      this._emit(out, cu);
    }
  }

  // windows-1252: identity except 0x80–0x9F, which map to printable punctuation
  // via the cp1252 table (the 5 undefined slots fall through to the byte value).
  // Also the decode target for iso-8859-1 / ascii labels. Single-byte, so it is
  // stateless and never errors.
  _win1252(out, bytes) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      this._emit(out, (b >= 0x80 && b <= 0x9F && CP1252_HIGH[b] !== undefined) ? CP1252_HIGH[b] : b);
    }
  }
}

globalThis.btoa        = btoa;
globalThis.atob        = atob;
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
