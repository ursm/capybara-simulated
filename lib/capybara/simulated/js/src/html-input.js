// HTMLInputElement's members (HTML §4.10.5) that reflect no content attribute — the generated binding takes those
// (gen_bindings.mjs) — as the implementation dom-class-aliases.js installs it with: its type and value by the type's
// value mode, its checkedness, its files, its number and date views and steps, its list, its picker, and the members
// the listed elements and the text controls share (html-forms.js, dom-nodes.js).

import {
  labelsOf, runComboboxFilter, autofillOf, setTextControlValue, showPickerSteps,
  submissionURL, textFieldSelectionMembers
} from './dom-nodes.js';
import { listedElementMembers, popoverTargetMembers } from './html-forms.js';
import { createFileList, filesOf } from './file-list.js';
import {
  INPUT_DATE, INPUT_LIST, INPUT_NUMERIC, INPUT_TYPED, VALUE_MODES, controlLiveValue, inputFacts, getCheckedness, inputHas, inputTypeState, inputValueMode, setCheckedness
} from './form-helpers.js';
import { bumpStyleState } from './mutation-observer.js';
import {
  STATE_DIRTY_BY_USER, STATE_INDETERMINATE, hasState, sanitizedValueOf, setStateBit, steppedValueOf
} from './native-query-shadow.js';
import { imageSize } from './image-request.js';

// The type keyword (`type` limited to known values, text its missing and invalid value default): its type state, the
// engine's.
const inputType = inputTypeState;
// (…a Date of any realm: one whose time value the intrinsic method reads)
function isDate(value) {
  try { Date.prototype.getTime.call(value); return true; } catch (_) { return false; }
}
const notApplicable = (member, type) => new globalThis.DOMException(
  `Failed to set the '${member}' property: The input element's type ('${type}') does not support this property.`,
  'InvalidStateError');

// An input's value, by its type's value mode: a file input's first file's name behind the `C:\fakepath\` prefix (or
// '' with none); a checkbox's / radio's `value` attribute, `on` where it is absent or empty; any other "default" mode
// type's `value` attribute; a "value" mode type's live value — its `value` attribute until it is dirtied — sanitized by
// the type (a parsed `value="2013-13"` on a month input reads ''), except a number field the user typed into, whose
// valid floating-point number reads as it was typed ("001.50", "1e2" — Chrome), an editing intermediate that still
// converts ("1.") its number, and one that doesn't ("1.e") '' (badInput set).
function inputValue(input) {
  const facts = inputFacts(input);
  const mode = VALUE_MODES[facts >>> 16];
  if (mode === 'filename') {
    const file = (input._files || [])[0];
    return file && file.name != null ? 'C:\\fakepath\\' + file.name : '';
  }
  if (mode === 'default/on') return input._attrs.value ?? 'on';
  if (mode === 'default') return input._attrs.value ?? '';
  // (…a number field — the one type both stepped and typed into)
  const number = (facts & (INPUT_NUMERIC | INPUT_TYPED)) === (INPUT_NUMERIC | INPUT_TYPED);
  if (number && hasState(input, STATE_DIRTY_BY_USER)) return globalThis.__dom.inputTypedNumber(controlLiveValue(input));
  // (…a clean one is its attribute sanitized already: `controlLiveValue`)
  const dirty = input._value;
  return dirty === undefined ? controlLiveValue(input) : sanitizedValueOf(input, inputType(input), dirty);
}
// …and set: a file input's only to '' (its files cleared), else an InvalidStateError; a "value" mode type's live value
// (setTextControlValue); a "default" mode type's `value` attribute. A filter combobox re-filters its select or
// datalist on every value change (`filter=` / `list=`).
function setInputValue(input, value) {
  const mode = inputValueMode(input);
  if (mode === 'filename') {
    if (value !== '') {
      throw new globalThis.DOMException(
        "Failed to set the 'value' property on 'HTMLInputElement': This input element accepts a filename, which may only be programmatically set to the empty string.",
        'InvalidStateError');
    }
    input._files = [];
    return;
  }
  if (mode === 'value') setTextControlValue(input, value, inputValue(input));
  else input._setAttribute('value', value);
  if (input._attrs.filter != null || input._attrs.list != null) runComboboxFilter(input);
}

// (…by `delta` steps, in the type's unit, from the step base onto the step grid within min and max — input_value.rs
// `step`; an InvalidStateError, named for the method that asked, for a type with no allowed value step)
export function stepInput(input, delta, method = delta < 0 ? 'stepDown' : 'stepUp') {
  const before = inputValue(input);
  const next = steppedValueOf(input, inputType(input), before, delta);
  if (next === undefined) {
    throw new globalThis.DOMException(
      `Failed to execute '${method}' on 'HTMLInputElement': This form element does not have an allowed value step.`,
      'InvalidStateError');
  }
  if (next !== null) setInputValue(input, next);
  return inputValue(input) !== before;
}

const imageWidth = imageSize('width');
const imageHeight = imageSize('height');
export const htmlInputElementMembers = {
  ...listedElementMembers,
  ...textFieldSelectionMembers,
  ...popoverTargetMembers,
  get_labels: labelsOf,
  // (…its `type` attribute's change steps — value mode migration, re-sanitizing, the selection and radio group — run
  // however it is set)
  get_type: inputType,
  set_type(input, value) { input._setAttribute('type', value); },
  get_value: inputValue,
  set_value: setInputValue,
  // (…its checkedness — not the `checked` attribute, its default: dirtied by a set; a radio checked its group's others
  // unchecked, the engine's as it writes it)
  get_checked: getCheckedness,
  set_checked(input, value) { setCheckedness(input, value); },
  // (…no content attribute: an `:indeterminate` state of its own)
  get_indeterminate: (input) => hasState(input, STATE_INDETERMINATE),
  set_indeterminate(input, value) {
    if (hasState(input, STATE_INDETERMINATE) === value) return;
    setStateBit(input, STATE_INDETERMINATE, value);
    bumpStyleState();
  },
  // (…a file input's selected files, the same FileList until the selection is replaced; null for any other type)
  get_files(input) {
    if (inputType(input) !== 'file') return null;
    if (input._files == null) input._files = [];
    if (!input._fileList || input._fileListArr !== input._files) {
      input._fileList = createFileList(input._files);
      input._fileListArr = input._files;
    }
    return input._fileList;
  },
  // (…a FileList of any realm shared, not copied — `input.files = dataTransfer.files`; null leaves the selection)
  set_files(input, value) {
    if (value == null || inputType(input) !== 'file') return;
    input._fileList = value;
    input._files = filesOf(value);
    input._fileListArr = input._files;
  },
  // (…its `list` id's datalist in its own tree — its shadow root's, else its document's — where `list` applies to its
  // type: none for a password field, a checkbox, a button… (Chrome))
  get_list(input) {
    const id = input._attrs.list;
    if (!id || !inputHas(input, INPUT_LIST)) return null;
    const root = input._getRootNode();
    const hit = root.getElementById ? root.getElementById(id) : null;
    return hit && hit._tag === 'datalist' ? hit : null;
  },
  get_valueAsNumber(input) {
    const type = inputType(input);
    return inputHas(input, INPUT_NUMERIC) ? globalThis.__dom.inputNumber(type, inputValue(input)) : NaN;
  },
  // (…an infinite value a TypeError, before the type's applicability; NaN the empty value)
  set_valueAsNumber(input, value) {
    if (value === Infinity || value === -Infinity) {
      throw new TypeError("Failed to set the 'valueAsNumber' property on 'HTMLInputElement': The value provided is infinite.");
    }
    const type = inputType(input);
    if (!inputHas(input, INPUT_NUMERIC)) throw notApplicable('valueAsNumber', type);
    setInputValue(input, Number.isNaN(value) ? '' : globalThis.__dom.inputValue(type, value, false));
  },
  // (…a date's and a week's UTC midnight, a month's first day's, a time's ms past the epoch's midnight)
  get_valueAsDate(input) {
    const type = inputType(input);
    if (!inputHas(input, INPUT_DATE)) return null;
    const n = globalThis.__dom.inputDate(type, inputValue(input));
    return Number.isNaN(n) ? null : new Date(n);
  },
  // (…an `object?`: a non-Date — of any realm — a TypeError, before the type's applicability; null or an invalid Date
  // the empty value)
  set_valueAsDate(input, value) {
    if (value != null && !isDate(value)) {
      throw new TypeError("Failed to set the 'valueAsDate' property on 'HTMLInputElement': The provided value is not a Date.");
    }
    const type = inputType(input);
    if (!inputHas(input, INPUT_DATE)) throw notApplicable('valueAsDate', type);
    const time = value == null ? NaN : Date.prototype.getTime.call(value);
    setInputValue(input, Number.isNaN(time) ? '' : globalThis.__dom.inputValue(type, time, true));
  },
  stepUp(input, n) { stepInput(input, n, 'stepUp'); },
  stepDown(input, n) { stepInput(input, -n, 'stepDown'); },
  showPicker: showPickerSteps,
  // (…its `formaction` as a URL — the document's address where it is absent or empty)
  get_formAction: (input) => submissionURL(input, input._attrs.formaction),
  // (…the autofill processing model's answer; a hidden input's is the anchor mantle's)
  get_autocomplete: (input) => autofillOf(input),
  // (…an image button's as an `<img>`'s; any other type has no image available, so 0)
  get_width: (input) => inputType(input) === 'image' ? imageWidth(input) : 0,
  get_height: (input) => inputType(input) === 'image' ? imageHeight(input) : 0,
  // (…HTML Media Capture's and the Entries API's, which reflect)
  get_capture: (input) => input._attrs.capture ?? '',
  set_capture(input, value) { input._setAttribute('capture', value); },
  get_webkitdirectory: (input) => input._attrs.webkitdirectory != null,
  set_webkitdirectory(input, value) {
    if (value) input._setAttribute('webkitdirectory', '');
    else input._removeAttribute('webkitdirectory');
  }
};
