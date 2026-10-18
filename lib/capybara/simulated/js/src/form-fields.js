// Form-field mutations — the Ruby-side Capybara DSL (`fill_in 'X',
// with: 'Y'`, `choose`, `select`, `send_keys`) ends up routed
// through these host fns. Each is one `Context#call` from Ruby; the
// JS-side reaction (keydown / input / change event sequence, value
// write, file attachment) happens entirely inside this module.

import { NODE_CDATA, NODE_ELEMENT, NODE_TEXT } from './constants.js';
import { handleOf, lookup }           from './handles.js';
import { dispatchEventForUserAction } from './dispatch.js';
import { engineWritten } from './mutation-observer.js';
import { styleEngineCaretEdge, styleEngineCaretStep } from './cascade.js';
import { caretALineOver, caretAtLineEdge, caretRectOf, clientBox, forgetCaretMove, rectOf, rememberCaretMove } from './layout.js';
import { queueTask }                  from './timers.js';
import { blobBytes, blobHost, blobType, fileName, hostBackedFile, isFile } from './blob.js';
import { latin1ToBytes }                from './bytes.js';
import { updateSelectedContent } from './custom-elements.js';
import { SELECT_HAS_SELECTED_CONTENT, elementFlag } from './element-flags.js';
import {
  ancestorForm, contenteditableHost, isContenteditable, isActuallyDisabled, getCheckedness, controlLiveValue,
  setControlLiveValue, defaultButtonOf, typeIntoControl, textSelectionOf, moveTextEntryCursor, editControl,
  markUserValidity, optionValue, optionsChanged, selectedCoordinateOf, inputHas, inputTypeState, INPUT_READONLY
} from './form-helpers.js';
import {
  setStateBit, childCountOf, sanitizedValueOf, STATE_DIRTY_BY_USER,
  EDIT_BACKSPACE, EDIT_DELETE, EDIT_LEFT, EDIT_RIGHT, EDIT_HOME, EDIT_END, EDIT_TEXT_START, EDIT_TEXT_END, EDIT_EXTEND, EDIT_WORD_LEFT, EDIT_WORD_RIGHT,
  EDIT_WORD_BACKSPACE, EDIT_WORD_DELETE, EDIT_LINE_BACKSPACE, TYPE_WHOLE, rareDataOf
} from './native-query-shadow.js';
import { Event, InputEvent, KeyboardEvent, eventState } from './events.js';
import {
  EDIT_LINE_BREAK, EDIT_PARAGRAPH, EDIT_TEXT, commitChangeKeepingFocus, deleteInEditingHost, deleteRangeContents,
  insertInEditingHost, inputSupportsList, isFocusable, performClipboardGesture, rangeCollapsed, rangeEnd, rangeStart,
  scrollElement, selectAllText, showComboboxDatalist, submissionURL
} from './dom-nodes.js';
import { bodyOf, documentElementOf } from './document-tree.js';
import { closeRequest } from './dialog.js';
import { closeTopmostPopover } from './popover.js';
import { stepInput } from './html-input.js';

// send_keys: replay a sequence of typed keystrokes against a
// focusable control (or, for non-typeable targets, a plain
// keydown / keyup chain at the body). Each atom from the Ruby
// side is one of:
//   { kind: 'text',  value: 'abc' }   — printable text
//   { kind: 'key',   name: 'enter' }  — special key (no modifier)
//   { kind: 'combo', parts: [...] }   — modifier(s) + final key
//
// We fire a real `keydown` (cancelable) for each effective key
// press, then — if it wasn't `preventDefault`-ed — apply the
// typed effect to the input value and fire `input`. `keyup`
// closes each press. A single `change` event coalesces at the
// end if the value moved (selenium parity: change fires after
// the whole `send_keys` batch, not per character).
// The keys that move the caret by lines, which carry what the last of them left (layout.js `forgetCaretMove`).
const LINE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End']);
// The key `spec` presses — one by its name (`enter`, `left` …), a modifier's, or a character's — as a US keyboard gives
// it: `{key, code, keyCode, char, inputType, named}` (keys.rs `resolve`).
function resolveKey(spec) {
  const [key, code, keyCode, char, inputType, named] = globalThis.__dom.resolveKey(String(spec));
  return { key, code, keyCode, char, inputType, named };
}
// What a key does to an element (`__dom.keyPlan`, keys.rs `plan`): its facts, the default actions that apply — and the
// modifiers it is asked with.
const KEY_TYPEABLE = 1, KEY_EDITING_HOST = 1 << 1, KEY_CHECK_OR_RADIO = 1 << 2, KEY_INTERACTIVE = 1 << 3;
const KEY_KEYPRESS = 1 << 4, KEY_CLOSE_REQUEST = 1 << 5, KEY_ARROW_CHOICE = 1 << 6, KEY_STEP = 1 << 7;
const KEY_IMPLICIT_SUBMIT = 1 << 8, KEY_ENTER_ACTIVATES = 1 << 9, KEY_SPACE_ACTIVATES = 1 << 10;
const KEY_CTRL = 1, KEY_META = 1 << 1, KEY_ALT = 1 << 2, KEY_SHIFT = 1 << 3;
// …and the edit a key makes in a typeable element (`__dom.keyEdit`, keys.rs `edit`).
const KEY_EDIT_TYPE = 1, KEY_EDIT_LINE_BREAK = 1 << 1, KEY_EDIT_PARAGRAPH = 1 << 2, KEY_EDIT_DELETE = 1 << 3;
const KEY_EDIT_FORWARD = 1 << 4, KEY_EDIT_WORD = 1 << 5, KEY_EDIT_LINE = 1 << 6;
// …and the caret it moves there (`__dom.keyMotion`, keys.rs `motion`): to its line's edge, by a character, a line over.
const KEY_MOVE_LINE_EDGE = 1, KEY_MOVE_CHAR = 2, KEY_MOVE_LINE = 3, KEY_MOVE_KIND = 3;
const KEY_MOVE_FORWARD = 1 << 2, KEY_MOVE_WHOLE = 1 << 3, KEY_MOVE_WORD = 1 << 4, KEY_MOVE_EXTEND = 1 << 5;
// …and the selection it edits (keys.rs `SELECTION_*`): a text control's, or the document's where `n` is an editing host —
// none where that one starts anywhere but in an editable part of `n` (an editing host nested in it the one edited) —
// and whether it is collapsed.
const KEY_SELECTION_NONE = 0, KEY_SELECTION_RANGE = 1, KEY_SELECTION_COLLAPSED = 2;
function keySelection(n, editingHost) {
  if (editingHost) {
    // (…its range as it is, not retargeted out of a shadow tree as the Selection's members are)
    const range = globalThis.__csimSelectionRange(), start = range && rangeStart(range)[0];
    const at = start && (start._nodeType === NODE_ELEMENT ? start : start._parent);
    if (!at || !isContenteditable(at) || !globalThis.__dom.contains(n._nid, at._nid)) return KEY_SELECTION_NONE;
    return rangeCollapsed(range) ? KEY_SELECTION_COLLAPSED : KEY_SELECTION_RANGE;
  }
  const sel = textSelectionOf(n);
  return !sel || sel.start === sel.end ? KEY_SELECTION_COLLAPSED : KEY_SELECTION_RANGE;
}
// …and the modifier `name` names, `{key, code, keyCode}` — null for none (keys.rs `modifier`).
function modifierKey(name) {
  const m = globalThis.__dom.modifierKey(String(name));
  return m && { key: m[0], code: m[1], keyCode: m[2] };
}
// ArrowLeft / ArrowRight inside a contenteditable: the selection's focus one character on — a word, with Control — the
// engine's (caret.rs `caret_step`, `caret_word_step`): across adjacent text leaves where it crosses a node's edge, so it
// transits link / mark boundaries (ProseMirror surfaces its link-toolbar on the resulting `selectionchange`), never out
// of the editing host (ArrowLeft at the very start of an editor stays put, where it once collapsed onto a heading
// above the composer); the selection extended to it with Shift, collapsed there without. A range, without Shift,
// collapses to its edge that way instead (Chrome).
function moveContenteditableCaret(dir, extend, word) {
  const focus = globalThis.__csimSelectionFocus();
  if (!focus) return;
  const range = globalThis.__csimSelectionRange();
  if (!extend && !rangeCollapsed(range) && !word) {
    const [node, offset] = dir < 0 ? rangeStart(range) : rangeEnd(range);
    globalThis.__csimCollapseSelection(node, offset);
    return;
  }
  const to = styleEngineCaretStep(word ? 'caretWordStep' : 'caretStep', focus[0], focus[1], dir > 0);
  if (!to) return;
  if (extend) globalThis.__csimExtendSelection(to[0], to[1]);
  else globalThis.__csimCollapseSelection(to[0], to[1]);
}
// (…a point the engine answers, [nodes, offsets…], as nodes and offsets: [node, offset, node, offset…])
function caretPoint(answer) {
  if (answer === undefined) return null;
  return answer[0].flatMap((node, i) => [node, answer[i + 1]]);
}

// A line-wise move made (layout.js `caretALineOver`, `caretAtLineEdge`): the selection's focus moved to it — extended to
// it with Shift — and the move kept for the next line-wise key; a textarea's in its value, from its selection's focus
// and anchor (`textareaEnds`).
function moveSelectionFocus(at, extend) {
  if (extend) globalThis.__csimExtendSelection(at.node, at.offset);
  else globalThis.__csimCollapseSelection(at.node, at.offset);
  rememberCaretMove(at);
}
function moveTextareaFocus(n, anchor, at, extend) {
  if (extend) moveTextEntryCursor(n, Math.min(anchor, at.offset), Math.max(anchor, at.offset), at.offset < anchor ? 'backward' : 'forward');
  else moveTextEntryCursor(n, at.offset);
  rememberCaretMove(at);
}
function textareaEnds(n) {
  const ts = globalThis.__dom.textSelection(n._nid, false);
  if (!ts) return [0, 0];
  return ts[2] === 'backward' ? [ts[0], ts[1]] : [ts[1], ts[0]];
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

// The modifier flags a chord's modifiers set.
function modifierFlags(infos) {
  const out = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  for (const { key } of infos) out[MODIFIER_FLAGS[key]] = true;
  return out;
}
const MODIFIER_FLAGS = { Control: 'ctrlKey', Meta: 'metaKey', Shift: 'shiftKey', Alt: 'altKey' };
// What a key event goes to now (UI Events: the focused element — inside a shadow tree too, which `document.activeElement`
// retargets to its host — else the body), `n` where the document has neither.
function keyEventTarget(n) {
  const doc = globalThis.document;
  return doc._activeElement || bodyOf(doc) || n;
}
globalThis.__csimSendKeys = function (h, atoms) {
  let n = lookup(h);
  if (!n || n._nodeType !== NODE_ELEMENT) return false;
  // Container-shape targets (the `<details>` element under select-kit,
  // for instance) aren't typeable themselves but the user-intent is to
  // route the keystroke to whatever's focused inside them. Discourse's
  // `expanded_component.press("Escape")` pattern targets the details
  // wrapper, but the Escape handler is bound on the inner summary /
  // body. Real browsers fire keydown on the focused element regardless
  // of which DOM container the test names; mirror that by retargeting
  // when an active descendant exists.
  if ((n._tag === 'details' || n._tag === 'div') && globalThis.document) {
    // (…the focused element itself, a shadow tree's too — `_parent` goes out through its host)
    const active = globalThis.document._activeElement;
    if (active && active !== n && active !== bodyOf(globalThis.document)) {
      let cur = active;
      while (cur && cur !== n) cur = cur._parent;
      if (cur === n) n = active;
    }
  }
  // Typed input is a user edit (mark the FINAL target, after any retarget) so
  // minlength/maxlength (tooShort/tooLong) validation can apply — it never does
  // for a programmatic `.value` set.
  if (n._tag === 'input' || n._tag === 'textarea') setStateBit(n, STATE_DIRTY_BY_USER, true);
  // (…what it is to a key: whether text can be typed into it, an editing host's or a control's — a checkbox or a radio
  // none, its Space an activation — and whether it is an interactive element: keys.rs `plan`)
  const facts = globalThis.__dom.keyPlan(n, '', null, 0);
  const ceTypeable = (facts & KEY_EDITING_HOST) !== 0;
  const typeable = (facts & KEY_TYPEABLE) !== 0;
  // Selenium / Playwright `send_keys` focus their target before
  // dispatching keys — even for non-typeable interactives like
  // anchors and buttons. This blurs whatever previously held focus
  // (Discourse `.topic-list-item` removes its `.selected` class on
  // `a.title` blur, which gates the Mousetrap `Enter` binding from
  // intercepting and redirecting to the wrong row).
  globalThis.__dom.setPointerModality(false);   // send_keys is keyboard-driven → :focus-visible applies
  if (facts & (KEY_TYPEABLE | KEY_CHECK_OR_RADIO | KEY_INTERACTIVE)) {
    // (…and keys sent to an element that does not have focus start at its end (WebDriver "element send keys"): a text
    // control's caret at its value's end, a contenteditable element's "after any child content" — its last caret
    // position, where focusing it put the caret at its first — the body the active element where nothing has focus, as a
    // design-mode document's is)
    const moveCaret = typeable && (n._ownerDocument._activeElement ?? bodyOf(n._ownerDocument)) !== n;
    try { n._focus(); } catch (_) {}
    if (moveCaret && ceTypeable) {
      const last = styleEngineCaretEdge(n, true);
      if (last) globalThis.__csimCollapseSelection(last[0], last[1]);
    } else if (moveCaret) {
      moveTextEntryCursor(n, String(controlLiveValue(n)).length);
    }
  }
  // …the document element, or a body that can't take focus, focusing the VIEWPORT (HTML "get the focusable area"):
  // whatever held focus loses it, and the keys go to the body (chromedriver, measured 2026-10-10 — a dialog the focus
  // was in no longer holds it, so closing it gives none back).
  else if (n === documentElementOf(n._ownerDocument) || (n === bodyOf(n._ownerDocument) && !isFocusable(n))) {
    const focused = n._ownerDocument._activeElement;
    if (focused) try { focused._blur(); } catch (_) {}
    n = bodyOf(n._ownerDocument) ?? n;
  }
  // A deferred default (Enter's, below) runs before the next key's events at the latest — its listeners' microtasks
  // drained first — so the keys' effects stay in the order they were pressed: `send_keys('a', :enter, [:control, 'a'])`
  // selects the line break too.
  let deferred = null;
  const pressKey = (info, modifiers) => {
    if (!LINE_KEYS.has(info.key)) forgetCaretMove();
    if (deferred) {
      if (globalThis.__csim_yield) globalThis.__csim_yield();
      if (deferred) deferred();
    }
    // (…the default actions the key takes on `n` where its events are not canceled: keys.rs `plan` — asked again after
    // each event, as a listener may change what `n` is to the key: remove a link's `href`, make an input read-only)
    const held = modifiers ? (modifiers.ctrlKey ? KEY_CTRL : 0) | (modifiers.metaKey ? KEY_META : 0) | (modifiers.altKey ? KEY_ALT : 0) : 0;
    const planNow = () => globalThis.__dom.keyPlan(n, info.key, info.char, held);
    let plan = planNow();
    const initBase = Object.assign({ bubbles: true, cancelable: true }, modifiers || {});
    const init = Object.assign({}, initBase, { key: info.key, code: info.code, keyCode: info.keyCode });
    const kd = new KeyboardEvent('keydown', init);
    dispatchEventForUserAction(n, kd);
    let blocked = eventState(kd).canceled;
    // `keypress`, the legacy event of a key that produces a character — a printable key's, Enter's (a carriage
    // return), none with Control / Alt / Meta held — right after its keydown unless that was canceled (UI Events'
    // order): its key code and char code the character's (Chrome's), and canceling it cancels the key's default
    // action as canceling the keydown does. Mousetrap-shape libraries (Discourse's
    // `@discourse/itsatrap` for the `/`-to-open-search shortcut) still listen for it, reading `e.which` +
    // `String.fromCharCode(...)` to look up a binding. It goes to whatever is focused now: a keydown handler may
    // have moved focus.
    if (!blocked && (plan & KEY_KEYPRESS)) {
      const charCode = info.key === 'Enter' ? 13 : info.char.charCodeAt(0);
      const kp = new KeyboardEvent('keypress', Object.assign({}, init, { keyCode: charCode, charCode }));
      dispatchEventForUserAction(keyEventTarget(n), kp);
      if (eventState(kp).canceled) blocked = true;
    }
    plan = planNow();
    // (…whether `n` is an editing host to the key now, which its events may have changed)
    const editingHost = (plan & KEY_EDITING_HOST) !== 0;
    // Escape's default action is a close request (HTML §6.4.4): the topmost showing auto popover hides, else the dialog
    // opened last that takes one closes.
    if (!blocked && (plan & KEY_CLOSE_REQUEST) && !closeTopmostPopover(n._ownerDocument)) closeRequest(n._ownerDocument);
    // Arrow-key default on a focused single-line <select> (Down/Up → adjacent option)
    // or radio (Down/Right → next, Up/Left → prev in the group) — shared with the
    // testdriver Actions path via __csimArrowKeyDefault.
    if (!blocked && (plan & KEY_ARROW_CHOICE) && typeof globalThis.__csimArrowKeyDefault === 'function') {
      globalThis.__csimArrowKeyDefault(n, info.key);
      // keyup retargets to whatever is now focused (radio nav moved focus to the
      // newly-checked radio), matching the normal keyup-retarget convention below.
      dispatchEventForUserAction(keyEventTarget(n), new KeyboardEvent('keyup', init));
      return false;
    }
    // Arrow Up/Down on a focused stepped input (number / range / date / time / …):
    // the default action steps the value by one step and fires beforeinput → input →
    // change, unless beforeinput is canceled (a spinner press). The IDL stepUp/
    // stepDown methods fire no events; this user-driven path does.
    if (!blocked && (plan & KEY_STEP)) {
      const bi = new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, data: null, inputType: '' });
      dispatchEventForUserAction(n, bi);
      if (!eventState(bi).canceled) {
        let stepped = false;
        try { stepped = stepInput(n, info.key === 'ArrowUp' ? 1 : -1); } catch (_) {}
        // (…the user's edit, and `input`, where its value moved — not its raw text alone: a typed "5." stepped to "5" at
        // its max is "5" still — then the edit committed: `change` where its value moved since it last was, typed or
        // stepped, the field keeping focus and its blur comparing against it now; Chrome)
        if (stepped) {
          globalThis.__dom.changeEdited(n._nid, true);
          dispatchEventForUserAction(n, new InputEvent('input', { bubbles: true, cancelable: false, composed: false, data: null, inputType: '' }));
        }
        commitChangeKeepingFocus(n);
      }
      dispatchEventForUserAction(n, new KeyboardEvent('keyup', init));
      return false;
    }
    // Enter's default action in a text-like input runs the form's
    // implicit-submit algorithm. If the page handler called
    // preventDefault, skip (Tagify / Tribute do this to chip the
    // current token instead of submitting).
    if (!blocked && (plan & KEY_IMPLICIT_SUBMIT)) {
      const form = implicitSubmitFormFor(n);
      if (form) {
        // Implicit submission's submitter is the form's DEFAULT BUTTON (first submit
        // button in tree order), if any. A default button that is disabled blocks
        // implicit submission entirely; with no default button the form still
        // submits, with a null submitter. (HTML "implicit submission".)
        const defaultBtn = defaultButtonOf(form);
        if (!(defaultBtn && isActuallyDisabled(defaultBtn))) {
          const submitter = defaultBtn || null;
          // A dirtied text field commits its `change` BEFORE `submit` (verified in
          // Chrome), while keeping focus — implicit submission doesn't blur it.
          commitChangeKeepingFocus(n);
          submitImplicitly(form, submitter);
        }
      }
    }
    // Enter on a focused button (or link) fires the element's
    // activation behavior — a click, a keyboard's: no pointer, no
    // press, its count 0 (`_click`), which libraries tell from a
    // mouse's (react-aria's `isVirtualClick`). Without this,
    // Tab-then-Enter-driven keyboard navigation through a floating
    // toolbar (PM link toolbar → Tab to edit button → Enter to
    // open modal) silently does nothing.
    //
    // Gated on `okDefault` (the keydown was not preventDefault'd) —
    // including the `<a href>` cmd/ctrl "open in new window" case.
    // Verified in real Chrome: a keydown handler that calls
    // preventDefault SUPPRESSES the native cmd+Enter new-tab open, so
    // when an app's keymap (e.g. Discourse's ItsATrap) both handles the
    // key itself (window.open) AND preventDefaults, firing our synthetic
    // activation too would open a SECOND window. Respect the cancellation
    // and let the app's own open stand.
    // (…the navigation or submission it plans left for the
    // post-send_keys drain — a link's in a new window with cmd /
    // ctrl held)
    if (!blocked && (plan & KEY_ENTER_ACTIVATES)) {
      n._click(modifiers || {});
    }
    // (…what it types, where its events are not canceled: the `inputType` of its `beforeinput` and `input`, and the edit
    // — keys.rs `edit`, asked now, as a listener may have made `n` read-only; the `data` of an `insertText` the text, of
    // a line break, a paragraph or a deletion none)
    const typed = blocked ? null : globalThis.__dom.keyEdit(
      n,
      info.key,
      info.char,
      info.inputType,
      held | (modifiers && modifiers.shiftKey ? KEY_SHIFT : 0),
      keySelection(n, editingHost)
    );
    const [inputType, edit] = typed || ['', 0];
    const data = inputType === 'insertText' ? info.char : null;
    if (typed) {
      // `beforeinput` fires before the value mutates, with the
      // semantic `inputType` set ('insertText' / 'insertLineBreak'
      // / 'deleteContentBackward' / etc.). Stimulus actions like
      // `data-action="beforeinput->list-autofill#handleBeforeInput"`
      // gate on `event.inputType` and call preventDefault to take
      // over (e.g. list-autofill replaces the default Enter with
      // a marker-prefixed newline). Honour the cancellation.
      const bi = new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, composed: true, data,
        // getTargetRanges(): an INSERT into a contenteditable targets the current
        // selection (for a caret this is a collapsed range, for a selection the
        // replaced range). Deletion instead targets the range it removes, which this
        // path doesn't compute, so report none rather than a misleading collapsed
        // caret; a plain text control (no DOM ranges) reports none either way.
        targetRanges: (editingHost && !(edit & KEY_EDIT_DELETE)) ? globalThis.__csimTargetRangesFromSelection() : [],
        inputType
      });
      dispatchEventForUserAction(n, bi);
      if (eventState(bi).canceled) blocked = true;
    }
    // Home / End and the arrows move the caret as their default action — no beforeinput / input — so a character typed
    // next lands where it went (`send_keys('abc', :left, 'x')` is 'abxc'): a text control's value index, an editing host's
    // selection, whose `selectionchange` ProseMirror / Tiptap read to place their toolbars. Which move a key makes is the
    // engine's (keys.rs `motion`: Control a word's or the whole text's, Shift extending the selection — Chrome on Linux);
    // where it goes, the caret's.
    const motion = blocked ? 0 : globalThis.__dom.keyMotion(n, info.key, held | (modifiers && modifiers.shiftKey ? KEY_SHIFT : 0));
    const extend = motion & KEY_MOVE_EXTEND ? EDIT_EXTEND : 0, forward = (motion & KEY_MOVE_FORWARD) !== 0;
    switch (motion & KEY_MOVE_KIND) {
      case KEY_MOVE_LINE_EDGE: {
        const whole = (motion & KEY_MOVE_WHOLE) !== 0;
        if (editingHost) {
          // (…in an editing host to the start or end of the caret's line — its whole text's with Control)
          const focus = globalThis.__csimSelectionFocus(), host = contenteditableHost(n);
          const edge = whole ? styleEngineCaretEdge(host, forward) : null;
          const at = whole ? edge && { node: edge[0], offset: edge[1] } : focus && caretAtLineEdge(host, focus[0], focus[1], forward);
          if (at) moveSelectionFocus(at, extend);
        } else if (n._tag === 'textarea' && !whole) {
          // (…in a textarea to the start or end of its LINE as it wraps, not of the value's line between newlines)
          const [focus, anchor] = textareaEnds(n);
          const at = caretAtLineEdge(n, n, focus, forward);
          if (at && at.node === n) moveTextareaFocus(n, anchor, at, extend);
        } else {
          editControl(n, (forward ? (whole ? EDIT_TEXT_END : EDIT_END) : (whole ? EDIT_TEXT_START : EDIT_HOME)) | extend);
        }
        break;
      }
      case KEY_MOVE_CHAR: {
        const byWord = (motion & KEY_MOVE_WORD) !== 0;
        if (editingHost) moveContenteditableCaret(forward ? 1 : -1, extend !== 0, byWord);
        else if (byWord) editControl(n, (forward ? EDIT_WORD_RIGHT : EDIT_WORD_LEFT) | extend);
        else editControl(n, (forward ? EDIT_RIGHT : EDIT_LEFT) | extend);
        break;
      }
      case KEY_MOVE_LINE: {
        const up = !forward;
        if (editingHost) {
          const focus = globalThis.__csimSelectionFocus();
          const host = contenteditableHost(n);
          const at = focus && caretALineOver(host, focus[0], focus[1], up, styleEngineCaretEdge(host, !up));
          if (at && contenteditableHost(at.node._nodeType === NODE_ELEMENT ? at.node : at.node._parent) === host) {
            moveSelectionFocus(at, extend);
            revealCaret(host, at.node, at.offset);
          }
        } else if (n._tag === 'textarea') {
          const [focus, anchor] = textareaEnds(n);
          const at = caretALineOver(n, n, focus, up, [n, up ? 0 : String(controlLiveValue(n)).length]);
          if (at && at.node === n) {
            moveTextareaFocus(n, anchor, at, extend);
            revealCaret(n, n, at.offset);
          }
        }
        break;
      }
    }
    if (!blocked && typed) {
      const doDefault = () => {
        if (editingHost) {
          if (edit & KEY_EDIT_TYPE) {
            insertInEditingHost(EDIT_TEXT, info.char);
          } else if (edit & (KEY_EDIT_PARAGRAPH | KEY_EDIT_LINE_BREAK)) {
            insertInEditingHost(edit & KEY_EDIT_PARAGRAPH ? EDIT_PARAGRAPH : EDIT_LINE_BREAK);
          } else {
            // (…the engine's: a character or a word, back or forward, or the selection — editing_delete.rs; its `input`
            // fires where nothing was there to delete too, as WPT input-events-typing holds it — Chrome fires none)
            deleteInEditingHost((edit & KEY_EDIT_FORWARD) !== 0, (edit & KEY_EDIT_WORD) !== 0);
          }
        } else if (edit & KEY_EDIT_TYPE) {
          // (…a keystroke `maxlength` or a number field's text refuses no edit: no `input` — Chrome)
          if (typeIntoControl(n, info.char) === '') return;
        } else {
          // (…the live value edited, a textarea's child-text default left as it is: the engine's — and where nothing
          // was there to delete, no `input`)
          const forward = (edit & KEY_EDIT_FORWARD) !== 0;
          const edits = edit & KEY_EDIT_LINE ? EDIT_LINE_BACKSPACE : edit & KEY_EDIT_WORD ? (forward ? EDIT_WORD_DELETE : EDIT_WORD_BACKSPACE)
            : forward ? EDIT_DELETE : EDIT_BACKSPACE;
          if (!editControl(n, edits)) return;
        }
        // A user edit since focus → the control fires `change` when it later loses
        // focus (commitChangeOnBlur); a programmatic value change never sets this.
        globalThis.__dom.changeEdited(n._nid, true);
        try {
          dispatchEventForUserAction(n, new InputEvent('input', {
            bubbles: true, cancelable: false, composed: true, data, inputType
          }));
        } catch (_) {}
      };
      // A key with a promise-deferrable default (Enter — Tagify,
      // Algolia's autocomplete, jQuery-UI menu all call
      // `e.preventDefault()` from a `beforeKeyDown(e).then(...)`
      // chain for it; Tab's focus move below is deferred alike)
      // defers to a task so listener microtasks drain first.
      // Regular character typing stays synchronous so subsequent
      // chars see the cursor mutation from the previous one
      // (`send_keys 'abc'` must produce "abc", not an out-of-order
      // shuffle).
      if (info.key === 'Enter') {
        const run = () => {
          if (deferred !== run) return;
          deferred = null;
          if (!eventState(kd).canceled) doDefault();
        };
        deferred = run;
        queueTask(run, 0);
      } else {
        doDefault();
      }
    }
    // Tab's UI Events default action moves focus through the
    // document's tabbable elements (reverse with shift). Menus
    // that close on `focusout` rely on the resulting blur/focus
    // events firing. Skip if a handler preventDefault'd the keydown.
    if (!blocked && info.key === 'Tab') {
      queueTask(() => {
        if (eventState(kd).canceled) return;
        try { globalThis.__csimAdvanceFocus(!!(modifiers && modifiers.shiftKey)); } catch (_) {}
      }, 0);
    }
    // keyup re-targets to whatever is currently focused —
    // a keydown handler that blurred or moved focus (Discourse
    // `Escape` → SearchMenu.close() blurs the input → focus moves
    // to BODY) must NOT route the subsequent keyup back to the
    // original element. Without this, SearchTerm's onKeyup fires
    // a spurious `openSearchMenu()` after Escape had just closed it.
    const kupTarget = keyEventTarget(n);
    const ku = new KeyboardEvent('keyup', init);
    dispatchEventForUserAction(kupTarget, ku);
    // Space activates a focused button, checkbox or radio on its release (a keyboard's click, as Enter's above) — the
    // keyup's default action, so unless it, its keydown or its keypress was canceled — a click whose listeners
    // (Discourse wizard, Stimulus actions) see the checkbox toggled and its `input` / `change` fire.
    if (!blocked && !eventState(ku).canceled && kupTarget === n && (planNow() & KEY_SPACE_ACTIVATES)) {
      n._click(modifiers || {});
    }
    return eventState(kd).canceled;
  };
  const atomList = Array.isArray(atoms) ? atoms : [];
  for (const a of atomList) {
    if (!a || typeof a !== 'object') continue;
    if (a.kind === 'text') {
      const s = String(a.value || '');
      for (const ch of s) pressKey(resolveKey(ch), null);
    } else if (a.kind === 'key') {
      pressKey(resolveKey(a.name), null);
    } else if (a.kind === 'combo') {
      const parts = Array.isArray(a.parts) ? a.parts : [];
      // Modifiers are everything but the final atom; the final
      // atom is the key being pressed *while* the modifiers are
      // held. Some callers only pass modifiers (selecting all
      // text via Ctrl+A is the canonical "modifier + letter").
      let lastKeyIdx = -1;
      for (let i = parts.length - 1; i >= 0; i--) {
        if (!modifierKey(parts[i])) { lastKeyIdx = i; break; }
      }
      const modNames = parts.slice(0, lastKeyIdx >= 0 ? lastKeyIdx : parts.length);
      // (…a name no modifier has none)
      const modInfos = modNames.map(modifierKey).filter(Boolean);
      const mods     = modifierFlags(modInfos);
      const keyName  = lastKeyIdx >= 0 ? parts[lastKeyIdx] : '';
      // Real keyboards send a keydown for each modifier first.
      // Capybara's `should generate key events` checks for the
      // 16/17/18 etc. keyCodes alongside the printable key's.
      for (const mi of modInfos) {
        try { dispatchEventForUserAction(n, new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: mi.key, code: mi.code, keyCode: mi.keyCode, ...mods })); } catch (_) {}
      }
      // `[:shift, 'side']` means "hold shift, type each character" —
      // unfold the string into per-character presses with the
      // modifier flags applied. Real keyboards send one keydown per
      // physical key; without unfolding, the whole 'side' string
      // typed as one keydown plus `info.char='side'` would either
      // miss the shift-uppercase mapping or land in the value as
      // the literal modifier name (the previous behaviour).
      // BUT: `[:control, :enter]` arrives with keyName='enter'
      // (Ruby stringifies symbols at the JSON boundary), and we
      // can't unfold a special-key name into 'e','n','t','e','r'.
      // Named keys take precedence over per-character unfolding.
      const isNamedKey = typeof keyName === 'string' && resolveKey(keyName).named;
      // (…whether the chord's key had its keydown canceled, which cancels its default below)
      let canceled = false;
      if (typeof keyName === 'string' && keyName.length > 1 && !isNamedKey) {
        for (const ch of keyName) {
          const cooked = mods.shiftKey ? ch.toUpperCase() : ch;
          pressKey(resolveKey(cooked), mods);
        }
      } else {
        const single = String(keyName);
        const cooked = mods.shiftKey && single.length === 1 ? single.toUpperCase() : single;
        canceled = pressKey(resolveKey(cooked), mods);
      }
      for (let i = modInfos.length - 1; i >= 0; i--) {
        const mi = modInfos[i];
        try { dispatchEventForUserAction(n, new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: mi.key, code: mi.code, keyCode: mi.keyCode })); } catch (_) {}
      }
      // Ctrl / Cmd + A, X, C, V: the chord's key's keydown default actions, unless it was canceled — select all
      // content in the focused text control or contenteditable host (UI Events), and the clipboard's cut, copy and
      // paste (dom-nodes performClipboardGesture: the ClipboardEvent, then beforeinput / input). Redmine's
      // `copy_*_to_clipboard` tests round-trip text via a Stimulus `clipboard#copyText` call, and Discourse's
      // ProseMirror pasting specs round-trip HTML via `navigator.clipboard.write([ClipboardItem(text/html)])`
      // followed by Ctrl+V.
      const lowerKey = String(keyName).toLowerCase();
      if (!canceled && (mods.ctrlKey || mods.metaKey)) {
        if (lowerKey === 'a') {
          if (ceTypeable) {
            const host = contenteditableHost(n);
            if (host) globalThis.__csimSelect(host, 0, host, childCountOf(host, false));
          } else if (typeable) {
            selectAllText(n);
          }
        } else if (lowerKey === 'x' || lowerKey === 'c' || lowerKey === 'v') {
          // (…the focused element itself — inside a shadow tree too, which `document.activeElement` retargets to its host)
          performClipboardGesture(CLIPBOARD_GESTURES[lowerKey], globalThis.document._activeElement || n);
        }
      }
    }
  }
  // `change` is NOT fired here: real keyboard input fires it when the control
  // loses focus (commitChangeOnBlur), not at the end of a key sequence. The focus
  // baseline armed by n.focus() above carries the pre-edit value to that blur.
  return true;
};

// Real browsers' double-click default action: select the word under
// the cursor. For a contenteditable target, walk the descendant text
// nodes, find the one containing the click (we approximate "click
// target" with the first text leaf inside), and grow the Selection
// to the word boundaries. PM / Tiptap pick this up via
// `selectionchange` to wrap the selected word with marks the
// subsequent paste applies.
globalThis.__csimSelectWordAt = function (h) {
  const n = lookup(h);
  if (!n || n._nodeType !== NODE_ELEMENT) return;
  if (!isContenteditable(n)) return;
  const sel = globalThis.__csimGetSelection();
  if (!sel) return;
  // The word at the selection's start where that is a text node inside the target, else at the start of the target's
  // first non-empty text leaf — PM wraps freshly-marked inline content with cursor / placeholder span widgets, so the
  // text leaf may not be the deepest first child — the engine's (caret.rs `caret_word`): real-browser word selection
  // crosses adjacent inline text nodes (`<code>code</code><strong>bold</strong>not` is one run, which Discourse's "wrap
  // URL paste over a selection with existing marks" needs whole), stopping at a non-word character or a block's edge.
  const r = globalThis.__csimSelectionRange();
  const [start, startOffset] = r ? rangeStart(r) : [null, 0];
  const inside = start && n._contains(start) && (start._nodeType === NODE_TEXT || start._nodeType === NODE_CDATA);
  const from = inside ? start : n;
  const word = caretPoint(globalThis.__dom.caretWord(from._nid, inside ? startOffset : 0));
  if (word) globalThis.__csimSelect(word[0], word[1], word[2], word[3]);
};

// Cheap probe used by `Browser#send_keys` to decide whether to
// split a multi-char text atom into per-char calls. The split
// is only necessary for contenteditable hosts (PM / Tiptap / Trix
// reconcile their view between chars); plain `<input>` /
// `<textarea>` get the whole string in one cross-boundary call.
globalThis.__csimIsContentEditable = function (h) {
  const n = lookup(h);
  return !!(n && n._nodeType === NODE_ELEMENT && isContenteditable(n));
};

globalThis.__csimAncestorForm = function (h) {
  const n = lookup(h);
  if (!n) return 0;
  const f = ancestorForm(n);
  return handleOf(f);
};

// Called by the Ruby side after `attach_file` resolves a list of paths: the input's FileList-shaped array, which
// `el.files` exposes to JS consumers (jQuery file widgets, Redmine's attachments.js).
// How `set` cannot reach the control behind handle `h`, where it is inert — behind a modal dialog, under `inert`: by a
// click, for a checkbox or a radio button (WebDriver's element click is intercepted), else by keys (element not
// interactable). Null where it can — and for a file input, which WebDriver lets take its files inert or not (no strict
// file interactability: chromedriver attaches to an uploader's input left outside the modal).
globalThis.__csimInert = function (h) {
  const n = lookup(h);
  if (n == null || n._nid == null || !globalThis.__dom.isInert(n._nid)) return null;
  if (n._tag !== 'input') return 'keys';
  const type = inputTypeState(n);
  return type === 'file' ? null : type === 'checkbox' || type === 'radio' ? 'click' : 'keys';
};
globalThis.__csimSetFiles = function (h, fileInfos) {
  const n = lookup(h);
  if (!n || n._nodeType !== NODE_ELEMENT) return false;
  const list = Array.isArray(fileInfos) ? fileInfos : [];
  n._files = list.map((info, i) => hostBackedFile(info, h, i));
  return true;
};
globalThis.__csimSetValue = function (h, value) {
  let n = lookup(h);
  if (!n || n._nodeType !== NODE_ELEMENT) {
    // The element vanished between the test's `find` and the `set`
    // host call. Forem's reply-form path is the canonical case: the
    // toggle handler schedules a setTimeout that focuses the textarea
    // 30 ms later; Capybara's `Element#set` calls `tick_real_time`
    // first, the focus fires inside that drain, the focus handler
    // hands off to Preact's `replaceTextArea` (microtask), and the
    // original textarea gets `remove()`d (with its handle unmapped)
    // before we ever reach this function. Fall back to whatever the
    // page just focused — which is what the test expected to type
    // into.
    const doc = globalThis.document;
    const active = doc && doc._activeElement;
    if (active && active !== bodyOf(doc) && active._nodeType === NODE_ELEMENT &&
        (active._tag === 'input' || active._tag === 'textarea' || isContenteditable(active))) {
      n = active;
    } else {
      return false;
    }
  }
  let tag = n._tag;
  // Capybara `.set` simulates user input → a user edit, so tooShort/tooLong
  // can apply (unlike a raw `.value` IDL set).
  if (tag === 'input' || tag === 'textarea') setStateBit(n, STATE_DIRTY_BY_USER, true);
  // `readonly` reject programmatic value changes for text-shaped
  // inputs. `disabled` does NOT — real-browser parity (and Cuprite,
  // which uses the native HTMLInputElement value setter) lets
  // programmatic assignment write through. The form-submit gate
  // separately drops disabled controls' values. Avo's KeyValueField
  // with `disable_editing_values: true` renders the value `<input
  // disabled>` and relies on the Stimulus controller's `input`
  // event listener to copy the typed value into a sibling
  // `<textarea>` that IS submitted.
  if (tag === 'input' || tag === 'textarea') {
    if (n._attrs.readonly != null && (tag === 'textarea' || inputHas(n, INPUT_READONLY))) return false;
  }
  // Selenium implicitly focuses the field before typing into it
  // (`feedback_send_keys_focus` memory). Without that, delegated
  // focus handlers — Redmine's inline-autocomplete attachment lives
  // on `$(document).on('focus', '[data-auto-complete=true]', ...)`,
  // Trix's editor focus path, Stimulus actionable-on-focus
  // controllers — never wire up, and the `input` event we're about
  // to dispatch has no observer. Skip for elements that don't accept
  // focus (option/optgroup/select-with-no-focus); checkboxes /
  // radios get focused for parity with selenium's `.click()` path.
  if (tag === 'input' || tag === 'textarea' || isContenteditable(n)) {
    try { n._focus(); } catch (_) {}
    // Focus handlers may swap the focused control out from under us:
    //   - `<trix-editor>` focuses its internal `[contenteditable]`
    //     descendant.
    //   - A replaceWith-style swap detaches the original node and
    //     focuses the freshly-inserted replacement.
    // Drain any zero-delay work the focus handler queued, then
    // retarget either when the active element is a descendant of
    // the original *or* the original was detached. Apps that mount
    // a sibling Preact tree alongside the focused textarea (Forem
    // comments) keep the original attached and the new control
    // outside its subtree, so they fall through and we still write
    // into the field the user/test asked for.
    try {
      if (typeof globalThis.__drainTimers === 'function') globalThis.__drainTimers(0, 1000);
    } catch (_) {}
    const active = globalThis.document && globalThis.document._activeElement;
    if (active && active._nodeType === NODE_ELEMENT &&
        active !== n &&
        (n._contains(active) || !n._parent) &&
        (active._tag === 'input' || active._tag === 'textarea' || isContenteditable(active))) {
      n = active;
      tag = n._tag;
    }
  }
  const v = value == null ? '' : String(value);
  if (tag === 'textarea') {
    // (…typed over what it held, CR / CRLF as LF, as the IDL `value` setter normalizes them — the child text, the
    // default `<form>.reset()` restores, left as it is — cut at `maxlength`, and the caret after it, as typing leaves
    // it: Tribute / inline-autocomplete read `selectionStart` to find the trigger character before the cursor)
    typeIntoControl(n, v.replace(/\r\n?/g, '\n'), TYPE_WHOLE);
  } else if (tag === 'input') {
    const type = inputTypeState(n);
    if (type === 'checkbox' || type === 'radio') {
      // Selenium's `set(true)` / `set(false)`: the control clicked — the user's pointer click, the driver's own
      // (`__csimClickResolve`), its activation the dispatch's — where that changes it, and nothing else: not a checked
      // one, nor a radio button, which no click unchecks. A non-boolean `value` sets the `value` content attribute (the
      // value-mode default/on attribute), not a live value: an attribute WRITE, like any — recorded for
      // MutationObserver, and a context change for `[value=…]` rules.
      const want = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
      if (want !== null) {
        if (want !== getCheckedness(n) && (want || type === 'checkbox')) globalThis.__csimClickResolve(handleOf(n), {}, { leavePending: true });
        return true;
      }
      n._setAttribute('value', v);
    } else if (type === 'number') {
      // A number field keeps what the user typed: out of its range or off its step is a constraint it now suffers
      // (`:out-of-range`, stepMismatch), and text that is no number sanitizes to "" with badInput — as a browser's
      // field does. (flatpickr's minute input, `type=number step=5`, must keep a typed 17.)
      setControlLiveValue(n, v);
    } else if (type === 'range') {
      // A range's UI can only land on the range, on its step: the value sanitization algorithm's (input_value.rs).
      setControlLiveValue(n, sanitizedValueOf(n, type, v));
    } else {
      // (…typed over what it held: cut at `maxlength` where that applies, the caret at its end — the engine's)
      typeIntoControl(n, v, TYPE_WHOLE);
    }
  } else if (tag === 'select') {
    // The first <option> whose value equals v that the user can pick, picked — its
    // events fired below. `optionValue` is the spec's "option's value" (the `value`
    // attribute, else the collapsed/trimmed `text` IDL) — matching Chrome, which
    // selects nothing for a raw, uncollapsed `<option>  Foo  Bar  </option>` text.
    if (!n._listOfOptions().some((o) => optionValue(o) === v && pickOption(o, PICK, false))) return false;
  } else if (isContenteditable(n)) {
    // Capybara `.set('text')` on a contenteditable element. Real
    // browsers don't bulk-replace the contenteditable's children;
    // they simulate per-character typing, driving each keystroke
    // through the full UI Events pipeline:
    //
    //   1. Select all current content (Ctrl-A).
    //   2. For each character of `v`:
    //        - keydown (cancellable)
    //        - beforeinput (cancellable; data=char, targetRanges
    //          = the current selection)
    //        - if editor preventDefault'd → it ran its own model
    //          update; otherwise our default action runs:
    //          deleteRangeContents on the selection then insert
    //          the char at the cursor (extending an adjacent text
    //          node, or creating a new one)
    //        - input (non-cancellable, data=char)
    //        - keyup
    //   3. PM/Tiptap's beforeinput reads the selection's static
    //      range to know what to replace; without that drive
    //      `onUpdate` never fires.
    //
    // This matches Cuprite's per-char `set` flow plus the
    // browser-default text-insertion step that Cuprite gets for
    // free from CDP's `Input.dispatchKeyEvent` reaching Chromium's
    // editing pipeline.
    const sel = globalThis.__csimGetSelection();

    // Capybara's `.set` semantics on a contenteditable is "make
    // its value v" — replace, not append. Real user does Ctrl-A +
    // type, which (a) selects all, (b) the first keystroke replaces
    // the selection with the typed character. Mirror that:
    //   1. select all its children — non-collapsed range over the
    //      contenteditable's content
    //   2. deleteRangeContents on it — clears existing text
    //   3. Per-char insertion at the now-empty cursor
    //
    // PM/Tiptap observes the "delete all" mutation and resets the
    // editor to its empty placeholder; the per-char inserts then
    // land in that placeholder. Plain contenteditable just sees
    // the cleared element + per-char text inserts.
    if (sel) {
      globalThis.__csimSelect(n, 0, n, childCountOf(n, false));
      const r0 = globalThis.__csimSelectionRange();
      if (r0 && !rangeCollapsed(r0)) deleteRangeContents(r0);
      // (…the caret at the first caret position of what is left: the emptied host's start — caret.rs `caret_edge`)
      const first = styleEngineCaretEdge(n, false);
      if (first) globalThis.__csimCollapseSelection(first[0], first[1]);
    }

    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      const { code, keyCode } = resolveKey(ch);
      const kd = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ch, code, keyCode });
      dispatchEventForUserAction(n, kd);
      if (eventState(kd).canceled) { continue; }
      // (…its keypress before its input, canceling it canceling the typing: `pressKey` above)
      const kp = new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: ch, keyCode: ch.charCodeAt(0), charCode: ch.charCodeAt(0) });
      dispatchEventForUserAction(n, kp);
      if (eventState(kp).canceled) { continue; }

      // Its target ranges the current Selection's first range, as StaticRanges (a live snapshot per UI Events). PM
      // uses them to map back to model positions.
      const bi = new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, composed: true, data: ch, inputType: 'insertText',
        targetRanges: globalThis.__csimTargetRangesFromSelection()
      });
      dispatchEventForUserAction(n, bi);
      // (…the text inserted, and its `input` fired, unless beforeinput was canceled)
      if (!eventState(bi).canceled) {
        insertInEditingHost(EDIT_TEXT, ch);
        try {
          dispatchEventForUserAction(n, new InputEvent('input', {
            bubbles: true, cancelable: false, composed: true, data: ch, inputType: 'insertText'
          }));
        } catch (_) {}
      }
      try {
        dispatchEventForUserAction(n, new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ch, code, keyCode }));
      } catch (_) {}
    }
    dispatchEventForUserAction(n, new InputEvent('input', {
      bubbles: true, cancelable: false, composed: true, data: v, inputType: 'insertText'
    }));
    return true;
  } else {
    setControlLiveValue(n, v);   // input/textarea live value (dirty value flag)
  }
  // Selenium's `.send_keys(text)` fires keydown + (beforeinput) +
  // input + keyup per character; libraries like Tribute initialise
  // their per-keystroke state (`commandEvent = false`) inside the
  // keydown handler, so without keydown firing first the keyup
  // check `false === commandEvent` reads `false === undefined`
  // and the show-menu branch never enters. Fire one keydown / keyup
  // pair around the value-change for the whole `set('text')` (we
  // don't have a per-character chain to lean on); the keyCode is 0
  // because we don't simulate a specific character.
  if (tag === 'input' || tag === 'textarea' || isContenteditable(n)) {
    try { dispatchEventForUserAction(n, new KeyboardEvent('keydown', { bubbles: true, cancelable: true })); } catch (_) {}
  }
  // Fire `input` (cancellable, bubbles) then `change` (bubbles only).
  // For checkbox / radio real browsers fire `change` only on a real
  // user interaction, but Capybara's `set` mirrors what `selenium`
  // does — both events, so listeners see the update either way.
  dispatchEventForUserAction(n, new InputEvent('input', { bubbles: true, cancelable: false, composed: true }));
  markUserValidity(n);
  dispatchEventForUserAction(n, new Event('change', { bubbles: true, cancelable: false }));
  // `.set` fired `change` eagerly (Capybara's high-level fill commits in one step);
  // clear the user-edit flag so a subsequent blur's change-on-blur doesn't re-fire.
  globalThis.__dom.changeEdited(n._nid, false);
  if (tag === 'input' || tag === 'textarea' || isContenteditable(n)) {
    try { dispatchEventForUserAction(n, new KeyboardEvent('keyup', { bubbles: true, cancelable: true })); } catch (_) {}
  }
  // Capybara's `set("value\n")` on a text input means "type the
  // value, then press Enter". HTML's implicit form submission says:
  // when Enter is pressed in a form's sole text-like control, the
  // form submits. Detect the trailing newline, strip it from the
  // stored value, and queue a form-submit intent for Ruby to drain
  // (same channel as Rails-UJS data-method chains).
  if (tag === 'input' && typeof value === 'string' && value.endsWith('\n')) {
    setControlLiveValue(n, String(controlLiveValue(n)).replace(/\n$/, ''));
    const form = implicitSubmitFormFor(n);
    if (form) {
      const submitter = defaultButtonOf(form);
      if (!(submitter && isActuallyDisabled(submitter))) submitImplicitly(form, submitter);
    }
  }
  return true;
};
// maxlength / minlength apply only to these input types (+ <textarea>) — NOT to
// number/date/etc., whose value isn't a free-form string. (HTML "the maxlength and
// minlength attributes".)
const CLIPBOARD_GESTURES = { x: 'cut', c: 'copy', v: 'paste' };
// HTML "implicit submission": a click at the form's default button — its activation submits, interactively, and a
// click listener that cancels it stops it — or, with none, an interactive submission from the form itself.
function submitImplicitly(form, defaultButton) {
  if (defaultButton) defaultButton._click({});
  else form._submitForm(null, true);
}
// HTML implicit submission — an Enter keypress in `control`, or a `.set("…\n")` trailing newline (Capybara's `should
// not submit single text input forms if ended with \n and has multiple values` pins the several-fields branch): the
// form it submits so, the engine's (element_state.rs `implicit_submission_form`) — its form owner, where it is a field
// that blocks implicit submission (a text-entry input) and the form has a default button, or it is the only such field
// the form owns.
function implicitSubmitFormFor(control) {
  if (!control || control._tag !== 'input') return null;
  return globalThis.__dom.implicitSubmissionForm(control._nid)[0] ?? null;
}
// Real browsers (and selenium's `.select_by(...)`) fire `input`
// and `change` on the parent `<select>` when the user picks a
// different option. Redmine's `<select onchange=
// "updateIssueFrom(...)">` relies on `change` to refire the form
// AJAX; a redundant `select_option` against the already-selected
// option changes nothing and fires neither.
function __fireSelectChange (sel) {
  try { dispatchEventForUserAction(sel, new InputEvent('input', { bubbles: true, cancelable: false, composed: true })); } catch (_) {}
  try { dispatchEventForUserAction(sel, new Event('change', { bubbles: true, cancelable: false })); } catch (_) {}
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
  const picked = globalThis.__dom.optionPick(option, how);
  if (picked === undefined) return false;
  userPicked(picked[0], picked[1], events);
  return true;
}
globalThis.__csimSelectOption = (h) => pickOption(lookup(h), PICK);
globalThis.__csimUnselectOption = (h) => pickOption(lookup(h), UNPICK);
// (…a TRUSTED click on an `<option>`: the customizable select popup's / a listbox's — dispatch.js)
globalThis.__csimToggleOptionByClick = (option) => pickOption(option, CLICK);

// UA arrow-key default action for a focused form control — identical whether the
// keydown came from Capybara send_keys, testdriver Actions, or a page-dispatched
// trusted key (the testdriver shim's keyDefaultAction routes here, so the behavior
// isn't a test-only shim hack). The engine names the radio button the group moves to,
// or moves the single select's pick (validity.rs `arrowDefault`): the radio button
// takes focus and is clicked — a trusted click, whose activation checks it and fires
// its input + change (Chrome) — and the select fires its own.
globalThis.__csimArrowKeyDefault = function (node, key) {
  if (!node || node._nodeType !== NODE_ELEMENT) return;
  // ArrowUp/Down on a customizable `<input list>` opens its `<datalist>` popover (the
  // same show as focus) when it isn't already open — open-ui combobox key behavior.
  // Gated on a list-applicable input type so `<input type=radio list=…>` still falls
  // through to the radio-group arrow navigation below.
  if ((key === 'ArrowDown' || key === 'ArrowUp') && inputSupportsList(node)) {
    showComboboxDatalist(node);
    return;
  }
  const moved = globalThis.__dom.arrowDefault(node, key);
  if (moved === undefined) return;
  const [target, changed] = moved;
  if (target._tag === 'select') {
    userPicked(target, changed);
    return;
  }
  target._focus();
  target._click({});
};

// An entry list flattened to a plain JSON list the Ruby submission encoder consumes:
// each entry is a string `{name, value}` or a file `{name, file, filename, type,
// handle, index}`. The handle/index point into Ruby's `@file_picks` slot (see
// `attach_file`), so a host-backed File's bytes resolve even when JS moved it onto
// another input. An in-memory `new File([…])` has no slot — its bytes live in the VM,
// so we carry them for the classic submit to encode.
export function serializeEntryList(entryList) {
  if (!entryList) return null;
  const out = [];
  for (const [name, value] of entryList) {
    if (isFile(value)) {
      const host = blobHost(value);
      out.push({
        name:     String(name),
        file:     true,
        filename: fileName(value),
        type:     blobType(value),
        handle:   host ? host.handle : null,
        index:    host ? host.index : null,
        bytes:    host ? null : latin1ToBytes(blobBytes(value))
      });
    } else {
      out.push({ name: String(name), value: String(value) });
    }
  }
  return out;
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
// so it consumes the pairs as-is; `__csimFormSerialize` flattens them for the Ruby boundary, which can't hold a File.
const ENTRY_TEXT = 0, ENTRY_FILES = 1;
function constructEntryList(form, submitter, encoding) {
  const [x, y] = submitter ? selectedCoordinateOf(submitter) : [0, 0];
  const [flat, nodes] = globalThis.__dom.formEntries(form._nid, submitter ? submitter._nid : -1, encoding, x, y);
  const fields = [];
  for (let i = 0; i < flat.length; i += 3) {
    const kind = flat[i], name = flat[i + 1], value = flat[i + 2];
    if (kind === ENTRY_TEXT) {
      fields.push([name, value]);
    } else if (kind === ENTRY_FILES) {
      // Each selected File, as the live object: its host-backed source (`_handle`/`_index` → the Ruby `@file_picks`
      // slot) rides along on it, so the multipart serialiser resolves bytes even for a file moved onto a DIFFERENT
      // input via JS (`input.files = dataTransfer.files`). An input with no selection still contributes one empty
      // entry, per HTML's form-data construction.
      const files = nodes[value].files;
      if (files && files.length) {
        for (const file of files) fields.push([name, file]);
      } else if (globalThis.File) {
        fields.push([name, new globalThis.File([], '', { type: 'application/octet-stream' })]);
      }
    } else {
      const el = nodes[value];
      appendCustomElementEntries(fields, el, el._attrs.name);
    }
  }
  return fields;
}

// HTML's "entry construction algorithm" for a form-associated custom element: its
// submission value — whatever `internals.setFormValue()` last stored — is either a
// list of entries (a FormData, whose own names REPLACE the element's `name`), a
// single File / string submitted under `name`, or null (nothing).
function appendCustomElementEntries(fields, el, name) {
  const value = rareDataOf(el)?.submissionValue;
  if (Array.isArray(value)) {
    for (const pair of value) fields.push([pair[0], pair[1]]);
    return;
  }
  if (!name || value == null) return;
  fields.push([name, value]);
}

// Cross-realm entry point for `new FormData(form, submitter)` — see resolveFormArg.
globalThis.__csimConstructEntryList = function (formHandle, submitterHandle, encoding) {
  const form = resolveFormArg(formHandle);
  if (!form || form._tag !== 'form') return null;
  return constructEntryList(form, resolveFormArg(submitterHandle), encoding);
};

// Where and how the form submits — everything about the submission EXCEPT its entry list, so a caller that only needs to
// route the navigation doesn't pay for the walk: the engine's (form_entries.rs `formSubmission`) — a submitter's
// `formaction` / `formmethod` / `formenctype` / `formtarget` over the form's own, the method and enctype their states, a
// `<base target>` the default target, the submission character encoding — the action URL resolved HERE, in the form's
// own realm, against its document's base URL (a form submitted inside an iframe resolves against the IFRAME's document
// and honours its `<base>`).
function formSubmissionSpec(form, submitter) {
  const doc = form._ownerDocument || globalThis.document;
  const [action, method, enctype, target, rel, encoding] =
    globalThis.__dom.formSubmission(form._nid, submitter ? submitter._nid : -1, doc ? doc.characterSet : 'UTF-8');
  return { action: submissionURL(form, action), method, enctype, target, rel, encoding };
}

// Route-only entry point: the submission spec with no entry list. The named-frame
// submit path encodes its own list (it holds the post-`formdata` one), so building
// and flattening a second one here would be pure waste (rule 3).
globalThis.__csimFormSubmissionSpec = function (formHandle, submitterHandle) {
  const form = resolveFormArg(formHandle);
  if (!form || form._tag !== 'form') return null;
  return formSubmissionSpec(form, resolveFormArg(submitterHandle));
};

// Ruby's submission entry point: the spec plus the entry list flattened for the host
// boundary — a File can't cross it, so it becomes a byte reference (a `@file_picks`
// slot, or its bytes inline).
globalThis.__csimFormSerialize = function (formHandle, submitterHandle) {
  const form = resolveFormArg(formHandle);
  if (!form || form._tag !== 'form') return null;
  const submitter = resolveFormArg(submitterHandle);
  const spec = formSubmissionSpec(form, submitter);
  spec.entries = serializeEntryList(constructEntryList(form, submitter, spec.encoding));
  return spec;
};
