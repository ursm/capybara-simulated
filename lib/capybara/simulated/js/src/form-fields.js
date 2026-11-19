// Form-field mutations — the Ruby-side Capybara DSL (`fill_in 'X', with: 'Y'`, `choose`, `select`, `send_keys`) ends up
// routed through these host steps, each one host call from Ruby: the keyboard's gestures the engine sequences
// (keys.rs `KeyGesture`) played, an option picked, files attached.

import { NODE_CDATA, NODE_ELEMENT, NODE_TEXT, isHtml } from './constants.js';
import { handleOf, lookup }           from './handles.js';
import { dispatchEventForUserAction } from './dispatch.js';
import { engineWritten } from './mutation-observer.js';
import { feedStyleEngineSheets, styleEngineCaretEdge } from './cascade.js';
import { caretRectOf, clientBox, ensureTextGeometry, forgetCaretMove, rectOf, rememberCaretMove } from './layout.js';
import { File, blobByteArray, blobHost, blobType, fileName, hostBackedFile, isFile } from './blob.js';
import { updateSelectedContent } from './custom-elements.js';
import { SELECT_HAS_SELECTED_CONTENT, elementFlag } from './element-flags.js';
import { formDataEntries } from './form-data.js';
import {
  ancestorForm, contenteditableHost, isContenteditable, controlLiveValue,
  setControlLiveValue, typeIntoControl, moveTextEntryCursor, editControl,
  markUserValidity, optionsChanged, selectedCoordinateOf, inputTypeState
} from './form-helpers.js';
import {
  childCountOf, sanitizedValueOf, rareDataOf, nodeDocumentOf, parentOrHostOf, setSelectedFiles
} from './native-query-shadow.js';
import { Event, InputEvent, KeyboardEvent, eventState } from './events.js';
import {
  commitChangeKeepingFocus, deleteInEditingHost, deleteRangeContents,
  clipboardGesture, insertInEditingHost, inputSupportsList, rangeCollapsed, rangeStart,
  scrollElement, selectEverything, showComboboxDatalist, submissionURL, formActionURL, formsRefused, popupRefused, nodeContains, clickElement, focusElement, submitForm, setAttribute, blurElement
} from './dom-nodes.js';
import { closeRequest } from './dialog.js';
import { closeTopmostPopover } from './popover.js';
import { stepInput } from './html-input.js';
import { attrsOf, nidOf, nodeTypeOf } from './node-identity.js';
import { documentEncoding } from './base-url.js';
import {
  builtList, dom, hostSteps, listFlatMap, listMap, listOf, listPush, newList, pageList,
  realmHooks
} from './engine.js';
import { arrayIsArray, mathMax, mathMin } from './intrinsics.js';

// The keyboard's gestures — `send_keys`' keys, Capybara's `set` — played as the engine sequences them (keys.rs
// `KeyGesture`): which event, at what, with which key and modifiers, and whether at all, and which default action runs,
// all decided there, each step as the page stands once the one before ran; each taken here as it says, and its outcome
// told back — whether the event fired was canceled, whether an edit changed anything. Its answer: whether there was an
// element to play it at (`set`: and a plan to play).
const SEND_KEYS = 0, SET = 1;
const KEY = 0, INPUT = 1, CHANGE = 2, FOCUS = 3, BLUR = 4, CARET_END = 5, CARET_LAST = 6, CLOSE = 7, ARROW = 8;
const STEP_VALUE = 9, COMMIT = 10, ACTIVATE = 11, SUBMIT = 12, SELECTION = 13, MOVE = 14, INSERT = 15, DELETE = 16;
const TYPE = 17, EDIT_CONTROL = 18, FOCUS_NAV = 19, SELECT_ALL = 20, CLIPBOARD = 21, DRAIN = 22, WRITE = 23, PICK_OPTION = 24;
const CLICK_RESOLVE = 25, CLEAR_HOST = 26;
// (…an InputEvent's flags — PLAIN: an `input` that is no InputEvent — and how a WRITE writes: its live value as given,
// sanitized first, or its `value` attribute)
const CANCELABLE = 1, TARGET_RANGES = 2, PLAIN = 4, WRITE_LIVE = 0, WRITE_SANITIZED = 1;
function playKeys(kind, n, what) {
  let step = dom.keyGesture(kind, n, what);
  while (typeof step === 'object') step = dom.keyNext(keyStep(step));
  return step;
}
// (…the modifiers held, as the engine's bits have them: CTRL 1, META 2, ALT 4, SHIFT 8)
function keyEventInit(step) {
  const held = step[7];
  return {
    __proto__: null, bubbles: true, cancelable: true, key: step[3], code: step[4], keyCode: step[5], charCode: step[6],
    ctrlKey: (held & 1) !== 0, metaKey: (held & 2) !== 0, altKey: (held & 4) !== 0, shiftKey: (held & 8) !== 0
  };
}
const modifierInit = (held) => ({ ctrlKey: (held & 1) !== 0, metaKey: (held & 2) !== 0, altKey: (held & 4) !== 0, shiftKey: (held & 8) !== 0 });
// A step: a KeyboardEvent `[KEY, type, target, key, code, keyCode, charCode, modifiers, forgetCaret]`, an InputEvent
// `[INPUT, type, target, inputType, data, flags]` (or a plain Event) — whether it was canceled — or a default action,
// `[kind, …]`.
function keyStep(step) {
  const kind = step[0];
  if (kind === KEY) {
    // (…a key that moves the caret by lines carries on from where the last such move left it; any other forgets that)
    if (step[8]) forgetCaretMove();
    return fire(step[2], new KeyboardEvent(step[1], keyEventInit(step)));
  }
  if (kind === INPUT) {
    const flags = step[5];
    if (flags & PLAIN) return fire(step[2], new Event(step[1], { __proto__: null, bubbles: true, cancelable: false, composed: true }));
    const init = { __proto__: null, bubbles: true, cancelable: (flags & CANCELABLE) !== 0, composed: true, data: step[4], inputType: step[3] };
    // (…an insertion's into an editing host targeting the selection: a collapsed range for a caret, the replaced one
    // for a selection)
    if (flags & TARGET_RANGES) init.targetRanges = listOf(hostSteps.targetRangesFromSelection());
    return fire(step[2], new InputEvent(step[1], init));
  }
  // (…a step's own throw — a focus listener's — ends nothing of the gesture's: the steps after it are taken all the same)
  try {
    switch (kind) {
      case CHANGE:
        markUserValidity(step[1]);
        dispatchEventForUserAction(step[1], new Event('change', { __proto__: null, bubbles: true, cancelable: false }));
        break;
      case FOCUS: focusElement(step[1]); break;
      case BLUR: blurElement(step[1]); break;
      case CARET_END: moveTextEntryCursor(step[1], String(controlLiveValue(step[1])).length); break;
      case CARET_LAST: {
        const last = styleEngineCaretEdge(step[1], true);
        if (last) realmHooks.collapseSelection(last[0], last[1]);
        break;
      }
      case CLOSE: {
        const doc = nodeDocumentOf(step[1]);
        if (!closeTopmostPopover(doc)) closeRequest(doc);
        break;
      }
      case ARROW: arrowKeyDefault(step[1], step[2]); break;
      case STEP_VALUE: return stepInput(step[1], step[2] ? 1 : -1) ? 1 : 0;
      case COMMIT: commitChangeKeepingFocus(step[1]); break;
      case ACTIVATE: clickElement(step[1], modifierInit(step[2])); break;
      case SUBMIT: submitForm(step[1], null, true); break;
      case SELECTION: return hostSelection(step[1]);
      case MOVE: moveCaret(step[1], step[2], step[3]); break;
      case INSERT: insertInEditingHost(step[1], step[2]); return 1;
      case DELETE: deleteInEditingHost(step[1], step[2]); return 1;
      case TYPE: return typeIntoControl(step[1], step[2], step[3]) === '' ? 0 : 1;
      case EDIT_CONTROL: return editControl(step[1], step[2]) ? 1 : 0;
      case FOCUS_NAV: hostSteps.advanceFocus(step[1]); break;
      case SELECT_ALL: selectEverything(nodeDocumentOf(step[1]), step[1]); break;
      case CLIPBOARD: clipboardGesture(step[1], nodeDocumentOf(step[2])); break;
      // (…the zero-delay work a `set`'s focus handlers queued, run before it writes)
      case DRAIN: hostSteps.drainTimers(0, 1000); break;
      case WRITE: {
        const n = step[1], v = step[2], how = step[3];
        if (how === WRITE_LIVE) setControlLiveValue(n, v);
        else if (how === WRITE_SANITIZED) setControlLiveValue(n, sanitizedValueOf(n, inputTypeState(n), v));
        else setAttribute(n, 'value', v);
        break;
      }
      case PICK_OPTION: pickOption(step[1], PICK, false); break;
      case CLICK_RESOLVE: hostSteps.clickResolve(handleOf(step[1]), {}, { leavePending: true }); break;
      case CLEAR_HOST: clearEditingHost(step[1]); break;
    }
  } catch (_) {}
  return 0;
}
function fire(target, event) {
  try { dispatchEventForUserAction(target, event); } catch (_) {}
  return eventState(event).canceled ? 1 : 0;
}
// The selection a key edits in an editing host (keys.rs `SELECTION_*`): the document's — none where it starts anywhere
// but in an editable part of `n` (an editing host nested in it the one edited) — and whether it is collapsed: its
// range as it is, not retargeted out of a shadow tree as the Selection's members are.
const SELECTION_NONE = 0, SELECTION_RANGE = 1, SELECTION_COLLAPSED = 2;
function hostSelection(n) {
  const range = realmHooks.selectionRange(), start = range && rangeStart(range)[0];
  const at = start && (nodeTypeOf(start) === NODE_ELEMENT ? start : parentOrHostOf(start));
  if (!at || !isContenteditable(at) || !dom.contains(nidOf(n), nidOf(at))) return SELECTION_NONE;
  return rangeCollapsed(range) ? SELECTION_COLLAPSED : SELECTION_RANGE;
}
// Home / End and the arrows move the caret of `n` as their default action (`motion`, keys.rs): where to is the engine's
// (caret_moves.rs `keyMoveTarget`) — an editing host's selection's focus to a point, a textarea's caret to an offset in
// its value, any other text control an edit — and the bindings set the selection to it, collapsed or (Shift) extended,
// which fires its `selectionchange`; a line-wise move kept as the next sets out from (`rememberCaretMove`), the caret
// revealed in a root that scrolls.
// (…one by the lines of its text, an editing host's or a textarea's, asked again once that is laid out: `TEXT_WANTED`)
const KEY_MOVE_EXTEND = 1 << 5;
const TO_POINT = 1, TO_VALUE = 2, TO_EDIT = 3, TEXT_WANTED = 4, KEEP = 1, REVEAL = 2;
function moveCaret(n, motion, editingHost) {
  feedStyleEngineSheets();
  const target = (laidOut) => dom.keyMoveTarget(n, motion, editingHost, realmHooks.selectionState(globalThis.document), laidOut);
  let move = target(false);
  if (move?.[0] === TEXT_WANTED) {
    ensureTextGeometry();
    move = target(true);
  }
  if (move === undefined) return;
  const extend = (motion & KEY_MOVE_EXTEND) !== 0;
  if (move[0] === TO_EDIT) {
    editControl(n, move[1]);
    return;
  }
  const kind = move[0], at = move[1], offset = move[2], x = move[3], upstream = move[4], flags = move[5];
  if (kind === TO_VALUE) {
    const anchor = at;
    if (extend) moveTextEntryCursor(n, mathMin(anchor, offset), mathMax(anchor, offset), offset < anchor ? 'backward' : 'forward');
    else moveTextEntryCursor(n, offset);
    rememberCaretMove({ node: n, offset, x, upstream });
    if (flags & REVEAL) revealCaret(n, n, offset);
    return;
  }
  const node = at[0];
  if (extend) realmHooks.extendSelection(node, offset);
  else realmHooks.collapseSelection(node, offset);
  if (flags & KEEP) rememberCaretMove({ node, offset, x, upstream });
  if (flags & REVEAL) revealCaret(contenteditableHost(n), node, offset);
}

// …and the caret where it shows: `root` — a textarea, an editing host that scrolls — scrolled the least to hold the
// caret's box, as an editor follows its caret (Chrome: a 16px font's caret on 20px lines, 21 and then 41).
function revealCaret(root, node, offset) {
  const rect = caretRectOf(node, offset, false, true);
  const box = rectOf(root), client = clientBox(root);
  if (!rect || !client.height) return;
  const top = box.y + client.top, bottom = top + client.height;
  const dy = rect[1] < top ? rect[1] - top : rect[1] + rect[3] > bottom ? rect[1] + rect[3] - bottom : 0;
  if (dy) scrollElement(root, undefined, dy, true);
}

hostSteps.sendKeys = (h, atoms) => playKeys(SEND_KEYS, lookup(h), atoms);

// A point the engine answers, [nodes, offsets…], as nodes and offsets: [node, offset, node, offset…].
function caretPoint(answer) {
  if (answer === undefined) return null;
  return listFlatMap(answer[0], (node, i) => [node, answer[i + 1]]);
}

// A second press's default action (pointer.rs `MousePointer`, a double click's): the word under the pointer selected —
// in an editing host, the word at the caret its press set. PM / Tiptap pick this up via `selectionchange`, and read it
// on the `dblclick` that follows, to wrap the selected word with marks the subsequent paste applies.
export function selectWordAt(n) {
  if (nodeTypeOf(n) !== NODE_ELEMENT || !isContenteditable(n)) return;
  const sel = realmHooks.getSelection();
  if (!sel) return;
  // The word at the selection's start where that is a text node inside the target, else at the start of the target's
  // first non-empty text leaf — PM wraps freshly-marked inline content with cursor / placeholder span widgets, so the
  // text leaf may not be the deepest first child — the engine's (caret.rs `caret_word`): real-browser word selection
  // crosses adjacent inline text nodes (`<code>code</code><strong>bold</strong>not` is one run, which Discourse's "wrap
  // URL paste over a selection with existing marks" needs whole), stopping at a non-word character or a block's edge.
  const r = realmHooks.selectionRange();
  const at = r ? rangeStart(r) : null, start = at ? at[0] : null, startOffset = at ? at[1] : 0;
  const inside = start && nodeContains(n, start) && (nodeTypeOf(start) === NODE_TEXT || nodeTypeOf(start) === NODE_CDATA);
  const from = inside ? start : n;
  const word = caretPoint(dom.caretWord(nidOf(from), inside ? startOffset : 0));
  if (word) realmHooks.select(word[0], word[1], word[2], word[3]);
}

// Cheap probe used by `Browser#send_keys` to decide whether to
// split a multi-char text atom into per-char calls. The split
// is only necessary for contenteditable hosts (PM / Tiptap / Trix
// reconcile their view between chars); plain `<input>` /
// `<textarea>` get the whole string in one cross-boundary call.
hostSteps.isContentEditable = function (h) {
  const n = lookup(h);
  return !!(n && nodeTypeOf(n) === NODE_ELEMENT && isContenteditable(n));
};

hostSteps.ancestorForm = function (h) {
  const n = lookup(h);
  if (!n) return 0;
  const f = ancestorForm(n);
  return handleOf(f);
};
// …and whether its document's sandbox refuses the form behind handle `h` a submission the driver makes of it
// (Capybara's `Node#submit`): as `form.submit()`'s steps do — no `allow-forms`, or a target that would open a new
// window without `allow-popups`.
hostSteps.formSubmissionRefused = function (h) {
  const form = lookup(h);
  if (!form) return false;
  return formsRefused(form) || popupRefused(dom.formSubmission(nidOf(form), -1, '')[3], form, () => formActionURL(form, null));
};

// Called by the Ruby side after `attach_file` resolves a list of paths: the input's FileList-shaped array, which
// `el.files` exposes to JS consumers (jQuery file widgets, Redmine's attachments.js).
// How `set` cannot reach the control behind handle `h`, where it is inert — behind a modal dialog, under `inert`: by a
// click, for a checkbox or a radio button (WebDriver's element click is intercepted), else by keys (element not
// interactable). Null where it can — and for a file input, which WebDriver lets take its files inert or not (no strict
// file interactability: chromedriver attaches to an uploader's input left outside the modal).
hostSteps.inert = function (h) {
  const n = lookup(h);
  if (n == null || nidOf(n) == null || !dom.isInert(nidOf(n))) return null;
  if (!isHtml(n, 'input')) return 'keys';
  const type = inputTypeState(n);
  return type === 'file' ? null : type === 'checkbox' || type === 'radio' ? 'click' : 'keys';
};
hostSteps.setFiles = function (h, fileInfos) {
  const n = lookup(h);
  if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return false;
  const list = arrayIsArray(fileInfos) ? fileInfos : pageList();
  setSelectedFiles(n, listMap(list, (info, i) => hostBackedFile(info, h, i)));
  return true;
};
// Capybara's `set`, as Selenium does it — the engine's (keys.rs `KeyGesture`, `set_plan`): the element written
// focused first, its value typed over, set, sanitized, clicked or picked, its `input` and `change` fired, and a value
// ending in a line feed submitting — or, an editing host's, its content typed key by key. The element vanished between
// the test's `find` and the `set` (null) the focused text control or editing host instead.
hostSteps.setValue = (h, value) => playKeys(SET, lookup(h), value);
// An editing host's content selected and deleted, the caret at the first caret position of what is left — the
// emptied host's start (caret.rs `caret_edge`) — as a user empties it before typing.
function clearEditingHost(n) {
  if (!realmHooks.getSelection()) return;
  realmHooks.select(n, 0, n, childCountOf(n, false));
  const r0 = realmHooks.selectionRange();
  if (r0 && !rangeCollapsed(r0)) deleteRangeContents(r0);
  const first = styleEngineCaretEdge(n, false);
  if (first) realmHooks.collapseSelection(first[0], first[1]);
}
// Real browsers (and selenium's `.select_by(...)`) fire `input`
// and `change` on the parent `<select>` when the user picks a
// different option — `input` a plain Event, bubbling and composed (HTML;
// Chrome and Firefox). Redmine's `<select onchange=
// "updateIssueFrom(...)">` relies on `change` to refire the form
// AJAX; a redundant `select_option` against the already-selected
// option changes nothing and fires neither.
function __fireSelectChange (sel) {
  try { dispatchEventForUserAction(sel, new Event('input', { __proto__: null, bubbles: true, cancelable: false, composed: true })); } catch (_) {}
  try { dispatchEventForUserAction(sel, new Event('change', { __proto__: null, bubbles: true, cancelable: false })); } catch (_) {}
}
// …once the engine picked: the options whose selectedness changed, which the select shows laid out in it and
// `:checked` matches, its `<selectedcontent>` and the generations — then its events, where something changed.
function userPicked(select, changed, events = true) {
  optionsChanged(changed);
  engineWritten();
  if (!select) return;
  if (elementFlag(select, SELECT_HAS_SELECTED_CONTENT)) updateSelectedContent(select);
  if (events && changed.length) __fireSelectChange(select);
}
// A user's pick of an option, its unpick, or a click on it in its select's list — which toggles it in a multiple
// select's, picks it in a single select's (validity.rs `optionPick`): false where the user can pick nothing — a
// disabled option (its own `disabled`, or its optgroup's), one in a disabled select, a click on one in none.
const PICK = 0, UNPICK = 1, CLICK = 2;
function pickOption(option, how, events = true) {
  const picked = dom.optionPick(option, how);
  if (picked === undefined) return false;
  userPicked(picked[0], picked[1], events);
  return true;
}
hostSteps.selectOption = (h) => pickOption(lookup(h), PICK);
hostSteps.unselectOption = (h) => pickOption(lookup(h), UNPICK);
// (…a TRUSTED click on an `<option>`: the customizable select popup's / a listbox's — dispatch.js)
realmHooks.toggleOptionByClick = (option) => pickOption(option, CLICK);

// UA arrow-key default action for a focused form control — identical whether the
// keydown came from Capybara send_keys, testdriver Actions, or a page-dispatched
// trusted key (the testdriver shim's keyDefaultAction routes here, so the behavior
// isn't a test-only shim hack). The engine names the radio button the group moves to,
// or moves the single select's pick (validity.rs `arrowDefault`): the radio button
// takes focus and is clicked — a trusted click, whose activation checks it and fires
// its input + change (Chrome) — and the select fires its own.
function arrowKeyDefault(node, key) {
  if (!node || nodeTypeOf(node) !== NODE_ELEMENT) return;
  // ArrowUp/Down on a customizable `<input list>` opens its `<datalist>` popover (the
  // same show as focus) when it isn't already open — open-ui combobox key behavior.
  // Gated on a list-applicable input type so `<input type=radio list=…>` still falls
  // through to the radio-group arrow navigation below.
  if ((key === 'ArrowDown' || key === 'ArrowUp') && inputSupportsList(node)) {
    showComboboxDatalist(node);
    return;
  }
  const moved = dom.arrowDefault(node, key);
  if (moved === undefined) return;
  const target = moved[0], changed = moved[1];
  if (isHtml(target, 'select')) {
    userPicked(target, changed);
    return;
  }
  focusElement(target);
  clickElement(target, {});
}
// (…the testdriver's key actions' too)
hostSteps.arrowKeyDefault = arrowKeyDefault;

// An entry list flattened to a plain JSON list the Ruby submission encoder consumes:
// each entry is a string `{name, value}` or a file `{name, file, filename, type,
// handle, index}`. The handle/index point into Ruby's `@file_picks` slot (see
// `attach_file`), so a host-backed File's bytes resolve even when JS moved it onto
// another input. An in-memory `new File([…])` has no slot — its bytes live in the VM,
// so we carry them for the classic submit to encode.
export function serializeEntryList(entryList) {
  if (!entryList) return null;
  const out = newList();
  for (let i = 0; i < entryList.length; i++) {
    const name = entryList[i][0], value = entryList[i][1];
    if (isFile(value)) {
      const host = blobHost(value);
      listPush(out, {
        name:     String(name),
        file:     true,
        filename: fileName(value),
        type:     blobType(value),
        handle:   host ? host.handle : null,
        index:    host ? host.index : null,
        bytes:    host ? null : blobByteArray(value)
      });
    } else {
      listPush(out, { name: String(name), value: String(value) });
    }
  }
  return builtList(out);
}

// Accept either a handle (the submission path) OR the element OBJECT directly.
// `new FormData(iframeForm)` constructs the entry list in the PARENT realm for a form
// living in a CHILD realm — that form's handle is in the child's per-realm registry,
// not ours, so a `lookup` would miss it. The object is cross-realm reachable (same
// isolate), so resolve to it directly.
function resolveFormArg(handleOrEl) {
  if (!handleOrEl) return null;
  return typeof handleOrEl === 'object' ? handleOrEl : lookup(handleOrEl);
}

// HTML "construct the entry list", the ordered walk every submission path shares — the engine's (form_entries.rs
// `entry_list`), each field's value sanitized as its `value` getter has it, but what only the bindings hold: a file
// input's files and a form-associated custom element's submission value, which the engine names and these fill in.
// Returns `[name, value]` pairs in TREE ORDER; a value is a string OR a live `File`. `new FormData(form)` IS this list,
// so it consumes the pairs as-is; `formSerialize` flattens them for the Ruby boundary, which can't hold a File.
const ENTRY_TEXT = 0, ENTRY_FILES = 1, ZERO_COORDINATE = [0, 0];
function constructEntryList(form, submitter, encoding) {
  const coordinate = submitter ? selectedCoordinateOf(submitter) : ZERO_COORDINATE;
  const entries = dom.formEntries(nidOf(form), submitter ? nidOf(submitter) : -1, encoding, coordinate[0], coordinate[1]);
  const flat = entries[0], nodes = entries[1];
  const fields = newList();
  for (let i = 0; i < flat.length; i += 3) {
    const kind = flat[i], name = flat[i + 1], value = flat[i + 2];
    if (kind === ENTRY_TEXT) {
      listPush(fields, [name, value]);
    } else if (kind === ENTRY_FILES) {
      // Each selected File, as the live object: its host-backed source (`_handle`/`_index` → the Ruby `@file_picks`
      // slot) rides along on it, so the multipart serialiser resolves bytes even for a file moved onto a DIFFERENT
      // input via JS (`input.files = dataTransfer.files`). An input with no selection still contributes one empty
      // entry, per HTML's form-data construction.
      const files = nodes[value].files;
      if (files && files.length) {
        for (let k = 0; k < files.length; k++) listPush(fields, [name, files[k]]);
      } else {
        listPush(fields, [name, new File(pageList(), '', { type: 'application/octet-stream' })]);
      }
    } else {
      const el = nodes[value];
      appendCustomElementEntries(fields, el, attrsOf(el).name);
    }
  }
  return builtList(fields);
}

// HTML's "entry construction algorithm" for a form-associated custom element: its
// submission value — whatever `internals.setFormValue()` last stored — is either a
// list of entries (a FormData, whose own names REPLACE the element's `name`), a
// single File / string submitted under `name`, or null (nothing).
function appendCustomElementEntries(fields, el, name) {
  const value = rareDataOf(el)?.submissionValue;
  if (arrayIsArray(value)) {
    for (let k = 0; k < value.length; k++) listPush(fields, [value[k][0], value[k][1]]);
    return;
  }
  if (!name || value == null) return;
  listPush(fields, [name, value]);
}

// Cross-realm entry point for `new FormData(form, submitter)` — see resolveFormArg.
realmHooks.constructEntryList = function (formHandle, submitterHandle, encoding) {
  const form = resolveFormArg(formHandle);
  if (!form || !isHtml(form, 'form')) return null;
  return constructEntryList(form, resolveFormArg(submitterHandle), encoding);
};

// Where and how the form submits — everything about the submission EXCEPT its entry list, so a caller that only needs to
// route the navigation doesn't pay for the walk: the engine's (form_entries.rs `formSubmission`) — a submitter's
// `formaction` / `formmethod` / `formenctype` / `formtarget` over the form's own, the method and enctype their states, a
// `<base target>` the default target, the submission character encoding — the action URL resolved HERE, in the form's
// own realm, against its document's base URL (a form submitted inside an iframe resolves against the IFRAME's document
// and honours its `<base>`).
function formSubmissionSpec(form, submitter) {
  const doc = nodeDocumentOf(form);
  const parts = dom.formSubmission(nidOf(form), submitter ? nidOf(submitter) : -1, doc ? documentEncoding(doc) : 'UTF-8');
  const action = parts[0], method = parts[1], enctype = parts[2], target = parts[3], rel = parts[4];
  const encoding = parts[5];
  return { action: submissionURL(form, action), method, enctype, target, rel, encoding };
}

// A form's submission as the host sends it — Ruby's for a form it submits, and a submission's request as it is planned
// (dom-nodes.js `recordFormSubmission`): the spec plus the entry list flattened for the host boundary — `entryList` the
// FormData its `formdata` event left where the submission built one, else the form's now — a File can't cross it, so
// it becomes a byte reference (a `@file_picks` slot, or its bytes inline).
hostSteps.formSerialize = function (formHandle, submitterHandle, entryList = null) {
  const form = resolveFormArg(formHandle);
  if (!form || !isHtml(form, 'form')) return null;
  const submitter = resolveFormArg(submitterHandle);
  const spec = formSubmissionSpec(form, submitter);
  spec.entries = serializeEntryList(entryList ? formDataEntries(entryList) : constructEntryList(form, submitter, spec.encoding));
  return spec;
};
