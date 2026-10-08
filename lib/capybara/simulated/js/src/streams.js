// WHATWG Streams. The stream classes themselves are pure JS over promises +
// microtask queuing (which our event loop models), so they're a polyfill, not an
// unmodeled subsystem — backed by web-streams-polyfill in the vendor bundle
// (`__csimVendor.streams`). We expose the standard globals and layer the encoding
// transform streams (TextDecoderStream / TextEncoderStream) over TransformStream
// + the Encoding Standard's codecs (encoding.js).
import { decodeWith, decoderSlots } from './encoding.js';
import { convertTextDecoderStreamArguments, installTextDecoderStream, installTextEncoderStream } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf, toAllowSharedBufferSource, toDOMString } from './webidl.js';

const V = globalThis.__csimVendor && globalThis.__csimVendor.streams;
// (…a stream the polyfill made — told by its internal slot, as the polyfill's own brand check does, and that slot's
// controller's back-reference to it (no plain object that names the slot), but of ANY realm's polyfill: a platform
// object of another realm is one still, as a top window's stream a frame's fetch() uploads — not by a global a page
// may replace: a BodyInit's)
registerInterface('ReadableStream', (o) => {
  if (o === null || typeof o !== 'object' || !Object.hasOwn(o, '_readableStreamController')) return false;
  const c = o._readableStreamController;
  return c !== null && typeof c === 'object' && (c._controlledReadableStream === o || c._controlledReadableByteStream === o);
});

// The classes the driver's own code makes streams of — the polyfill's, not the globals a page may replace.
export const ReadableStream = V ? V.ReadableStream : undefined;
const TransformStream = V ? V.TransformStream : undefined;

// The Encoding Standard's transform streams (§8.3, §8.4), generated from their IDL: a TransformStream of this realm's
// polyfill in their slots, its readable and writable sides theirs (GenericTransformStream).
//
// TextDecoderStream decodes as TextDecoder does — its slots a decoder's (`decoderSlots`), one native decoder open across
// its chunks and flushed as the stream closes — each chunk converted to an AllowSharedBufferSource (a TypeError, which
// errors the stream, for anything else: undefined too), and only text that is there enqueued.
const decoderStreamOf = (o) => slotsOf(o, 'TextDecoderStream');
registerInterface('TextDecoderStream', (o) => decoderStreamOf(o) !== undefined);
export class TextDecoderStream {
  constructor(label, options) {
    [label, options] = convertTextDecoderStreamArguments(arguments);
    const s = makeSlots(this, 'TextDecoderStream', decoderSlots('TextDecoderStream', label, options));
    const owner = this;
    s.transform = new TransformStream({
      transform(chunk, controller) {
        const input = toAllowSharedBufferSource(chunk, "Failed to execute 'transform' on 'TextDecoderStream': ");
        enqueueNonEmpty(controller, decodeWith(s, owner, input, true));
      },
      flush(controller) { enqueueNonEmpty(controller, decodeWith(s, owner, undefined, false)); }
    });
  }
}
installTextDecoderStream(TextDecoderStream, {
  get_encoding: (stream) => decoderStreamOf(stream).name.toLowerCase(),
  get_fatal: (stream) => decoderStreamOf(stream).fatal,
  get_ignoreBOM: (stream) => decoderStreamOf(stream).ignoreBOM,
  get_readable: (stream) => decoderStreamOf(stream).transform.readable,
  get_writable: (stream) => decoderStreamOf(stream).transform.writable
});

// TextEncoderStream encodes each chunk, converted to a DOMString, as UTF-8 — a lead surrogate ending one held as its
// "leading surrogate" for the next, so a pair split across two encodes as its one code point; one that no trail
// follows, or a trail that no lead goes before, U+FFFD — and a lead still held as the stream closes U+FFFD too.
const encoderStreamOf = (o) => slotsOf(o, 'TextEncoderStream');
registerInterface('TextEncoderStream', (o) => encoderStreamOf(o) !== undefined);
export class TextEncoderStream {
  constructor() {
    const s = makeSlots(this, 'TextEncoderStream', { leadingSurrogate: '' });
    s.transform = new TransformStream({
      transform(chunk, controller) {
        let input = s.leadingSurrogate + toDOMString(chunk, false, "Failed to execute 'transform' on 'TextEncoderStream': ");
        const last = input.charCodeAt(input.length - 1);
        s.leadingSurrogate = last >= 0xD800 && last <= 0xDBFF ? input.slice(-1) : '';
        if (s.leadingSurrogate) input = input.slice(0, -1);
        enqueueNonEmpty(controller, globalThis.__dom.utf8Encode(input.toWellFormed()));
      },
      flush(controller) {
        if (s.leadingSurrogate) controller.enqueue(globalThis.__dom.utf8Encode('\uFFFD'));
      }
    });
  }
}
installTextEncoderStream(TextEncoderStream, {
  get_encoding: () => 'utf-8',
  get_readable: (stream) => encoderStreamOf(stream).transform.readable,
  get_writable: (stream) => encoderStreamOf(stream).transform.writable
});

function enqueueNonEmpty(controller, chunk) {
  if (chunk.length) controller.enqueue(chunk);
}

if (V) {
  for (const name of [
    'ReadableStream', 'WritableStream', 'TransformStream',
    'ByteLengthQueuingStrategy', 'CountQueuingStrategy',
    'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader',
    'ReadableStreamDefaultController', 'ReadableByteStreamController',
    'ReadableStreamBYOBRequest', 'WritableStreamDefaultWriter',
    'WritableStreamDefaultController', 'TransformStreamDefaultController'
  ]) {
    if (V[name] && !globalThis[name]) globalThis[name] = V[name];
  }
  if (!globalThis.TextDecoderStream) globalThis.TextDecoderStream = TextDecoderStream;
  if (!globalThis.TextEncoderStream) globalThis.TextEncoderStream = TextEncoderStream;
}
