// Shim for Node's `buffer` module — V8 has TextEncoder/Decoder, ArrayBuffer.
// happy-dom uses Buffer.from, .toString, .concat, Buffer.byteLength, Buffer.alloc.
// Provide just enough surface area to keep happy-dom from crashing at load time.
class Buffer extends Uint8Array {
  static from(input, encoding) {
    if (typeof input === 'string') {
      if (encoding === 'base64') {
        const bin = atob(input);
        const out = new Buffer(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      const enc = new TextEncoder();
      return new Buffer(enc.encode(input));
    }
    if (input instanceof Buffer) return input;
    if (input && input.buffer instanceof ArrayBuffer) return new Buffer(input);
    if (Array.isArray(input)) return new Buffer(input);
    return new Buffer(input || 0);
  }
  static alloc(size, fill = 0) {
    const buf = new Buffer(size);
    if (fill !== 0) buf.fill(fill);
    return buf;
  }
  static byteLength(value, encoding) {
    if (typeof value !== 'string') return value.byteLength || value.length || 0;
    return new TextEncoder().encode(value).length;
  }
  static concat(list, totalLength) {
    if (totalLength == null) {
      totalLength = 0;
      for (const b of list) totalLength += b.length;
    }
    const out = new Buffer(totalLength);
    let off = 0;
    for (const b of list) { out.set(b, off); off += b.length; }
    return out;
  }
  static isBuffer(obj) { return obj instanceof Buffer; }
  toString(encoding = 'utf-8') {
    if (encoding === 'base64') {
      let bin = '';
      for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]);
      return btoa(bin);
    }
    return new TextDecoder(encoding === 'binary' ? 'latin1' : encoding).decode(this);
  }
}

// happy-dom imports `Blob` from `buffer`. V8 has Blob as a global.
const Blob = globalThis.Blob || class Blob {
  constructor(parts = [], options = {}) { this.parts = parts; this.type = options.type || ''; }
  get size() { return this.parts.reduce((n, p) => n + (p.length || 0), 0); }
  text() { return Promise.resolve(this.parts.join('')); }
  arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); }
  slice() { return new Blob(); }
};

export {Buffer, Blob};
export default {Buffer, Blob};
