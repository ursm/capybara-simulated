// Minimal FileReader — apps that mount file pickers (image preview
// widgets) read the chosen File via `reader.readAsDataURL` /
// `readAsText`. We feed the synchronous Blob.text() result back via
// an event in the next microtask.

import { EventTarget } from './events.js';
import { bytesToArrayBuffer } from './bytes.js';

export class FileReader extends EventTarget {
  constructor() {
    super();
    this.result     = null;
    this.readyState = 0;
    this.error      = null;
  }
  readAsText(blob)         { this._read(blob, t => t); }
  readAsDataURL(blob)      { this._read(blob, t => 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + (globalThis.__csim_btoa ? globalThis.__csim_btoa(t) : '')); }
  readAsArrayBuffer(blob)  { this._read(blob, t => bytesToArrayBuffer(t)); }
  readAsBinaryString(blob) { this._read(blob, t => t); }
  abort()                  { this.readyState = 2; this._fire('abort'); }
  _read(blob, transform) {
    this.readyState = 1;
    Promise.resolve(blob && blob.text ? blob.text() : '').then(t => {
      try {
        this.result = transform(t);
        this.readyState = 2;
        this._fire('load');
        this._fire('loadend');
      } catch (e) {
        this.error = e;
        this.readyState = 2;
        this._fire('error');
        this._fire('loadend');
      }
    });
  }
  _fire(type) {
    const ev = {type, target: this, currentTarget: this};
    if (typeof this['on' + type] === 'function') {
      try { this['on' + type](ev); } catch (_) {}
    }
    try { this.dispatchEvent(ev); } catch (_) {}
  }
}
