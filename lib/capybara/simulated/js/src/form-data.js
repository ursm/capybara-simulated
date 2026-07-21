// `FormData` — `new FormData(form, submitter?)` populates from a form's
// submittable controls. Rails-UJS's `data-remote` multipart path
// constructs `FormData(form)` and immediately calls `xhr.send(fd)`.
// `submitter` (if given) contributes its name/value too.
//
// The ordered walk of the form's controls — HTML "construct the entry list" — lives
// in form-fields.js (`__csimConstructEntryList`), shared with the submission paths;
// this constructor is that list plus the `formdata` event.

import { dispatchEvent }                   from './dispatch.js';
import { FormDataEvent }                   from './events.js';
import { isSubmitButton, formForControl }  from './form-helpers.js';

// HTML "construct the entry list": each field name/value built from the form is
// converted to a sequence of Unicode SCALAR values — an unpaired surrogate becomes
// U+FFFD. (Entry names/values from a form are USVStrings; `.append`'d DOMStrings are
// not.)
function toScalarValueString(s) {
  return String(s).replace(
    /([\uD800-\uDBFF])(?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g,
    (_m, loneHigh, prefix) => loneHigh != null ? '�' : prefix + '�'
  );
}

// Spec: when append/set receives a Blob value, wrap it in a File
// with the given filename (or "blob" if none). For File entries the
// filename arg overrides `file.name`.
// WebIDL overload guard for append/set: a `filename` argument is only valid on the
// `(name, Blob, filename)` overload, so supplying one with a non-Blob value (a string,
// a URLSearchParams, …) is a TypeError (append/set-formelement).
function checkFilenameArg(value, filename) {
  if (filename !== undefined && !(globalThis.Blob && value instanceof globalThis.Blob)) {
    throw new TypeError("Failed to execute 'append'/'set' on 'FormData': parameter 2 is not of type 'Blob'.");
  }
}

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
  // `internal` is set by the form-submission entry-list path (it passes an
  // already-validated submitter): HTML's "construct the entry list" does NOT
  // re-validate the submitter, so the public-constructor checks below are skipped
  // there — only `new FormData(form, submitter)` from script validates.
  constructor(form, submitter, internal) {
    this._entries = [];
    // `new FormData()` with no form → empty. A null / non-HTMLFormElement first
    // argument is a WebIDL TypeError (constructor.any.js).
    if (form === undefined) return;
    if (!form || form._tag !== 'form') {
      throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.");
    }
    // A non-null submitter must be a submit button (TypeError otherwise) owned by
    // this form (NotFoundError otherwise) — same checks as requestSubmit()
    // (constructor-submitter).
    if (submitter != null && !internal) {
      if (!isSubmitButton(submitter)) {
        throw new TypeError("Failed to construct 'FormData': The specified element is not a submit button.");
      }
      if (formForControl(submitter) !== form) {
        throw new globalThis.DOMException("Failed to construct 'FormData': The specified element is not owned by this form element.", 'NotFoundError');
      }
    }
    {
      // HTML "construct the entry list" step 1: a form already constructing its entry
      // list (we're inside its `formdata` handler) makes this return null → the
      // FormData constructor throws InvalidStateError. Without this guard a handler
      // that does `new FormData(e.target)` recurses (formdata-event re-entrancy).
      if (form._constructingEntryList) {
        throw new globalThis.DOMException("Failed to construct 'FormData': The form is constructing its entry list.", 'InvalidStateError');
      }
      // Pass the form OBJECT (not its handle): a cross-realm `new FormData(iframeForm)`
      // constructs the list in this realm for a form whose handle lives in the child's
      // registry. The submitter is passed through too, so its name/value lands at the
      // control's tree position with the walk's correct image-button `.x`/`.y` and
      // disabled-exemption handling — rather than being tacked on at the end here.
      // The pairs come back in tree order and carry live `File`s (a file control's
      // selection, a form-associated custom element's submission value) as objects, so
      // only the string entries are USV-converted — `_charset_` is already resolved to
      // the encoding by the walk. The walk emits strings and Files and nothing else, so
      // the non-string case is tested by TYPE rather than `instanceof File`: a
      // cross-realm `new FormData(iframeForm)` sees the CHILD realm's File, which fails
      // the parent's brand check and would be stringified to "[object File]".
      const pairs = globalThis.__csimConstructEntryList(form, submitter || 0) || [];
      for (const [name, value] of pairs) {
        this._entries.push([toScalarValueString(name), typeof value === 'string' ? toScalarValueString(value) : value]);
      }
      // Fire the `formdata` event so listeners can mutate the entry list
      // (append/delete) before it's used. The event's `formData` is a SEPARATE
      // FormData sharing this entry list during the event (handler mutations land in
      // it); afterwards this FormData takes a CLONE — so the event's object and the
      // constructed one are distinct, and a post-event mutation of the event's object
      // does NOT leak into the constructed list (HTML "construct the entry list":
      // fire on `formData`, return a clone of the entry list).
      //
      // `new FormData(form)` IS HTML's "construct the entry list", so it sets the
      // form's constructing-entry-list flag while `formdata` fires: a submit of any
      // kind (incl. form.submit()) re-entered from a handler bails (the submit
      // algorithm checks the flag at step 2), and a re-entrant `new FormData(form)`
      // throws (guarded above). Save/restore to nest cleanly under a submit that
      // already set it. See `__runFormSubmit` in dom-nodes.js.
      const eventFormData = new FormData();
      eventFormData._entries = this._entries;
      const wasConstructing = form._constructingEntryList;
      form._constructingEntryList = true;
      try {
        dispatchEvent(form, new FormDataEvent('formdata', { bubbles: true, cancelable: false, formData: eventFormData }));
      } catch (_) {
      } finally {
        form._constructingEntryList = wasConstructing;
      }
      this._entries = eventFormData._entries.slice();
    }
  }
  // The entry list (and FormData) stays RAW: newline normalization is NOT done here but
  // by the form-submission encoders (newline-normalization.html / constructing-form-data
  // -set.html assert the stored name/value keep a bare CR/LF).
  append(k, v, filename) { checkFilenameArg(v, filename); this._entries.push([String(k), normalizeEntry(v, filename)]); }
  delete(k)              { this._entries = this._entries.filter(e => e[0] !== String(k)); }
  get(k)                 { for (const e of this._entries) if (e[0] === String(k)) return e[1]; return null; }
  getAll(k)              { return this._entries.filter(e => e[0] === String(k)).map(e => e[1]); }
  has(k)                 { return this._entries.some(e => e[0] === String(k)); }
  set(k, v, filename)    { checkFilenameArg(v, filename); this.delete(k); this.append(k, v, filename); }
  // WebIDL pair-iterator / forEach: an INDEX into the LIVE entry list, re-read each step — so an
  // entry deleted (or appended) mid-iteration shifts what the next index yields (formdata/iteration).
  // Reading `this._entries` per step is load-bearing: `delete`/`set` REPLACE the array, so a captured
  // reference would miss the mutation.
  forEach(fn, thisArg)   { for (let i = 0; i < this._entries.length; i++) { const e = this._entries[i]; fn.call(thisArg, e[1], e[0], this); } }
  _iterator(kind) {
    const fd = this;
    let i = 0;
    return {
      next() {
        if (i >= fd._entries.length) return {value: undefined, done: true};
        const e = fd._entries[i++];
        return {value: kind === 'key' ? e[0] : kind === 'value' ? e[1] : [e[0], e[1]], done: false};
      },
      [Symbol.iterator]() { return this; }
    };
  }
  entries()              { return this._iterator('entry'); }
  keys()                 { return this._iterator('key'); }
  values()               { return this._iterator('value'); }
  [Symbol.iterator]()    { return this.entries(); }
}

globalThis.FormData = FormData;
