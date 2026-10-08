// FormData (XMLHttpRequest Standard), generated from its IDL: its entry list — pairs of a name and a value, a string or
// a File. `new FormData(form, submitter?)` is a form's entry list, constructed by the ordered walk of its controls (HTML
// "construct the entry list", form-fields.js `__csimConstructEntryList`, which the form's submission shares) and the
// `formdata` event fired at it. Rails-UJS's `data-remote` multipart path constructs `FormData(form)` and at once calls
// `xhr.send(fd)`.

import { fireEvent }                                         from './dispatch.js';
import { convertFormDataArguments, installFormData }           from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf }               from './webidl.js';
import { File, blobType, fileLastModified, fileName, isFile } from './blob.js';
import { FormDataEvent }                                     from './events.js';
import { isSubmitButton, formForControl }                    from './form-helpers.js';
import { formSubmissionEncoding }                            from './encodings.js';

// (…a Blob value a File of this realm — of `filename` where one is given, else of a File's own name or "blob" — but a
// File given no filename the entry's as it is; any realm's blob, told by its slots)
function blobEntry(blob, filename) {
  if (isFile(blob) && filename === undefined) return blob;
  const name = filename !== undefined ? filename : isFile(blob) ? fileName(blob) : 'blob';
  return new File([blob], name, { type: blobType(blob), lastModified: isFile(blob) ? fileLastModified(blob) : undefined });
}

const formDataOf = (o) => slotsOf(o, 'FormData');
export const isFormData = (o) => formDataOf(o) !== undefined;
registerInterface('FormData', isFormData);
// A FormData's entry list: its [name, value] pairs, a value a string or a File — what a submission or a body encodes,
// read here rather than through the iterator a page may have replaced.
export const formDataEntries = (fd) => formDataOf(fd).list;
function formData(o, list) {
  makeSlots(o, 'FormData', { list });
  return o;
}

export class FormData {
  constructor(form, submitter) {
    [form, submitter] = convertFormDataArguments(arguments);
    formData(this, []);
    if (form === undefined) return;
    // A submitter must be a submit button (TypeError otherwise) of this form (NotFoundError otherwise) — the checks
    // requestSubmit() makes.
    if (submitter !== null) {
      if (!isSubmitButton(submitter)) {
        throw new TypeError("Failed to construct 'FormData': The specified element is not a submit button.");
      }
      if (formForControl(submitter) !== form) {
        throw new globalThis.DOMException("Failed to construct 'FormData': The specified element is not owned by this form element.", 'NotFoundError');
      }
    }
    construct(this, form, submitter, 'UTF-8');
  }
}
// The FormData a form's submission encodes (form submission's "construct the entry list"): its submitter not checked
// again, and the list constructed in the form's submission encoding (a `_charset_` control's value), where a script's
// FormData's is UTF-8.
export function submissionFormData(form, submitter) {
  return construct(formData(Object.create(FormData.prototype), []), form, submitter, formSubmissionEncoding(form));
}
function construct(fd, form, submitter, encoding) {
  // HTML "construct the entry list" step 1: a form already constructing its entry list (we're inside its `formdata`
  // handler) makes it return null, and the FormData constructor throw InvalidStateError — a handler that does
  // `new FormData(e.target)` would recurse (formdata-event re-entrancy).
  if (form._constructingEntryList) {
    throw new globalThis.DOMException("Failed to construct 'FormData': The form is constructing its entry list.", 'InvalidStateError');
  }
  // The form OBJECT is passed (not its handle): a cross-realm `new FormData(iframeForm)` constructs the list in this
  // realm for a form whose handle lives in the child's registry. The submitter's name/value lands at the control's tree
  // position with the walk's image-button `.x`/`.y` and disabled-exemption handling. The pairs come back in tree order
  // and carry live Files (a file control's selection, a form-associated custom element's submission value) — of the
  // CHILD realm for a cross-realm form, so a value is told a string by its type, not a File by `instanceof` — and only
  // the strings are converted to scalar values (an unpaired surrogate U+FFFD); `_charset_` is already resolved to the
  // encoding by the walk.
  const list = formDataOf(fd).list;
  for (const [name, value] of globalThis.__csimConstructEntryList(form, submitter ?? 0, encoding) || []) {
    list.push([name.toWellFormed(), typeof value === 'string' ? value.toWellFormed() : value]);
  }
  // The `formdata` event's `formData` is a SEPARATE FormData sharing this entry list while it fires (a handler's
  // mutations land in it); afterwards this one takes a CLONE — so a mutation of the event's object after the event does
  // not leak into it (HTML "construct the entry list": fire at `formData`, return a clone of the entry list). The form's
  // constructing-entry-list flag is set meanwhile: a submit of any kind (form.submit() included) re-entered from a
  // handler bails (the submit algorithm checks it at step 2), and a re-entrant `new FormData(form)` throws (above).
  // Saved and restored, to nest under a submit that already set it (`__runFormSubmit` in dom-nodes.js).
  const eventFormData = formData(Object.create(FormData.prototype), list);
  const wasConstructing = form._constructingEntryList;
  form._constructingEntryList = true;
  try {
    fireEvent(form, new FormDataEvent('formdata', { bubbles: true, cancelable: false, formData: eventFormData }));
  } catch (_) {
  } finally {
    form._constructingEntryList = wasConstructing;
  }
  formDataOf(fd).list = formDataOf(eventFormData).list.slice();
  return fd;
}

// The entry list stays RAW: newlines are normalized not here but by the submission's encoders
// (newline-normalization.html / constructing-form-data-set.html assert a stored name / value keeps a bare CR / LF).
function append(fd, name, value) {
  formDataOf(fd).list.push([name, value]);
}
// `set` replaces the FIRST entry of the name, in place, and removes the rest; none, the entry is appended.
function set(fd, name, value) {
  const s = formDataOf(fd);
  const first = s.list.findIndex((e) => e[0] === name);
  if (first < 0) {
    s.list.push([name, value]);
    return;
  }
  s.list = s.list.filter((e, i) => i <= first || e[0] !== name);
  s.list[first] = [name, value];
}
installFormData(FormData, {
  append_name_value: append,
  append_name_blobValue_filename: (fd, name, blob, filename) => append(fd, name, blobEntry(blob, filename)),
  delete(fd, name) {
    const s = formDataOf(fd);
    s.list = s.list.filter((e) => e[0] !== name);
  },
  get(fd, name) {
    const entry = formDataOf(fd).list.find((e) => e[0] === name);
    return entry ? entry[1] : null;
  },
  getAll: (fd, name) => formDataOf(fd).list.filter((e) => e[0] === name).map((e) => e[1]),
  has: (fd, name) => formDataOf(fd).list.some((e) => e[0] === name),
  set_name_value: set,
  set_name_blobValue_filename: (fd, name, blob, filename) => set(fd, name, blobEntry(blob, filename)),
  pairs: formDataEntries
});

globalThis.FormData = FormData;
