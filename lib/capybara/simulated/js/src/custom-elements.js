// Custom Elements registry + lifecycle hooks. `ceState.pendingUpgrade`
// is the seam by which `upgradeElement` hands the prototype-swap
// target into the user-supplied constructor — the Element ctor in
// bridge.entry.js reads it and returns the existing element instead
// of allocating a fresh one. ES module live bindings are readonly
// for `let` exports, so the mutable-object indirection is necessary.

import { walk, walkInclShadow, isConnected } from './walk.js';
import { NODE_ELEMENT }             from './constants.js';
import { logThrew }                 from './console.js';
import { parseHtmlNonneg }          from './html-integers.js';

const registry = new Map();
const HTML_NS  = 'http://www.w3.org/1999/xhtml';
// The registered custom-element constructor for `el`, or undefined. Per spec a
// custom element is matched by (HTML namespace + local name), NOT its qualified
// tag — so an XML/XHTML element carrying a namespace prefix (`html:custom-el`,
// localName `custom-el`) still upgrades by its local name. For an element in an
// HTML document `_tag === _localName`, so this is equivalent to the old `_tag`
// lookup there. (shadow-dom/innerHTML-setter.xhtml)
function ceCtorFor(el) {
  return el && el._ns === HTML_NS ? registry.get(el._localName) : undefined;
}
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
    // Match by (HTML namespace + local name), not the qualified tag — a
    // prefixed XML custom element (`html:custom-el`) must upgrade too. Collect
    // first, then upgrade: upgrading mutates the tree the walk traverses.
    const matches = [];
    walk(doc.documentElement, el => { if (ceCtorFor(el) === ctor) matches.push(el); });
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
        const ctor = ceCtorFor(node);
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
export function fireAttrChangedCallback(el, name, oldValue, newValue) {
  if (!el || el.nodeType !== NODE_ELEMENT) return;
  // Only an upgraded custom element has an attributeChangedCallback; plain
  // elements (the hot case — every setAttribute) bail here, BEFORE touching
  // `el.constructor`, which is now a per-tag accessor (dom-class-aliases.js).
  // Upgraded CEs had their prototype swapped to the CE class (upgradeElement),
  // so `el.constructor` is that class and its `observedAttributes` gates.
  const fn = el.attributeChangedCallback;
  if (typeof fn !== 'function') return;
  const ctor = el.constructor;
  const observed = ctor && ctor.observedAttributes;
  if (!observed || observed.indexOf(name) < 0) return;
  try { fn.call(el, name, oldValue, newValue, null); }
  catch (e) { logThrew('attributeChangedCallback', e); }
}

// HTML option "selectedness" model. An option's *selectedness* is
// internal state (`_selectedness`) distinct from the `selected`
// content attribute (`_attrs.selected`, which is `defaultSelected`):
// `.selected` / `:checked` / `select.value` read selectedness, while
// `[selected]` / `defaultSelected` / `:default` read the content
// attribute. They are wired together by the content-attribute change
// steps (an authored `selected`, when the option is not dirty, sets
// selectedness true) and decoupled by the IDL setter / `select_option`
// (which set the dirtiness flag `_dirtySel`). Keeping them separate is
// what lets selectedness survive an option being moved *out* of its
// select (real-browser / WPT moveBefore semantics) and lets a
// freshly-inserted selected option win over the incumbent.

// Initialise an option's selectedness from its authored `selected`
// content attribute exactly once (the parse-time default). Idempotent
// and connection-independent, so the selectedness algorithm can call it
// to be self-sufficient regardless of how the option entered the tree
// (parser connect-walk, innerHTML replace, detached createElement +
// appendChild). The IDL setter / a user pick set `_dirtySel`, after
// which the content attribute no longer drives selectedness.
export function ensureOptionSelInit(o) {
  if (o._selInit !== true) {
    if (o._dirtySel !== true) o._selectedness = o._attrs.selected != null;
    o._selInit = true;
  }
}

// Nearest ancestor `<select>` of `node` (inclusive), walking past
// optgroup / arbitrary wrappers. Returns null when `node` is not in a
// select.
function ownerSelectOf(node) {
  let p = node;
  while (p && p.nodeType === NODE_ELEMENT && p._tag !== 'select') p = p._parent;
  return (p && p._tag === 'select') ? p : null;
}

// HTML "display size" of a `<select>`: the `size` content attribute parsed by
// the shared rules for parsing non-negative integers (./html-integers.js) when
// that succeeds and is positive, otherwise 4 when `multiple` is present and 1
// otherwise. The selectedness algorithm's "select the first option by default"
// step applies only at display size 1 (a dropdown); a list box (size ≥ 2) keeps
// an empty selection. Callers here only consult it for single-selects, so the
// `multiple → 4` branch never actually gates anything, but it keeps the helper
// faithful to the spec definition.
function selectDisplaySize(select) {
  const n = parseHtmlNonneg(select._attrs.size);
  if (n != null && n > 0) return n;
  return select._attrs.multiple != null ? 4 : 1;
}

// HTML "selectedness setting algorithm" for a `<select>`. `justSelected`
// is the option that was just made selected (via insertion of an already
// selected option, or via the IDL setter), excluded from the de-dup pass
// so it wins over the incumbent. With `justSelected` null this is the
// plain reset run on insert / remove / parse.
export function runSelectednessAlgorithm(select, justSelected) {
  if (!select || select._tag !== 'select') return;
  // A multiple-select has no implicit default and no single-selection
  // invariant to maintain, so there is nothing to reconcile — bail before
  // the O(N) option scan so a bulk `option.selected = true` loop over a
  // large multi-select stays O(N) overall (rule 3). Its options are
  // initialised independently (connect walk / finalizeSelectOptions).
  if (select._attrs.multiple != null) return;
  const opts = select.querySelectorAll('option');
  // Self-init every option's selectedness from its content attribute so
  // the algorithm is correct no matter how the options were built (it
  // runs from connect, insert, remove, innerHTML replace, reset, …).
  for (const o of opts) ensureOptionSelInit(o);
  // Step 1: a freshly-selected option in a single-select clears the rest.
  if (justSelected && justSelected._selectedness === true) {
    for (const o of opts) if (o !== justSelected) o._selectedness = false;
  }
  let selected = null, selectedCount = 0;
  for (const o of opts) if (o._selectedness === true) { selected = o; selectedCount++; }
  if (selectedCount === 0) {
    // Step 2: no selection ⇒ first non-disabled option becomes selected — but
    // ONLY when the display size is 1 (a dropdown). A list box (size ≥ 2) keeps
    // an empty selection, matching real browsers. `multiple` is already absent
    // here (bailed at the top), so the display size is 1 iff `size` is
    // absent/invalid or equals 1.
    if (selectDisplaySize(select) === 1) {
      for (const o of opts) { if (o._attrs.disabled == null) { o._selectedness = true; break; } }
    }
  } else if (selectedCount >= 2) {
    // Step 3: keep only the last selected option in tree order. The
    // forward scan above left `selected` pointing at that last match.
    for (const o of opts) if (o._selectedness === true && o !== selected) o._selectedness = false;
  }
}

// Cheap hot-path gate shared by every ask-for-reset entry point: a mutation can
// only affect a <select>'s selectedness when `node` is an option / optgroup, or
// it is being inserted into / removed from a select / optgroup. Everything else
// — the overwhelming majority of element mutations on an Avo-scale page — bails
// here before the O(depth) ancestor walk (rule 3). Either argument may be null.
function affectsSelectedness(node, parent) {
  return !!((node && (node._tag === 'option' || node._tag === 'optgroup')) ||
            (parent && (parent._tag === 'select' || parent._tag === 'optgroup')));
}

// The last selected <option> that `node` contributes to its owning select, in
// tree order: `node` itself when it is a selected option, else the last selected
// option among its descendants (an inserted <optgroup> carrying selected
// options), else null. Initialises each option's selectedness from its content
// attribute first. The option fast path is O(1) and allocation-free (the hot
// single-insert case); only an inserted optgroup pays the descendant scan.
function lastSelectedOption(node) {
  if (node._tag === 'option') { ensureOptionSelInit(node); return node._selectedness === true ? node : null; }
  if (node._tag === 'optgroup') {
    let last = null;
    for (const o of node.querySelectorAll('option')) { ensureOptionSelInit(o); if (o._selectedness === true) last = o; }
    return last;
  }
  return null;
}

// Single-node insertion entry point (insertBefore / appendChild / replaceChild /
// moveBefore): run the owning select's selectedness algorithm. When the inserted
// node contributes a selected option (it IS one, or an inserted optgroup carries
// one) that option is the `justSelected` argument so it wins over the incumbent
// (the rest are cleared) rather than losing the "keep last in tree order"
// tie-break — a just-inserted selected option wins even when placed BEFORE an
// already-selected one (WPT select-validity prepends the placeholder back and
// expects it selected; moveBefore/select-option-optgroup; Avo's
// `reload_belongs_to_field_controller.updateNonSearchable`). For a BATCH of nodes
// inserted at once (a fragment) use `askForResetBatch` instead — see its note on
// why a per-child loop here would let the FIRST win rather than the last.
export function askForReset(child) {
  if (!child || child.nodeType !== NODE_ELEMENT) return;
  const parent = child._parent;
  if (!affectsSelectedness(child, parent)) return;
  const select = ownerSelectOf(parent);
  if (!select) return;
  runSelectednessAlgorithm(select, lastSelectedOption(child));
}

// Batch insertion entry point (a DocumentFragment's children, or a replace's
// node list, inserted in one operation): reconcile the owning select's
// selectedness a SINGLE time. The model is still "a just-inserted selected
// option wins over the incumbent", but for a batch the LAST such option in tree
// order (= insertion order) is the winner — a real browser grafting
// `<option selected>First`,`Second` into a single-select keeps Second. Looping
// `askForReset` per child can't express this: reconciling the first inserted
// option clears the later ones' selectedness before they get their turn, so the
// FIRST would wrongly win (the jQuery `.append(fragment)` WPT case). So gather
// the batch first, pick the last selected option, and reconcile once.
export function askForResetBatch(nodes) {
  if (!nodes || !nodes.length) return;
  const parent = nodes[0]._parent;
  let gated = affectsSelectedness(null, parent);
  if (!gated) { for (const n of nodes) if (affectsSelectedness(n, null)) { gated = true; break; } }
  if (!gated) return;
  const select = ownerSelectOf(parent);
  if (!select) return;
  // The LAST inserted node (tree order) that contributes a selected option wins.
  let justSelected = null;
  for (const n of nodes) { const ls = lastSelectedOption(n); if (ls) justSelected = ls; }
  runSelectednessAlgorithm(select, justSelected);
}

// Removal entry point: an option leaving a select can drop its selection
// to zero, so the former select re-runs the algorithm and picks a new
// default. `removedChild` is the detached node, `formerParent` the node it
// left — together they gate the ancestor walk cheaply.
export function askForResetAfterRemoval(removedChild, formerParent) {
  if (!formerParent) return;
  if (!affectsSelectedness(removedChild, formerParent)) return;
  const select = ownerSelectOf(formerParent);
  if (select) runSelectednessAlgorithm(select, null);
}

// Finalize a select whose options were (re)built outside the insert hooks
// and connect walk (`select.innerHTML = …`, `replaceChildren`). Unlike the
// reconcile-only algorithm, this also initialises every option's
// selectedness from its content attribute — necessary for a multiple-select
// (which the algorithm skips), and harmless/idempotent for a single one.
export function finalizeSelectOptions(select) {
  if (!select || select._tag !== 'select') return;
  for (const o of select.querySelectorAll('option')) ensureOptionSelInit(o);
  runSelectednessAlgorithm(select, null);
}

// Upgrade-only walk (no connectedCallback) — used by
// `Document.importNode` to upgrade elements that were inert in
// `<template>.content`. Connection happens later when they're
// appended to the live tree.
export function ceUpgradeTree(subtree) {
  walk(subtree, el => {
    const ctor = ceCtorFor(el);
    if (!ctor) return;
    if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
  });
}

// CE side of fireCEConnect's per-element walk: upgrade if pending,
// then fire `connectedCallback`. Script and `<link>` handling stays
// in bridge.entry.js because both need closure state
// (`__inHTMLGrafting`, `__initialScriptsDone`) the IIFE owns.
export function ceTryConnect(el) {
  const ctor = ceCtorFor(el);
  if (!ctor) return;
  if (Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
  fireCEHook(el, 'connectedCallback');
}

export function fireCEDisconnect(subtree) {
  // `walkInclShadow` so a removed host's shadow-tree custom elements get
  // disconnectedCallback — balancing the shadow-aware connect walk (fireCEConnect
  // → walkInclShadow). A light-tree-only walk here would leave a shadow CE that
  // received connectedCallback never disconnected.
  walkInclShadow(subtree, el => {
    if (ceCtorFor(el)) fireCEHook(el, 'disconnectedCallback');
  });
}

// CE reactions for an atomic move (`moveBefore`) of a CONNECTED subtree. Walked
// per element in tree order (HTML "Reactions to atomic move are called in order
// of element, not in order of operation"): an element that defines
// `connectedMoveCallback` gets ONLY that; otherwise it falls back to the legacy
// `disconnectedCallback` + `connectedCallback` pair. The element never leaves
// the tree during the move, so `isConnected` stays true throughout both hooks.
// `walkInclShadow` keeps shadow-resident CEs in sync with the connect/disconnect
// walks (which are also shadow-aware).
export function fireCEMoveReactions(subtree) {
  walkInclShadow(subtree, el => {
    if (!ceCtorFor(el)) return;
    if (typeof el.connectedMoveCallback === 'function') {
      fireCEHook(el, 'connectedMoveCallback');
    } else {
      fireCEHook(el, 'disconnectedCallback');
      fireCEHook(el, 'connectedCallback');
    }
  });
}

globalThis.customElements = customElements;
