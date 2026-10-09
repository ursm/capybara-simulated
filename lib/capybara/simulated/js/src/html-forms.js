// The form controls' members (HTML §4.10) that reflect no content attribute — the generated bindings take those
// (gen_bindings.mjs) — as the implementations dom-class-aliases.js installs them with. Each listed element's form owner
// and constraint validation are the shared `constraintValidationMembers`' and `formForControl`'s.

import { asciiLower } from './ascii.js';
import { liveHTMLCollection } from './dom-collections.js';
import {
  constraintValidationMembers, elementReferenceMembers, fieldsetControlElements, labelsOf, submissionURL, tokenListFor
} from './dom-nodes.js';
import { formForControl } from './form-helpers.js';
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

// A popover invoker's (PopoverTargetAttributes, a button's and an input's) popover — an element reference.
const popoverTarget = elementReferenceMembers('popoverTargetElement');
const popoverTargetMembers = {
  get_popoverTargetElement: popoverTarget.get,
  set_popoverTargetElement: popoverTarget.set
};

// A button's command (HTML §4.10.6): its `command` attribute's keyword — one of the built-in commands, ASCII
// case-insensitive; a custom one (`--` and more) as it is written; '' for a missing or unknown one.
const BUILT_IN_COMMANDS = new Set(['toggle-popover', 'show-popover', 'hide-popover', 'close', 'request-close', 'show-modal']);
function buttonCommand(button) {
  const value = button._attrs.command;
  if (value == null) return '';
  if (value.startsWith('--')) return value;
  const keyword = asciiLower(value);
  return BUILT_IN_COMMANDS.has(keyword) ? keyword : '';
}
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
