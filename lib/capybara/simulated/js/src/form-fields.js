// Form-field mutations — the Ruby-side Capybara DSL (`fill_in 'X',
// with: 'Y'`, `choose`, `select`, `send_keys`) ends up routed
// through these host fns. Each is one `Context#call` from Ruby; the
// JS-side reaction (keydown / input / change event sequence, value
// write, file attachment) happens entirely inside this module.

import { hrefAttr } from './link-href.js';
import { NODE_CDATA, NODE_ELEMENT, NODE_TEXT } from './constants.js';
import { lookup }                     from './handles.js';
import { dispatchEventForUserAction, fireCheckableActivation } from './dispatch.js';
import { bumpSettleGen } from './mutation-observer.js';
import { queueTask }                  from './timers.js';
import { blobBytes, blobHost, blobType, fileName, hostBackedFile, isFile } from './blob.js';
import { formSubmissionEncoding }       from './encodings.js';
import { latin1ToBytes }                from './bytes.js';
import { updateSelectedContent, optionSelectednessDisabled } from './custom-elements.js';
import {
  ancestorForm,
  contenteditableHost,
  formForControl,
  isContenteditable,
  isActuallyDisabled,
  setRadio,
  radioGroupMembers,
  getCheckedness,
  setCheckedness,
  setSelectedness,
  controlLiveValue,
  setControlLiveValue,
  defaultButtonOf,
  moveTextEntryCursor,
  textSelectionOf,
  markUserValidity,
  selectedCoordinateOf
} from './form-helpers.js';
import {
  nodesAtPaths, setStateBit, STATE_DIRTY_BY_USER, STATE_SELECTED_DIRTY, STATE_USER_INTERACTED
} from './native-query-shadow.js';
import { Event, InputEvent, KeyboardEvent, PointerEvent, pointerEventInit, eventState } from './events.js';
import {
  asciiLower, commitChangeKeepingFocus, deleteRangeContents, inputSupportsList, isFocusable, performClipboardGesture, setRangePoint,
  showComboboxDatalist, submissionURL
} from './dom-nodes.js';
import { bodyOf, documentElementOf } from './document-tree.js';
import { selectAll } from './selectors.js';
import { closeRequest } from './dialog.js';
import { isConnected } from './walk.js';
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
const __KEY_NAME_MAP = {
  enter:      { key: 'Enter',     code: 'Enter',     keyCode: 13, char: '\n', inputType: 'insertLineBreak' },
  return:     { key: 'Enter',     code: 'Enter',     keyCode: 13, char: '\n', inputType: 'insertLineBreak' },
  tab:        { key: 'Tab',       code: 'Tab',       keyCode:  9, char: null, inputType: null },   // moves focus, types nothing
  space:      { key: ' ',         code: 'Space',     keyCode: 32, char: ' ',  inputType: 'insertText'      },
  backspace:  { key: 'Backspace', code: 'Backspace', keyCode:  8, char: null, inputType: 'deleteContentBackward' },
  delete:     { key: 'Delete',    code: 'Delete',    keyCode: 46, char: null, inputType: 'deleteContentForward'  },
  escape:     { key: 'Escape',    code: 'Escape',    keyCode: 27, char: null, inputType: null },
  up:         { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38, char: null, inputType: null },
  down:       { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40, char: null, inputType: null },
  left:       { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37, char: null, inputType: null },
  right:      { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, char: null, inputType: null },
  home:       { key: 'Home',       code: 'Home',       keyCode: 36, char: null, inputType: null },
  end:        { key: 'End',        code: 'End',        keyCode: 35, char: null, inputType: null },
  page_up:    { key: 'PageUp',     code: 'PageUp',     keyCode: 33, char: null, inputType: null },
  page_down:  { key: 'PageDown',   code: 'PageDown',   keyCode: 34, char: null, inputType: null },
  pageup:     { key: 'PageUp',     code: 'PageUp',     keyCode: 33, char: null, inputType: null },
  pagedown:   { key: 'PageDown',   code: 'PageDown',   keyCode: 34, char: null, inputType: null }
};
const __MODIFIER_NAMES = new Set([
  'control', 'ctrl', 'command', 'cmd', 'meta', 'shift', 'alt', 'option'
]);
// Input types whose value is a step grid — Arrow Up/Down on a focused one steps it.
const STEPPED_INPUT_TYPES = new Set(['number', 'range', 'date', 'month', 'week', 'time', 'datetime-local']);
const __MODIFIER_KEY_INFO = {
  shift:   { key: 'Shift',    code: 'ShiftLeft',   keyCode: 16 },
  control: { key: 'Control',  code: 'ControlLeft', keyCode: 17 },
  ctrl:    { key: 'Control',  code: 'ControlLeft', keyCode: 17 },
  alt:     { key: 'Alt',      code: 'AltLeft',     keyCode: 18 },
  option:  { key: 'Alt',      code: 'AltLeft',     keyCode: 18 },
  meta:    { key: 'Meta',     code: 'MetaLeft',    keyCode: 91 },
  command: { key: 'Meta',     code: 'MetaLeft',    keyCode: 91 },
  cmd:     { key: 'Meta',     code: 'MetaLeft',    keyCode: 91 }
};
// Punctuation chars need their KEYBOARD keyCode, not their ASCII
// charCode. ASCII for "." is 46 — which is the Delete key's
// keyCode. ProseMirror sees `keyCode: 46` on keydown and treats
// it as Delete (preventDefault'ing it), and the typed char never
// reaches the editor. Same shadowing exists for "," / "/" / ";"
// etc.
const __PRINTABLE_KEY_INFO = {
  ' ':  { code: 'Space',         keyCode: 32  },
  '!':  { code: 'Digit1',        keyCode: 49  },
  '"':  { code: 'Quote',         keyCode: 222 },
  '#':  { code: 'Digit3',        keyCode: 51  },
  '$':  { code: 'Digit4',        keyCode: 52  },
  '%':  { code: 'Digit5',        keyCode: 53  },
  '&':  { code: 'Digit7',        keyCode: 55  },
  "'":  { code: 'Quote',         keyCode: 222 },
  '(':  { code: 'Digit9',        keyCode: 57  },
  ')':  { code: 'Digit0',        keyCode: 48  },
  '*':  { code: 'Digit8',        keyCode: 56  },
  '+':  { code: 'Equal',         keyCode: 187 },
  ',':  { code: 'Comma',         keyCode: 188 },
  '-':  { code: 'Minus',         keyCode: 189 },
  '.':  { code: 'Period',        keyCode: 190 },
  '/':  { code: 'Slash',         keyCode: 191 },
  ':':  { code: 'Semicolon',     keyCode: 186 },
  ';':  { code: 'Semicolon',     keyCode: 186 },
  '<':  { code: 'Comma',         keyCode: 188 },
  '=':  { code: 'Equal',         keyCode: 187 },
  '>':  { code: 'Period',        keyCode: 190 },
  '?':  { code: 'Slash',         keyCode: 191 },
  '@':  { code: 'Digit2',        keyCode: 50  },
  '[':  { code: 'BracketLeft',   keyCode: 219 },
  '\\': { code: 'Backslash',     keyCode: 220 },
  ']':  { code: 'BracketRight',  keyCode: 221 },
  '^':  { code: 'Digit6',        keyCode: 54  },
  '_':  { code: 'Minus',         keyCode: 189 },
  '`':  { code: 'Backquote',     keyCode: 192 },
  '{':  { code: 'BracketLeft',   keyCode: 219 },
  '|':  { code: 'Backslash',     keyCode: 220 },
  '}':  { code: 'BracketRight',  keyCode: 221 },
  '~':  { code: 'Backquote',     keyCode: 192 }
};

function __resolveKey(spec) {
  // Try the named-key table first so callers can pass 'enter' /
  // 'tab' / 'escape' interchangeably as strings or symbols — the
  // Ruby side stringifies symbols at the JSON boundary, so an
  // atom for `:enter` arrives here as the string 'enter' and
  // would otherwise fall into the printable-char branch and get
  // typed verbatim.
  const known = __KEY_NAME_MAP[String(spec).toLowerCase()];
  if (known) return Object.assign({}, known);
  // Embedded newlines / tabs inside a text atom map to their
  // keyboard equivalents. Without this, `send_keys("# H\n## H2")`
  // sends a literal "\n" char (keyCode 10) instead of an Enter key
  // press (keyCode 13), which ProseMirror needs to fire its split-
  // block transaction. Same for "\t" → Tab.
  if (spec === '\n') return Object.assign({}, __KEY_NAME_MAP.enter);
  if (spec === '\t') return Object.assign({}, __KEY_NAME_MAP.tab);
  // Printable: typically a single char from a text atom.
  if (typeof spec === 'string' && spec.length >= 1) {
    const len = spec.length;
    const punct = len === 1 ? __PRINTABLE_KEY_INFO[spec] : null;
    let code, keyCode;
    if (punct) {
      code    = punct.code;
      keyCode = punct.keyCode;
    } else if (len === 1) {
      code    = 'Key' + spec.toUpperCase();
      keyCode = spec.toUpperCase().charCodeAt(0);
    } else {
      code    = '';
      keyCode = 0;
    }
    return { key: spec, code, keyCode, char: spec, inputType: 'insertText' };
  }
  return { key: String(spec), code: '', keyCode: 0, char: null, inputType: null };
}
// ArrowLeft / ArrowRight inside a contenteditable: the caret on the global Selection one character on — the engine's
// (caret.rs `caret_step`): across adjacent text leaves where it crosses a node's edge, so it transits link / mark
// boundaries (ProseMirror surfaces its link-toolbar on the resulting `selectionchange`), never out of the editing host
// (ArrowLeft at the very start of an editor stays put, where it once collapsed onto a heading above the composer).
function moveContenteditableCaret(dir) {
  const r = globalThis.__csimSelectionRange();
  if (!r || !r.startContainer) return;
  const to = caretPoint(r.startContainer, globalThis.__dom.caretStep(r.startContainer._nid, r.startOffset, dir > 0));
  if (to) globalThis.__csimGetSelection().collapse(to[0], to[1]);
}
// (…a point the engine answers, [nodes, offsets…], as nodes and offsets: [node, offset, node, offset…])
function caretPoint(near, answer) {
  if (answer === undefined) return null;
  const nodes = nodesAtPaths(near._getRootNode(), answer[0]);
  return nodes.flatMap((node, i) => [node, answer[i + 1]]);
}

// Home / End on a contenteditable: move the caret to the start or
// end of the current block-level container (closest ancestor that
// renders as block-level — we approximate with HTML block tags
// since we don't run a layout engine). Without this, the dispatched
// keydown has no observable effect on the Selection and PM keymaps
// that key off "Backspace at start of block" (Home then Backspace
// resets heading → paragraph) never trigger.
function nearestPreAncestor(node) {
  for (let cur = node; cur; cur = cur._parent) {
    if (cur._nodeType === NODE_ELEMENT && cur._tag === 'pre') return cur;
  }
  return null;
}

// ArrowUp/Down inside a `<pre><code>`: real Chrome moves the caret
// visually within the code block via browser-native nav and PM's
// selectionchange listener picks up the new position. Our gap-cursor
// approximation intercepts the keydown and PM relocates the caret out
// of the block, so the subsequent toolbar `formatCode()` sees the
// wrong parent (case 2 instead of case 1). Walk the multi-line text
// node directly and let `selectionchange` notify PM after the keydown
// transaction has flushed.
function moveCaretInPre(dir, savedSel) {
  const sel = globalThis.__csimGetSelection();
  if (!sel) return;
  const sc = savedSel.node;
  const so = savedSel.offset | 0;
  const data = sc.data || '';
  if (data.indexOf('\n') < 0) return;
  const lineStart = data.lastIndexOf('\n', so - 1) + 1;
  const lineEnd   = (() => { const i = data.indexOf('\n', so); return i < 0 ? data.length : i; })();
  const col = so - lineStart;
  let target;
  if (dir < 0) {
    if (lineStart === 0) return;
    const prevEnd   = lineStart - 1;
    const prevStart = data.lastIndexOf('\n', prevEnd - 1) + 1;
    target = prevStart + Math.min(col, prevEnd - prevStart);
  } else {
    if (lineEnd === data.length) return;
    const nextStart = lineEnd + 1;
    const nextEndAfter = data.indexOf('\n', nextStart);
    const nextEnd   = nextEndAfter < 0 ? data.length : nextEndAfter;
    target = nextStart + Math.min(col, nextEnd - nextStart);
  }
  sel.collapse(sc, target);
}

// …and to the start or end of the block holding it (caret.rs `caret_block_edge`): its first or last caret stop — a text
// leaf, or a void element beside which a browser places the caret — or the block itself where it has none.
function moveContenteditableCaretToBlockEdge(edge) {
  const r = globalThis.__csimSelectionRange();
  if (!r || !r.startContainer) return;
  const to = caretPoint(r.startContainer, globalThis.__dom.caretBlockEdge(r.startContainer._nid, edge === 'end'));
  if (to) globalThis.__csimGetSelection().collapse(to[0], to[1]);
}

function __modifierFlags(names) {
  const out = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  for (const raw of names) {
    const n = String(raw).toLowerCase();
    if (n === 'control' || n === 'ctrl')                out.ctrlKey  = true;
    else if (n === 'command' || n === 'cmd' || n === 'meta') out.metaKey = true;
    else if (n === 'shift')                             out.shiftKey = true;
    else if (n === 'alt' || n === 'option')             out.altKey   = true;
  }
  return out;
}
function __appendValue(n, ch) {
  if (ch == null) return;
  const cur = controlLiveValue(n);
  // Insert at the current selection (which may have been moved by
  // an ArrowLeft / ArrowRight earlier in the same send_keys atom
  // stream). If selection bounds are missing, fall back to "append
  // at end" — i.e. caret-at-end after the last write.
  const sel = textSelectionOf(n);
  const s = sel ? sel.start : cur.length;
  const e = sel ? sel.end : s;
  const composed = cur.slice(0, s) + ch + cur.slice(e);
  // A number field rejects a keystroke that would make its text un-typeable as a
  // floating-point number being entered (e.g. a second sign after 'e' in "1e+1"):
  // the character is simply not inserted. The grammar is a PREFIX of a valid
  // scientific number, so intermediate states ("1.", "1.e", "1e+") are still
  // accepted — whether such text converts to a value is decided when it's read.
  if (n._tag === 'input' && (n._attrs.type || '').toLowerCase() === 'number' &&
      !/^[-+]?\d*\.?\d*(?:[eE][-+]?\d*)?$/.test(composed)) return;
  // maxlength truncates typed input only for the types it applies to (textarea +
  // text-like inputs); it does NOT for number/date/etc.
  const maxlenApplies = n._tag === 'textarea' ||
    (n._tag === 'input' && MAXLENGTH_INPUT_TYPES.has((n._attrs.type || 'text').toLowerCase()));
  const maxlen   = maxlenApplies ? parseInt(n._attrs.maxlength || '', 10) : NaN;
  // Typing sets the dirty value flag → live value in `_value`; a textarea's
  // child text (its default) is NOT rewritten.
  const next = (maxlen > 0 && composed.length > maxlen) ? composed.slice(0, maxlen) : composed;
  setControlLiveValue(n, next);
  moveTextEntryCursor(n, Math.min(next.length, s + ch.length));
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
    const active = globalThis.document.activeElement;
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
  const ceTypeable = isContenteditable(n);
  // Radio / checkbox inputs aren't typeable: HTML §4.10.5.2.16 says
  // space-key fires the activation behavior (synthetic click) instead.
  const inputType = (n._attrs.type || '').toLowerCase();
  const isCheckOrRadio = n._tag === 'input' && (inputType === 'radio' || inputType === 'checkbox');
  const isFormControl  = (n._tag === 'input' || n._tag === 'textarea') &&
                         !(n._attrs.readonly != null || n._attrs.disabled != null);
  const typeable = ceTypeable || (isFormControl && !isCheckOrRadio);
  // Selenium / Playwright `send_keys` focus their target before
  // dispatching keys — even for non-typeable interactives like
  // anchors and buttons. This blurs whatever previously held focus
  // (Discourse `.topic-list-item` removes its `.selected` class on
  // `a.title` blur, which gates the Mousetrap `Enter` binding from
  // intercepting and redirecting to the wrong row).
  const isInteractive = n._tag === 'a' || n._tag === 'button' || n._tag === 'summary' || n._tag === 'select';
  globalThis.__csimFocusModality = 'keyboard';   // send_keys is keyboard-driven → :focus-visible applies
  if (typeable || isCheckOrRadio || isInteractive) { try { n._focus(); } catch (_) {} }
  // …the document element, or a body that can't take focus, focusing the VIEWPORT (HTML "get the focusable area"):
  // whatever held focus loses it, and the keys go to the body (chromedriver, measured 2026-10-10 — a dialog the focus
  // was in no longer holds it, so closing it gives none back).
  else if (n === documentElementOf(n.ownerDocument) || (n === bodyOf(n.ownerDocument) && !isFocusable(n))) {
    const focused = n.ownerDocument._activeElement;
    if (focused) try { focused._blur(); } catch (_) {}
    n = bodyOf(n.ownerDocument) ?? n;
  }
  // A deferred default (Enter's, below) runs before the next key's events at the latest — its listeners' microtasks
  // drained first — so the keys' effects stay in the order they were pressed: `send_keys('a', :enter, [:control, 'a'])`
  // selects the line break too.
  let deferred = null;
  const pressKey = (info, modifiers) => {
    if (deferred) {
      if (globalThis.__csim_yield) globalThis.__csim_yield();
      if (deferred) deferred();
    }
    // Enter's inputType is context-dependent: in a contenteditable it inserts a
    // PARAGRAPH (insertParagraph), Shift+Enter a line break (insertLineBreak); a
    // plain text control always inserts a line break. Its beforeinput/input `data`
    // is null for both — a line-break / paragraph insertion carries no data — even
    // though the default action still inserts a '\n' (KEY_SPECS.enter.char), so
    // pin `data` explicitly rather than deriving it from that char.
    if (info.key === 'Enter') {
      info = Object.assign({}, info, {
        inputType: (ceTypeable && !(modifiers && modifiers.shiftKey)) ? 'insertParagraph' : 'insertLineBreak',
        data: null
      });
    }
    const initBase = Object.assign({ bubbles: true, cancelable: true }, modifiers || {});
    const init = Object.assign({}, initBase, { key: info.key, code: info.code, keyCode: info.keyCode });
    const kd = new KeyboardEvent('keydown', init);
    let preNavSavedSel = null;
    if (ceTypeable && (info.key === 'ArrowUp' || info.key === 'ArrowDown')) {
      const r0 = globalThis.__csimSelectionRange();
      const sc0 = r0 && r0.startContainer;
      if (sc0 && sc0._nodeType === NODE_TEXT && nearestPreAncestor(sc0) && (sc0.data || '').indexOf('\n') >= 0) {
        preNavSavedSel = { node: sc0, offset: r0.startOffset | 0 };
      }
    }
    dispatchEventForUserAction(n, kd);
    let blocked = eventState(kd).canceled;
    // `keypress`, the legacy event of a key that produces a character — a printable key's, Enter's (a carriage
    // return), none with Control / Alt / Meta held — right after its keydown unless that was canceled (UI Events'
    // order): its key code and char code the character's (Chrome's), and canceling it cancels the key's default
    // action as canceling the keydown does. Mousetrap-shape libraries (Discourse's
    // `@discourse/itsatrap` for the `/`-to-open-search shortcut) still listen for it, reading `e.which` +
    // `String.fromCharCode(...)` to look up a binding. It goes to whatever is focused now: a keydown handler may
    // have moved focus.
    const chord = modifiers && (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey);
    if (!blocked && !chord && (info.key === 'Enter' || (info.key && info.key.length === 1 && info.key === info.char))) {
      const charCode = info.key === 'Enter' ? 13 : info.char.charCodeAt(0);
      const kp = new KeyboardEvent('keypress', Object.assign({}, init, { keyCode: charCode, charCode }));
      dispatchEventForUserAction(globalThis.document.activeElement || n, kp);
      if (eventState(kp).canceled) blocked = true;
    }
    // Escape's default action is a close request (HTML §6.4.4): the dialog opened last that takes one closes.
    if (!blocked && info.key === 'Escape') closeRequest(n.ownerDocument);
    // Arrow-key default on a focused single-line <select> (Down/Up → adjacent option)
    // or radio (Down/Right → next, Up/Left → prev in the group) — shared with the
    // testdriver Actions path via __csimArrowKeyDefault.
    if (!blocked && (info.key === 'ArrowDown' || info.key === 'ArrowUp' || info.key === 'ArrowLeft' || info.key === 'ArrowRight') &&
        (n._tag === 'select' || (n._tag === 'input' && inputType === 'radio')) &&
        typeof globalThis.__csimArrowKeyDefault === 'function') {
      globalThis.__csimArrowKeyDefault(n, info.key);
      // keyup retargets to whatever is now focused (radio nav moved focus to the
      // newly-checked radio), matching the normal keyup-retarget convention below.
      dispatchEventForUserAction(globalThis.document.activeElement || n, new KeyboardEvent('keyup', init));
      return false;
    }
    // Arrow Up/Down on a focused stepped input (number / range / date / time / …):
    // the default action steps the value by one step and fires beforeinput → input →
    // change, unless beforeinput is canceled (a spinner press). The IDL stepUp/
    // stepDown methods fire no events; this user-driven path does.
    if (!blocked && (info.key === 'ArrowUp' || info.key === 'ArrowDown') &&
        n._tag === 'input' && n._attrs.readonly == null && n._attrs.disabled == null &&
        STEPPED_INPUT_TYPES.has(inputType)) {
      const bi = new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, data: null, inputType: '' });
      dispatchEventForUserAction(n, bi);
      if (!eventState(bi).canceled) {
        const before = n.value;
        try { stepInput(n, info.key === 'ArrowUp' ? 1 : -1); } catch (_) {}
        if (n.value !== before) {
          dispatchEventForUserAction(n, new InputEvent('input', { bubbles: true, cancelable: false, composed: false, data: null, inputType: '' }));
          markUserValidity(n);
          dispatchEventForUserAction(n, new Event('change', { bubbles: true }));
        }
      }
      dispatchEventForUserAction(n, new KeyboardEvent('keyup', init));
      return false;
    }
    // Enter's default action in a text-like input runs the form's
    // implicit-submit algorithm. If the page handler called
    // preventDefault, skip (Tagify / Tribute do this to chip the
    // current token instead of submitting).
    if (!blocked && info.key === 'Enter' && typeable && (!modifiers || (!modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey))) {
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
    if (info.key === 'Enter' && !blocked && n._attrs.disabled == null &&
        ((n._tag === 'a' && hrefAttr(n) != null) || ((isButtonLike(n) || n._tag === 'summary') && !chord))) {
      n._click(modifiers || {});
    }
    // (…Enter a line break only where there are lines: a single-line input's Enter submits, above, and types nothing)
    const wouldType =
      typeable && !blocked &&
      (info.char != null || info.inputType === 'deleteContentBackward' || info.inputType === 'deleteContentForward') &&
      !(info.key === 'Enter' && n._tag === 'input') &&
      (!modifiers || (!modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey));
    if (wouldType && info.inputType) {
      // `beforeinput` fires before the value mutates, with the
      // semantic `inputType` set ('insertText' / 'insertLineBreak'
      // / 'deleteContentBackward' / etc.). Stimulus actions like
      // `data-action="beforeinput->list-autofill#handleBeforeInput"`
      // gate on `event.inputType` and call preventDefault to take
      // over (e.g. list-autofill replaces the default Enter with
      // a marker-prefixed newline). Honour the cancellation.
      const bi = new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, composed: true,
        data: info.data !== undefined ? info.data : (info.char != null ? info.char : null),
        // getTargetRanges(): an INSERT into a contenteditable targets the current
        // selection (`info.char` is the inserted text — for a caret this is a
        // collapsed range, for a selection the replaced range). Deletion instead
        // targets the range it removes, which this path doesn't compute, so report
        // none rather than a misleading collapsed caret; a plain text control (no
        // DOM ranges) reports none either way.
        targetRanges: (ceTypeable && info.char != null) ? globalThis.__csimTargetRangesFromSelection() : [],
        inputType: info.inputType
      });
      dispatchEventForUserAction(n, bi);
      if (eventState(bi).canceled) blocked = true;
    }
    // Arrow keys: real keyboards move the caret as the default
     // action. We don't fire input/beforeinput for these (caret
     // moves don't dispatch input), but we update the selection
     // so a subsequent character lands at the new position —
     // Capybara's `send_keys('abc', :left, 'x')` expects 'abxc'.
     // For `<input>` / `<textarea>` this is a value-index update;
     // for contenteditable the caret lives on the `Selection`'s
     // Range, and ProseMirror / Tiptap rely on the resulting
     // `selectionchange` event firing to update their floating
     // toolbars.
     if (typeable && !blocked && (info.key === 'Home' || info.key === 'End')) {
       if (ceTypeable) {
         moveContenteditableCaretToBlockEdge(info.key === 'Home' ? 'start' : 'end');
       } else {
         const cur = controlLiveValue(n);
         moveTextEntryCursor(n, info.key === 'Home' ? 0 : cur.length);
       }
     } else if (typeable && !blocked && (info.key === 'ArrowLeft' || info.key === 'ArrowRight')) {
       const dir = info.key === 'ArrowLeft' ? -1 : 1;
       if (ceTypeable) {
         moveContenteditableCaret(dir);
       } else {
         const cur = controlLiveValue(n);
         const sel = textSelectionOf(n);
         const baseAnchor = !sel ? cur.length : dir < 0 ? sel.start : sel.end;
         moveTextEntryCursor(n, dir < 0 ? Math.max(0, baseAnchor - 1) : Math.min(cur.length, baseAnchor + 1));
       }
     } else if (preNavSavedSel) {
       // Defer to let PM's keydown transaction flush before our
       // collapse + selectionchange — otherwise PM's SelectionReader
       // skips the read while `updating` is set, and state.selection
       // stays at wherever its gap-cursor handler put it.
       const dir = info.key === 'ArrowUp' ? -1 : 1;
       globalThis.__csimSetTimeout(() => moveCaretInPre(dir, preNavSavedSel), 0);
     }
    if (!blocked && wouldType) {
      const doDefault = () => {
        if (ceTypeable) {
          if (info.char != null) {
            globalThis.__csimInsertTextAtSelection(info.char);
          } else if (info.inputType === 'deleteContentBackward') {
            const r = globalThis.__csimSelectionRange();
            const sc = r && r.startContainer;
            if (sc && sc._nodeType === NODE_TEXT && r.startOffset > 0) {
              const pos = r.startOffset;
              sc.data = sc._data.slice(0, pos - 1) + sc._data.slice(pos);
              setRangePoint(r, 2, sc, pos - 1);
            }
          }
        } else if (info.char != null) {
          __appendValue(n, info.char);
        } else if (info.inputType === 'deleteContentBackward') {
          const cur   = controlLiveValue(n);
          const sel   = textSelectionOf(n);
          const start = sel ? sel.start : cur.length;
          const end   = sel ? sel.end : start;
          // Live value edit (dirty value flag); a textarea's child-text default is
          // not rewritten. A non-collapsed selection (e.g. after select()) is
          // deleted whole; a collapsed caret removes the one char before it.
          if (end > start) {
            setControlLiveValue(n, cur.slice(0, start) + cur.slice(end));
            moveTextEntryCursor(n, start);
          } else if (start > 0) {
            setControlLiveValue(n, cur.slice(0, start - 1) + cur.slice(start));
            moveTextEntryCursor(n, start - 1);
          }
        }
        // A user edit since focus → the control fires `change` when it later loses
        // focus (commitChangeOnBlur); a programmatic value change never sets this.
        if (n._changeBaseline !== undefined) n._editedSinceFocus = true;
        try {
          dispatchEventForUserAction(n, new InputEvent('input', {
            bubbles: true, cancelable: false, composed: true,
            data: info.data !== undefined ? info.data : (info.char != null ? info.char : null),
            inputType: info.inputType
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
    const kupTarget = globalThis.document.activeElement || n;
    const ku = new KeyboardEvent('keyup', init);
    dispatchEventForUserAction(kupTarget, ku);
    // Space activates a focused button, checkbox or radio on its release (a keyboard's click, as Enter's above) — the
    // keyup's default action, so unless it, its keydown or its keypress was canceled — a click whose listeners
    // (Discourse wizard, Stimulus actions) see the checkbox toggled and its `input` / `change` fire.
    if (!blocked && !eventState(ku).canceled && info.key === ' ' && kupTarget === n && (isCheckOrRadio || isButtonLike(n) || n._tag === 'summary')) {
      n._click(modifiers || {});
    }
    return eventState(kd).canceled;
  };
  const atomList = Array.isArray(atoms) ? atoms : [];
  for (const a of atomList) {
    if (!a || typeof a !== 'object') continue;
    if (a.kind === 'text') {
      const s = String(a.value || '');
      for (const ch of s) pressKey(__resolveKey(ch), null);
    } else if (a.kind === 'key') {
      pressKey(__resolveKey(a.name), null);
    } else if (a.kind === 'combo') {
      const parts = Array.isArray(a.parts) ? a.parts : [];
      // Modifiers are everything but the final atom; the final
      // atom is the key being pressed *while* the modifiers are
      // held. Some callers only pass modifiers (selecting all
      // text via Ctrl+A is the canonical "modifier + letter").
      let lastKeyIdx = -1;
      for (let i = parts.length - 1; i >= 0; i--) {
        if (!__MODIFIER_NAMES.has(String(parts[i]).toLowerCase())) { lastKeyIdx = i; break; }
      }
      const modNames = parts.slice(0, lastKeyIdx >= 0 ? lastKeyIdx : parts.length);
      const mods     = __modifierFlags(modNames);
      const keyName  = lastKeyIdx >= 0 ? parts[lastKeyIdx] : '';
      // Real keyboards send a keydown for each modifier first.
      // Capybara's `should generate key events` checks for the
      // 16/17/18 etc. keyCodes alongside the printable key's.
      const modInfos = modNames.map(m => __MODIFIER_KEY_INFO[String(m).toLowerCase()]).filter(Boolean);
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
      // Probe `__KEY_NAME_MAP` first so named keys take precedence
      // over per-character unfolding.
      const isNamedKey = typeof keyName === 'string' && __KEY_NAME_MAP[keyName.toLowerCase()];
      // (…whether the chord's key had its keydown canceled, which cancels its default below)
      let canceled = false;
      if (typeof keyName === 'string' && keyName.length > 1 && !isNamedKey) {
        for (const ch of keyName) {
          const cooked = mods.shiftKey ? ch.toUpperCase() : ch;
          pressKey(__resolveKey(cooked), mods);
        }
      } else {
        const single = String(keyName);
        const cooked = mods.shiftKey && single.length === 1 ? single.toUpperCase() : single;
        canceled = pressKey(__resolveKey(cooked), mods);
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
            if (host) globalThis.__csimSelect(host, 0, host, host._children.length);
          } else if (typeable) {
            n.select();
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
  const inside = r && r.startContainer && n._contains(r.startContainer) &&
                 (r.startContainer._nodeType === NODE_TEXT || r.startContainer._nodeType === NODE_CDATA);
  const from = inside ? r.startContainer : n;
  const word = caretPoint(from, globalThis.__dom.caretWord(from._nid, inside ? r.startOffset : 0));
  if (word) sel.setBaseAndExtent(word[0], word[1], word[2], word[3]);
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
  return f ? f._id : 0;
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
  const type = asciiLower(n._attrs.type || '');
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
    const active = doc && doc.activeElement;
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
    if (n._attrs.readonly != null) {
      const t = (n._attrs.type || 'text').toLowerCase();
      const READONLY_RESPECTING = new Set(['text', 'email', 'password', 'tel', 'url', 'search', 'number', 'date', 'datetime-local', 'time', 'week', 'month']);
      if (READONLY_RESPECTING.has(t) || tag === 'textarea') return false;
    }
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
    const active = globalThis.document && globalThis.document.activeElement;
    if (active && active._nodeType === NODE_ELEMENT &&
        active !== n &&
        (n._contains(active) || !n._parent) &&
        (active._tag === 'input' || active._tag === 'textarea' || isContenteditable(active))) {
      n = active;
      tag = n._tag;
    }
  }
  const v = value == null ? '' : String(value);
  let kind = 'value';
  if (tag === 'textarea') {
    // Set the dirty value flag → live value in `_value`, with CR / CRLF
    // normalized to LF to match the IDL `value` setter (so a later `.value`
    // read is spec-normalized). The child text (the default that
    // `<form>.reset()` restores) is left untouched.
    const tv = v.replace(/\r\n?/g, '\n');
    setControlLiveValue(n, tv);
    // Mirror real browsers: typing-style value updates leave the
    // caret at the end of the new content. Tribute / inline-
    // autocomplete read `selectionStart` to find the trigger
    // character before the cursor; without advancing the caret,
    // selectionStart stays at 0 and the trigger detection sees
    // an empty "text before cursor" slice.
    moveTextEntryCursor(n, tv.length);
  } else if (tag === 'input') {
    const type = (n._attrs.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      // Checkedness goes through setCheckedness, which sets the dirty checkedness
      // flag itself. A non-boolean `value` sets the `value` content attribute
      // (the value-mode default/on attribute), not a live value.
      const wasChecked = getCheckedness(n);
      if (value === true || value === 'true') {
        // Radio: setting one in a group clears the others on the
        // same `name`.
        if (type === 'radio') setRadio(n);
        else                  setCheckedness(n, true);
      } else if (value === false || value === 'false') setCheckedness(n, false);
      // …an attribute WRITE, like any: recorded for MutationObserver, and a context change for `[value=…]` rules.
      else n._setAttribute('value', v);
      // Selenium parity: `set(true)` on a checkbox / radio fires the
      // same `click` event a real user click does. The `input` +
      // `change` part of HTML activation is dispatched by the end of
      // this function (shared with text inputs); only `click` is
      // checkbox-specific here.
      if (getCheckedness(n) !== wasChecked) {
        // The desired checked state is already set above, so the click must
        // NOT re-toggle in the dispatch algorithm's activation step.
        const clickEv = new PointerEvent('click', pointerEventInit({ bubbles: true, cancelable: true, button: 0, detail: 1 }, 0));
        eventState(clickEv).csimActivationHandled = true;
        try { dispatchEventForUserAction(n, clickEv); } catch (_) {}
      }
      kind = 'checked';
    } else if (type === 'number') {
      // A number field keeps what the user typed: out of its range or off its step is a constraint it now suffers
      // (`:out-of-range`, stepMismatch), and text that is no number sanitizes to "" with badInput — as a browser's
      // field does. (flatpickr's minute input, `type=number step=5`, must keep a typed 17.)
      setControlLiveValue(n, v);
    } else if (type === 'range') {
      // A range's UI can only land on the range, on its step.
      const num    = parseFloat(v);
      const min    = parseFloat(n._attrs.min);
      const max    = parseFloat(n._attrs.max);
      let clamped  = isNaN(num) ? (isNaN(min) ? 0 : min) : num;
      if (!isNaN(min) && clamped < min) clamped = min;
      if (!isNaN(max) && clamped > max) clamped = max;
      const step = parseFloat(n._attrs.step) || 1;
      if (!isNaN(min) && step > 0) {
        const k = Math.round((clamped - min) / step);
        clamped = min + k * step;
        clamped = parseFloat(clamped.toFixed(10));
      }
      setControlLiveValue(n, String(clamped));
    } else {
      // Browsers truncate at maxlength when the user types; programmatic
      // assignment via the IDL setter does the same when the input is
      // a text-like control (not number/date/etc.). Sets the dirty value flag.
      const maxlen = MAXLENGTH_INPUT_TYPES.has(type) ? parseInt(n._attrs.maxlength || '', 10) : NaN;
      setControlLiveValue(n, (maxlen > 0 && v.length > maxlen) ? v.slice(0, maxlen) : v);
      // Caret-at-end, same rationale as textarea above.
      moveTextEntryCursor(n, n._value.length);
    }
  } else if (tag === 'select') {
    // Match the first <option> whose value equals v; mark it selected, clear
    // siblings. `o.value` is the spec's "option's value" (the `value` attribute,
    // else the collapsed/trimmed `text` IDL) — matching Chrome, which selects
    // nothing for a raw, uncollapsed `<option>  Foo  Bar  </option>` text.
    const opts = n._listOfOptions();
    let hit = false;
    for (const o of opts) {
      if (o.value === v) { selectOptionExclusive(n, o); hit = true; break; }
    }
    if (!hit) return false;
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
      globalThis.__csimSelect(n, 0, n, n._children.length);
      const r0 = globalThis.__csimSelectionRange();
      if (r0 && !r0.collapsed) deleteRangeContents(r0);
      // After delete the range collapses to the empty container;
      // re-position cursor inside the deepest leaf if one exists.
      const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'wbr', 'meta', 'link']);
      let leaf = n;
      while (leaf._children && leaf._children.length > 0) {
        const next = leaf._children.find(c =>
          c._nodeType === NODE_ELEMENT && !VOID_TAGS.has(c._tag)
        );
        if (!next) break;
        leaf = next;
      }
      sel.collapse(leaf, leaf._children ? leaf._children.length : 0);
    }

    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      const { code, keyCode } = __resolveKey(ch);
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
        globalThis.__csimInsertTextAtSelection(ch);
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
  n._editedSinceFocus = false;
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
const MAXLENGTH_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);
const CLIPBOARD_GESTURES = { x: 'cut', c: 'copy', v: 'paste' };
// A button: a `<button>`, or an input in one of the button states (HTML).
const BUTTON_INPUT_TYPES = new Set(['submit', 'reset', 'button', 'image']);
function isButtonLike(n) {
  return n._tag === 'button' || (n._tag === 'input' && BUTTON_INPUT_TYPES.has(asciiLower(n._attrs.type || '')));
}
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
  return nodesAtPaths(control._getRootNode(), globalThis.__dom.implicitSubmissionForm(control._nid))[0] ?? null;
}
function selectOptionExclusive(select, opt) {
  const multi = select._attrs.multiple != null;
  const opts = select._listOfOptions();
  // A user pick sets selectedness (and the dirtiness flag), not the
  // `selected` content attribute; single-select clears every sibling.
  if (!multi) for (const o of opts) setSelectedness(o, false);
  setSelectedness(opt, true);
  setStateBit(opt, STATE_SELECTED_DIRTY, true);
  if (select._hasSelectedContent) updateSelectedContent(select);
}
// Real browsers (and selenium's `.select_by(...)`) fire `input`
// and `change` on the parent `<select>` when the user picks a
// different option. Redmine's `<select onchange=
// "updateIssueFrom(...)">` relies on `change` to refire the form
// AJAX; without these dispatches the form stays stale. We gate on
// a "did the selected state change" check so a redundant
// `select_option` against the already-selected option doesn't
// re-fire AJAX on every Capybara call.
function __fireSelectChange (sel) {
  try { dispatchEventForUserAction(sel, new InputEvent('input', { bubbles: true, cancelable: false, composed: true })); } catch (_) {}
  try { dispatchEventForUserAction(sel, new Event('change', { bubbles: true, cancelable: false })); } catch (_) {}
}
function __ancestorSelect (option) {
  let cur = option._parent;
  while (cur && cur._tag !== 'select') cur = cur._parent;
  return cur && cur._tag === 'select' ? cur : null;
}
// Can a user pick this option at all? A disabled option (its own `disabled`, or a
// disabled `<optgroup>` — `optionSelectednessDisabled` is HTML's single "option is
// disabled" notion, shared with the entry list and "ask for a reset" so the three
// can't drift) inside a disabled select is inert: real browsers ignore the pick
// entirely rather than selecting it.
function __optionPickable (option, sel) {
  return !optionSelectednessDisabled(option) && !isActuallyDisabled(sel);
}
globalThis.__csimSelectOption = function (h) {
  const n = lookup(h);
  if (!n || n._tag !== 'option') return false;
  const sel = __ancestorSelect(n);
  if (!sel) { setSelectedness(n, true); setStateBit(n, STATE_SELECTED_DIRTY, true); bumpSettleGen(); return true; }
  if (!__optionPickable(n, sel)) return false;
  const wasSelected = n._selectedness === true;
  selectOptionExclusive(sel, n);
  setStateBit(sel, STATE_USER_INTERACTED, true);            // a user pick → :user-valid / :user-invalid
  // Selectedness is observable (`:selected` / option `:checked` cascade memos,
  // the live `select.selectedOptions` collection, settle key) — bump the gen.
  bumpSettleGen();
  if (!wasSelected) __fireSelectChange(sel);
  return true;
};
globalThis.__csimUnselectOption = function (h) {
  const n = lookup(h);
  if (!n || n._tag !== 'option') return false;
  const sel = __ancestorSelect(n);
  // Same inertness rule as picking: a user can't clear a disabled option either.
  if (sel && !__optionPickable(n, sel)) return false;
  const wasSelected = n._selectedness === true;
  setSelectedness(n, false);
  setStateBit(n, STATE_SELECTED_DIRTY, true);
  bumpSettleGen();   // observable selectedness change (see __csimSelectOption)
  if (wasSelected && sel) {
    setStateBit(sel, STATE_USER_INTERACTED, true);
    if (sel._hasSelectedContent) updateSelectedContent(sel);
    __fireSelectChange(sel);
  }
  return true;
};
// A user CLICK on an `<option>` (the customizable select popup / a listbox) toggles
// its selection: a multiple-select flips just that option, a single-select picks it
// exclusively. Fires input/change on the select and records the user interaction
// (:user-valid / :user-invalid). Returns true if the selection changed.
globalThis.__csimToggleOptionByClick = function (option) {
  if (!option || option._tag !== 'option') return false;
  const sel = __ancestorSelect(option);
  if (!sel) return false;
  if (!__optionPickable(option, sel)) return false;
  const multi = sel._attrs.multiple != null;
  const was = option._selectedness === true;
  if (multi) {
    setSelectedness(option, !was);
    setStateBit(option, STATE_SELECTED_DIRTY, true);
    if (sel._hasSelectedContent) updateSelectedContent(sel);
  } else {
    if (was) { setStateBit(sel, STATE_USER_INTERACTED, true); return false; }   // re-picking the current option: no change
    selectOptionExclusive(sel, option);
  }
  setStateBit(sel, STATE_USER_INTERACTED, true);
  bumpSettleGen();
  __fireSelectChange(sel);
  return true;
};

// UA arrow-key default action for a focused form control — identical whether the
// keydown came from Capybara send_keys, testdriver Actions, or a page-dispatched
// trusted key (the testdriver shim's keyDefaultAction routes here, so the behavior
// isn't a test-only shim hack). Radio: Down/Right → next, Up/Left → prev radio in the
// group (tree order, wrapping), moving focus + checkedness and firing input + change.
// Single-line <select>: Down → next option, Up → prev (no wrap), firing input + change.
globalThis.__csimArrowKeyDefault = function (node, key) {
  if (!node || node._nodeType !== NODE_ELEMENT) return;
  const forward = key === 'ArrowDown' || key === 'ArrowRight';
  const tag = node._tag;
  // ArrowUp/Down on a customizable `<input list>` opens its `<datalist>` popover (the
  // same show as focus) when it isn't already open — open-ui combobox key behavior.
  // Gated on a list-applicable input type so `<input type=radio list=…>` still falls
  // through to the radio-group arrow navigation below.
  if ((key === 'ArrowDown' || key === 'ArrowUp') && inputSupportsList(node)) {
    showComboboxDatalist(node);
    return;
  }
  if (tag === 'input' && (node._attrs.type || '').toLowerCase() === 'radio') {
    const group = radioGroupMembers(node).filter((r) => !isActuallyDisabled(r));
    const len = group.length;
    const i = group.indexOf(node);
    if (len < 2 || i < 0) return;
    const target = group[forward ? (i + 1) % len : (i - 1 + len) % len];
    if (target === node) return;
    setRadio(target);                               // check target + uncheck the group
    target._focus();
    bumpSettleGen();
    if (target.isConnected) fireCheckableActivation(target);
    return;
  }
  if (tag === 'select' && node._attrs.multiple == null && (key === 'ArrowDown' || key === 'ArrowUp')) {
    const opts = node._listOfOptions().filter((o) => !isActuallyDisabled(o));
    const len = opts.length;
    if (!len) return;
    let cur = -1;
    for (let k = 0; k < len; k++) if (opts[k]._selectedness) { cur = k; break; }
    const next = cur < 0 ? (forward ? 0 : len - 1)
                         : (forward ? Math.min(cur + 1, len - 1) : Math.max(cur - 1, 0));
    if (next === cur) return;                        // already at an end — no change, no event
    selectOptionExclusive(node, opts[next]);
    bumpSettleGen();
    __fireSelectChange(node);
  }
};

// ── History form-state restoration (bfcache "persisted user state") ──────────
//
// On a history traversal that crosses a document boundary, a browser restores
// each form control to the value it held when the document was navigated AWAY
// from — NOT its default and WITHOUT firing input/change (it's a restore, not a
// user edit). The Ruby history machinery captures this snapshot into the history
// entry before tearing down the outgoing VM (`__csimCaptureFormState`) and
// re-applies it after the entry's document is rebuilt (`__csimRestoreFormState`).
// Controls are matched by tree order: the re-fetched document is identical, so
// the `input, textarea, select` list lines up one-to-one with the captured one.
function __csimControlState(c) {
  const tag = (c.tagName || '').toLowerCase();
  if (tag === 'select') {
    // Capture by VALUE (not index): on restore, an option with the captured value
    // is reselected; if none matches (a "mismatched" restore), the freshly-parsed
    // default selection is left in place — what browsers do (reset to initial).
    if (c.multiple) return { k: 'selm', vals: c._listOfOptions().filter((o) => o.selected).map((o) => o.value) };
    return { k: 'sel', v: c.value };
  }
  if (tag === 'textarea') return { k: 'val', v: c.value };
  const t = (c.type || 'text').toLowerCase();
  if (t === 'checkbox' || t === 'radio') return { k: 'chk', c: c.checked };
  if (t === 'file') return { k: 'skip' };   // file controls aren't restorable (no programmatic value)
  return { k: 'val', v: c.value };
}

globalThis.__csimCaptureFormState = function () {
  const out = [];
  const doc = globalThis.document;
  if (!doc) return out;
  for (const c of selectAll(doc, 'input, textarea, select')) out.push(__csimControlState(c));
  return out;
};

globalThis.__csimRestoreFormState = function (state) {
  if (!Array.isArray(state) || state.length === 0) return;
  const doc = globalThis.document;
  if (!doc) return;
  const controls = selectAll(doc, 'input, textarea, select');
  const n = Math.min(controls.length, state.length);
  for (let i = 0; i < n; i++) {
    const c = controls[i], s = state[i];
    if (!s || s.k === 'skip') continue;
    // A control removed from the tree by an EARLIER restore in this pass is not
    // restored — e.g. restoring a <select> rebuilds its <selectedcontent>, which
    // disconnects an <input> that lived inside it. Matches browsers (the dropped
    // input keeps its fresh value, not the captured one).
    if (c.isConnected === false) continue;
    // Property setters set the dirty flag but do NOT dispatch input/change.
    if (s.k === 'val') c.value = s.v;
    else if (s.k === 'chk') c.checked = s.c;
    else if (s.k === 'sel') {
      // Reselect by value; leave the default if no option matches (mismatched restore).
      if (c._listOfOptions().some((o) => o.value === s.v)) c.value = s.v;
    }
    else if (s.k === 'selm') {
      const want = new Set(s.vals);
      for (const o of c._listOfOptions()) o.selected = want.has(o.value);
    }
  }
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
  const tree = isConnected(form) ? form._getRootNode() : form;
  const [x, y] = submitter ? selectedCoordinateOf(submitter) : [0, 0];
  const [flat, held] = globalThis.__dom.formEntries(form._nid, submitter ? submitter._nid : -1, encoding, x, y);
  const nodes = nodesAtPaths(tree, held);
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
  const value = el._ceSubmissionValue;
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

// Where and how the form submits — everything about the submission EXCEPT its entry
// list, so a caller that only needs to route the navigation doesn't pay for the walk.
function formSubmissionSpec(form, submitter) {
  // HTML 5: a `<button formaction="...">` / `<button formmethod>` /
  // `<button formenctype>` on the submitter overrides the form's
  // attributes for that one submission.
  const subAction  = submitter && submitter._attrs && submitter._attrs.formaction;
  const subMethod  = submitter && submitter._attrs && submitter._attrs.formmethod;
  const subEnctype = submitter && submitter._attrs && submitter._attrs.formenctype;
  // `<button formtarget>` overrides `<form target>` (HTML submitter overrides).
  // Drives whether a form submitted inside an iframe navigates the frame
  // (target _self / empty) or the top page (_top).
  const subTarget  = submitter && submitter._attrs && submitter._attrs.formtarget;
  // The submission action URL, ALREADY RESOLVED here in the form's own realm: the
  // submitter's `formaction`, else the form's `action` content attribute (`submissionURL`).
  // Resolving in-realm is what makes a form submitted inside an iframe resolve relative
  // URLs against the IFRAME's document (not the top page) and honour its <base>.
  const resolvedAction = subAction != null ? submissionURL(submitter, subAction) : submissionURL(form, form._attrs.action);
  return {
    action:  resolvedAction,
    method:  (subMethod  || form._attrs.method  || 'get').toLowerCase(),
    enctype: (subEnctype || form._attrs.enctype || 'application/x-www-form-urlencoded').toLowerCase(),
    target:  subTarget != null ? subTarget
             : (form._attrs.target != null ? form._attrs.target : baseTargetFor(form)),
    rel:     form._attrs.rel != null ? form._attrs.rel : '',
    // The form's submission character encoding (the entry list's, and its encoders').
    encoding: formSubmissionEncoding(form)
  };
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

// A form with no `target` (and no submitter `formtarget`) inherits the document's
// `<base target>` as its default browsing-context name (HTML "form submission" →
// the rules for choosing a navigable).
function baseTargetFor(form) {
  const root = form.getRootNode ? form.getRootNode() : null;
  const base = root && root.querySelector ? root.querySelector('base[target]') : null;
  return base && base._attrs.target != null ? base._attrs.target : '';
}
