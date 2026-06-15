// `FormData` — `new FormData(form, submitter?)` populates from a form's
// submittable controls. Rails-UJS's `data-remote` multipart path
// constructs `FormData(form)` and immediately calls `xhr.send(fd)`.
// `submitter` (if given) contributes its name/value too.
//
// Form serialization is owned by the Ruby side
// (`__csimFormSerialize(form_id, multipart)` walks the live DOM and
// returns the submission spec); we just thread `_entries` through it.

import { lookup } from './handles.js';

// Spec: when append/set receives a Blob value, wrap it in a File
// with the given filename (or "blob" if none). For File entries the
// filename arg overrides `file.name`.
function normalizeEntry(value, filename) {
  const Blob = globalThis.Blob;
  const File = globalThis.File;
  if (Blob && value instanceof Blob) {
    const name = filename != null ? String(filename) : (value.name || 'blob');
    if (File && value instanceof File && filename == null) return value;
    if (File) return new File([value], name, { type: value.type, lastModified: value.lastModified });
    return value;
  }
  return String(value);
}

export class FormData {
  constructor(form, submitter) {
    this._entries = [];
    if (form && form._tag === 'form') {
      const spec = globalThis.__csimFormSerialize(form._id, 0);
      if (spec && Array.isArray(spec.fields)) {
        for (const pair of spec.fields) this._entries.push([String(pair[0]), String(pair[1])]);
      }
      // File inputs are reported separately by the serializer (it can't marshal
      // live File objects). Pull each input's current File list off the DOM so
      // `new FormData(form)` carries uploads — the Turbo / fetch submit path
      // depends on this. An input with no selection still contributes one empty
      // entry, per HTML's form-data construction.
      if (spec && Array.isArray(spec.fileInputs)) {
        const File = globalThis.File;
        for (const fi of spec.fileInputs) {
          const el    = lookup(fi.handle);
          const files = el && el.files;
          if (files && files.length) {
            for (const f of files) this._entries.push([String(fi.name), f]);
          } else if (File) {
            this._entries.push([String(fi.name), new File([], '', { type: 'application/octet-stream' })]);
          }
        }
      }
      // Per HTML spec, the submitter's name/value is appended to the
      // form data set when it's a submit button with a non-empty name.
      if (submitter && submitter._attrs && submitter._attrs.name) {
        this._entries.push([String(submitter._attrs.name), String(submitter._attrs.value || '')]);
      }
    }
  }
  append(k, v, filename) { this._entries.push([String(k), normalizeEntry(v, filename)]); }
  delete(k)              { this._entries = this._entries.filter(e => e[0] !== String(k)); }
  get(k)                 { for (const e of this._entries) if (e[0] === String(k)) return e[1]; return null; }
  getAll(k)              { return this._entries.filter(e => e[0] === String(k)).map(e => e[1]); }
  has(k)                 { return this._entries.some(e => e[0] === String(k)); }
  set(k, v, filename)    { this.delete(k); this.append(k, v, filename); }
  forEach(fn)            { for (const e of this._entries) fn(e[1], e[0], this); }
  entries()              { return this._entries[Symbol.iterator](); }
  keys()                 { return this._entries.map(e => e[0])[Symbol.iterator](); }
  values()               { return this._entries.map(e => e[1])[Symbol.iterator](); }
  [Symbol.iterator]()    { return this.entries(); }
}

globalThis.FormData = FormData;
