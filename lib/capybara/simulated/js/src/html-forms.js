// The form controls' members (HTML §4.10) that reflect no content attribute — the generated bindings take those
// (gen_bindings.mjs) — as the implementations dom-class-aliases.js installs them with. Each listed element's form owner
// and constraint validation are the shared `constraintValidationMembers`' and `formForControl`'s.

import { liveHTMLCollection } from './dom-collections.js';
import { askForReset, ensureOptionSelInit } from './custom-elements.js';
import {
  buttonCommand, collectOptionText, constraintValidationMembers, elementReferenceMembers, fieldsetControlElements, labelsOf,
  serializeAutofill, setTextControlValue, submissionURL, textFieldSelectionMembers, tokenListFor
} from './dom-nodes.js';
import { controlLiveValue, formForControl, setSelectedness, textareaRawValue } from './form-helpers.js';
import { bumpSettleGen } from './mutation-observer.js';
import { reflectEnum } from './reflect.js';

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

// A popover invoker's (PopoverTargetAttributes — a button's; an input's once it is generated) popover, an element
// reference.
const popoverTarget = elementReferenceMembers('popoverTargetElement');
const popoverTargetMembers = {
  get_popoverTargetElement: popoverTarget.get,
  set_popoverTargetElement: popoverTarget.set
};

const BUTTON_TYPES = new Map([['submit', 'submit'], ['reset', 'reset'], ['button', 'button']]);
const commandFor = elementReferenceMembers('commandForElement');
export const htmlButtonElementMembers = {
  ...listedElementMembers,
  ...popoverTargetMembers,
  get_command: buttonCommand,
  get_commandForElement: commandFor.get,
  set_commandForElement: commandFor.set,
  // (…its `formaction` as a URL — the document's address where it is absent or empty)
  get_formAction: (button) => submissionURL(button, button._attrs.formaction),
  // (…limited to known values, submit its missing and invalid value default)
  get_type: (button) => reflectEnum(button, 'type', BUTTON_TYPES, 'submit', 'submit'),
  get_labels: labelsOf
};

// An option's select: the select whose list of options it is in — its parent, or past one optgroup, or past the
// transparent wrappers of a customizable select — none across an option, a datalist, an hr or a second optgroup.
function optionSelect(option) {
  let crossedOptgroup = false;
  for (let cur = option._parent; cur; cur = cur._parent) {
    const t = cur._tag;
    if (t === 'select') return cur;
    if (t === 'option' || t === 'datalist' || t === 'hr') return null;
    if (t === 'optgroup') {
      if (crossedOptgroup) return null;
      crossedOptgroup = true;
    }
  }
  return null;
}
// (…its text: its descendant text, past HTML and SVG scripts, ASCII whitespace stripped and collapsed)
function optionText(option) {
  const parts = [];
  collectOptionText(option, parts);
  return parts.join('').replace(/[ \t\n\f\r]+/g, ' ').replace(/^ | $/g, '');
}
export const htmlOptionElementMembers = {
  // (…its select's form owner — an option is no listed element itself)
  get_form(option) {
    const select = optionSelect(option);
    return select ? (formForControl(select) || null) : null;
  },
  // (…its `label` attribute — in no namespace — else its text)
  get_label: (option) => option._getAttributeNS(null, 'label') ?? optionText(option),
  set_label(option, value) { option._setAttribute('label', value); },
  // (…a parsed `<option selected>` read before it is connected to a select reports its default)
  get_selected(option) {
    ensureOptionSelInit(option);
    return option._selectedness === true;
  },
  // (…dirty from now on, so its `selected` attribute drives it no more; its select re-runs the selectedness algorithm —
  // a single select's other options deselected, one with none selected given its default)
  set_selected(option, value) {
    const changed = (option._selectedness === true) !== value;
    option._dirtySel = true;
    setSelectedness(option, value);
    askForReset(option);
    if (changed) bumpSettleGen();
  },
  // (…its `value` attribute — in no namespace — else its text)
  get_value: (option) => option._getAttributeNS(null, 'value') ?? optionText(option),
  set_value(option, value) { option._setAttribute('value', value); },
  get_text: optionText,
  set_text(option, value) { option.textContent = value; },
  // (…its place in its select's list of options; 0 with no select)
  get_index(option) {
    const select = optionSelect(option);
    return select ? Math.max(0, Array.prototype.indexOf.call(select.options, option)) : 0;
  }
};

// A textarea's: its raw value — its child text until a set, typing or setRangeText dirties it — its default (its child
// text), the autofill processing model's answer for its `autocomplete`, and the text field selection API. (The "first
// newline removal" is the parsers': its text node lacks the leading line break already, so the value reads it as it is
// — Avo's KeyValueField stores a JSON blob in a hidden textarea and parses its value.)
export const htmlTextAreaElementMembers = {
  ...listedElementMembers,
  ...textFieldSelectionMembers,
  get_autocomplete: (textarea) => serializeAutofill(textarea._attrs.autocomplete, false),
  get_type: () => 'textarea',
  get_defaultValue: textareaRawValue,
  set_defaultValue(textarea, value) { textarea.textContent = value; },
  get_value: (textarea) => controlLiveValue(textarea),
  set_value: setTextControlValue,
  // (…its value's length in UTF-16 code units)
  get_textLength: (textarea) => controlLiveValue(textarea).length,
  get_labels: labelsOf
};
