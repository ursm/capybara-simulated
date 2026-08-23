// Custom Elements registry + lifecycle hooks. `ceState.pendingUpgrade`
// is the seam by which `upgradeElement` hands the prototype-swap
// target into the user-supplied constructor — the Element ctor in
// bridge.entry.js reads it and returns the existing element instead
// of allocating a fresh one. ES module live bindings are readonly
// for `let` exports, so the mutable-object indirection is necessary.

import { setSelectedness } from './form-helpers.js';
import { walk, walkInclShadow, isConnected } from './walk.js';
import { bumpStyleState } from './mutation-observer.js';
import { NODE_ELEMENT }             from './constants.js';
import { logThrew }                 from './console.js';
import { parseHtmlNonneg }          from './html-integers.js';
import { isKnownHtmlElementName }   from './html-element-names.js';

const HTML_NS  = 'http://www.w3.org/1999/xhtml';
// Custom element definitions live PER CustomElementRegistry instance (`this._defs`
// etc.); the global `customElements` is one such instance. An element resolves
// definitions through its ASSOCIATED registry — its `_ceRegistry` if it was created
// in a scoped shadow tree / document, otherwise the global one.
let totalDefinitions = 0;   // count across ALL registries — the cheap gate for upgrade walks
// Any customized built-in (`customElements.define(name, ctor, {extends})`) defined,
// in any registry. The gate for reading an element's `is` value in ceCtorFor: a page
// with only autonomous custom elements (the common case) never pays it (rule 3).
let anyBuiltinCE = false;
// Constructor → its definition, across EVERY registry (global + scoped). The HTML
// constructor's sanity checks (dom-class-aliases.js) look a NewTarget up here to decide
// whether it's a defined custom element and which built-in interface it must extend —
// registry-agnostic, because a scoped-registry element still constructs through the
// same interface constructor. A constructor is registered in at most one registry per
// name; the last definition wins (the interface it validates against is the same).
const ctorToDef = new WeakMap();
// The definition a constructor was registered with, in any registry, or undefined.
export function ctorDefinition(ctor) {
  return (ctor === null || (typeof ctor !== 'function' && typeof ctor !== 'object')) ? undefined : ctorToDef.get(ctor);
}
// Whether ANY registry holds a definition for `ctor` (backs the Element
// constructor's scoped-only rejection: new-able only via the global registry).
export function ctorHasAnyDefinition(ctor) {
  return ctorDefinition(ctor) !== undefined;
}
// TEMPLATE-content tracking null: elements parsed into a <template>'s content
// live (spec-wise) in the template-contents owner document, whose registry is
// null — but unlike the STICKY null of the customelementregistry attribute,
// this null RE-POINTS when the element reaches a real tree (connection into the
// live document, adoption, importNode). Our template content shares the main
// document object, so the state rides a sentinel slot value instead of an
// owner-document difference.
export const TRACKING_NULL = Symbol('template-tracking-null-registry');
// A DOCUMENT's registry: the realm's live document (and only it) defaults to the
// global registry; a document without a browsing context (new Document /
// createHTMLDocument / createDocument / DOMParser output) defaults to the NULL
// registry, until a scoped registry's initialize() associates one (`_ceRegistry`).
// A document's WINDOW registry: its realm's global registry for a live
// (browsing-context) document, null for an inert one. This — never the
// initialize()d association below — is what an element in the UNSET state
// tracks, and what a non-scoped registry re-points to on adoption: a scoped
// initialize() on an inert document associates new CREATIONS with the scoped
// registry, but adopted-in default elements still land on null.
export function windowRegistryOf(doc) {
  if (!doc) return customElements;   // ownerless node — pre-feature global fallback
  // The inert check comes FIRST: createHtmlPageDocument stamps every document it
  // builds (some end up inert — DOMParser flips the flag after construction).
  if (doc._noBrowsingContext) return null;
  // The stamp makes a CROSS-REALM read (the top page asking about a frame's
  // document) resolve the FRAME's registry, which `doc === globalThis.document`
  // can't from another realm.
  if (doc._ceDefaultRegistry) return doc._ceDefaultRegistry;
  return doc === globalThis.document ? customElements : null;
}
// The document's ACTIVE registry — the initialize()d association when one
// exists, else the window registry. Backs document.customElementRegistry and
// the registry newly-created elements get.
export function documentRegistry(doc) {
  if (!doc) return customElements;
  const r = doc._ceRegistry;
  return r !== undefined ? r : windowRegistryOf(doc);
}
// An element's associated registry: `_ceRegistry` unset (the common case, no
// per-element field) TRACKS THE NODE DOCUMENT — that is what makes cross-document
// adoption re-point a global-registry element for free; an explicit scoped
// registry is pinned; `null` is the "null registry" state (an upgrade candidate
// that never matches a definition).
export function registryForElement(el) {
  const r = el && el._ceRegistry;
  if (r !== undefined) return r === TRACKING_NULL ? null : r;
  // FAST PATH (rule 3 — this runs per element on every connect/disconnect
  // walk): a live-tree element carries `_ownerDoc === null` (the ownerDocument
  // getter's fallback IS the live document), so the common case is one slot
  // read + null check — no doc-proxy property traffic.
  const d = el && (el.nodeType === 9 ? el : el._ownerDoc);
  if (d == null || d === globalThis.document) return customElements;
  return windowRegistryOf(d);
}
// An element's "is value": the customized built-in name it was created with. Set as
// the `_isValue` slot by createElement({is}); a PARSED / CLONED customized built-in
// carries it on the `is` content attribute instead (copied on clone), so fall back to
// that. Only read when a customized built-in exists (anyBuiltinCE) — otherwise the `is`
// attribute is inert and this stays undefined.
function isValueOf(el) {
  if (el._isValue != null) return el._isValue;
  const a = el._attrs;
  return a && a.is != null ? a.is : undefined;
}
// HTML "look up a custom element definition" (returning the constructor) for `registry`
// given a local name and is value. Autonomous match: a definition NAMED localName whose
// own local name equals its name. Customized-built-in match: a definition whose local
// name is localName and whose name is the element's is value. A null registry matches
// nothing.
function lookupDefinitionCtor(registry, localName, isValue) {
  if (!registry) return undefined;
  const d = registry._defs.get(localName);
  if (d !== undefined && d.localName === d.name) return d.ctor;   // autonomous
  if (isValue != null) {
    const m = registry._builtins.get(localName);
    if (m !== undefined) { const bd = m.get(String(isValue)); if (bd !== undefined) return bd.ctor; }
  }
  return undefined;
}
// The registered custom-element constructor for `el`, or undefined. Per spec a
// custom element is matched by (HTML namespace + local name + is value), NOT its
// qualified tag — so an XML/XHTML element carrying a namespace prefix
// (`html:custom-el`, localName `custom-el`) still upgrades by its local name. For an
// element in an HTML document `_tag === _localName`, so this is equivalent to the old
// `_tag` lookup there. (shadow-dom/innerHTML-setter.xhtml)
export function ceCtorFor(el) {
  if (!el || el._ns !== HTML_NS) return undefined;
  return lookupDefinitionCtor(registryForElement(el), el._localName, anyBuiltinCE ? isValueOf(el) : undefined);
}

// CSS `:defined` — an element matches UNLESS it is a custom element in the
// "undefined" (or "failed") state. A plain built-in (no is value, non-CE local
// name) and any foreign (non-HTML) element are always defined; an autonomous CE
// name, or any element carrying an is value, is defined only once it has upgraded to
// its definition's prototype.
export function elementIsDefined(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  if (el._ns !== HTML_NS) return true;
  const isValue = isValueOf(el);
  const ln = el._localName;
  const autonomousName = ln.indexOf('-') !== -1 && isValidCustomElementName(ln);
  if (!autonomousName && isValue == null) return true;   // plain built-in element
  const ctor = ceCtorFor(el);
  return ctor !== undefined && Object.getPrototypeOf(el) === ctor.prototype;
}
// Each registry keeps a reverse index (constructor → name) too, backing getName()
// and the "constructor already used" define() guard. The SAME constructor may be
// defined in more than one registry (under possibly different names), so this is
// per-instance, not global; customElementLocalName (the direct-`new MyCE()` path)
// reads the GLOBAL registry's index. (define() also COLLECTS the lifecycle callbacks
// / observedAttributes / form-association from the constructor, but doesn't persist
// them — the runtime re-reads those live at upgrade / attribute-change time; the
// collection exists for its spec-mandated validation + rethrow side effects.)
// Constructors whose static `formAssociated` is true, snapshotted at define time so
// the form-membership + form-owner-reset hot paths never re-invoke the (observable,
// user-defined) getter. `anyFormAssociatedCE` flips once any form-associated element
// is defined, so a page that defines none short-circuits every gate to O(1) (rule 3).
const formAssociatedCtors = new WeakSet();
let   anyFormAssociatedCE = false;
// The defined form-associated local names, as a selector fragment. HTML's "construct
// the entry list" walks the submittable elements in TREE ORDER; a form-associated
// custom element is submittable, so the walk's selector has to name it. Appending the
// names to the built-in selector keeps that walk a SINGLE ordered querySelectorAll
// instead of a second pass that would then need re-sorting (rule 3). Empty — so the
// selector is untouched — until a form-associated element is defined.
const formAssociatedNames = [];
export function formAssociatedTagSelector() { return formAssociatedNames.join(','); }
// Reconciles a form-associated custom element's owner + disabled state (firing
// formAssociatedCallback / formDisabledCallback on a change), injected from
// dom-nodes.js (it owns `formForControl` + `isNodeActuallyDisabled` + the form-name
// registry). Called at every seam where either can change from within this module —
// upgrade, connection, disconnection; dom-nodes drives the attribute-change seams
// (`form`/`id`/`disabled`, and a `<fieldset>`'s `disabled`) directly. Mirrors
// setScopeFormOwnerResolver.
let formAssociatedReset = null;
export function setFormAssociatedReset(fn) { formAssociatedReset = fn; }
// True once any form-associated custom element has been defined — the cheap gate for
// dom-nodes's form-membership walks and the <form> `id`-change fan-out.
export function hasFormAssociatedCustomElements() { return anyFormAssociatedCE; }
// Is `el` an autonomous custom element whose definition is form-associated? O(1): the
// module flag, then an HTML-namespace + registry-membership check (no getter call).
export function isFormAssociatedCustomElement(el) {
  if (!anyFormAssociatedCE || !el || el._ns !== HTML_NS) return false;
  const ctor = ceCtorFor(el);
  return ctor !== undefined && formAssociatedCtors.has(ctor);
}
export const ceState = { pendingUpgrade: null };

// The lifecycle callbacks define() reads off the prototype, IN ORDER. We support
// moveBefore, so `connectedMoveCallback` is in the set (between disconnected and
// adopted), matching what a real browser with atomic-move support collects.
const LIFECYCLE_CALLBACKS = ['connectedCallback', 'disconnectedCallback', 'connectedMoveCallback', 'adoptedCallback', 'attributeChangedCallback'];
const FORM_CALLBACKS      = ['formAssociatedCallback', 'formResetCallback', 'formDisabledCallback', 'formStateRestoreCallback'];

// A "valid custom element name" (HTML): a valid element local name whose first code
// point is an ASCII lower alpha, containing no ASCII upper alpha and at least one
// U+002D (-), excluding the eight reserved SVG/MathML hyphenated names. The HTML spec
// relaxed the old PotentialCustomElementName production (specific Unicode ranges) to a
// "valid element local name" -- a leading ASCII letter followed by any code point
// except NULL / ASCII whitespace / '/' / '>' -- so e.g. "a-" plus a control char is
// now valid. (The full production also allows a leading ':' / '_' / non-ASCII code
// point, but a custom element name always starts with an ASCII lower alpha, so only
// this alternative can apply; the leading-lower / no-upper-alpha checks are in the loop.)
const VALID_ELEMENT_LOCAL_NAME_RE = /^[A-Za-z][^\0\t\n\f\r />]*$/u;
const RESERVED_CE_NAMES = new Set([
  'annotation-xml', 'color-profile', 'font-face', 'font-face-src',
  'font-face-uri', 'font-face-format', 'font-face-name', 'missing-glyph'
]);
export function isValidCustomElementName(name) {
  if (!name || !name.includes('-') || RESERVED_CE_NAMES.has(name)) return false;
  let first = true;
  for (const c of name) {
    const cp = c.codePointAt(0);
    if (first) {
      if (cp < 0x61 || cp > 0x7a) return false;   // must start with an ASCII lower alpha
      first = false;
    }
    if (cp >= 0x41 && cp <= 0x5a) return false;    // no ASCII upper alpha anywhere
  }
  return VALID_ELEMENT_LOCAL_NAME_RE.test(name);
}

// IsConstructor(fn): does `fn` have a [[Construct]] slot? Reflect.construct
// validates newTarget (`fn`) is a constructor at step 2 — BEFORE the target is
// constructed — so a target whose [[Construct]] is a Proxy trap that returns
// early never runs OrdinaryCreateFromConstructor and so never reads `fn.prototype`.
// (A plain `Reflect.construct(String, [], fn)` WOULD read `fn.prototype` as the
// newTarget's prototype, adding a spurious "prototype" Get that define()'s
// property-access-order test counts.)
const CONSTRUCT_PROBE = new Proxy(function () {}, { construct: () => ({}) });
function isConstructor(fn) {
  if (typeof fn !== 'function') return false;
  try { Reflect.construct(CONSTRUCT_PROBE, [], fn); return true; }
  catch (_) { return false; }
}

// WebIDL sequence<DOMString> conversion, faithful about WHERE it can throw so
// define()'s "rethrow" subtests pass: retrieving Symbol.iterator, stepping the
// iterator, and stringifying each value are all observable failure points.
function toSequenceDOMString(value) {
  const method = value == null ? undefined : value[Symbol.iterator];
  if (typeof method !== 'function') throw new TypeError('The value is not iterable.');
  const iterator = method.call(value);
  const out = [];
  while (true) {
    const step = iterator.next();
    if (step.done) break;
    out.push(String(step.value));
  }
  return out;
}

// Resolve a registry's pending whenDefined() promise for a freshly-defined name, then
// drop the entry: once the name is defined, whenDefined() returns a NEW resolved
// promise each call (spec), so nothing more should read the cached pending one.
function resolveWhenDefined(reg, name, ctor) {
  const entry = reg._whenDefined.get(name);
  if (entry) { entry.resolve(ctor); reg._whenDefined.delete(name); }
}

class CustomElementRegistry {
  constructor() {
    this._scoped = true;         // author-constructed registries are scoped; the module's global one is flipped below
    this._defs = new Map();          // name -> definition { name, ctor, localName }
    this._ctorToName = new Map();    // constructor -> name (this registry's reverse index)
    this._builtins = new Map();      // extends-local-name -> Map(name -> definition), customized built-ins only
    this._whenDefined = new Map();   // name -> { promise, resolve } for not-yet-defined names
    this._defRunning = false;        // HTML "element definition is running" flag (per registry)
  }

  // HTML "CustomElementRegistry.define(name, constructor, options)". The step
  // ORDER is observable (WPT asserts IsConstructor and name validity are checked
  // BEFORE the definition-running flag), so keep it: IsConstructor → valid name →
  // duplicate name → duplicate constructor → resolve `extends` → running-flag →
  // collect from the constructor under the flag → store → upgrade → resolve whenDefined.
  define(name, constructor, options) {
    const n = String(name);
    if (!isConstructor(constructor)) {
      throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': the provided constructor is not a constructor.");
    }
    if (!isValidCustomElementName(n)) {
      throw new DOMException(`Failed to execute 'define' on 'CustomElementRegistry': "${n}" is not a valid custom element name.`, 'SyntaxError');
    }
    if (this._defs.has(n)) {
      throw new DOMException(`Failed to execute 'define' on 'CustomElementRegistry': the name "${n}" has already been used with this registry.`, 'NotSupportedError');
    }
    if (this._ctorToName.has(constructor)) {
      throw new DOMException("Failed to execute 'define' on 'CustomElementRegistry': the constructor has already been used with this registry.", 'NotSupportedError');
    }
    // `options.extends` names the built-in element this is a customized built-in of.
    // The definition's local name becomes `extends` (so `<button is="my-button">`
    // matches, not `<my-button>`). `extends` must NOT itself be a valid custom
    // element name (can't customize a custom element) and MUST name a real built-in
    // (its interface is not HTMLUnknownElement) — both NotSupportedError.
    let localName = n;
    const extendsName = options != null && options.extends != null ? String(options.extends) : null;
    if (extendsName !== null) {
      if (isValidCustomElementName(extendsName)) {
        throw new DOMException(`Failed to execute 'define' on 'CustomElementRegistry': "${extendsName}" is a valid custom element name, so it cannot be extended.`, 'NotSupportedError');
      }
      if (!isKnownHtmlElementName(extendsName)) {
        throw new DOMException(`Failed to execute 'define' on 'CustomElementRegistry': "${extendsName}" is not a valid local name for a customized built-in element.`, 'NotSupportedError');
      }
      localName = extendsName;
    }
    if (this._defRunning) {
      throw new DOMException("Failed to execute 'define' on 'CustomElementRegistry': an element definition is already running.", 'NotSupportedError');
    }
    // Collect from the constructor under the running flag. The values are validated
    // (and getter / iterator / conversion errors rethrown, per the define() "must
    // rethrow…" subtests) but not persisted — see the ctorToName note above.
    let hasAttributeChangedCallback = false;
    let formAssociated = false;
    this._defRunning = true;
    try {
      const prototype = constructor.prototype;
      if (prototype === null || (typeof prototype !== 'object' && typeof prototype !== 'function')) {
        throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': the constructor's prototype property is not an object.");
      }
      for (const cb of LIFECYCLE_CALLBACKS) {
        const v = prototype[cb];
        if (v !== undefined && typeof v !== 'function') {
          throw new TypeError(`Failed to execute 'define' on 'CustomElementRegistry': the '${cb}' callback is not callable.`);
        }
        if (cb === 'attributeChangedCallback' && typeof v === 'function') hasAttributeChangedCallback = true;
      }
      // observedAttributes / disabledFeatures / formAssociated are STATIC — read
      // off the constructor, not the prototype (observedAttributes only when an
      // attributeChangedCallback exists to receive the notifications).
      if (hasAttributeChangedCallback) {
        const oa = constructor.observedAttributes;
        if (oa !== undefined) toSequenceDOMString(oa);
      }
      const df = constructor.disabledFeatures;
      if (df !== undefined) toSequenceDOMString(df);
      formAssociated = Boolean(constructor.formAssociated);
      if (formAssociated) {
        for (const cb of FORM_CALLBACKS) {
          const v = prototype[cb];
          if (v !== undefined && typeof v !== 'function') {
            throw new TypeError(`Failed to execute 'define' on 'CustomElementRegistry': the '${cb}' callback is not callable.`);
          }
        }
      }
    } finally {
      this._defRunning = false;
    }
    const def = { name: n, ctor: constructor, localName };
    this._defs.set(n, def);
    // `:defined` flips for every existing element of this name — a dynamic pseudo-class, so no
    // cached cascade result depends on it (taint); what this moves is the scoped layout sweep
    // (`__csimApplyScopedStateDirty`), since nothing else changes for a definition (no attribute,
    // no DOM change).
    bumpStyleState();
    this._ctorToName.set(constructor, n);
    ctorToDef.set(constructor, def);   // cross-registry index for the HTML constructor's checks
    totalDefinitions++;
    if (localName !== n) {
      // Customized built-in: also index it by the extended local name so
      // `<extends is="name">` elements resolve to it.
      anyBuiltinCE = true;
      let m = this._builtins.get(localName);
      if (m === undefined) { m = new Map(); this._builtins.set(localName, m); }
      m.set(n, def);
    }
    if (formAssociated) {
      formAssociatedCtors.add(constructor);
      anyFormAssociatedCE = true;
      // Form-associatedness is registry state that a STATIC pseudo-class reads: `:disabled` /
      // `:enabled` start matching every existing element of this name (its `disabled` attribute
      // was inert until now). Nothing on the element or its ancestors moved, and a `:disabled`
      // rule is not tainted — so this is a rule-set-shaped change for the memos: move the version.
      if (globalThis.__csimBumpCascadeVersion) globalThis.__csimBumpCascadeVersion();
      // A valid custom element name may hold selector metacharacters (`.` and `·` are
      // both legal in PotentialCustomElementName), so serialise it as an identifier
      // rather than splicing the raw name into the selector.
      formAssociatedNames.push((globalThis.CSS && globalThis.CSS.escape) ? globalThis.CSS.escape(n) : n);
    }
    // Upgrade existing matches by (HTML namespace + local name) — a prefixed XML
    // custom element (`html:custom-el`) must upgrade too. Collect first, then
    // upgrade: upgrading mutates the tree the walk traverses.
    const doc = globalThis.document;
    if (doc && doc.documentElement) {
      // Shadow-including tree order (HTML "upgrade candidates") so a host and its
      // shadow-resident matches upgrade in document order.
      const matches = [];
      walkInclShadow(doc.documentElement, el => { if (ceCtorFor(el) === constructor) matches.push(el); });
      for (const el of matches) {
        upgradeElement(el, constructor);
        if (isConnected(el)) fireCEHook(el, 'connectedCallback');
      }
    }
    resolveWhenDefined(this, n, constructor);
  }

  get(name) { const d = this._defs.get(String(name)); return d ? d.ctor : undefined; }

  // HTML "CustomElementRegistry.getName(constructor)": the name a constructor was
  // registered under, or null.
  getName(constructor) {
    const n = this._ctorToName.get(constructor);
    return n === undefined ? null : n;
  }

  // Spec: resolves with the constructor when the name is defined; rejects for a
  // name that isn't a valid custom element name. Apps `await
  // customElements.whenDefined(tag)` before reading from not-yet-upgraded elements.
  whenDefined(name) {
    const n = String(name);
    if (!isValidCustomElementName(n)) {
      return Promise.reject(new DOMException(`Failed to execute 'whenDefined' on 'CustomElementRegistry': "${n}" is not a valid custom element name.`, 'SyntaxError'));
    }
    // Already defined → a fresh resolved promise each call. Only a not-yet-defined
    // name gets the stored, shared promise (so repeated calls return the same one).
    const d = this._defs.get(n);
    if (d) return Promise.resolve(d.ctor);
    let entry = this._whenDefined.get(n);
    if (!entry) {
      let resolve;
      const promise = new Promise(res => { resolve = res; });
      entry = { promise, resolve };
      this._whenDefined.set(n, entry);
    }
    return entry.promise;
  }

  // HTML "CustomElementRegistry.initialize(root)": associate this registry with a
  // subtree in the NULL-registry state — the escape hatch that makes a declarative
  // `shadowrootcustomelementregistry` tree (or an inert document's content)
  // usable. Only nodes whose registry currently resolves to null are claimed: the
  // root (a Document / ShadowRoot gets its own association) and its SAME-SCOPE
  // descendant elements (never descending into nested shadow trees — each root is
  // initialized separately). Elements already associated keep their registry.
  initialize(root) {
    if (root == null || typeof root.nodeType !== 'number') return;
    if (!this._scoped && root.nodeType === 9) {
      throw new DOMException("Failed to execute 'initialize' on 'CustomElementRegistry': a non-scoped registry cannot initialize a document.", 'NotSupportedError');
    }
    // A root already associated with a DIFFERENT registry makes the whole call a
    // no-op; a root associated with THIS registry skips claiming but still runs
    // the upgrade pass below (initialize doubles as "upgrade my disconnected
    // candidates" for already-associated subtrees).
    const rootReg = root.nodeType === 1 ? registryForElement(root) : (root.customElementRegistry !== undefined ? root.customElementRegistry : null);
    if (rootReg !== null && rootReg !== this) return;
    const claim = (n) => { if (registryForElement(n) === null) n._ceRegistry = this; };
    if (root.nodeType === 9) {
      if (documentRegistry(root) === null) root._ceRegistry = this;
    } else if (root._isShadowRoot) {
      if (root.customElementRegistry === null) root._ceRegistry = this;
    } else if (root.nodeType === 1) {
      claim(root);
    }
    const walkScope = (node) => {
      const ch = node._children;
      if (!ch) return;
      for (const child of ch) {
        if (child.nodeType === 1) { claim(child); walkScope(child); }
      }
    };
    walkScope(root);
    // Then upgrade, synchronously in tree order, every element in scope now
    // associated with THIS registry that matches one of its definitions —
    // including elements associated before this call (initialize is also the
    // "upgrade my disconnected candidates" entry point; a scoped define() only
    // auto-upgrades CONNECTED candidates via the document sweep).
    const candidates = [];
    const collect = (n) => {
      if (n.nodeType === 1 && n._ceRegistry === this) candidates.push(n);
      const ch = n._children;
      if (ch) for (const child of ch) collect(child);
    };
    collect(root);
    for (const el of candidates) {
      const ctor = ceCtorFor(el);
      if (ctor && Object.getPrototypeOf(el) !== ctor.prototype) {
        upgradeElement(el, ctor);
        if (isConnected(el)) fireCEHook(el, 'connectedCallback');
      }
    }
  }

  // Spec: walk `root`'s subtree and upgrade any element whose name has a
  // registered constructor but hasn't upgraded yet. Lit / Stencil flows that build
  // elements off-document then call `customElements.upgrade(fragment)` before
  // attaching depend on it.
  upgrade(root) {
    if (!root || typeof root._children === 'undefined') return;
    const walkTree = (node) => {
      if (node && node.nodeType === 1) {
        const ctor = ceCtorFor(node);
        if (ctor && Object.getPrototypeOf(node) !== ctor.prototype) {
          upgradeElement(node, ctor);
        }
        // Shadow-including descendants + template contents (HTML "upgrade
        // candidates" of root's shadow-including inclusive descendants).
        if (node._shadowRoot) walkTree(node._shadowRoot);
        if (node._templateContent) walkTree(node._templateContent);
      }
      if (node && node._children) for (const c of node._children) walkTree(c);
    };
    walkTree(root);
  }

  get [Symbol.toStringTag]() { return 'CustomElementRegistry'; }
}

export const customElements = new CustomElementRegistry();
// The ONE non-scoped registry (HTML: the window's registry). `initialize` refuses
// documents for it, and adoption re-points elements associated with it.
customElements._scoped = false;

// The AUTONOMOUS constructor registered under global-registry name `tag`, or
// undefined. Callers pass a name (an autonomous CE's local name, or a customized
// built-in's is value) and want that named definition's constructor — attachShadow's
// disabledFeatures probe (by local name / is value) and attachInternals (autonomous
// local name). Customized-built-in element MATCHING (by local name + is value) goes
// through `lookupCEDefinitionCtor` / `ceCtorFor` instead.
export function getCustomElementCtor(tag) {
  const d = customElements._defs.get(tag);
  return d ? d.ctor : undefined;
}

// HTML "look up a custom element definition" (returning the constructor) for a
// registry given a local name and is value — the create-time counterpart of
// `ceCtorFor` (which reads the pair off an existing element). `_createElement` uses
// it for an element whose customElementRegistry option names a scoped registry, and
// for the default global registry.
export function lookupCEDefinitionCtor(registry, localName, isValue) {
  return lookupDefinitionCtor(registry, localName, isValue);
}

// The local name a custom-element constructor CONSTRUCTS with, or null: an
// autonomous CE's own name, a customized built-in's extended local name (`button`
// for a `<button is>` definition). The Element constructor uses it so a DIRECT
// `new MyCustomElement()` (no createElement tag, no pending upgrade) gets the right
// local name — the HTML HTMLElement-constructor "look up the definition by
// NewTarget" step.
export function customElementLocalName(ctor) {
  const n = customElements._ctorToName.get(ctor);
  if (n === undefined) return null;
  const d = customElements._defs.get(n);
  return d ? d.localName : n;
}

// The is value a DIRECT `new Ctor()` of a customized built-in constructs with — the
// definition's NAME (so the element, and any later clone, resolves the same
// definition by local name + is value). An autonomous CE has no is value → null.
export function customElementIsValueForCtor(ctor) {
  const n = customElements._ctorToName.get(ctor);
  if (n === undefined) return null;
  const d = customElements._defs.get(n);
  return d && d.localName !== d.name ? d.name : null;
}

export function upgradeElement(el, ctor) {
  if (Object.getPrototypeOf(el) === ctor.prototype) return;
  // "Failed" elements never upgrade, through ANY entry point (define()'s match
  // sweep, customElements.upgrade(), importNode, connection) — see ceTryConnect.
  if (el._unknownFallback === true) return;
  // Once custom, always custom: lifecycle callbacks keep firing even after the
  // element's registry re-points to null (adoption into an inert document).
  el._ceUpgraded = true;
  // Save/restore rather than null-out: this is the HTML "construction stack". A CE
  // constructor may (during its upgrade) define + synchronously upgrade ANOTHER
  // custom element — that inner upgrade consumes the slot and would otherwise leave
  // it null, so when this element's own `super()` reaches the Element constructor
  // there'd be no pending element to adopt and its prototype would never swap.
  const prev = ceState.pendingUpgrade;
  ceState.pendingUpgrade = el;
  try {
    Reflect.construct(ctor, [], ctor);
  } catch (e) {
    logThrew('custom element constructor', e);
    // Custom element state "FAILED" — an element whose UPGRADE threw gets no
    // further reactions (no attributeChanged, no connectedCallback) and never
    // retries, exactly like the parser's construction failure. The prototype
    // still swaps: the spec's failed element keeps whatever the half-run
    // constructor built, and downstream code expects the class surface.
    el._unknownFallback = true;
    try { Object.setPrototypeOf(el, ctor.prototype); } catch (_) {}
  } finally {
    ceState.pendingUpgrade = prev;
  }
  // Per the CE spec, after upgrading, fire `attributeChangedCallback`
  // once per observed attribute already present on the element with
  // `oldValue = null` — so a parsed `<turbo-frame src="…">` sees its
  // `src` change from null to the attribute value and the
  // FrameController kicks off the load.
  const observed = ctor.observedAttributes;
  const fn = el.attributeChangedCallback;
  if (observed && observed.length && typeof fn === 'function') {
    // In the element's ATTRIBUTE-LIST order (not observedAttributes order) — HTML "upgrade an element"
    // walks the attribute list and enqueues attributeChanged for each attribute that is observed
    // (custom-elements/reactions/Node "only for observed attributes" asserts the class-before-title order).
    for (const name of Object.keys(el._attrs)) {
      if (observed.indexOf(name) < 0) continue;
      try { fn.call(el, name, null, el._attrs[name], null); }
      catch (e) { logThrew('attributeChangedCallback (upgrade)', e); }
    }
  }
  // A newly upgraded form-associated element reconciles its owner + disabled state
  // (HTML upgrade steps: enqueue formAssociatedCallback with the owner when non-null,
  // formDisabledCallback when disabled) — the single seam covering every upgrade path
  // (define's match sweep, customElements.upgrade, importNode's ceUpgradeTree,
  // ceTryConnect). Each reaction is idempotent (guarded on a change), so the extra
  // ceTryConnect call below is a no-op here.
  if (formAssociatedReset) formAssociatedReset(el);
}

export function fireCEHook(el, hookName) {
  try {
    const fn = el[hookName];
    if (typeof fn === 'function') fn.call(el);
  } catch (e) {
    logThrew('custom element ' + hookName, e);
  }
}

// HTML "adopt": every custom element in the adopted subtree gets an
// `adoptedCallback(oldDocument, newDocument)` reaction (a moved element's
// disconnected → adopted → connected sequence, or a bare `document.adoptNode`).
// Shadow-aware to match the connect / disconnect walks. Unupgraded elements have
// no method, so they no-op.
export function fireCEAdopted(subtree, oldDoc, newDoc) {
  walkInclShadow(subtree, el => {
    if (!ceCtorFor(el) && !el._ceUpgraded) return;
    const fn = el.adoptedCallback;
    if (typeof fn !== 'function') return;
    try { fn.call(el, oldDoc, newDoc); }
    catch (e) { logThrew('custom element adoptedCallback', e); }
  });
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
    if (o._dirtySel !== true) setSelectedness(o, o._attrs.selected != null);
    o._selInit = true;
  }
}

// Nearest ancestor `<select>` of `node` (inclusive), walking past
// optgroup / arbitrary wrappers. Returns null when `node` is not in a
// select.
export function ownerSelectOf(node) {
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
export function selectDisplaySize(select) {
  const n = parseHtmlNonneg(select._attrs.size);
  if (n != null && n > 0) return n;
  return select._attrs.multiple != null ? 4 : 1;
}

// Is an `<option>` "disabled"? Per HTML that's the option's OWN [disabled] or a
// disabled ancestor `<optgroup>` (only the nearest optgroup counts; reachable across a
// transparent wrapper like `<div>` in a customizable select). A disabled `<select>` /
// `<fieldset>` does NOT disable its options here — so this is deliberately narrower
// than isNodeActuallyDisabled, which folds the select in (using that would leave a
// `<select disabled>` with NO option selected instead of the spec's first one).
//
// Shared by the two places that must agree on what a disabled option IS: the
// selectedness default-pick below ("first option ... that is not disabled") and the
// entry list (form-fields.js — "selectedness is true AND that is not disabled"). One
// choosing an option the other then drops would be incoherent, so they read the same
// predicate rather than each spelling the rule out.
export function optionSelectednessDisabled(o) {
  if (o._attrs.disabled != null) return true;
  for (let cur = o._parent; cur; cur = cur._parent) {
    const t = cur._tag;
    if (t === 'optgroup') return cur._attrs.disabled != null;   // nearest optgroup decides
    if (t === 'select' || t === 'option' || t === 'datalist') return false;
  }
  return false;
}

// HTML "selectedness setting algorithm" for a `<select>`. `justSelected`
// is the option that was just made selected (via insertion of an already
// selected option, or via the IDL setter), excluded from the de-dup pass
// so it wins over the incumbent. With `justSelected` null this is the
// plain reset run on insert / remove / parse.
export function runSelectednessAlgorithm(select, justSelected, deferContent) {
  if (!select || select._tag !== 'select') return;
  const syncSC = (s) => { if (s._hasSelectedContent) { if (deferContent) scheduleSelectedContentUpdate(s); else updateSelectedContent(s); } };
  // A multiple-select has no implicit default and no single-selection
  // invariant to maintain, so there is nothing to reconcile — bail before
  // the O(N) option scan so a bulk `option.selected = true` loop over a
  // large multi-select stays O(N) overall (rule 3). Its options are
  // initialised independently (connect walk / finalizeSelectOptions).
  if (select._attrs.multiple != null) { syncSC(select); return; }
  const opts = select._listOfOptions();
  // Self-init every option's selectedness from its content attribute so
  // the algorithm is correct no matter how the options were built (it
  // runs from connect, insert, remove, innerHTML replace, reset, …).
  for (const o of opts) ensureOptionSelInit(o);
  // Step 1: a freshly-selected option in a single-select clears the rest.
  if (justSelected && justSelected._selectedness === true) {
    for (const o of opts) if (o !== justSelected) setSelectedness(o, false);
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
      // "first option element in the list ... whose option element is not disabled":
      // an option's own [disabled] OR an ancestor disabled <optgroup> (across a
      // transparent <div> wrapper) — but NOT the select's own disabledness, so a
      // `<select disabled>` still defaults to its first option.
      for (const o of opts) { if (!optionSelectednessDisabled(o)) { setSelectedness(o, true); break; } }
    }
  } else if (selectedCount >= 2) {
    // Step 3: keep only the last selected option in tree order. The
    // forward scan above left `selected` pointing at that last match.
    for (const o of opts) if (o._selectedness === true && o !== selected) setSelectedness(o, false);
  }
  syncSC(select);
}

// Per-spec the `<selectedcontent>` update on a CHANGE (selectedness change, option
// removal, atomic move, value/selectedIndex set) is deferred to a microtask — only a
// fresh CONNECTION / parse updates it synchronously (in post-connection steps). This
// queues a deduped per-select microtask so e.g. moving the selected option doesn't
// rewrite selectedcontent until after the current task (selectedcontent-movebefore,
// -insertion-removal). The Capybara settle drains the microtask before the next read.
const __pendingSelectedContent = new Set();
let __selectedContentFlushScheduled = false;
export function scheduleSelectedContentUpdate(select) {
  if (!select || select._tag !== 'select' || !select._hasSelectedContent) return;
  __pendingSelectedContent.add(select);
  if (__selectedContentFlushScheduled) return;
  __selectedContentFlushScheduled = true;
  globalThis.queueMicrotask(() => {
    __selectedContentFlushScheduled = false;
    const pending = Array.from(__pendingSelectedContent);
    __pendingSelectedContent.clear();
    for (const s of pending) { try { updateSelectedContent(s); } catch (_) {} }
  });
}

// HTML `<selectedcontent>` — a snapshot clone-mirror of the currently-selected
// `<option>`'s child nodes. Replace every `<selectedcontent>` in the select with
// a deep clone of the (first, tree-order) selected option's children, or empty it
// when nothing is selected. It is a SNAPSHOT: it does NOT track later mutations of
// the option's own subtree — only re-cloned when the selection settles or the
// `<selectedcontent>` (re)connects. The hot caller (runSelectednessAlgorithm) gates
// on `select._hasSelectedContent` so an ordinary select never pays the descendant
// query (rule 3); the cold value/selectedIndex setters call it unconditionally.
export function updateSelectedContent(select, force) {
  if (!select || select._tag !== 'select' || select._inUpdateSelectedContent) return;
  const scs = select.querySelectorAll('selectedcontent');
  if (scs.length === 0) return;
  // A multiple select mirrors EVERY selected option (in tree order); a single
  // select mirrors just the first/only selected one.
  const multiple = select.multiple === true;
  const selectedOpts = [];
  for (const o of select._listOfOptions()) {
    if (o._selectedness === true) { selectedOpts.push(o); if (!multiple) break; }
  }
  // Re-entrancy guard: replaceChildren connects the clones, which can fire CE /
  // connect hooks (and an ill-formed option subtree could even contain a nested
  // <selectedcontent>); without this guard such a hook re-entering updateSelectedContent
  // on the same select would recurse unboundedly.
  select._inUpdateSelectedContent = true;
  try {
    // IDEMPOTENT: skip the replaceChildren when the selectedcontent already mirrors
    // the selected option's serialized content. This runs many times per select —
    // the per-option reconcile on each <option> insert, the option's post-pop fill,
    // and the connect-walk drain all call it — so only the actual content transitions
    // surface as MutationObserver records (selectedcontent-mutations). A genuine
    // content mutation of the selected option still differs and re-clones.
    // A single select mirrors the selected option's content directly; a multiple
    // select wraps EACH selected option's content in its own <div>.
    const doc  = select.ownerDocument || globalThis.document;
    const want = multiple
      ? selectedOpts.map((o) => `<div>${o.innerHTML}</div>`).join('')
      : selectedOpts.map((o) => o.innerHTML).join('');
    for (const sc of scs) {
      // An outer selectedcontent's replace detaches a nested one (the content model
      // forbids nesting) — skip it once detached.
      if (sc._parent == null) continue;
      // Idempotency suppresses the over-firing of parse-time updates (the selection
      // settling re-runs many times as options stream in). A `force` caller — a
      // tree mutation that re-clones per spec (re-insertion/move) — replaces the
      // children with FRESH clones even when the serialized content is unchanged,
      // so MutationObserver records the node replacement (selectedcontent-mutations
      // test8: a moved <select>'s "Added [one] Removed [one]").
      if (!force && sc.innerHTML === want) continue;
      const clones = [];
      for (const o of selectedOpts) {
        if (multiple) {
          const div = doc.createElement('div');
          for (const c of o.childNodes) div.appendChild(c.cloneNode(true));
          clones.push(div);
        } else {
          for (const c of o.childNodes) clones.push(c.cloneNode(true));
        }
      }
      sc.replaceChildren(...clones);
    }
  } finally {
    select._inUpdateSelectedContent = false;
  }
}

// A `<selectedcontent>` just connected (parse / appendChild / re-insert): flag its
// owning select so the selectedness algorithm keeps it in sync, then clone the
// current selection into it now — this is its post-connection step, run in the
// connect walk's document order so a sibling `<script>` observes the populated
// content iff it connects after.
export function connectSelectedContent(sc) {
  const select = ownerSelectOf(sc);
  if (!select) return;
  select._hasSelectedContent = true;
  // First connection (parse build) fills idempotently; a RE-connection (the
  // selectedcontent was previously connected and got moved/re-inserted) is a tree
  // mutation that re-clones per spec — force it so the node replacement records.
  const reconnect = sc._everConnected === true;
  sc._everConnected = true;
  updateSelectedContent(select, reconnect);
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
export function askForReset(child, deferContent) {
  if (!child || child.nodeType !== NODE_ELEMENT) return;
  const parent = child._parent;
  if (!affectsSelectedness(child, parent)) return;
  const select = ownerSelectOf(parent);
  if (!select) return;
  runSelectednessAlgorithm(select, lastSelectedOption(child), deferContent);
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
export function askForResetBatch(nodes, deferContent) {
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
  runSelectednessAlgorithm(select, justSelected, deferContent);
}

// Removal entry point: an option leaving a select can drop its selection
// to zero, so the former select re-runs the algorithm and picks a new
// default. `removedChild` is the detached node, `formerParent` the node it
// left — together they gate the ancestor walk cheaply.
export function askForResetAfterRemoval(removedChild, formerParent) {
  if (!formerParent) return;
  if (!affectsSelectedness(removedChild, formerParent)) return;
  const select = ownerSelectOf(formerParent);
  // Removal of the selected option defers the selectedcontent update to a microtask
  // (it stays showing the removed option's content until then) — selectedcontent-
  // insertion-removal / -movebefore.
  if (select) runSelectednessAlgorithm(select, null, true);
}

// Finalize a select whose options were (re)built outside the insert hooks
// and connect walk (`select.innerHTML = …`, `replaceChildren`). Unlike the
// reconcile-only algorithm, this also initialises every option's
// selectedness from its content attribute — necessary for a multiple-select
// (which the algorithm skips), and harmless/idempotent for a single one.
export function finalizeSelectOptions(select) {
  if (!select || select._tag !== 'select') return;
  for (const o of select._listOfOptions()) ensureOptionSelInit(o);
  // `innerHTML` / `replaceChildren` build a select's <selectedcontent> without a
  // connect walk (notably on a DETACHED select), so flag it here too — then the
  // reconcile below mirrors the initial selection into it, and later value /
  // selectedIndex changes keep it in sync even while disconnected.
  if (!select._hasSelectedContent && select.querySelector('selectedcontent')) {
    select._hasSelectedContent = true;
  }
  runSelectednessAlgorithm(select, null);
}

// Upgrade-only walk (no connectedCallback) — used by `Document.importNode` to
// upgrade elements that were inert in `<template>.content`. Connection happens
// later when they're appended to the live tree. Gated on a browsing context, like
// ceTryConnect: importing into / attaching a shadow within a window-less document
// (createHTMLDocument / createDocument / DOMParser) must NOT construct the element —
// HTML "look up a custom element definition" returns null there.
// Rule-3 gate for O(N) upgrade walks: nothing anywhere can upgrade when no
// registry holds a definition.
export function hasAnyCEDefinitions() { return totalDefinitions > 0; }

export function ceUpgradeTree(subtree) {
  // No definitions in ANY registry → nothing can upgrade; skip the subtree walk
  // entirely. cloneNode calls this on every deep clone (Turbo StreamMessage /
  // template.content), so a page with no custom elements must pay O(1) here, not an
  // O(N) walk (rule 3).
  if (totalDefinitions === 0) return;
  walk(subtree, el => {
    const ctor = ceCtorFor(el);
    if (!ctor) return;
    if (Object.getPrototypeOf(el) !== ctor.prototype && el.ownerDocument === globalThis.document) {
      upgradeElement(el, ctor);
    }
  });
}

// CE side of fireCEConnect's per-element walk: upgrade if pending,
// then fire `connectedCallback`. Script and `<link>` handling stays
// in bridge.entry.js because both need closure state
// (`__inHTMLGrafting`, `__initialScriptsDone`) the IIFE owns.
export function ceTryConnect(el) {
  // Custom element state "FAILED": the parser already ran this element's
  // constructor and it threw / returned the wrong thing, so the parser built
  // an HTMLUnknownElement fallback (constructParsedCustomElement). A failed
  // element never upgrades and never gets reactions — retrying here would
  // resurrect the very definition the parser rejected.
  if (el._unknownFallback === true) return;
  const ctor = ceCtorFor(el);
  if (!ctor) {
    // An ALREADY-upgraded element whose registry re-pointed to null (adopted
    // into an inert document) still gets its connectedCallback — reactions are
    // per-element once custom, independent of the current registry resolution.
    if (el._ceUpgraded) {
      fireCEHook(el, 'connectedCallback');
      if (formAssociatedReset) formAssociatedReset(el);
    }
    return;
  }
  // UPGRADE (constructing an undefined element) needs a browsing context — HTML
  // "look up a custom element definition" returns null without one, so connecting an
  // undefined element into an INERT document (createHTMLDocument / createDocument /
  // cloned / DOMParser) must NOT upgrade it. connectedCallback, by contrast, fires on
  // connection to ANY document, so an ALREADY-upgraded element still gets it there
  // (its method is absent on a never-upgraded element, so fireCEHook is a no-op).
  if (Object.getPrototypeOf(el) !== ctor.prototype && el.ownerDocument === globalThis.document) {
    upgradeElement(el, ctor);
  }
  fireCEHook(el, 'connectedCallback');
  // Connecting can change the owner or disabled state of an ALREADY-upgraded
  // form-associated element (a move into a form's / disabled-<fieldset>'s subtree, or
  // its `form=` target now resolving). upgradeElement above already reconciled a fresh
  // upgrade; this covers the rest.
  if (formAssociatedReset) formAssociatedReset(el);
}

export function fireCEDisconnect(subtree) {
  // `walkInclShadow` so a removed host's shadow-tree custom elements get
  // disconnectedCallback — balancing the shadow-aware connect walk (fireCEConnect
  // → walkInclShadow). A light-tree-only walk here would leave a shadow CE that
  // received connectedCallback never disconnected.
  walkInclShadow(subtree, el => {
    if (!ceCtorFor(el) && !el._ceUpgraded) return;
    fireCEHook(el, 'disconnectedCallback');
    // Removal detaches the element from its form / disabled-<fieldset> subtree (already
    // unlinked here), so a form-associated element reconciles its owner + disabled
    // state — enqueuing formAssociatedCallback(null) / formDisabledCallback(false) per
    // the removing steps.
    if (formAssociatedReset) formAssociatedReset(el);
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
    if (!ceCtorFor(el) && !el._ceUpgraded) return;
    if (typeof el.connectedMoveCallback === 'function') {
      fireCEHook(el, 'connectedMoveCallback');
    } else {
      fireCEHook(el, 'disconnectedCallback');
      fireCEHook(el, 'connectedCallback');
    }
  });
}

globalThis.CustomElementRegistry = CustomElementRegistry;
globalThis.customElements = customElements;
