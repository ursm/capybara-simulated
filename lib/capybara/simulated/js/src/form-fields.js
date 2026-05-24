// Form-field mutations — the Ruby-side Capybara DSL (`fill_in 'X',
// with: 'Y'`, `choose`, `select`, `send_keys`) ends up routed
// through these host fns. Each is one `Context#call` from Ruby; the
// JS-side reaction (keydown / input / change event sequence, value
// write, file attachment) happens entirely inside this module.

import { NODE_ELEMENT, NODE_TEXT }    from './constants.js';
import { lookup, handles }            from './handles.js';
import { dispatchEvent }              from './dispatch.js';
import { recordCharacterData, recordChildList } from './mutation-observer.js';
import { scheduleTimer }              from './timers.js';
import { stripOneLeadingNewline, walk } from './walk.js';
import {
  ancestorForm,
  formForControl,
  isContenteditable,
  setRadio
} from './form-helpers.js';
import { Event, InputEvent, MouseEvent, KeyboardEvent, SubmitEvent } from './events.js';
import { Text, deleteRangeContents }  from './dom-nodes.js';

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
  right:      { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, char: null, inputType: null }
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
  const cur = n._attrs.value != null ? n._attrs.value : '';
  // Insert at the current selection (which may have been moved by
  // an ArrowLeft / ArrowRight earlier in the same send_keys atom
  // stream). If selection bounds are missing, fall back to "append
  // at end" — i.e. caret-at-end after the last write.
  const s = n._selectionStart != null ? n._selectionStart : cur.length;
  const e = n._selectionEnd   != null ? n._selectionEnd   : s;
  const composed = cur.slice(0, s) + ch + cur.slice(e);
  const maxlen   = parseInt(n._attrs.maxlength || '', 10);
  n._attrs.value = (maxlen > 0 && composed.length > maxlen) ? composed.slice(0, maxlen) : composed;
  if (n._tag === 'textarea') {
    n._children = [Object.assign(new Text(n._attrs.value), { _parent: n })];
  }
  const caret = Math.min(n._attrs.value.length, s + ch.length);
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
  const ceTypeable = isContenteditable(n);
  // Radio / checkbox inputs aren't typeable: HTML §4.10.5.2.16 says
  // space-key fires the activation behavior (synthetic click) instead.
  const inputType = (n._attrs.type || '').toLowerCase();
  const isCheckOrRadio = n._tag === 'input' && (inputType === 'radio' || inputType === 'checkbox');
  const isFormControl  = (n._tag === 'input' || n._tag === 'textarea') &&
                         !(n._attrs.readonly != null || n._attrs.disabled != null);
  const typeable = ceTypeable || (isFormControl && !isCheckOrRadio);
  if (typeable || isCheckOrRadio) { try { n.focus(); } catch (_) {} }
  const startValue = typeable ? (n._attrs.value || '') : null;
  const pressKey = (info, modifiers) => {
    const initBase = Object.assign({ bubbles: true, cancelable: true }, modifiers || {});
    const init = Object.assign({}, initBase, { key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode });
    const kd = new KeyboardEvent('keydown', init);
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
        const submit = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: null });
        dispatchEvent(form, submit);
        if (!submit.defaultPrevented) {
          globalThis.__csimPendingFormSubmit = { form, submitter: null };
        }
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
        bubbles: true, cancelable: true,
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
     if (typeable && !blocked && (info.key === 'ArrowLeft' || info.key === 'ArrowRight')) {
       const dir = info.key === 'ArrowLeft' ? -1 : 1;
       if (ceTypeable) {
         moveContenteditableCaret(dir);
       } else {
         const cur = n._attrs.value != null ? n._attrs.value : '';
         const baseAnchor = dir < 0
           ? (n._selectionStart != null ? n._selectionStart : cur.length)
           : (n._selectionEnd   != null ? n._selectionEnd   : cur.length);
         const next = dir < 0 ? Math.max(0, baseAnchor - 1) : Math.min(cur.length, baseAnchor + 1);
         n._selectionStart = next;
         n._selectionEnd   = next;
       }
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
          const cur = n._attrs.value != null ? n._attrs.value : '';
          const pos = n._selectionStart != null ? n._selectionStart : cur.length;
          if (pos > 0) {
            const next = cur.slice(0, pos - 1) + cur.slice(pos);
            n._attrs.value = next;
            if (n._tag === 'textarea') n._children = [Object.assign(new Text(next), { _parent: n })];
            n._selectionStart = pos - 1;
            n._selectionEnd   = pos - 1;
          }
        }
        try {
          dispatchEvent(n, new InputEvent('input', {
            bubbles: true, cancelable: true,
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
    // `keypress` is deprecated but Mousetrap-shape libraries (Discourse's
    // `@discourse/itsatrap` for the `/`-to-open-search shortcut) still
    // listen for it on character keys. Real browsers fire it after
    // `keydown` for any character-producing key when not preventDefaulted.
    if (!blocked && info.char != null) {
      dispatchEvent(n, new KeyboardEvent('keypress', init));
    }
    dispatchEvent(n, new KeyboardEvent('keyup', init));
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
      // Clipboard paste: Ctrl+V / Cmd+V should fire a `paste` event
      // with the system clipboard's text content. Real browsers do
      // this as the default action of the keydown; Redmine's
      // `copy_*_to_clipboard` tests use it to round-trip the
      // value from a Stimulus `clipboard#copyText` call.
      const lowerKey = String(keyName).toLowerCase();
      if (typeable && (mods.ctrlKey || mods.metaKey) && lowerKey === 'v') {
        const pasted = globalThis.__csimClipboardGet();
        if (pasted) {
          const ev = new Event('paste', { bubbles: true, cancelable: true });
          ev.clipboardData = {
            types: ['text/plain'],
            getData (kind) {
              return kind === 'text' || kind === 'text/plain' ? pasted : '';
            },
            setData () {}
          };
          dispatchEvent(n, ev);
          if (!ev.defaultPrevented) {
            // Insert at current caret position, replacing any
            // selection range — same as a real browser paste.
            const cur = n._attrs.value != null ? n._attrs.value : '';
            const s = n._selectionStart != null ? n._selectionStart : cur.length;
            const e = n._selectionEnd   != null ? n._selectionEnd   : s;
            const next = cur.slice(0, s) + pasted + cur.slice(e);
            n._attrs.value = next;
            if (n._tag === 'textarea') {
              n._children = [Object.assign(new Text(next), { _parent: n })];
            }
            n._selectionStart = n._selectionEnd = s + pasted.length;
            dispatchEvent(n, new InputEvent('input', {
              bubbles: true, cancelable: true,
              data: pasted, inputType: 'insertFromPaste'
            }));
          }
        }
      }
    }
  }
  if (typeable && n._attrs.value !== startValue) {
    dispatchEvent(n, new Event('change', { bubbles: true, cancelable: false }));
  }
  return true;
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
    n._children = []; n._children.push(Object.assign(new Text(v), { _parent: n }));
    n._attrs.value = v;
    // Mirror real browsers: typing-style value updates leave the
    // caret at the end of the new content. Tribute / inline-
    // autocomplete read `selectionStart` to find the trigger
    // character before the cursor; without advancing the caret,
    // selectionStart stays at 0 and the trigger detection sees
    // an empty "text before cursor" slice.
    n._selectionStart = v.length;
    n._selectionEnd   = v.length;
  } else if (tag === 'input') {
    const type = (n._attrs.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      const wasChecked = n._attrs.checked != null;
      if (value === true || value === 'true') {
        // Radio: setting one in a group clears the others on the
        // same `name`.
        if (type === 'radio') setRadio(n);
        else                  n._attrs.checked = '';
      } else if (value === false || value === 'false') delete n._attrs.checked;
      else n._attrs.value = v;
      // Selenium parity: `set(true)` on a checkbox / radio fires the
      // same `click` event a real user click does. The `input` +
      // `change` part of HTML activation is dispatched by the end of
      // this function (shared with text inputs); only `click` is
      // checkbox-specific here.
      if ((n._attrs.checked != null) !== wasChecked) {
        try { dispatchEvent(n, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, which: 1 })); } catch (_) {}
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
      n._attrs.value = String(clamped);
    } else {
      // Browsers truncate at maxlength when the user types; programmatic
      // assignment via the IDL setter does the same when the input is
      // a text-like control.
      const maxlen = parseInt(n._attrs.maxlength || '', 10);
      n._attrs.value = (maxlen > 0 && v.length > maxlen) ? v.slice(0, maxlen) : v;
      // Caret-at-end, same rationale as textarea above.
      n._selectionStart = n._attrs.value.length;
      n._selectionEnd   = n._attrs.value.length;
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
        bubbles: true, cancelable: true, data: ch, inputType: 'insertText',
        targetRanges
      });
      dispatchEvent(n, bi);
      if (!bi.defaultPrevented) {
        globalThis.__csimInsertTextAtSelection(ch);
      }
      try {
        dispatchEvent(n, new InputEvent('input', {
          bubbles: true, cancelable: false, data: ch, inputType: 'insertText'
        }));
      } catch (_) {}
      try {
        dispatchEvent(n, new KeyboardEvent('keyup', {
          bubbles: true, cancelable: true, key: ch, char: ch
        }));
      } catch (_) {}
    }
    dispatchEvent(n, new InputEvent('input', {
      bubbles: true, cancelable: false, data: v, inputType: 'insertText'
    }));
    return true;
  } else {
    n._attrs.value = v;
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
  dispatchEvent(n, new InputEvent('input',  { bubbles: true, cancelable: true }));
  dispatchEvent(n, new Event('change', { bubbles: true, cancelable: false }));
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
    n._attrs.value = String(n._attrs.value || '').replace(/\n$/, '');
    const form = implicitSubmitFormFor(n);
    if (form) {
      // Match the shape `__takePendingFormSubmit` reads: an object
      // with the raw form/submitter Element refs, not handle ids.
      globalThis.__csimPendingFormSubmit = { form, submitter: null };
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
  if (!multi) for (const o of opts) delete o._attrs.selected;
  opt._attrs.selected = '';
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
  try { dispatchEvent(sel, new InputEvent('input',  { bubbles: true, cancelable: true })); } catch (_) {}
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
  if (!sel) { n._attrs.selected = ''; return true; }
  const wasSelected = n._attrs.selected != null;
  selectOptionExclusive(sel, n);
  if (!wasSelected) __fireSelectChange(sel);
  return true;
};
globalThis.__csimUnselectOption = function (h) {
  const n = lookup(h);
  if (!n || n._tag !== 'option') return false;
  const wasSelected = n._attrs.selected != null;
  delete n._attrs.selected;
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
globalThis.__csimFormSerialize = function (formHandle, submitterHandle) {
  const form = lookup(formHandle);
  if (!form || form._tag !== 'form') return null;
  const submitter = submitterHandle ? lookup(submitterHandle) : null;
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
  for (const f of globalThis.document.documentElement.querySelectorAll('input,textarea,select,button')) {
    const explicit = f._attrs.form;
    if (explicit != null) {
      if (formId && explicit === formId) inputs.push(f);
    } else if (isDescendant(f)) {
      inputs.push(f);
    }
  }
  for (const f of inputs) {
    if (!f._attrs.name) continue;
    if (f._attrs.disabled != null) continue;
    const tag = f._tag;
    const name = f._attrs.name;
    if (tag === 'input') {
      const type = (f._attrs.type || 'text').toLowerCase();
      if (type === 'submit' || type === 'image' || type === 'reset' || type === 'button') {
        if (f !== submitter) continue;
        fields.push([name, f._attrs.value != null ? f._attrs.value : '']);
        continue;
      }
      if (type === 'checkbox' || type === 'radio') {
        if (f._attrs.checked == null) continue;
        fields.push([name, f._attrs.value != null ? f._attrs.value : 'on']);
        continue;
      }
      if (type === 'file') {
        fileInputs.push({ name, handle: f._id });
        continue;
      }
      fields.push([name, f._attrs.value != null ? f._attrs.value : '']);
    } else if (tag === 'textarea') {
      // HTML form-submission spec normalizes textarea LF to CRLF.
      // Strip the same single leading line terminator that
      // `globalThis.__csimValue` strips, then re-normalize line endings.
      const raw = f._attrs.value != null
        ? f._attrs.value
        : stripOneLeadingNewline(f.textContent);
      fields.push([name, String(raw).replace(/\r\n|\r|\n/g, '\r\n')]);
    } else if (tag === 'select') {
      const multi = f._attrs.multiple != null;
      const opts = f.querySelectorAll('option');
      let chose = false;
      for (const o of opts) {
        if (o._attrs.selected != null) {
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
  return {
    action:  subAction  != null ? subAction  : (form._attrs.action  != null ? form._attrs.action  : ''),
    method:  (subMethod  || form._attrs.method  || 'get').toLowerCase(),
    enctype: (subEnctype || form._attrs.enctype || 'application/x-www-form-urlencoded').toLowerCase(),
    fields: fields,
    fileInputs: fileInputs
  };
};
