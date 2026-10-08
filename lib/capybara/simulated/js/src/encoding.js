// `btoa` / `atob` / `TextEncoder` / `TextDecoder` — WindowOrWorkerGlobalScope's base64, and the Encoding Standard's
// codecs (native, text_codec.rs).

import { getEncoding } from './encodings.js';
import { convertTextDecoderArguments, installTextDecoder, installTextEncoder } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';

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
      throw new globalThis.DOMException("The string to be encoded contains characters outside of the Latin1 range.", 'InvalidCharacterError');
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

// Infra "forgiving-base64 decode": strip ASCII whitespace, then — ONLY when the length
// is a multiple of 4 — drop one or two trailing `=`; a length ≡ 1 (mod 4), or any
// remaining non-alphabet code point (including a `=` that survived, e.g. `a===` → `a=`),
// is a failure → InvalidCharacterError. (html/webappapis/atob/base64.)
export function atob(data) {
  let s = String(data).replace(/[\t\n\f\r ]/g, '');
  if (s.length % 4 === 0) s = s.replace(/={1,2}$/, '');
  if (s.length % 4 === 1) throw new globalThis.DOMException("The string to be decoded is not correctly encoded.", 'InvalidCharacterError');
  let out = '';
  let bits = 0, value = 0;
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    // B64_INDEX only spans 0x00–0xFF; a higher code unit (a non-Latin1 char / surrogate)
    // is never in the base64 alphabet, so it's a decode failure (atob("𐀀")).
    const idx = cc < 256 ? B64_INDEX[cc] : 255;
    if (idx === 255) throw new globalThis.DOMException("The string to be decoded is not correctly encoded.", 'InvalidCharacterError');
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}
// (…the driver's, whatever a page puts in their place)
globalThis.__csimBtoa = btoa;
globalThis.__csimAtob = atob;

// Per spec the encoder is UTF-8 exclusive; decoder defaults to UTF-8.
// Avo's `filter_controller` round-trips its encoded_filters payload
// via `btoa(String.fromCodePoint(...new TextEncoder().encode(...)))`
// and `new TextDecoder().decode(Uint8Array.from(atob(...), ...))`;
// without these the controller throws on `changeFilter`, the
// redirect-target href stays stale, and the filters panel never
// navigates → "User names filter" stays visible in
// filters_panel_open_spec's "keeps the panel closed on selection".

// `TextEncoder` (Encoding §8.2), generated from its IDL: UTF-8, native (text_codec.rs) — a lone surrogate U+FFFD, as the
// Encoding Standard's UTF-8 encoder has it (the binding's USVString conversion makes it so).
export class TextEncoder {
  constructor() { makeSlots(this, 'TextEncoder'); }
}
registerInterface('TextEncoder', (o) => slotsOf(o, 'TextEncoder') !== undefined);
installTextEncoder(TextEncoder, {
  get_encoding: () => 'utf-8',
  encode: (encoder, input) => globalThis.__dom.utf8Encode(input),
  // `encodeInto`: `source` UTF-8-encoded into `destination` (a Uint8Array of any realm, its buffer not resizable — the
  // binding's), never a partial code point: `read` counts the UTF-16 code units consumed, `written` the bytes.
  encodeInto(encoder, source, destination) {
    const [read, written] = globalThis.__dom.utf8EncodeInto(source, destination);
    return { read, written };
  }
});

// HTML "encode" for a form submitted in a legacy encoding (its submission character encoding is not UTF-8): a BYTE
// STRING (each char code 0x00–0xFF is one output byte), a code point the encoding cannot encode written `&#N;` (the
// "html" encoder error mode) — native (text_codec.rs), every legacy encoding the Encoding Standard has.
export function legacyFormEncode(str, name) {
  return globalThis.__dom.legacyEncode(name, String(str));
}

// A streaming `TextDecoder`'s native decoder is closed when its stream ends — or when the TextDecoder is collected with
// one still open.
const openDecoders = typeof FinalizationRegistry !== 'undefined'
  ? new FinalizationRegistry((id) => { if (globalThis.__dom) globalThis.__dom.textDecoderClose(id); })
  : null;

// `TextDecoder` (Encoding §8.1), generated from its IDL, driven through the Encoding Standard's "decode": every
// encoding it has, native (text_codec.rs) — the single-byte tables, UTF-16, and the multibyte CJK decoders. A decode
// that streams (`{stream: true}`) keeps a native decoder open across its calls, partial sequences and ISO-2022-JP's
// state with it; a final, non-streaming decode flushes it. The encoding's own BOM is removed unless `ignoreBOM`; a
// malformed sequence is U+FFFD, or — `fatal` — a TypeError, after which a stream carries on from the bytes past the
// malformed sequence. Its encoding, its flags and its open decoder are its internal slots'.
export class TextDecoder {
  constructor(label, options) {
    [label, options] = convertTextDecoderArguments(arguments);
    makeSlots(this, 'TextDecoder', decoderSlots('TextDecoder', label, options));
  }
}
const decoderOf = (o) => slotsOf(o, 'TextDecoder');
registerInterface('TextDecoder', (o) => decoderOf(o) !== undefined);
installTextDecoder(TextDecoder, {
  get_encoding: (decoder) => decoderOf(decoder).name.toLowerCase(),   // the lowercased canonical name
  get_fatal: (decoder) => decoderOf(decoder).fatal,
  get_ignoreBOM: (decoder) => decoderOf(decoder).ignoreBOM,
  // (…its input an `AllowSharedBufferSource`, not a resizable one — the binding's; none no bytes)
  decode: (decoder, input, options) => decodeWith(decoderOf(decoder), decoder, input, options.stream)
});

// A decoder's slots — TextDecoder's and TextDecoderStream's (`iface`) — for `label` and its TextDecoderOptions: "get an
// encoding", an unknown label a RangeError, and so is the replacement encoding (a security rule: it is reached by
// decoding alone, not by a constructor).
export function decoderSlots(iface, label, options) {
  const name = getEncoding(label);
  if (!name || name === 'replacement') {
    throw new RangeError(`Failed to construct '${iface}': The encoding label provided ('${label}') is invalid.`);
  }
  return { name, fatal: options.fatal, ignoreBOM: options.ignoreBOM, stream: 0 };
}
// …and "decode" `input` (an AllowSharedBufferSource, or none for no bytes) with them, the end of the stream unless
// `stream`: a native decoder opened for a stream, and closed as it ends — or as `owner`, whose slots they are, is
// collected with one still open.
export function decodeWith(s, owner, input, stream) {
  const dom = globalThis.__dom;
  let text;
  if (s.stream === 0 && !stream) {
    text = dom.textDecode(s.name, input, s.ignoreBOM, s.fatal);
  } else {
    if (s.stream === 0) {
      s.stream = dom.textDecoderOpen(s.name, s.ignoreBOM);
      if (openDecoders) openDecoders.register(owner, s.stream, owner);
    }
    text = dom.textDecoderPush(s.stream, input, !stream, s.fatal);
    if (!stream) {
      if (openDecoders) openDecoders.unregister(owner);
      s.stream = 0;
    }
  }
  if (text === null) throw new TypeError('The encoded data was not valid for encoding ' + s.name.toLowerCase() + '.');
  return text;
}

globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
