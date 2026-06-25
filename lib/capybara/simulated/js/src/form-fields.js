// Form-field mutations — the Ruby-side Capybara DSL (`fill_in 'X',
// with: 'Y'`, `choose`, `select`, `send_keys`) ends up routed
// through these host fns. Each is one `Context#call` from Ruby; the
// JS-side reaction (keydown / input / change event sequence, value
// write, file attachment) happens entirely inside this module.

import { NODE_ELEMENT, NODE_TEXT }    from './constants.js';
import { lookup, handles }            from './handles.js';
import { dispatchEvent }              from './dispatch.js';
import { recordCharacterData, recordChildList, bumpSettleGen } from './mutation-observer.js';
import { scheduleTimer }              from './timers.js';
import { walk } from './walk.js';
import { newChildList }                 from './dom-collections.js';
import {
  ancestorForm,
  contenteditableHost,
  formForControl,
  isContenteditable,
  setRadio,
  getCheckedness,
  setCheckedness,
  controlLiveValue
} from './form-helpers.js';
import { Event, InputEvent, MouseEvent, KeyboardEvent, SubmitEvent } from './events.js';
import { Text, deleteRangeContents, recordFormSubmission, commitChangeKeepingFocus, isActuallyDisabled } from './dom-nodes.js';
import { BLOCK_TAGS }                 from './cascade.js';

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
  tab:        { key: 'Tab',       code: 'Tab',       keyCode:  9, char: '\t', inputType: 'insertText'      },
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
// ArrowLeft / ArrowRight inside a contenteditable: move the caret on
// the global Selection by one character. Walks across adjacent text
// nodes when crossing offset 0 / length boundaries so the caret
// transits link / mark boundaries (ProseMirror surfaces its
// link-toolbar on the resulting `selectionchange`).
function moveContenteditableCaret(dir) {
  const sel = globalThis.getSelection && globalThis.getSelection();
  if (!sel) return;
  const r = sel._ranges && sel._ranges[0];
  if (!r) return;
  let node = r.startContainer;
  let off  = r.startOffset;
  if (dir < 0) {
    if (node && node.nodeType === NODE_TEXT && off > 0) {
      off -= 1;
    } else {
      const prev = previousTextLeaf(node);
      if (!prev) return;
      node = prev;
      off  = (prev.data || '').length;
    }
  } else {
    const len = (node && node.nodeType === NODE_TEXT) ? (node.data || '').length : 0;
    if (node && node.nodeType === NODE_TEXT && off < len) {
      off += 1;
    } else {
      const next = nextTextLeaf(node);
      if (!next) return;
      node = next;
      off  = 0;
    }
  }
  if (typeof sel.collapse === 'function') sel.collapse(node, off);
}

function previousTextLeaf(start) {
  let n = start;
  while (n) {
    const prev = n.previousSibling;
    if (prev) {
      const leaf = deepestLastText(prev);
      if (leaf && leaf.nodeType === NODE_TEXT) return leaf;
      n = prev;
    } else {
      n = n._parent;
    }
  }
  return null;
}

function nextTextLeaf(start) {
  let n = start;
  while (n) {
    const next = n.nextSibling;
    if (next) {
      const leaf = deepestFirstText(next);
      if (leaf && leaf.nodeType === NODE_TEXT) return leaf;
      n = next;
    } else {
      n = n._parent;
    }
  }
  return null;
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
    if (cur.nodeType === NODE_ELEMENT && cur._tag === 'pre') return cur;
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
  const sel = globalThis.getSelection && globalThis.getSelection();
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
  if (typeof sel.collapse === 'function') sel.collapse(sc, target);
}

function moveContenteditableCaretToBlockEdge(edge) {
  const sel = globalThis.getSelection && globalThis.getSelection();
  if (!sel) return;
  const r = sel._ranges && sel._ranges[0];
  if (!r) return;
  const start = r.startContainer;
  if (!start) return;
  const block = findBlockAncestor(start);
  if (!block) return;
  const leaf = edge === 'start' ? deepestFirstText(block) : deepestLastText(block);
  if (!leaf) return;
  const off = (edge === 'start')
    ? 0
    : (leaf.nodeType === NODE_TEXT ? (leaf.data || '').length : (leaf._children ? leaf._children.length : 0));
  if (typeof sel.collapse === 'function') sel.collapse(leaf, off);
}

function findBlockAncestor(node) {
  for (let cur = node; cur; cur = cur._parent) {
    if (cur.nodeType !== NODE_ELEMENT) continue;
    if (BLOCK_TAGS.has(cur._tag)) return cur;
  }
  return null;
}

function deepestLastText(root) {
  let n = root;
  while (n && n._children && n._children.length > 0) {
    n = n._children[n._children.length - 1];
  }
  return n;
}

function deepestFirstText(root) {
  let n = root;
  while (n && n._children && n._children.length > 0) {
    n = n._children[0];
  }
  return n;
}

function findFirstNonEmptyText(root) {
  if (!root) return null;
  if (root.nodeType === NODE_TEXT && (root.data || '').length) return root;
  const kids = root._children;
  if (!kids) return null;
  for (let i = 0; i < kids.length; i++) {
    const hit = findFirstNonEmptyText(kids[i]);
    if (hit) return hit;
  }
  return null;
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
  const s = n._selectionStart != null ? n._selectionStart : cur.length;
  const e = n._selectionEnd   != null ? n._selectionEnd   : s;
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
  n._value = next;
  const caret = Math.min(next.length, s + ch.length);
  n._selectionStart = caret;
  n._selectionEnd   = caret;
}
globalThis.__csimSendKeys = function (h, atoms) {
  let n = lookup(h);
  if (!n || n.nodeType !== NODE_ELEMENT) return false;
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
    if (active && active !== n && active !== globalThis.document.body) {
      let cur = active;
      while (cur && cur !== n) cur = cur._parent;
      if (cur === n) n = active;
    }
  }
  // Typed input is a user edit (mark the FINAL target, after any retarget) so
  // minlength/maxlength (tooShort/tooLong) validation can apply — it never does
  // for a programmatic `.value` set.
  if (n._tag === 'input' || n._tag === 'textarea') n._dirtyByUser = true;
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
  if (typeable || isCheckOrRadio || isInteractive) { try { n.focus(); } catch (_) {} }
  const pressKey = (info, modifiers) => {
    const initBase = Object.assign({ bubbles: true, cancelable: true }, modifiers || {});
    const init = Object.assign({}, initBase, { key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode });
    const kd = new KeyboardEvent('keydown', init);
    let preNavSavedSel = null;
    if (ceTypeable && (info.key === 'ArrowUp' || info.key === 'ArrowDown')) {
      const s0 = globalThis.getSelection && globalThis.getSelection();
      const r0 = s0 && s0._ranges && s0._ranges[0];
      const sc0 = r0 && r0.startContainer;
      if (sc0 && sc0.nodeType === NODE_TEXT && nearestPreAncestor(sc0) && (sc0.data || '').indexOf('\n') >= 0) {
        preNavSavedSel = { node: sc0, offset: r0.startOffset | 0 };
      }
    }
    dispatchEvent(n, kd);
    let blocked = kd.defaultPrevented;
    // Space-key activation on checkbox / radio inputs: the spec'd
    // default action is a synthetic click, which our existing
    // `__csimClickResolve` already implements (mousedown → mouseup →
    // click → toggle + input + change). Route through it so listeners
    // wired to `change` (Discourse wizard, Stimulus actions) fire.
    if (!blocked && isCheckOrRadio && info.key === ' ') {
      try { globalThis.__csimClickResolve(n._id, modifiers || null); } catch (_) {}
      dispatchEvent(n, new KeyboardEvent('keyup', init));
      return;
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
        const defaultBtn = form.querySelector(DEFAULT_SUBMIT_SELECTOR);
        if (!(defaultBtn && isActuallyDisabled(defaultBtn))) {
          const submitter = defaultBtn || null;
          // A dirtied text field commits its `change` BEFORE `submit` (verified in
          // Chrome), while keeping focus — implicit submission doesn't blur it.
          commitChangeKeepingFocus(n);
          const submit = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter });
          dispatchEvent(form, submit);
          if (!submit.defaultPrevented) {
            recordFormSubmission(form, submitter);
          }
        }
      }
    }
    // Enter / Space on a focused `<button>` (or anchor) fires the
    // element's activation behavior — i.e. a click. Without this,
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
    if (info.key === 'Enter' || info.key === ' ') {
      const isLink     = n._tag === 'a' && n._attrs.href != null;
      const isButton   = n._tag === 'button';
      const hasMods    = modifiers && (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey);
      const okDefault  = !blocked && n._attrs.disabled == null;
      if (okDefault && (isLink || (isButton && !hasMods))) {
        try {
          const action = globalThis.__csimClickResolve(n._id, modifiers || null);
          // __csimClickResolve returns the navigate / submit / download
          // intent for Ruby to drive; from the keyboard activation
          // path we forward it through `__csimPendingNavigation` so
          // the post-send_keys drain (`consume_pending_navigation`)
          // picks it up — including `target='_blank'` from cmd+Enter.
          if (action && action.kind === 'navigate' && action.url) {
            globalThis.__csimPendingNavigation = { url: action.url, target: action.target || '' };
          }
        } catch (_) {}
      }
    }
    const wouldType =
      typeable && !blocked &&
      (info.char != null || info.inputType === 'deleteContentBackward' || info.inputType === 'deleteContentForward') &&
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
        data: info.char != null ? info.char : null,
        inputType: info.inputType
      });
      dispatchEvent(n, bi);
      if (bi.defaultPrevented) blocked = true;
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
         const pos = info.key === 'Home' ? 0 : cur.length;
         n._selectionStart = pos;
         n._selectionEnd   = pos;
       }
     } else if (typeable && !blocked && (info.key === 'ArrowLeft' || info.key === 'ArrowRight')) {
       const dir = info.key === 'ArrowLeft' ? -1 : 1;
       if (ceTypeable) {
         moveContenteditableCaret(dir);
       } else {
         const cur = controlLiveValue(n);
         const baseAnchor = dir < 0
           ? (n._selectionStart != null ? n._selectionStart : cur.length)
           : (n._selectionEnd   != null ? n._selectionEnd   : cur.length);
         const next = dir < 0 ? Math.max(0, baseAnchor - 1) : Math.min(cur.length, baseAnchor + 1);
         n._selectionStart = next;
         n._selectionEnd   = next;
       }
     } else if (preNavSavedSel) {
       // Defer to let PM's keydown transaction flush before our
       // collapse + selectionchange — otherwise PM's SelectionReader
       // skips the read while `updating` is set, and state.selection
       // stays at wherever its gap-cursor handler put it.
       const dir = info.key === 'ArrowUp' ? -1 : 1;
       globalThis.setTimeout(() => moveCaretInPre(dir, preNavSavedSel), 0);
     }
    if (!blocked && wouldType) {
      const doDefault = () => {
        if (ceTypeable) {
          if (info.char != null) {
            globalThis.__csimInsertTextAtSelection(info.char);
          } else if (info.inputType === 'deleteContentBackward') {
            const sel = globalThis.getSelection && globalThis.getSelection();
            const r = sel && sel._ranges[0];
            const sc = r && r.startContainer;
            if (sc && sc.nodeType === NODE_TEXT && r.startOffset > 0) {
              const pos = r.startOffset;
              sc.data = sc._data.slice(0, pos - 1) + sc._data.slice(pos);
              r.startOffset = pos - 1; r.endOffset = pos - 1;
            }
          }
        } else if (info.char != null) {
          __appendValue(n, info.char);
        } else if (info.inputType === 'deleteContentBackward') {
          const cur   = controlLiveValue(n);
          const start = n._selectionStart != null ? n._selectionStart : cur.length;
          const end   = n._selectionEnd   != null ? n._selectionEnd   : start;
          // Live value edit (dirty value flag); a textarea's child-text default is
          // not rewritten. A non-collapsed selection (e.g. after select()) is
          // deleted whole; a collapsed caret removes the one char before it.
          if (end > start) {
            n._value = cur.slice(0, start) + cur.slice(end);
            n._selectionStart = n._selectionEnd = start;
          } else if (start > 0) {
            n._value = cur.slice(0, start - 1) + cur.slice(start);
            n._selectionStart = n._selectionEnd = start - 1;
          }
        }
        // A user edit since focus → the control fires `change` when it later loses
        // focus (commitChangeOnBlur); a programmatic value change never sets this.
        if (n._changeBaseline !== undefined) n._editedSinceFocus = true;
        try {
          dispatchEvent(n, new InputEvent('input', {
            bubbles: true, cancelable: false, composed: true,
            data: info.char != null ? info.char : null,
            inputType: info.inputType
          }));
        } catch (_) {}
      };
      // Keys with a promise-deferrable default (Enter / Tab —
      // Tagify, Algolia's autocomplete, jQuery-UI menu all call
      // `e.preventDefault()` from a `beforeKeyDown(e).then(...)`
      // chain for these) defer to a task so listener microtasks
      // drain first. Regular character typing stays synchronous
      // so subsequent chars see the cursor mutation from the
      // previous one (`send_keys 'abc'` must produce "abc", not
      // an out-of-order shuffle).
      if (info.key === 'Enter' || info.key === 'Tab') {
        scheduleTimer(() => {
          if (kd.defaultPrevented) return;
          doDefault();
        }, 0, [], null);
      } else {
        doDefault();
      }
    }
    // Tab's UI Events default action moves focus through the
    // document's tabbable elements (reverse with shift). Menus
    // that close on `focusout` rely on the resulting blur/focus
    // events firing. Skip if a handler preventDefault'd the keydown.
    if (!blocked && info.key === 'Tab') {
      scheduleTimer(() => {
        if (kd.defaultPrevented) return;
        try { globalThis.__csimAdvanceFocus(!!(modifiers && modifiers.shiftKey)); } catch (_) {}
      }, 0, [], null);
    }
    // `keypress` is deprecated but Mousetrap-shape libraries
    // (Discourse's `@discourse/itsatrap` for the `/`-to-open-search
    // shortcut) still listen for it on character keys. Per UI Events
    // spec, keypress's `which` is the character code for printable
    // keys, not the physical key code — itsatrap reads `e.which` +
    // `String.fromCharCode(...)` to look up its binding, and a
    // Slash-key 191 resolves to `¿` instead of `/`. Only `which` is
    // overridden; PM's input-rule chain reads `event.keyCode` on
    // keypress, and changing that to the ASCII code reorders typed
    // chars in the markdown-image auto-convert (test:
    // `prosemirror_keymap_spec.rb:184`).
    // keypress / keyup re-target to whatever is currently focused —
    // a keydown handler that blurred or moved focus (Discourse
    // `Escape` → SearchMenu.close() blurs the input → focus moves
    // to BODY) must NOT route the subsequent keyup back to the
    // original element. Without this, SearchTerm's onKeyup fires
    // a spurious `openSearchMenu()` after Escape had just closed it.
    const kupTarget = globalThis.document.activeElement || n;
    if (!blocked && info.char != null) {
      const printable = info.key && info.key.length === 1 && info.key === info.char;
      const kpInit    = printable
        ? Object.assign({}, init, { which: info.char.charCodeAt(0) })
        : init;
      dispatchEvent(kupTarget, new KeyboardEvent('keypress', kpInit));
    }
    dispatchEvent(kupTarget, new KeyboardEvent('keyup', init));
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
        try { dispatchEvent(n, new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: mi.key, code: mi.code, keyCode: mi.keyCode, which: mi.keyCode, ...mods })); } catch (_) {}
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
      if (typeof keyName === 'string' && keyName.length > 1 && !isNamedKey) {
        for (const ch of keyName) {
          const cooked = mods.shiftKey ? ch.toUpperCase() : ch;
          pressKey(__resolveKey(cooked), mods);
        }
      } else {
        const single = String(keyName);
        const cooked = mods.shiftKey && single.length === 1 ? single.toUpperCase() : single;
        pressKey(__resolveKey(cooked), mods);
      }
      for (let i = modInfos.length - 1; i >= 0; i--) {
        const mi = modInfos[i];
        try { dispatchEvent(n, new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: mi.key, code: mi.code, keyCode: mi.keyCode, which: mi.keyCode })); } catch (_) {}
      }
      // Clipboard paste: Ctrl+V / Cmd+V fires a `paste` event with
      // the system clipboard's content surfaced through
      // clipboardData.getData(...). Real browsers do this as the
      // default action of the keydown; Redmine's
      // `copy_*_to_clipboard` tests round-trip text via a Stimulus
      // `clipboard#copyText` call, and Discourse's ProseMirror
      // pasting specs round-trip HTML via
      // `navigator.clipboard.write([ClipboardItem(text/html)])`
      // followed by Ctrl+V.
      const lowerKey = String(keyName).toLowerCase();
      const isModCombo = mods.ctrlKey || mods.metaKey;
      // Ctrl+A / Cmd+A default action: select all content in the
      // focused text control or contenteditable host. Per HTML/UI
      // Events spec, this runs as the keydown's default action.
      if (isModCombo && lowerKey === 'a') {
        if (ceTypeable) {
          const sel  = globalThis.getSelection?.();
          const host = contenteditableHost(n);
          if (sel && host) sel.selectAllChildren(host);
        } else if (typeable) {
          n.select();
        }
      }
      if (isModCombo && lowerKey === 'v') {
        const types = (globalThis.__csimClipboardTypes ? globalThis.__csimClipboardTypes() : []).slice();
        const plain = globalThis.__csimClipboardGet('text/plain') || '';
        const html  = globalThis.__csimClipboardGet('text/html')  || '';
        const files = (globalThis.__csimClipboardFiles ? globalThis.__csimClipboardFiles() : []).slice();
        // Per DataTransfer spec, `types` includes the literal string
        // `"Files"` when the transfer contains any File entries —
        // separate from the per-file MIME-type entries. Discourse's
        // `clipboardHelpers` gates upload on `types.includes("Files")`
        // (not on `files.length`), so the file-upload branch never
        // fires without this entry and a pasted image is read out of
        // the placeholder HTML instead.
        if (files.length > 0 && !types.includes('Files')) types.push('Files');
        if (types.length > 0 || plain || html) {
          const ev = new Event('paste', { bubbles: true, cancelable: true });
          ev.clipboardData = {
            types,
            files,
            items: types.map((t) => {
              const isFile = files.some((f) => f && f.type === t);
              return {
                kind: isFile ? 'file' : 'string',
                type: t,
                getAsFile: isFile
                  ? (() => { const f = files.find((x) => x.type === t); return f || null; })
                  : (() => null),
                getAsString: isFile
                  ? ((_cb) => {})
                  : ((cb) => { try { cb(globalThis.__csimClipboardGet(t) || ''); } catch (_) {} })
              };
            }),
            getData (kind) {
              const k = String(kind || '').toLowerCase();
              if (k === 'text' || k === 'text/plain') return plain;
              if (k === 'text/html') return html;
              return globalThis.__csimClipboardGet(k) || '';
            },
            setData () {}
          };
          dispatchEvent(n, ev);
          if (!ev.defaultPrevented && typeable) {
            // Real browser's default action: insert clipboard text at
            // the current selection. For `<input>` / `<textarea>` we
            // splice into the live value (`_value`); for contenteditable,
            // route through the same path as typing (PM's own paste handler
            // usually preventDefaults, so this branch is mainly for
            // plain contenteditable surfaces that don't intercept).
            const text = plain || html;
            if (ceTypeable) {
              if (text) globalThis.__csimInsertTextAtSelection(text);
            } else {
              const cur = controlLiveValue(n);
              const s = n._selectionStart != null ? n._selectionStart : cur.length;
              const e = n._selectionEnd   != null ? n._selectionEnd   : s;
              n._value = cur.slice(0, s) + text + cur.slice(e);
              n._selectionStart = n._selectionEnd = s + text.length;
              dispatchEvent(n, new InputEvent('input', {
                bubbles: true, cancelable: false, composed: true,
                data: text, inputType: 'insertFromPaste'
              }));
            }
          }
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
  if (!n || n.nodeType !== NODE_ELEMENT) return;
  if (!isContenteditable(n)) return;
  const sel = globalThis.getSelection && globalThis.getSelection();
  if (!sel) return;
  // If selection is already inside the target, use its anchor; else
  // descend to find the first text node inside the target.
  let r = sel._ranges && sel._ranges[0];
  let textNode = null;
  let off = 0;
  if (r && r.startContainer && n.contains(r.startContainer) &&
      r.startContainer.nodeType === NODE_TEXT) {
    textNode = r.startContainer;
    off = r.startOffset | 0;
  } else {
    // PM wraps freshly-marked inline content with cursor / placeholder
    // span widgets; the actual text leaf may not be the deepest
    // first-child. Walk the subtree DFS until we hit a non-empty text
    // node so dblclick-on-`<strong>bold</strong>` finds the "bold"
    // text rather than an empty leading span.
    const leaf = findFirstNonEmptyText(n);
    if (!leaf) return;
    textNode = leaf;
    off = 0;
  }
  // Real-browser word selection crosses adjacent inline text nodes:
  // `<code>code</code><strong>bold</strong>not<em>italic</em>` renders
  // as one continuous run "codeboldnotitalic", and a dblclick anywhere
  // in there selects the whole run. Stop only at non-word characters
  // (whitespace, punctuation) or a block-level boundary. Without the
  // cross-node walk, Discourse's "wrap URL paste over a selection with
  // existing marks" test selects only "bold" and the link wraps just
  // that one mark instead of the full inline run.
  const wordChar = /[\p{L}\p{N}_]/u;
  const data0 = textNode.data || '';
  let startNode = textNode;
  let startOff  = Math.min(off, data0.length);
  let endNode   = textNode;
  let endOff    = startOff;
  while (startOff > 0 && wordChar.test(data0[startOff - 1])) startOff -= 1;
  while (endOff < data0.length && wordChar.test(data0[endOff])) endOff += 1;
  const anchorBlock = findBlockAncestor(textNode);
  if (startOff === 0) {
    [startNode, startOff] = extendWordAcrossLeaves(startNode, -1, wordChar, anchorBlock);
  }
  if (endOff === data0.length) {
    [endNode, endOff] = extendWordAcrossLeaves(endNode, +1, wordChar, anchorBlock);
  }
  if (startNode === endNode && startOff === endOff) return;
  if (typeof sel.setBaseAndExtent === 'function') {
    sel.setBaseAndExtent(startNode, startOff, endNode, endOff);
  } else if (typeof sel.collapse === 'function') {
    sel.collapse(startNode, startOff);
    if (typeof sel.extend === 'function') sel.extend(endNode, endOff);
  }
};
function extendWordAcrossLeaves(startLeaf, dir, wordChar, anchorBlock) {
  let leaf = startLeaf;
  let off  = dir < 0 ? 0 : (leaf.data || '').length;
  let cur  = dir < 0 ? previousTextLeaf(leaf) : nextTextLeaf(leaf);
  while (cur && cur.nodeType === NODE_TEXT && findBlockAncestor(cur) === anchorBlock) {
    const d = cur.data || '';
    if (!d.length) break;
    const edgeChar = dir < 0 ? d[d.length - 1] : d[0];
    if (!wordChar.test(edgeChar)) break;
    leaf = cur;
    if (dir < 0) {
      off = d.length;
      while (off > 0 && wordChar.test(d[off - 1])) off -= 1;
      if (off > 0) break;
    } else {
      off = 0;
      while (off < d.length && wordChar.test(d[off])) off += 1;
      if (off < d.length) break;
    }
    cur = dir < 0 ? previousTextLeaf(cur) : nextTextLeaf(cur);
  }
  return [leaf, off];
}

// Cheap probe used by `Browser#send_keys` to decide whether to
// split a multi-char text atom into per-char calls. The split
// is only necessary for contenteditable hosts (PM / Tiptap / Trix
// reconcile their view between chars); plain `<input>` /
// `<textarea>` get the whole string in one cross-boundary call.
globalThis.__csimIsContentEditable = function (h) {
  const n = lookup(h);
  return !!(n && n.nodeType === NODE_ELEMENT && isContenteditable(n));
};

globalThis.__csimAncestorForm = function (h) {
  const n = lookup(h);
  if (!n) return 0;
  const f = ancestorForm(n);
  return f ? f._id : 0;
};

// Called by the Ruby side after `attach_file` resolves a list of
// paths to {name, size, type, lastModified} entries. The list is
// attached to the input as a FileList-shaped array; `el.files`
// exposes it to JS consumers (jQuery file widgets, Redmine's
// attachments.js).
// Build a File whose bytes lazily load from the Ruby side via
// `globalThis.__csimReadFilePick(handle, index, start, end)` — ActiveStorage's
// `DirectUpload` MD5-chunks the file via
// `fileSlice.call(file, start, end)` + `FileReader.readAsArrayBuffer`,
// so attached files need real Blob slicing and reading rather
// than a plain `{name, size, type}` info dict. The host-backed
// mode is keyed off the `_csimHost` flag the Blob prototype's
// `slice` / `text` check.
function __makeHostBackedFile(info, handle, index) {
  const size = Number(info.size || 0);
  const file = new globalThis.File([], String(info.name || ''), {
    type: String(info.type || ''),
    lastModified: Number(info.lastModified || 0)
  });
  file._csimHost = true;
  file._handle   = handle;
  file._index    = index;
  file._start    = 0;
  file._end      = size;
  file.size      = size;
  return file;
}
globalThis.__csimSetFiles = function (h, fileInfos) {
  const n = lookup(h);
  if (!n || n.nodeType !== NODE_ELEMENT) return false;
  const list = Array.isArray(fileInfos) ? fileInfos : [];
  n._files = list.map((info, i) => __makeHostBackedFile(info, h, i));
  return true;
};
globalThis.__csimSetValue = function (h, value) {
  let n = lookup(h);
  if (!n || n.nodeType !== NODE_ELEMENT) {
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
    if (active && active !== doc.body && active.nodeType === NODE_ELEMENT &&
        (active._tag === 'input' || active._tag === 'textarea' || isContenteditable(active))) {
      n = active;
    } else {
      return false;
    }
  }
  let tag = n._tag;
  // Capybara `.set` simulates user input → a user edit, so tooShort/tooLong
  // can apply (unlike a raw `.value` IDL set).
  if (tag === 'input' || tag === 'textarea') n._dirtyByUser = true;
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
    try { n.focus(); } catch (_) {}
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
    if (active && active.nodeType === NODE_ELEMENT &&
        active !== n &&
        (n.contains(active) || !n._parent) &&
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
    n._value = tv;
    // Mirror real browsers: typing-style value updates leave the
    // caret at the end of the new content. Tribute / inline-
    // autocomplete read `selectionStart` to find the trigger
    // character before the cursor; without advancing the caret,
    // selectionStart stays at 0 and the trigger detection sees
    // an empty "text before cursor" slice.
    n._selectionStart = tv.length;
    n._selectionEnd   = tv.length;
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
      else n._attrs.value = v;
      // Selenium parity: `set(true)` on a checkbox / radio fires the
      // same `click` event a real user click does. The `input` +
      // `change` part of HTML activation is dispatched by the end of
      // this function (shared with text inputs); only `click` is
      // checkbox-specific here.
      if (getCheckedness(n) !== wasChecked) {
        // The desired checked state is already set above, so the click must
        // NOT re-toggle in the dispatch algorithm's activation step.
        const clickEv = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, which: 1 });
        clickEv._csimActivationHandled = true;
        try { dispatchEvent(n, clickEv); } catch (_) {}
      }
      kind = 'checked';
    } else if (type === 'range' || type === 'number') {
      // HTML5: number inputs only *validate* against step (via
      // `:invalid` / `validity.stepMismatch`), they don't snap on
      // IDL assignment. Only `<input type="range">` snaps to the
      // nearest valid step. flatpickr's minute/second inputs are
      // `type="number"` with `step="5"`; snapping at `.set(17)`
      // turns it into 15 and the picker silently saves the wrong time.
      const num    = parseFloat(v);
      const min    = parseFloat(n._attrs.min);
      const max    = parseFloat(n._attrs.max);
      let clamped  = isNaN(num) ? (isNaN(min) ? 0 : min) : num;
      if (!isNaN(min) && clamped < min) clamped = min;
      if (!isNaN(max) && clamped > max) clamped = max;
      if (type === 'range') {
        const step = parseFloat(n._attrs.step) || 1;
        if (!isNaN(min) && step > 0) {
          const k = Math.round((clamped - min) / step);
          clamped = min + k * step;
          clamped = parseFloat(clamped.toFixed(10));
        }
      }
      n._value = String(clamped);
    } else {
      // Browsers truncate at maxlength when the user types; programmatic
      // assignment via the IDL setter does the same when the input is
      // a text-like control (not number/date/etc.). Sets the dirty value flag.
      const maxlen = MAXLENGTH_INPUT_TYPES.has(type) ? parseInt(n._attrs.maxlength || '', 10) : NaN;
      n._value = (maxlen > 0 && v.length > maxlen) ? v.slice(0, maxlen) : v;
      // Caret-at-end, same rationale as textarea above.
      n._selectionStart = n._value.length;
      n._selectionEnd   = n._value.length;
    }
  } else if (tag === 'select') {
    // Match the first <option> whose value (or textContent fallback)
    // equals v; mark it selected, clear siblings.
    const opts = n.querySelectorAll('option');
    let hit = false;
    for (const o of opts) {
      const ov = o._attrs.value != null ? o._attrs.value : o.textContent;
      if (ov === v) { selectOptionExclusive(n, o); hit = true; break; }
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
    const sel = globalThis.getSelection && globalThis.getSelection();

    // Capybara's `.set` semantics on a contenteditable is "make
    // its value v" — replace, not append. Real user does Ctrl-A +
    // type, which (a) selects all, (b) the first keystroke replaces
    // the selection with the typed character. Mirror that:
    //   1. selectAllChildren(n) — non-collapsed range over the
    //      contenteditable's content
    //   2. deleteRangeContents on it — clears existing text
    //   3. Per-char insertion at the now-empty cursor
    //
    // PM/Tiptap observes the "delete all" mutation and resets the
    // editor to its empty placeholder; the per-char inserts then
    // land in that placeholder. Plain contenteditable just sees
    // the cleared element + per-char text inserts.
    if (sel) {
      sel.selectAllChildren(n);
      const r0 = sel._ranges[0];
      if (r0 && !r0.collapsed) deleteRangeContents(r0);
      // After delete the range collapses to the empty container;
      // re-position cursor inside the deepest leaf if one exists.
      const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'wbr', 'meta', 'link']);
      let leaf = n;
      while (leaf._children && leaf._children.length > 0) {
        const next = leaf._children.find(c =>
          c.nodeType === NODE_ELEMENT && !VOID_TAGS.has(c._tag)
        );
        if (!next) break;
        leaf = next;
      }
      sel.collapse(leaf, leaf._children ? leaf._children.length : 0);
    }

    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      const kd = new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: ch, char: ch
      });
      dispatchEvent(n, kd);
      if (kd.defaultPrevented) { continue; }

      // Build targetRanges from the current Selection's first range
      // (live snapshot per UI Events spec). PM uses this to map
      // back to model positions.
      const r = sel && sel._ranges[0];
      const targetRanges = r ? [{
        startContainer: r.startContainer, startOffset: r.startOffset | 0,
        endContainer:   r.endContainer,   endOffset:   r.endOffset   | 0
      }] : [];
      const bi = new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, composed: true, data: ch, inputType: 'insertText',
        targetRanges
      });
      dispatchEvent(n, bi);
      if (!bi.defaultPrevented) {
        globalThis.__csimInsertTextAtSelection(ch);
      }
      try {
        dispatchEvent(n, new InputEvent('input', {
          bubbles: true, cancelable: false, composed: true, data: ch, inputType: 'insertText'
        }));
      } catch (_) {}
      try {
        dispatchEvent(n, new KeyboardEvent('keyup', {
          bubbles: true, cancelable: true, key: ch, char: ch
        }));
      } catch (_) {}
    }
    dispatchEvent(n, new InputEvent('input', {
      bubbles: true, cancelable: false, composed: true, data: v, inputType: 'insertText'
    }));
    return true;
  } else {
    n._value = v;   // input/textarea live value (dirty value flag)
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
    try { dispatchEvent(n, new KeyboardEvent('keydown', { bubbles: true, cancelable: true })); } catch (_) {}
  }
  // Fire `input` (cancellable, bubbles) then `change` (bubbles only).
  // For checkbox / radio real browsers fire `change` only on a real
  // user interaction, but Capybara's `set` mirrors what `selenium`
  // does — both events, so listeners see the update either way.
  dispatchEvent(n, new InputEvent('input', { bubbles: true, cancelable: false, composed: true }));
  dispatchEvent(n, new Event('change', { bubbles: true, cancelable: false }));
  // `.set` fired `change` eagerly (Capybara's high-level fill commits in one step);
  // clear the user-edit flag so a subsequent blur's change-on-blur doesn't re-fire.
  n._editedSinceFocus = false;
  if (tag === 'input' || tag === 'textarea' || isContenteditable(n)) {
    try { dispatchEvent(n, new KeyboardEvent('keyup', { bubbles: true, cancelable: true })); } catch (_) {}
  }
  // Capybara's `set("value\n")` on a text input means "type the
  // value, then press Enter". HTML's implicit form submission says:
  // when Enter is pressed in a form's sole text-like control, the
  // form submits. Detect the trailing newline, strip it from the
  // stored value, and queue a form-submit intent for Ruby to drain
  // (same channel as Rails-UJS data-method chains).
  if (tag === 'input' && typeof value === 'string' && value.endsWith('\n')) {
    n._value = String(controlLiveValue(n)).replace(/\n$/, '');
    const form = implicitSubmitFormFor(n);
    if (form) {
      // Route through the shared submission helper so a `target`ed named-frame
      // submit is contained to that frame (not a top-page nav); ordinary
      // submits queue the pending intent `__takePendingFormSubmit` reads.
      recordFormSubmission(form, null);
    }
  }
  return true;
};
// HTML5 implicit form submission. Returns the form to submit when
// `control` is the target of an Enter keypress (or a `.set("...\n")`
// trailing-newline). A form is eligible if it has a default submit
// button OR exactly one text-shaped input; the control itself must
// be a text-shaped input. Capybara's `should not submit single
// text input forms if ended with \n and has multiple values` pins
// the multi-input branch.
const TEXT_LIKE_INPUT_TYPES = new Set([
  'text', 'email', 'password', 'search', 'tel', 'url',
  'number', 'date', 'datetime-local', 'month', 'time', 'week'
]);
// maxlength / minlength apply only to these input types (+ <textarea>) — NOT to
// number/date/etc., whose value isn't a free-form string. (HTML "the maxlength and
// minlength attributes".)
const MAXLENGTH_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);
const DEFAULT_SUBMIT_SELECTOR = 'button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]';
function implicitSubmitFormFor (control) {
  if (!control || control._tag !== 'input') return null;
  const type = (control._attrs.type || 'text').toLowerCase();
  if (!TEXT_LIKE_INPUT_TYPES.has(type)) return null;
  const form = formForControl(control);
  if (!form) return null;
  if (form.querySelector(DEFAULT_SUBMIT_SELECTOR)) return form;
  let count = 0;
  for (const el of form.querySelectorAll('input')) {
    if (TEXT_LIKE_INPUT_TYPES.has((el._attrs.type || 'text').toLowerCase())) {
      if (++count > 1) return null;
    }
  }
  return count === 1 ? form : null;
}
function selectOptionExclusive(select, opt) {
  const multi = select._attrs.multiple != null;
  const opts = select.querySelectorAll('option');
  // A user pick sets selectedness (and the dirtiness flag), not the
  // `selected` content attribute; single-select clears every sibling.
  if (!multi) for (const o of opts) o._selectedness = false;
  opt._selectedness = true;
  opt._dirtySel = true;
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
  try { dispatchEvent(sel, new InputEvent('input', { bubbles: true, cancelable: false, composed: true })); } catch (_) {}
  try { dispatchEvent(sel, new Event('change', { bubbles: true, cancelable: false })); } catch (_) {}
}
function __ancestorSelect (option) {
  let cur = option._parent;
  while (cur && cur._tag !== 'select') cur = cur._parent;
  return cur && cur._tag === 'select' ? cur : null;
}
globalThis.__csimSelectOption = function (h) {
  const n = lookup(h);
  if (!n || n._tag !== 'option') return false;
  const sel = __ancestorSelect(n);
  if (!sel) { n._selectedness = true; n._dirtySel = true; bumpSettleGen(); return true; }
  const wasSelected = n._selectedness === true;
  selectOptionExclusive(sel, n);
  // Selectedness is observable (`:selected` / option `:checked` cascade memos,
  // the live `select.selectedOptions` collection, settle key) — bump the gen.
  bumpSettleGen();
  if (!wasSelected) __fireSelectChange(sel);
  return true;
};
globalThis.__csimUnselectOption = function (h) {
  const n = lookup(h);
  if (!n || n._tag !== 'option') return false;
  const wasSelected = n._selectedness === true;
  n._selectedness = false;
  n._dirtySel = true;
  bumpSettleGen();   // observable selectedness change (see __csimSelectOption)
  if (wasSelected) {
    const sel = __ancestorSelect(n);
    if (sel) __fireSelectChange(sel);
  }
  return true;
};

// Form serialise — mirrors urlencoded submit semantics. Skips:
//   - inputs without `name`
//   - disabled controls
//   - unchecked checkbox / radio
//   - file inputs (reported separately as `fileInputs` for the
//     multipart submit path)
//   - submit buttons other than the submitter
globalThis.__csimFormSerialize = function (formHandle, submitterHandle, resolveAction) {
  // Accept either a handle (the submission path) OR the element OBJECT directly.
  // `new FormData(iframeForm)` constructs the entry list in the PARENT realm for a
  // form living in a CHILD realm — that form's handle is in the child's per-realm
  // registry, not ours, so a `lookup` would miss it. The object is cross-realm
  // reachable (same isolate), so serialise from it.
  const form = (formHandle && typeof formHandle === 'object') ? formHandle : lookup(formHandle);
  if (!form || form._tag !== 'form') return null;
  const submitter = submitterHandle
    ? ((typeof submitterHandle === 'object') ? submitterHandle : lookup(submitterHandle))
    : null;
  const fields = [];
  const fileInputs = [];
  // HTML's `form` IDL: controls participate via either DOM ancestry
  // Walk the whole document once and keep controls whose form
  // association lands on this form (explicit `form=<id>` wins,
  // otherwise DOM-descendant). Document order matters — browsers
  // serialise in tree order regardless of where the control lives.
  const formId = form._attrs.id;
  const isDescendant = (el) => {
    for (let cur = el._parent; cur; cur = cur._parent) if (cur === form) return true;
    return false;
  };
  const inputs = [];
  // Walk the form's OWN document (not always globalThis.document — a cross-realm
  // form is serialised from the parent realm but its controls live in the child).
  const doc = form.ownerDocument || globalThis.document;
  const docRoot = (doc && doc.documentElement) || globalThis.document.documentElement;
  for (const f of docRoot.querySelectorAll('input,textarea,select,button')) {
    const explicit = f._attrs.form;
    if (explicit != null) {
      if (formId && explicit === formId) inputs.push(f);
    } else if (isDescendant(f)) {
      inputs.push(f);
    }
  }
  for (const f of inputs) {
    const tag  = f._tag;
    const name = f._attrs.name;
    // A nameless control contributes nothing — EXCEPT an image-button submitter,
    // which always contributes bare `x` / `y` coordinate entries (HTML). Only the
    // nameless case pays the extra type check, keeping the common path cheap.
    if (!name && !(tag === 'input' && (f._attrs.type || '').toLowerCase() === 'image' && f === submitter)) continue;
    // HTML "construct the entry list" walks every submittable element
    // and skips disabled ones — except the submitter, whose name/value
    // gets appended in a separate later step that does NOT check
    // disabled. Rails-UJS' `data-disable-with` mutates disabled during
    // the submit event (before form data is read), so a disabled-check
    // here would drop the very button the user clicked. The exemption
    // applies only to `f === submitter`; other disabled controls
    // (including unselected submit buttons) still skip.
    if (f._attrs.disabled != null && f !== submitter) continue;
    if (tag === 'input') {
      const type = (f._attrs.type || 'text').toLowerCase();
      // HTML "construct the entry list": a `_charset_` hidden input with no value
      // is set to the form's submission character encoding (we always encode and
      // submit as UTF-8, so emit that).
      if (name === '_charset_' && type === 'hidden' && controlLiveValue(f) === '') {
        fields.push([name, 'UTF-8']);
        continue;
      }
      if (type === 'image') {
        // An image button contributes only when it's the submitter, and then as
        // two coordinate entries `<name>.x` / `<name>.y` (bare `x` / `y` when it
        // has no name). No layout engine → the activation coordinate is (0, 0).
        if (f !== submitter) continue;
        fields.push([name ? name + '.x' : 'x', '0']);
        fields.push([name ? name + '.y' : 'y', '0']);
        continue;
      }
      if (type === 'submit' || type === 'reset' || type === 'button') {
        if (f !== submitter) continue;
        fields.push([name, f._attrs.value != null ? f._attrs.value : '']);
        continue;
      }
      if (type === 'checkbox' || type === 'radio') {
        if (!getCheckedness(f)) continue;
        fields.push([name, f._attrs.value != null ? f._attrs.value : 'on']);
        continue;
      }
      if (type === 'file') {
        // Carry each selected File's host-backed source (`_handle`/`_index` →
        // the Ruby `@file_picks` slot) so the multipart serialiser can resolve
        // bytes even for files moved onto a DIFFERENT input via JS
        // (`input.files = dataTransfer.files`), where the input's own handle was
        // never the target of an `attach_file`.
        const files = (f._files || []).map((file) => ({
          name:   String(file.name || ''),
          handle: file && file._csimHost ? file._handle : null,
          index:  file && file._csimHost ? file._index  : null
        }));
        fileInputs.push({ name, handle: f._id, el: f, files });
        continue;
      }
      fields.push([name, controlLiveValue(f)]);
    } else if (tag === 'textarea') {
      // HTML form-submission normalizes textarea LF to CRLF. The live value is
      // `_value` after a set/typing edit, else the child text content as-is (the
      // "first newline removal" already happened at parse time, so the DOM text
      // node lacks the leading line terminator) — matching `globalThis.__csimValue`.
      const raw = controlLiveValue(f);
      fields.push([name, String(raw).replace(/\r\n|\r|\n/g, '\r\n')]);
    } else if (tag === 'select') {
      const multi = f._attrs.multiple != null;
      const opts = f.querySelectorAll('option');
      let chose = false;
      for (const o of opts) {
        if (o._selectedness === true) {
          const v = o._attrs.value != null ? o._attrs.value : o.textContent;
          fields.push([name, v]);
          chose = true;
          if (!multi) break;
        }
      }
      // Implicit selection: single-select non-multi falls back to
      // first non-disabled option (mirrors browser submit).
      if (!chose && !multi) {
        for (const o of opts) {
          if (o._attrs.disabled != null) continue;
          const v = o._attrs.value != null ? o._attrs.value : o.textContent;
          fields.push([name, v]);
          break;
        }
      }
    } else if (tag === 'button') {
      const type = (f._attrs.type || 'submit').toLowerCase();
      if (type !== 'submit') continue;
      if (f !== submitter) continue;
      fields.push([name, f._attrs.value != null ? f._attrs.value : '']);
    }
  }
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
  // The submission action URL, ALREADY RESOLVED here in the form's own realm —
  // an empty/missing action is the form document's ADDRESS, a non-empty one is
  // resolved against the document's BASE URL (the `action` / `formAction` IDL
  // getters encode exactly this). Resolving in-realm is what makes a form
  // submitted inside an iframe resolve relative URLs against the IFRAME's
  // document (not the top page) and honour its <base>. Skipped (rule 3) when the
  // caller doesn't need it — `new FormData(form)` only reads fields, and the URL
  // parse the `action` getter runs would be thrown away on that hot path.
  let resolvedAction = '';
  if (resolveAction !== false) {
    if (subAction != null && subAction !== '') {
      resolvedAction = submitter.formAction;          // resolved against base
    } else if (subAction === '') {
      const doc = form.ownerDocument;                  // empty formaction → form doc address
      resolvedAction = (doc && typeof doc.URL === 'string' && doc.URL) ||
                       (globalThis.location && globalThis.location.href) || '';
    } else {
      resolvedAction = form.action;                    // empty/missing → addr, else base
    }
  }
  return {
    action:  resolvedAction,
    method:  (subMethod  || form._attrs.method  || 'get').toLowerCase(),
    enctype: (subEnctype || form._attrs.enctype || 'application/x-www-form-urlencoded').toLowerCase(),
    target:  subTarget != null ? subTarget : (form._attrs.target != null ? form._attrs.target : ''),
    fields: fields,
    fileInputs: fileInputs
  };
};
