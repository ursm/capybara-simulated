// The form controls' members (HTML §4.10) that reflect no content attribute — the generated bindings take those
// (gen_bindings.mjs) — as the implementations dom-class-aliases.js installs them with. Each listed element's form owner
// and constraint validation are the shared `constraintValidationMembers`' and `formForControl`'s.

import { liveHTMLCollection } from './dom-collections.js';
import { constraintValidationMembers, fieldsetControlElements, labelsOf, tokenListFor } from './dom-nodes.js';
import { formForControl } from './form-helpers.js';

const listedElementMembers = {
  ...constraintValidationMembers,
  get_form: (control) => formForControl(control) || null
};

// An output element's value mode — "default" (its text is its default value) until its `value` is set, "value" after,
// until a form reset puts it back — and the default value it then holds apart.
export const htmlOutputElementMembers = {
  ...listedElementMembers,
  get_htmlFor: (output) => tokenListFor(output, 'for'),
  get_type: () => 'output',
  get_defaultValue: (output) => output._outputValueMode === 'value' ? (output._outputDefault || '') : output.textContent,
  // (…in the default mode its text too, in the value mode only the default held apart)
  set_defaultValue(output, value) {
    output._outputDefault = value;
    if (output._outputValueMode !== 'value') output.textContent = value;
  },
  get_value: (output) => output.textContent,
  // (…the value mode set — the text it had frozen as its default — and its text replaced)
  set_value(output, value) {
    if (output._outputValueMode !== 'value') output._outputDefault = output.textContent;
    output._outputValueMode = 'value';
    output.textContent = value;
  },
  get_labels: labelsOf
};

export const htmlFieldSetElementMembers = {
  ...listedElementMembers,
  get_type: () => 'fieldset',
  // (…its listed-element descendants, live, the same collection every time)
  get_elements: (fieldset) => fieldset._elementsColl || (fieldset._elementsColl = liveHTMLCollection(() => fieldsetControlElements(fieldset)))
};
