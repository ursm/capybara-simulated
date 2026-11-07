// WHATWG Streams. The stream classes themselves are pure JS over promises +
// microtask queuing (which our event loop models), so they're a polyfill, not an
// unmodeled subsystem — backed by web-streams-polyfill in the vendor bundle
// (`__csimVendor.streams`). We expose the standard globals and layer the encoding
// transform streams (TextDecoderStream / TextEncoderStream) over TransformStream
// + the Encoding Standard's codecs (encoding.js).
import { decodeWith, fillDecoder } from './encoding.js';
import { defineTextDecoderStream, defineTextEncoderStream } from './generated/bindings.js';
import { registerInterface, slotsOf, toAllowSharedBufferSource, toDOMString } from './webidl.js';
import { dom } from './engine.js';

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
// polyfill in their slots (`newTransform`), its readable and writable sides theirs (GenericTransformStream).
//
// TextDecoderStream decodes as TextDecoder does — its slots a decoder's (`fillDecoder`), one native decoder open across
// its chunks and flushed as the stream closes — each chunk converted to an AllowSharedBufferSource (a TypeError, which
// errors the stream, for anything else: undefined too), and only text that is there enqueued.
const decoderStreamOf = (o) => slotsOf(o, 'TextDecoderStream');
export const TextDecoderStream = defineTextDecoderStream({
  construct(s, label, options) {
    fillDecoder(s, 'TextDecoderStream', label, options);
    s.transform = newTransform(
      (chunk, controller) => {
        const input = toAllowSharedBufferSource(chunk, "Failed to execute 'transform' on 'TextDecoderStream': ");
        enqueueNonEmpty(controller, decodeWith(s, input, true));
      },
      (controller) => enqueueNonEmpty(controller, decodeWith(s, undefined, false))
    );
  },
  get_encoding: (stream) => decoderStreamOf(stream).name.toLowerCase(),
  get_readable: (stream) => decoderStreamOf(stream).transform.readable,
  get_writable: (stream) => decoderStreamOf(stream).transform.writable
});

// TextEncoderStream encodes each chunk, converted to a DOMString, as UTF-8 — the engine's (text_codec.rs
// `utf8EncodeChunk`), handed the "leading surrogate" the last one ended with, which it keeps — and a lead still held as
// the stream closes U+FFFD.
const encoderStreamOf = (o) => slotsOf(o, 'TextEncoderStream');
export const TextEncoderStream = defineTextEncoderStream({
  construct(s) {
    s.leadingSurrogate = 0;
    s.transform = null;
    const encode = (controller, chunk, last) => {
      const encoded = dom.utf8EncodeChunk(chunk, s.leadingSurrogate, last);
      s.leadingSurrogate = encoded[1];
      enqueueNonEmpty(controller, encoded[0]);
    };
    s.transform = newTransform(
      (chunk, controller) => {
        encode(controller, toDOMString(chunk, false, "Failed to execute 'transform' on 'TextEncoderStream': "), false);
      },
      (controller) => encode(controller, '', true)
    );
  },
  get_encoding: () => 'utf-8',
  get_readable: (stream) => encoderStreamOf(stream).transform.readable,
  get_writable: (stream) => encoderStreamOf(stream).transform.writable
});

// "Set up" a TransformStream with these algorithms (Streams §6.4.3): its transformer and its two queuing strategies
// objects of the platform's own — null-prototyped, so a page's `Object.prototype.start` or `.highWaterMark` is none of
// theirs — the writable side's high-water mark 1, the readable side's 0.
function newTransform(transform, flush) {
  return new TransformStream(
    { __proto__: null, transform, flush },
    { __proto__: null, highWaterMark: 1 },
    { __proto__: null, highWaterMark: 0 }
  );
}

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
