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

export function FormData(form) {
  this._entries = [];
  if (form && form._tag === 'form') {
    const spec = globalThis.__csimFormSerialize(form._id, 0);
    if (spec && Array.isArray(spec.fields)) {
      for (const pair of spec.fields) this._entries.push([String(pair[0]), String(pair[1])]);
    }
  }
}

// Methods on `FormData.prototype` (not the instance) so
// `instance.constructor` stays pointing at FormData and `instance
// instanceof FormData` remains true (replacing the prototype with a
// fresh literal would wipe the constructor link).
Object.defineProperties(FormData.prototype, {
  append:  { value: function (k, v) { this._entries.push([String(k), v]); }, writable: true, configurable: true },
  delete:  { value: function (k)    { this._entries = this._entries.filter(e => e[0] !== String(k)); }, writable: true, configurable: true },
  get:     { value: function (k)    { for (const e of this._entries) if (e[0] === String(k)) return e[1]; return null; }, writable: true, configurable: true },
  getAll:  { value: function (k)    { return this._entries.filter(e => e[0] === String(k)).map(e => e[1]); }, writable: true, configurable: true },
  has:     { value: function (k)    { return this._entries.some(e => e[0] === String(k)); }, writable: true, configurable: true },
  set:     { value: function (k, v) { this.delete(k); this.append(k, v); }, writable: true, configurable: true },
  forEach: { value: function (fn)   { for (const e of this._entries) fn(e[1], e[0], this); }, writable: true, configurable: true },
  entries: { value: function ()     { return this._entries[Symbol.iterator](); }, writable: true, configurable: true },
  keys:    { value: function ()     { return this._entries.map(e => e[0])[Symbol.iterator](); }, writable: true, configurable: true },
  values:  { value: function ()     { return this._entries.map(e => e[1])[Symbol.iterator](); }, writable: true, configurable: true },
  [Symbol.iterator]: { value: function () { return this.entries(); }, writable: true, configurable: true }
});
