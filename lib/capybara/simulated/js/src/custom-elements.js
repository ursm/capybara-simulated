// Custom Elements registry + lifecycle hooks. `ceState.pendingUpgrade`
// is the seam by which `upgradeElement` hands the prototype-swap
// target into the user-supplied constructor — the Element ctor in
// bridge.entry.js reads it and returns the existing element instead
// of allocating a fresh one. ES module live bindings are readonly
// for `let` exports, so the mutable-object indirection is necessary.

import { walk, isConnected } from './walk.js';
import { NODE_ELEMENT }             from './constants.js';
import { logThrew }                 from './console.js';

const registry = new Map();
// Pending whenDefined() promises: tag -> [resolve(ctor), ...].
// `define()` resolves them when the tag's constructor is registered,
// so apps awaiting `customElements.whenDefined('my-tag')` before
// reading from the element get woken when the registry settles.
const pendingWhenDefined = new Map();
export const ceState = { pendingUpgrade: null };

export const customElements = {
  define(tag, ctor) {
    const t = String(tag).toLowerCase();
    if (registry.has(t)) return;
    registry.set(t, ctor);
    const waiters = pendingWhenDefined.get(t);
    if (waiters) {
      pendingWhenDefined.delete(t);
      for (const resolve of waiters) {
        try { resolve(ctor); } catch (_) {}
      }
    }
    const doc = globalThis.document;
    if (!doc || !doc.documentElement) return;
    const matches = doc.documentElement.querySelectorAll(t);
    for (const el of matches) {
      upgradeElement(el, ctor);
      if (isConnected(el)) fireCEHook(el, 'connectedCallback');
    }
  },
  get(tag) { return registry.get(String(tag).toLowerCase()) || undefined; },
  // Spec: resolves with the constructor when the tag is defined.
  // Apps `await customElements.whenDefined(tag)` before reading
  // from elements that haven't upgraded yet.
  whenDefined(tag) {
    const t   = String(tag).toLowerCase();
    const ctor = registry.get(t);
    if (ctor) return Promise.resolve(ctor);
    return new Promise(resolve => {
      const list = pendingWhenDefined.get(t) || [];
      list.push(resolve);
      pendingWhenDefined.set(t, list);
    });
  },
  // Spec: walks the subtree of `node` and upgrades any element whose
  // tag has a registered constructor but hasn't been upgraded yet.
  // Lit / Stencil flows that build elements off-document and then
  // call `customElements.upgrade(fragment)` before attaching depend
  // on it.
  upgrade(root) {
    if (!root || typeof root._children === 'undefined') return;
    const walk = (node) => {
      if (node && node.nodeType === 1) {
        const ctor = registry.get(node._tag);
        if (ctor && Object.getPrototypeOf(node) !== ctor.prototype) {
          upgradeElement(node, ctor);
        }
      }
      if (node && node._children) for (const c of node._children) walk(c);
    };
    walk(root);
  }
};

export function getCustomElementCtor(tag) {
  return registry.get(tag);
}

export function upgradeElement(el, ctor) {
  if (Object.getPrototypeOf(el) === ctor.prototype) return;
  ceState.pendingUpgrade = el;
  try {
    Reflect.construct(ctor, [], ctor);
  } catch (e) {
    logThrew('custom element constructor', e);
    try { Object.setPrototypeOf(el, ctor.prototype); } catch (_) {}
  } finally {
    ceState.pendingUpgrade = null;
  }
  // Per the CE spec, after upgrading, fire `attributeChangedCallback`
  // once per observed attribute already present on the element with
  // `oldValue = null` — so a parsed `<turbo-frame src="…">` sees its
  // `src` change from null to the attribute value and the
  // FrameController kicks off the load.
  const observed = ctor.observedAttributes;
  const fn = el.attributeChangedCallback;
  if (observed && observed.length && typeof fn === 'function') {
    for (const name of observed) {
      if (Object.prototype.hasOwnProperty.call(el._attrs, name)) {
        try { fn.call(el, name, null, el._attrs[name], null); }
        catch (e) { logThrew('attributeChangedCallback (upgrade)', e); }
      }
    }
  }
}

export function fireCEHook(el, hookName) {
  try {
    const fn = el[hookName];
    if (typeof fn === 'function') fn.call(el);
  } catch (e) {
    logThrew('custom element ' + hookName, e);
  }
}

// `attributeChangedCallback(name, oldValue, newValue, namespace)`
// for custom elements per the CE spec. Gated on the element's class
// declaring an `observedAttributes` array so non-CE elements (and
// CEs that opted out) pay nothing. Turbo's `FrameElement` observes
// `loading` / `src` / `disabled` / `complete` / `busy`; setting
// `frame.src = url` would otherwise mutate the attribute but never
// dispatch the chain that issues the fetch.
export function fireAttrChangedCallback(el, name, oldValue, newValue, ElementCtor) {
  if (!el || el.nodeType !== NODE_ELEMENT) return;
  const ctor = el.constructor;
  if (!ctor || ctor === ElementCtor) return;
  const observed = ctor.observedAttributes;
  if (!observed || observed.indexOf(name) < 0) return;
  const fn = el.attributeChangedCallback;
  if (typeof fn !== 'function') return;
  try { fn.call(el, name, oldValue, newValue, null); }
  catch (e) { logThrew('attributeChangedCallback', e); }
}

// HTML spec "ask for a reset" — when an option (or an optgroup
// containing options) is inserted into a single-select `<select>`,
// any pre-existing options whose selectedness is true get cleared
// so only the last selected option in tree order wins. Avo's
// `reload_belongs_to_field_controller.updateNonSearchable` builds
// a new `<option selected>` and appends it to a `<select>` whose
// current option also has `selected=""`; without the reset both
// come back from `selectedOptions` and `have_select(selected: ...)`
// reports two matches. The setter at `option.selected = true`
// already clears siblings when the option *has* a parent select,
// but `selected` set before `appendChild` runs against a detached
// option and can't reach into the target select.
export function askForReset(child) {
  if (!child || child.nodeType !== NODE_ELEMENT) return;
  const t = child._tag;
  if (t === 'option') {
    if (child._attrs.selected == null) return;
  } else if (t === 'optgroup') {
    let any = false;
    for (const o of child._children) {
      if (o.nodeType === NODE_ELEMENT && o._tag === 'option' && o._attrs.selected != null) {
        any = true; break;
      }
    }
    if (!any) return;
  } else {
    return;
  }
  let p = child._parent;
  while (p && p.nodeType === NODE_ELEMENT && p._tag !== 'select') p = p._parent;
  if (!p || p._tag !== 'select') return;
  if (p._attrs.multiple != null) return;
  const opts = p.querySelectorAll('option');
  let last = null;
  for (const o of opts) if (o._attrs.selected != null) last = o;
  if (!last) return;
  for (const o of opts) if (o !== last) delete o._attrs.selected;
}

// Upgrade-only walk (no connectedCallback) — used by
// `Document.importNode` to upgrade elements that were inert in
// `<template>.content`. Connection happens later when they're
// appended to the live tree.
export function ceUpgradeTree(subtree) {
  walk(subtree, el => {
    const ctor = registry.get(el._tag);
    if (!ctor) return;
    if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
  });
}

// CE side of fireCEConnect's per-element walk: upgrade if pending,
// then fire `connectedCallback`. Script and `<link>` handling stays
// in bridge.entry.js because both need closure state
// (`__inHTMLGrafting`, `__initialScriptsDone`) the IIFE owns.
export function ceTryConnect(el) {
  const ctor = registry.get(el._tag);
  if (!ctor) return;
  if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
  fireCEHook(el, 'connectedCallback');
}

export function fireCEDisconnect(subtree) {
  walk(subtree, el => {
    if (registry.has(el._tag)) fireCEHook(el, 'disconnectedCallback');
  });
}

globalThis.customElements = customElements;
