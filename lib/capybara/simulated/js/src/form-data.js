// `FormData` — `new FormData(form)` populates from a form's
// submittable controls. Rails-UJS's `data-remote` multipart path
// constructs `FormData(form)` and immediately calls `xhr.send(fd)`;
// without the form-population branch the FormData is empty and the
// server reads zero params from what looks like an empty form
// submit.
//
// Form serialization is owned by the Ruby side
// (`__csimFormSerialize(form_id, multipart)` walks the live DOM and
// returns the submission spec); we just thread `_entries` through it.

export class FormData {
  constructor(form) {
    this._entries = [];
    if (form && form._tag === 'form') {
      const spec = globalThis.__csimFormSerialize(form._id, 0);
      if (spec && Array.isArray(spec.fields)) {
        for (const pair of spec.fields) this._entries.push([String(pair[0]), String(pair[1])]);
      }
    }
  }
  append(k, v)  { this._entries.push([String(k), v]); }
  delete(k)     { this._entries = this._entries.filter(e => e[0] !== String(k)); }
  get(k)        { for (const e of this._entries) if (e[0] === String(k)) return e[1]; return null; }
  getAll(k)     { return this._entries.filter(e => e[0] === String(k)).map(e => e[1]); }
  has(k)        { return this._entries.some(e => e[0] === String(k)); }
  set(k, v)     { this.delete(k); this.append(k, v); }
  forEach(fn)   { for (const e of this._entries) fn(e[1], e[0], this); }
  entries()     { return this._entries[Symbol.iterator](); }
  keys()        { return this._entries.map(e => e[0])[Symbol.iterator](); }
  values()      { return this._entries.map(e => e[1])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
}

globalThis.FormData = FormData;
