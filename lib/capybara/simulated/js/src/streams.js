// WHATWG Streams. The stream classes themselves are pure JS over promises +
// microtask queuing (which our event loop models), so they're a polyfill, not an
// unmodeled subsystem — backed by web-streams-polyfill in the vendor bundle
// (`__csimVendor.streams`). We expose the standard globals and layer the encoding
// transform streams (TextDecoderStream / TextEncoderStream) over TransformStream
// + our own TextDecoder / TextEncoder (encoding.js).
import { TextDecoder, TextEncoder } from './encoding.js';
import { registerInterface } from './webidl.js';

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

export class TextDecoderStream {
  constructor(label = 'utf-8', options = {}) {
    // Constructing the decoder validates the label (RangeError on unknown) and
    // captures fatal / ignoreBOM, exactly like `new TextDecoder(...)`.
    const decoder = new TextDecoder(label, options);
    this._decoder = decoder;
    this._t = new TransformStream({
      transform(chunk, controller) {
        // The chunk is converted as `decode`'s input is — an AllowSharedBufferSource of any realm, a shared buffer
        // included; anything else (a number, a plain object, an array) the TypeError that errors the stream
        // (decode-bad-chunks.any.js asserts the write rejects). Not optional, as `decode`'s is: undefined is no chunk.
        if (chunk === undefined) throw new TypeError("Failed to execute 'transform' on 'TextDecoderStream': chunk is not an AllowSharedBufferSource.");
        const text = decoder.decode(chunk, { stream: true });
        if (text) controller.enqueue(text);
      },
      flush(controller) {
        // Final decode flushes any pending partial sequence (→ U+FFFD, or a
        // TypeError that errors the stream under fatal).
        const text = decoder.decode();
        if (text) controller.enqueue(text);
      }
    });
  }
  get encoding()  { return this._decoder.encoding; }
  get fatal()     { return this._decoder.fatal; }
  get ignoreBOM() { return this._decoder.ignoreBOM; }
  get readable()  { return this._t.readable; }
  get writable()  { return this._t.writable; }
}

export class TextEncoderStream {
  constructor() {
    const encoder = new TextEncoder();
    // A high surrogate at a chunk boundary is held until the next chunk so the
    // pair encodes as one code point (HTML "encode and enqueue a chunk").
    let pending = '';
    this._t = new TransformStream({
      transform(chunk, controller) {
        let input = pending + String(chunk);
        pending = '';
        const last = input.charCodeAt(input.length - 1);
        if (last >= 0xD800 && last <= 0xDBFF) {
          pending = input.slice(-1);
          input = input.slice(0, -1);
        }
        if (input) {
          const bytes = encoder.encode(input);
          if (bytes.length) controller.enqueue(bytes);
        }
      },
      flush(controller) {
        // A leftover lone high surrogate encodes as the replacement character.
        if (pending) {
          const bytes = encoder.encode(pending);
          if (bytes.length) controller.enqueue(bytes);
        }
      }
    });
  }
  get encoding() { return 'utf-8'; }
  get readable() { return this._t.readable; }
  get writable() { return this._t.writable; }
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
