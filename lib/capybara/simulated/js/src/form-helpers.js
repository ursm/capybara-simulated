// Form-control helpers shared between Element class methods and the
// form-field mutation block (send_keys / set / select). Pure
// node-shape queries plus the `<dialog>.close` event dispatch.

import { NODE_ELEMENT }       from './constants.js';
import { Event }              from './events.js';
import { selectFirst }        from './selectors.js';
import { recordAttrMutation } from './mutation-observer.js';
import { dispatchEvent }      from './dispatch.js';

// Spec-minimal `<dialog>.close(returnValue)` — strip `open`,
// dispatch a non-bubbling, non-cancelable `close` event. Turbo's
// `confirm` flow waits on this event and reads `dialog.returnValue`
// to decide whether to proceed.
export function closeDialog(dlg, returnValue) {
  if (!dlg || dlg._tag !== 'dialog') return;
  dlg.returnValue = String(returnValue == null ? '' : returnValue);
  if (Object.prototype.hasOwnProperty.call(dlg._attrs, 'open')) {
    const old = dlg._attrs.open;
    delete dlg._attrs.open;
    recordAttrMutation(dlg, 'open', old == null ? null : old);
  }
  try { dispatchEvent(dlg, new Event('close', { bubbles: false, cancelable: false })); } catch (_) {}
}

// Resolve a `<label>` element to its labeled form control per HTML
// spec. Preference order: `for` attribute → first labelable
// descendant (input / textarea / select / button / output / meter /
// progress, excluding `input[type=hidden]`).
export const LABELABLE = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);
export function labeledControlFor(label) {
  const forId = label._attrs.for;
  if (forId) {
    const root = globalThis.document.documentElement;
    if (root) {
      const hit = selectFirst([root], '#' + forId);
      if (hit) return hit;
    }
  }
  const stack = [label];
  while (stack.length) {
    const cur = stack.shift();
    for (const c of cur._children) {
      if (c.nodeType !== NODE_ELEMENT) continue;
      if (LABELABLE.has(c._tag)) {
        if (c._tag === 'input' && (c._attrs.type || '').toLowerCase() === 'hidden') continue;
        return c;
      }
      stack.push(c);
    }
  }
  return null;
}

// Nearest `<label>` ancestor of `n` (excluding `n` itself), or null
// if none. Walk stops at the first labelable control because clicking
// it activates that control instead of the outer label's target —
// matches HTML "click in a label" semantics. `n` itself being a label
// is the caller's concern.
export function enclosingLabelFor(n) {
  let cur = n._parent;
  while (cur && cur.nodeType === NODE_ELEMENT) {
    if (cur._tag === 'label') return cur;
    if (LABELABLE.has(cur._tag)) return null;
    cur = cur._parent;
  }
  return null;
}

// Nearest contenteditable host ancestor (or `n` itself). Returns null
// when `n` is outside any editable region, or inside an explicit
// `contenteditable="false"` subtree (the `false` value short-circuits
// the walk without inheriting from a grandparent).
export function contenteditableHost(n) {
  let cur = n;
  while (cur && cur.nodeType === NODE_ELEMENT) {
    const v = cur._attrs.contenteditable;
    if (v != null) {
      const lower = String(v).toLowerCase();
      if (lower === '' || lower === 'true' || lower === 'plaintext-only') return cur;
      if (lower === 'false') return null;
    }
    cur = cur._parent;
  }
  return null;
}

export function isContenteditable(n) {
  return contenteditableHost(n) != null;
}

export function isSubmitButton(n) {
  if (n._tag === 'button') {
    const t = (n._attrs.type || 'submit').toLowerCase();
    return t === 'submit';
  }
  if (n._tag === 'input') {
    const t = (n._attrs.type || '').toLowerCase();
    return t === 'submit' || t === 'image';
  }
  return false;
}

export function ancestorForm(n) {
  let cur = n._parent;
  while (cur && cur.nodeType === NODE_ELEMENT) {
    if (cur._tag === 'form') return cur;
    cur = cur._parent;
  }
  return null;
}

// HTML 5: a form control's owning form is resolved via either the
// `form="<id>"` IDL attribute (looking up the form by id) or — when
// absent — by walking ancestors. The attribute takes precedence and
// is the only way to associate a button that lives *outside* the
// form's DOM subtree.
export function formForControl(n) {
  const formId = n._attrs.form;
  if (formId) {
    const root = globalThis.document.documentElement;
    if (root) {
      const forms = root.getElementsByTagName('form');
      for (const f of forms) if (f._attrs.id === formId) return f;
    }
  }
  return ancestorForm(n);
}

export function toggleChecked(n) {
  if (n._attrs.checked != null) delete n._attrs.checked;
  else n._attrs.checked = '';
}

// HTMLFormElement named-item access: `form.foo` returns the form
// control whose `name` (or `id`) is `foo`. The Proxy delegates
// anything Element already owns (methods, attrs, IDL) and falls back
// to a named lookup on miss. Cached on the form so identity checks
// (`button.form === form`) hold across multiple reads.
export function formNamedAccess(form) {
  if (form._namedAccessProxy) return form._namedAccessProxy;
  const proxy = new Proxy(form, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string') return target[key];
      for (const f of target.elements || []) {
        if (f._attrs && (f._attrs.name === key || f._attrs.id === key)) return f;
      }
      return undefined;
    }
  });
  form._namedAccessProxy = proxy;
  return proxy;
}

export function setRadio(n) {
  const name = n._attrs.name;
  if (name) {
    // siblings in same form sharing name: clear, then set this one
    const root = ancestorForm(n) || globalThis.document.documentElement;
    const candidates = root && root.querySelectorAll
      ? root.querySelectorAll('input')
      : [];
    for (const o of candidates) {
      if ((o._attrs.type || '').toLowerCase() === 'radio' && o._attrs.name === name) {
        delete o._attrs.checked;
      }
    }
  }
  n._attrs.checked = '';
}
