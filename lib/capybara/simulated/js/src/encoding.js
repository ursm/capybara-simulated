// `btoa` / `atob` / `TextEncoder` / `TextDecoder` — WindowOrWorkerGlobalScope's base64, and the Encoding Standard's
// codecs (native, text_codec.rs).

import { getEncoding } from './encodings.js';
import { convertTextDecoderArguments, installTextDecoder, installTextEncoder } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';

// `btoa(data)`: `data`'s code units, each a byte, base64-encoded — one above 0xFF an InvalidCharacterError (apps that
// need Unicode base64 wrap their input through `encodeURIComponent` first, Forem's `base64EncodeUnicode`); `atob(data)`:
// Infra's forgiving-base64 decode, a failure an InvalidCharacterError — the engine's (data_url.rs).
export function btoa(data) {
  const encoded = globalThis.__dom.base64Encode(String(data));
  if (encoded === null) throw new globalThis.DOMException('The string to be encoded contains characters outside of the Latin1 range.', 'InvalidCharacterError');
  return encoded;
}
export function atob(data) {
  const decoded = globalThis.__dom.base64Decode(String(data));
  if (decoded === null) throw new globalThis.DOMException('The string to be decoded is not correctly encoded.', 'InvalidCharacterError');
  return decoded;
}
// (…the driver's, whatever a page puts in their place)
globalThis.__csimBtoa = btoa;

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
  decode: (decoder, input, options) => decodeWith(decoderOf(decoder), input, options.stream)
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
// `stream`: a native decoder opened for a stream, and closed as it ends — or as the slots' owner is collected with one
// still open.
export function decodeWith(s, input, stream) {
  const dom = globalThis.__dom;
  let text;
  if (s.stream === 0 && !stream) {
    text = dom.textDecode(s.name, input, s.ignoreBOM, s.fatal);
  } else {
    if (s.stream === 0) {
      s.stream = dom.textDecoderOpen(s.name, s.ignoreBOM);
      if (openDecoders) openDecoders.register(s.owner, s.stream, s.owner);
    }
    text = dom.textDecoderPush(s.stream, input, !stream, s.fatal);
    if (!stream) {
      if (openDecoders) openDecoders.unregister(s.owner);
      s.stream = 0;
    }
  }
  if (text === null) throw new TypeError('The encoded data was not valid for encoding ' + s.name.toLowerCase() + '.');
  return text;
}

globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
