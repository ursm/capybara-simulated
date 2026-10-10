// The form controls' members (HTML §4.10) that reflect no content attribute — the generated bindings take those
// (gen_bindings.mjs) — as the implementations dom-class-aliases.js installs them with. Each listed element's form owner
// and constraint validation are the shared `constraintValidationMembers`' and `formForControl`'s.

import { asciiLower } from './ascii.js';
import { HTML_NS } from './constants.js';
import { liveFormControlsCollection, liveHTMLCollection, liveOptionsCollection } from './dom-collections.js';
import { askForReset, ensureOptionSelInit, updateSelectedContent } from './custom-elements.js';
import {
  buttonCommand, childNodeRemove, collectOptionText, constraintValidationMembers, elementReferenceMembers,
  fieldsetControlElements, formCheckValidity, labelsOf, listOfOptions, nodeContains, popoverTargetReference, resetForm,
  autofillOf, setTextControlValue, showPickerSteps, submissionURL, textFieldSelectionMembers, tokenListFor
} from './dom-nodes.js';
import {
  controlLiveValue, formControlElements, formForControl, isSubmitButton, setSelectedness, textareaRawValue
} from './form-helpers.js';
import { bumpSettleGen } from './mutation-observer.js';
import { setStateBit, STATE_SELECTED_DIRTY, STATE_SELECTED_INIT } from './native-query-shadow.js';
import { reflectEnum } from './reflect.js';

export const listedElementMembers = {
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

// A popover invoker's (PopoverTargetAttributes — a button's and an input's) popover, an element reference.
export const popoverTargetMembers = {
  get_popoverTargetElement: popoverTargetReference.get,
  set_popoverTargetElement: popoverTargetReference.set
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
  // (…limited to known values; the Auto state's — a missing or invalid one — `button` for a command button, else
  // `submit`)
  get_type(button) {
    const auto = button._attrs.command != null || button._attrs.commandfor != null ? 'button' : 'submit';
    return reflectEnum(button, 'type', BUTTON_TYPES, auto, auto);
  },
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
  // (…a parsed `<option selected>` read before it is connected to a select reports its default)
  get_selected(option) {
    ensureOptionSelInit(option);
    return option._selectedness === true;
  },
  // (…dirty from now on, so its `selected` attribute drives it no more; its select re-runs the selectedness algorithm —
  // a single select's other options deselected, one with none selected given its default)
  set_selected(option, value) {
    const changed = (option._selectedness === true) !== value;
    setStateBit(option, STATE_SELECTED_DIRTY, true);
    setSelectedness(option, value);
    askForReset(option);
    if (changed) bumpSettleGen();
  },
  // (…its `value` attribute — in no namespace — else its text)
  get_value: (option) => option._getAttributeNS(null, 'value') ?? optionText(option),
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
  get_autocomplete: (textarea) => autofillOf(textarea),
  get_type: () => 'textarea',
  get_defaultValue: textareaRawValue,
  set_defaultValue(textarea, value) { textarea.textContent = value; },
  get_value: (textarea) => controlLiveValue(textarea),
  set_value: setTextControlValue,
  // (…its value's length in UTF-16 code units)
  get_textLength: (textarea) => controlLiveValue(textarea).length,
  get_labels: labelsOf
};

// HTMLSelectElement's members (HTML §4.10.7) no attribute reflects, as dom-class-aliases.js installs them with the
// generated binding: its options (a live HTMLOptionsCollection, the same one every time — jQuery's `.val()` reads it
// by index, Avo's city-in-country `options.remove(0)`s it), length, add / item / namedItem / remove, selectedIndex,
// selectedOptions and value over its options' selectedness, type, autocomplete, labels, picker, and the listed
// elements' form owner and constraint validation. Its indices are its options' (SELECT_HANDLER, the Proxy each select
// is).
const selectOptions = (select) =>
  select._optionsColl || (select._optionsColl = liveOptionsCollection(select, () => listOfOptions(select)));
// (…a selectedness change made by script: `:checked` / `:selected` memos and the settle key move, and the select's
// `<selectedcontent>` follows — even a detached one's, appended without a connect pass)
function selectednessChanged(select) {
  bumpSettleGen();
  updateSelectedContent(select);
}
export const htmlSelectElementMembers = {
  ...listedElementMembers,
  get_labels: labelsOf,
  showPicker: showPickerSteps,
  get_autocomplete: (select) => autofillOf(select),
  get_type: (select) => (select._attrs.multiple != null ? 'select-multiple' : 'select-one'),
  get_options: selectOptions,
  get_length: (select) => listOfOptions(select).length,
  // (…grown by blank options appended, shrunk by options removed from the end — HTMLOptionsCollection's)
  set_length(select, n) {
    const options = listOfOptions(select);
    if (n > options.length && n - options.length <= 100000) {   // (…an absurd growth, a wrapped negative, skipped)
      const doc = select.ownerDocument;
      for (let i = options.length; i < n; i++) select._appendChild(doc.createElementNS(HTML_NS, 'option'));
    } else {
      for (let i = options.length - 1; i >= n; i--) options[i]._parent._removeChild(options[i]);
    }
  },
  // (…HTMLOptionsCollection.add: `before` an index into the list of options or an element of it — a NotFoundError for
  // one outside the select — the new one inserted before it in its parent, the optgroup of a nested one; appended to
  // the select where it is none or out of range)
  add(select, element, before) {
    let reference = null;
    if (typeof before === 'number') {
      reference = listOfOptions(select)[before] || null;
    } else if (before != null) {
      if (!nodeContains(select, before) || before === select) {
        throw new globalThis.DOMException('The node before which the new node is to be inserted is not a child of this node.', 'NotFoundError');
      }
      // (…an option put before itself stays where it is)
      if (before === element) return;
      reference = before;
    }
    (reference != null ? reference._parent : select)._insertBefore(element, reference);
  },
  item: (select, index) => selectOptions(select).item(index),
  namedItem: (select, name) => selectOptions(select).namedItem(name),
  // (…its two overloads: ChildNode's remove() the select itself detached; remove(index) its index-th option's)
  remove_none: (select) => childNodeRemove(select),
  remove_index(select, index) {
    const options = listOfOptions(select);
    if (index >= 0 && index < options.length) options[index]._parent._removeChild(options[index]);
  },
  // (…the first selected option's index, -1 with none)
  get_selectedIndex: (select) => listOfOptions(select).findIndex((o) => o._selectedness === true),
  // (…every option deselected and the index-th selected, dirty — out of range none, not re-defaulted: -1 reads back)
  set_selectedIndex(select, index) {
    const options = listOfOptions(select);
    for (let i = 0; i < options.length; i++) {
      setStateBit(options[i], STATE_SELECTED_INIT, true);
      if (i === index) { setSelectedness(options[i], true); setStateBit(options[i], STATE_SELECTED_DIRTY, true); }
      else setSelectedness(options[i], false);
    }
    selectednessChanged(select);
  },
  get_selectedOptions: (select) => select._selectedOptionsColl ||
    (select._selectedOptionsColl = liveHTMLCollection(() => listOfOptions(select).filter((o) => o._selectedness === true))),
  // (…the first selected option's value — a DOMString even for a multiple select — '' with none: Redmine's
  // `updateIssueFrom` serializes the form through it)
  get_value(select) {
    for (const o of listOfOptions(select)) if (o._selectedness === true) return o.value;
    return '';
  },
  // (…the first option of that value selected, dirty, every other deselected — as a user's pick, not through the
  // `selected` attribute; with no match none, not re-defaulted, as Chrome)
  set_value(select, value) {
    let matched = false;
    for (const o of listOfOptions(select)) {
      ensureOptionSelInit(o);
      if (!matched && o.value === value) {
        matched = true;
        setSelectedness(o, true);
        setStateBit(o, STATE_SELECTED_DIRTY, true);
      }
      else setSelectedness(o, false);
    }
    selectednessChanged(select);
  }
};

// HTMLFormElement's members (HTML §4.10.3) no attribute reflects, as dom-class-aliases.js installs them with the
// generated binding: its action (a URL, the document's address where it is absent or empty), method / enctype
// (limited to known values), autocomplete (`on` unless `off`), elements and length, relList, and submitting,
// requesting submission, resetting and validating it. Its indices and names are its controls' (FORM_HANDLER, the Proxy
// each form is). Rails-UJS's `handleMethod` builds a form with `form.method = 'post'` / `form.action = href`.
const formElements = (form) =>
  form._elementsColl || (form._elementsColl = liveFormControlsCollection(() => formControlElements(form)));
const FORM_METHODS = new Map([['get', 'get'], ['post', 'post'], ['dialog', 'dialog']]);
const FORM_ENCTYPES = new Map(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].map((k) => [k, k]));
export const htmlFormElementMembers = {
  get_action: (form) => submissionURL(form, form._attrs.action),
  get_method: (form) => reflectEnum(form, 'method', FORM_METHODS, 'get', 'get'),
  set_method(form, value) { form._setAttribute('method', value); },
  get_enctype: (form) => reflectEnum(form, 'enctype', FORM_ENCTYPES, 'application/x-www-form-urlencoded', 'application/x-www-form-urlencoded'),
  set_enctype(form, value) { form._setAttribute('enctype', value); },
  // (…`encoding`, the legacy name of `enctype`)
  get_encoding: (form) => htmlFormElementMembers.get_enctype(form),
  set_encoding: (form, value) => htmlFormElementMembers.set_enctype(form, value),
  get_autocomplete: (form) => (asciiLower(form._attrs.autocomplete ?? '') === 'off' ? 'off' : 'on'),
  set_autocomplete(form, value) { form._setAttribute('autocomplete', value); },
  get_elements: formElements,
  get_length: (form) => formElements(form).length,
  get_relList: (form) => tokenListFor(form, 'rel'),
  // (…the "submit a form" algorithm from the submit() method: no submit event, no constraint validation — but its
  // entry list (and `formdata`) all the same. The intent rides a global slot the click resolver reads: Rails-UJS's
  // data-method chain ends in form.submit() inside a click handler)
  submit(form) { form.__runFormSubmit(null, true); },
  // (…a submit button the form owns, or none — a TypeError for another element, a NotFoundError for another form's —
  // then submitted interactively: constraint validation and the submit event)
  requestSubmit(form, submitter) {
    if (submitter != null) {
      if (!isSubmitButton(submitter)) {
        throw new globalThis.TypeError("Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not a submit button.");
      }
      if (formForControl(submitter) !== form) {
        throw new globalThis.DOMException(
          "Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not owned by this form element.", 'NotFoundError');
      }
    }
    form._submitForm(submitter ?? null, true);
  },
  reset: (form) => resetForm(form),
  checkValidity: (form) => formCheckValidity(form),
  reportValidity: (form) => formCheckValidity(form)
};
