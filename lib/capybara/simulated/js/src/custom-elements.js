// Custom Elements registry + lifecycle hooks. `ceState.pendingUpgrade`
// is the seam by which `upgradeElement` hands the prototype-swap
// target into the user-supplied constructor — the Element ctor in
// bridge.entry.js reads it and returns the existing element instead
// of allocating a fresh one. ES module live bindings are readonly
// for `let` exports, so the mutable-object indirection is necessary.

import { SELECT_HAS_SELECTED_CONTENT, EVER_CONNECTED, SELECT_IN_UPDATE, elementFlag, setElementFlag, CE_FAILED } from './element-flags.js';
import { selectFirst } from './selectors.js';
import { optionsChanged } from './form-helpers.js';
import { isConnected } from './walk.js';
import { bumpCascadeVersion, bumpStyleState } from './mutation-observer.js';
import { NODE_ELEMENT, HTML_NS }    from './constants.js';
import { logThrew }                 from './console.js';
import { isKnownHtmlElementName }   from './html-element-names.js';
import {
  customElementCandidatesIn, hasState, htmlAncestorOf, initialiseOptions, runSelectedness, askForResetOf, setElementState,
  inclusiveElementsIn, rareDataOf, shadowIncludingElementsIn, upgradeCandidatesIn, upgradedElementsIn, REALM, STATE_CUSTOM, STATE_FORM_ASSOCIATED,
  STATE_SELECTED_INIT, STATE_UPGRADED
} from './native-query-shadow.js';
import { makeSlots, registerInterface, rejectedPromise, resolvedPromise, setCEReactionsRunner, slotsOf } from './webidl.js';
import { installCustomElementRegistry } from './generated/bindings.js';
import { documentElementOf } from './document-tree.js';

// Custom element definitions live PER CustomElementRegistry instance — in the engine (ce_reactions.rs), which looks one
// up by name, and by local name and is value; the global `customElements` is one such instance. An element resolves
// definitions through its ASSOCIATED registry — its `_ceRegistry` if it was created in a scoped shadow tree / document,
// otherwise the global one.
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
// …while it is the engine's: one whose realm went is none (`ceDefinitionLive`).
export function ctorDefinition(ctor) {
  if (ctor === null || (typeof ctor !== 'function' && typeof ctor !== 'object')) return undefined;
  const def = ctorToDef.get(ctor);
  return def !== undefined && globalThis.__dom.ceDefinitionLive(def.id, def) ? def : undefined;
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
// (browsing-context) document, null for an inert one — the engine's, which a document
// is given as it gets or loses a browsing context (`setWindowRegistryOf`). This — never
// the initialize()d association below — is what an element in the UNSET state
// tracks, and what a non-scoped registry re-points to on adoption: a scoped
// initialize() on an inert document associates new CREATIONS with the scoped
// registry, but adopted-in default elements still land on null.
export function windowRegistryOf(doc) {
  if (!doc) return customElements;   // ownerless node — pre-feature global fallback
  return globalThis.__dom.ceWindowRegistry(doc) ?? null;
}
// …given to `doc` with its browsing context (`registry`, its window's), or taken away (null).
export function setWindowRegistryOf(doc, registry) {
  doc._noBrowsingContext = registry === null;
  globalThis.__dom.ceSetWindowRegistry(doc, registry === null ? 0 : registryCodeOf(registry), registry);
}
// The registry of a document, an element or a shadow root, as the engine resolves it (ce_reactions.rs `registry_for`):
// its own where one is set — null for the null registry, and for the template contents' tracking null — else its node
// document's window registry (a document's own). An element's unset association (the common case) TRACKS THE NODE
// DOCUMENT — that is what makes cross-document adoption re-point a global-registry element for free; an explicit scoped
// registry is pinned; null is the "null registry" state (an upgrade candidate that never matches a definition). A
// document's is its ACTIVE registry — the initialize()d association when one exists, else the window registry: what
// `document.customElementRegistry` is, and newly created elements get.
export function documentRegistry(doc) {
  return doc ? globalThis.__dom.ceRegistryFor(doc) ?? null : customElements;
}
export function registryForElement(el) {
  return el ? globalThis.__dom.ceRegistryFor(el) ?? null : customElements;
}
export function shadowRootRegistry(root) {
  return globalThis.__dom.ceRegistryFor(root) ?? null;
}
// An element's "is value": the customized built-in name it was created with — createElement's `is` option, a
// parsed element's `is` attribute, a clone's source's — held in `_isValue`. Fixed at creation: an `is` attribute set
// later names nothing (Chrome: the element stays defined and is never upgraded).
function isValueOf(el) {
  return el._isValue != null ? el._isValue : undefined;
}
// HTML "look up a custom element definition" for `registry` given a local name and is value. Autonomous match: a
// definition NAMED localName whose own local name equals its name. Customized-built-in match: a definition whose local
// name is localName and whose name is the element's is value. A null registry matches nothing.
function lookupDefinition(registry, localName, isValue) {
  return registry ? globalThis.__dom.ceLookUp(registryCodeOf(registry), localName, isValue == null ? undefined : String(isValue)) : undefined;
}
// …and the definition named `name` of `registry`, or undefined.
function namedDefinition(registry, name) {
  return globalThis.__dom.ceNamed(registryCodeOf(registry), name);
}
// …its constructor.
function lookupDefinitionCtor(registry, localName, isValue) {
  return lookupDefinition(registry, localName, isValue)?.ctor;
}
// The registered custom-element constructor for `el`, or undefined. Per spec a
// custom element is matched by (HTML namespace + local name + is value), NOT its
// qualified tag — so an XML/XHTML element carrying a namespace prefix
// (`html:custom-el`, localName `custom-el`) still upgrades by its local name. For an
// element in an HTML document `_tag === _localName`, so this is equivalent to the old
// `_tag` lookup there. (shadow-dom/innerHTML-setter.xhtml)
export function ceCtorFor(el) {
  return ceDefinitionFor(el)?.ctor;
}
// …and its definition, of the registry the element's is: a constructor two scoped registries define is two definitions,
// each with the callbacks it was defined with.
function ceDefinitionFor(el) {
  if (!el || el._ns !== HTML_NS) return undefined;
  return globalThis.__dom.ceDefinitionFor(el, anyBuiltinCE ? isValueOf(el) : undefined);
}
// The definition `ctor` makes `el` custom by: its registry's, where that is `ctor`'s, else the one `ctor` was last
// defined with (a direct `new MyCE()` of a global definition).
function definitionFor(el, ctor) {
  const def = ceDefinitionFor(el);
  return def !== undefined && def.ctor === ctor ? def : ctorToDef.get(ctor);
}
// Each registry keeps a reverse index (constructor → definition) too, backing getName()
// and the "constructor already used" define() guard. The SAME constructor may be
// defined in more than one registry (under possibly different names), so this is
// per-instance, not global; customElementLocalName (the direct-`new MyCE()` path)
// reads the GLOBAL registry's index.
// Constructors whose static `formAssociated` is true, snapshotted at define time so
// the form-membership + form-owner-reset hot paths never re-invoke the (observable,
// user-defined) getter. `anyFormAssociatedCE` flips once any form-associated element
// is defined, so a page that defines none short-circuits every gate to O(1) (rule 3).
const formAssociatedCtors = new WeakSet();
let   anyFormAssociatedCE = false;
// Reconciles a form-associated custom element's owner + disabled state (enqueuing
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
// `el` is custom now — `ctor` constructed it, or upgraded it without throwing: `:defined` matches it, and it is a
// form-associated custom element when `ctor` is one's.
// A form-associated custom element's restored persisted state (HTML §4.13.7.4): its formStateRestoreCallback enqueued
// with it and "restore" — or, for an element not upgraded yet, kept until it is (`upgradeElement`); one no definition
// makes form-associated, none.
export function restoreFormStateOf(el, state) {
  if (isFormAssociatedCustomElement(el)) fireCEHook(el, FORM_STATE_RESTORE_CALLBACK, [state, 'restore']);
  else if (!hasState(el, STATE_UPGRADED)) rareDataOf(el, true).pendingFormState = state;
}
export function becomeCustom(el, ctor) {
  const bits = STATE_UPGRADED | STATE_CUSTOM | (formAssociatedCtors.has(ctor) ? STATE_FORM_ASSOCIATED : 0);
  setElementState(el, STATE_UPGRADED | STATE_CUSTOM | STATE_FORM_ASSOCIATED, bits);
  // (…and its custom element definition, whose callbacks — captured as it was defined — are the ones it is owed: the
  // engine's, ce_reactions.rs)
  const def = definitionFor(el, ctor);
  globalThis.__dom.ceSetDefinition(el._nid, def?.id ?? -1, def ?? null);
}

// The custom element reactions (HTML §4.13.6), the engine's (ce_reactions.rs): an element's callback reaction enqueued
// on its reaction queue, and the element on the current call's element queue — or on the backup one, whose microtask
// runs it, which an op that enqueued one there says is to be queued.
function backupQueued(queue) {
  if (queue) queueMicrotask(runBackupElementQueue);
}
// …a reaction the engine enqueued there itself (attributes.rs: an attribute's change).
export function queueBackupReactions() {
  queueMicrotask(runBackupElementQueue);
}
// HTML "invoke custom element reactions": each element's reactions in turn, those enqueued as they run included, a
// callback's exception reported.
function invokeReactions(elements) {
  for (const el of elements) runReactionsOf(el);
}
// …one element's.
function runReactionsOf(el) {
  const d = globalThis.__dom;
  for (let r; (r = d.ceTakeReaction(el._nid)) !== undefined;) {
    try { r[0].apply(el, r[1]); } catch (e) { reportCallbackError(r[0], e); }
  }
}
function reportCallbackError(callback, e) {
  try { globalThis.__csimReportCallbackError(callback, e); } catch (_) { logThrew('custom element reaction', e); }
}
function runBackupElementQueue() {
  invokeReactions(globalThis.__dom.ceTakeBackup());
}
// …which a microtask checkpoint runs too, where the queue holds an element (`ceStack[2]`, no call): the microtask queued
// for it is one realm's, which a page left or a frame removed takes with it.
globalThis.__csimRunBackupReactions = runBackupElementQueue;
// …and the part of it realm `cid`'s elements are, as that realm goes: a frame navigates here at once, where a browser
// keeps the old document until the new one commits — and its microtask runs before then.
globalThis.__csimRunBackupReactionsOf = (cid) => invokeReactions(globalThis.__dom.ceTakeBackup(cid));
// …and the element queue of the [CEReactions] call that returns (webidl.js `ceLeave`), popped.
setCEReactionsRunner((depth) => invokeReactions(globalThis.__dom.ceTakeQueue(depth)));
// A form-associated custom element: one made CUSTOM by a form-associated definition (a failed upgrade leaves it
// none, as it leaves the element no definition).
export function isFormAssociatedCustomElement(el) {
  return anyFormAssociatedCE && el != null && hasState(el, STATE_FORM_ASSOCIATED);
}
// (`parsing`: how many parser connections run — the elements the parser connects are its "create an element for a
// token"'s, constructed at once where their definition is there, inside its markup insertion guard, not upgraded later)
export const ceState = { pendingUpgrade: null, parsing: 0 };

// The callbacks define() reads off the prototype, IN ORDER: the lifecycle callbacks — `connectedMoveCallback` among them,
// between disconnected and adopted, as a browser with atomic moves collects it — then, for a form-associated definition,
// the form callbacks. A definition hands them to the engine in this order, which `fireCEHook` names one by.
const CALLBACKS = [
  'connectedCallback', 'disconnectedCallback', 'connectedMoveCallback', 'adoptedCallback', 'attributeChangedCallback',
  'formAssociatedCallback', 'formResetCallback', 'formDisabledCallback', 'formStateRestoreCallback'
];
const LIFECYCLE_CALLBACKS = 5, ATTRIBUTE_CHANGED_CALLBACK = 4;
export const CONNECTED_CALLBACK = 0, DISCONNECTED_CALLBACK = 1, CONNECTED_MOVE_CALLBACK = 2, ADOPTED_CALLBACK = 3;
export const FORM_RESET_CALLBACK = 6, FORM_STATE_RESTORE_CALLBACK = 8;   // (…formAssociatedCallback and formDisabledCallback the engine's to enqueue: ceFormStateReset)

// A "valid custom element name" (HTML), the engine's (element_state.rs `is_valid_custom_element_name`).
export const isValidCustomElementName = (name) => globalThis.__dom.validCustomElementName(name);

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
function resolveWhenDefined(r, name, ctor) {
  const entry = r.whenDefined.get(name);
  if (entry) { entry.resolve(ctor); r.whenDefined.delete(name); }
}

// CustomElementRegistry (HTML §4.13.4), generated from its IDL: its definitions, and what they are looked up by, in
// its slots.
const registryOf = (o) => slotsOf(o, 'CustomElementRegistry');
export const isRegistry = (o) => registryOf(o) !== undefined;
// …and whether one is scoped: every one a page constructs; not the window's (`customElements`).
export const isScopedRegistry = (o) => registryOf(o)?.scoped === true;
// …and the code a node's registry association is (ce_reactions.rs): none set, the tracking null, the null registry, or
// the registry's own.
export function registryCodeOf(r) {
  if (r === undefined || r === TRACKING_NULL || r === null) return r === undefined ? 0 : r === null ? 2 : 1;
  const s = registryOf(r);
  return s.code || (s.code = s.global.__dom.ceMakeRegistry(r, s.scoped));
}
registerInterface('CustomElementRegistry', isRegistry);
// (…every one scoped but the window's, made first: `customElements`)
let windowRegistryMade = false;
export class CustomElementRegistry {
  constructor() {
    const scoped = windowRegistryMade;
    windowRegistryMade = true;
    makeSlots(this, 'CustomElementRegistry', {
      scoped,                   // author-constructed registries are scoped; the window's one (`customElements`) not
      code: 0,                  // what a node's association names it by (ce_reactions.rs), made as it first is one
      global: globalThis,       // …in its own realm (the window's is made into the snapshot, before any engine is there)
      ctorToDef: new Map(),     // constructor -> definition (this registry's reverse index)
      whenDefined: new Map(),   // name -> { promise, resolve } for not-yet-defined names
      defRunning: false,        // HTML "element definition is running" flag (per registry)
      steps: registrySteps      // its realm's steps: a frame's registry defines and upgrades in the frame
    });
  }
}
// (…each member the steps of the registry's own realm — its document swept, its gates moved, its promises made — as a
// registry of another realm is called through this one's interface)
installCustomElementRegistry(CustomElementRegistry, {
  define: (self, name, constructor, options) => registryOf(self).steps.define(self, name, constructor, options),
  get: (self, name) => registryOf(self).steps.get(self, name),
  getName: (self, constructor) => registryOf(self).steps.getName(self, constructor),
  whenDefined: (self, name) => registryOf(self).steps.whenDefined(self, name),
  initialize: (self, root) => registryOf(self).steps.initialize(self, root),
  upgrade: (self, root) => registryOf(self).steps.upgrade(self, root)
});
const NativePromise = Promise;
const registrySteps = {

  // HTML "CustomElementRegistry.define(name, constructor, options)". The step
  // ORDER is observable (WPT asserts IsConstructor and name validity are checked
  // BEFORE the definition-running flag), so keep it: IsConstructor → valid name →
  // duplicate name → duplicate constructor → resolve `extends` (refused by a scoped
  // registry) → running-flag →
  // collect from the constructor under the flag → store → upgrade → resolve whenDefined.
  define(self, n, constructor, options) {
    const r = registryOf(self);
    if (!isConstructor(constructor)) {
      throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': the provided constructor is not a constructor.");
    }
    if (!isValidCustomElementName(n)) {
      throw new DOMException(`Failed to execute 'define' on 'CustomElementRegistry': "${n}" is not a valid custom element name.`, 'SyntaxError');
    }
    if (namedDefinition(self, n) !== undefined) {
      throw new DOMException(`Failed to execute 'define' on 'CustomElementRegistry': the name "${n}" has already been used with this registry.`, 'NotSupportedError');
    }
    if (r.ctorToDef.has(constructor)) {
      throw new DOMException("Failed to execute 'define' on 'CustomElementRegistry': the constructor has already been used with this registry.", 'NotSupportedError');
    }
    // `options.extends` names the built-in element this is a customized built-in of.
    // The definition's local name becomes `extends` (so `<button is="my-button">`
    // matches, not `<my-button>`). `extends` must NOT itself be a valid custom
    // element name (can't customize a custom element) and MUST name a real built-in
    // (its interface is not HTMLUnknownElement) — both NotSupportedError.
    let localName = n;
    const extendsName = options.extends ?? null;
    if (extendsName !== null) {
      // (…a customized built-in is the global registry's alone)
      if (r.scoped) {
        throw new DOMException("Failed to execute 'define' on 'CustomElementRegistry': a scoped registry cannot define a customized built-in element.", 'NotSupportedError');
      }
      if (isValidCustomElementName(extendsName)) {
        throw new DOMException(`Failed to execute 'define' on 'CustomElementRegistry': "${extendsName}" is a valid custom element name, so it cannot be extended.`, 'NotSupportedError');
      }
      if (!isKnownHtmlElementName(extendsName)) {
        throw new DOMException(`Failed to execute 'define' on 'CustomElementRegistry': "${extendsName}" is not a valid local name for a customized built-in element.`, 'NotSupportedError');
      }
      localName = extendsName;
    }
    if (r.defRunning) {
      throw new DOMException("Failed to execute 'define' on 'CustomElementRegistry': an element definition is already running.", 'NotSupportedError');
    }
    // Collect from the constructor under the running flag. The values are validated
    // (and getter / iterator / conversion errors rethrown, per the define() "must
    // rethrow…" subtests), and the callbacks and observed attributes kept by the definition.
    let formAssociated = false;
    // (…the callbacks, and the attributes it observes, as they are now: a later write to the prototype changes nothing
    // the definition calls)
    const callbacks = new Array(CALLBACKS.length);
    let observed = [];
    r.defRunning = true;
    try {
      const prototype = constructor.prototype;
      if (prototype === null || (typeof prototype !== 'object' && typeof prototype !== 'function')) {
        throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': the constructor's prototype property is not an object.");
      }
      const collect = (from, to) => {
        for (let i = from; i < to; i++) {
          const v = prototype[CALLBACKS[i]];
          if (v !== undefined && typeof v !== 'function') {
            throw new TypeError(`Failed to execute 'define' on 'CustomElementRegistry': the '${CALLBACKS[i]}' callback is not callable.`);
          }
          callbacks[i] = v;
        }
      };
      collect(0, LIFECYCLE_CALLBACKS);
      // observedAttributes / disabledFeatures / formAssociated are STATIC — read
      // off the constructor, not the prototype (observedAttributes only when an
      // attributeChangedCallback exists to receive the notifications).
      if (callbacks[ATTRIBUTE_CHANGED_CALLBACK] !== undefined) {
        const oa = constructor.observedAttributes;
        if (oa !== undefined) observed = toSequenceDOMString(oa);
      }
      const df = constructor.disabledFeatures;
      if (df !== undefined) toSequenceDOMString(df);
      formAssociated = Boolean(constructor.formAssociated);
      if (formAssociated) collect(LIFECYCLE_CALLBACKS, CALLBACKS.length);
    } finally {
      r.defRunning = false;
    }
    // (…the engine's, which a lookup answers with the object kept here — which holds the callbacks the engine holds weakly:
    // a definition lives with its registry — a customized built-in's by the local name it extends and its name too, so
    // `<extends is="name">` elements resolve to it)
    const def = { name: n, ctor: constructor, localName, callbacks, id: -1 };
    def.id = globalThis.__dom.ceDefine(registryCodeOf(self), n, localName, def, callbacks, observed);
    r.ctorToDef.set(constructor, def);
    ctorToDef.set(constructor, def);   // cross-registry index for the HTML constructor's checks
    totalDefinitions++;
    if (localName !== n) anyBuiltinCE = true;
    if (formAssociated) {
      formAssociatedCtors.add(constructor);
      anyFormAssociatedCE = true;
      // Form-associatedness is registry state that a STATIC pseudo-class reads: `:disabled` /
      // `:enabled` start matching every existing element of this name (its `disabled` attribute
      // was inert until now). Nothing on the element or its ancestors moved, and a `:disabled`
      // rule is not tainted — so this is a rule-set-shaped change for the memos: move the version.
      bumpCascadeVersion();
    }
    // Upgrade existing matches by (HTML namespace + local name) — a prefixed XML
    // custom element (`html:custom-el`) must upgrade too. Collect first, then
    // upgrade: upgrading mutates the tree the walk traverses.
    const doc = globalThis.document;
    if (doc && documentElementOf(doc)) {
      // Shadow-including tree order (HTML "upgrade candidates") so a host and its
      // shadow-resident matches upgrade in document order: the engine's candidates by name (`upgradeCandidatesIn`),
      // those whose registry's definition this is.
      const matches = upgradeCandidatesIn(documentElementOf(doc), localName, localName !== n ? n : null)
        .filter((el) => ceCtorFor(el) === constructor);
      for (const el of matches) upgradeElement(el, constructor);
    }
    resolveWhenDefined(r, n, constructor);
  },

  get(self, name) { return namedDefinition(self, name)?.ctor; },

  // HTML "CustomElementRegistry.getName(constructor)": the name a constructor was
  // registered under, or null.
  getName(self, constructor) {
    return registryOf(self).ctorToDef.get(constructor)?.name ?? null;
  },

  // Spec: resolves with the constructor when the name is defined; rejects for a
  // name that isn't a valid custom element name. Apps `await
  // customElements.whenDefined(tag)` before reading from not-yet-upgraded elements.
  whenDefined(self, n) {
    const r = registryOf(self);
    if (!isValidCustomElementName(n)) {
      return rejectedPromise(new DOMException(`Failed to execute 'whenDefined' on 'CustomElementRegistry': "${n}" is not a valid custom element name.`, 'SyntaxError'));
    }
    // Already defined → a fresh resolved promise each call. Only a not-yet-defined
    // name gets the stored, shared promise (so repeated calls return the same one).
    const d = namedDefinition(self, n);
    if (d) return resolvedPromise(d.ctor);   // (…promises of the realm's own, not a page's Promise)
    let entry = r.whenDefined.get(n);
    if (!entry) {
      let resolve;
      const promise = new NativePromise(res => { resolve = res; });
      entry = { promise, resolve };
      r.whenDefined.set(n, entry);
    }
    return entry.promise;
  },

  // HTML "CustomElementRegistry.initialize(root)": associate this registry with a
  // subtree in the NULL-registry state — the escape hatch that makes a declarative
  // `shadowrootcustomelementregistry` tree (or an inert document's content)
  // usable. The global registry initializes only a tree of its own document; a
  // Document / ShadowRoot root in the null state is claimed, then every inclusive
  // descendant element in it (never descending into nested shadow trees — each
  // root is initialized separately), and each element now of this registry tried
  // for an upgrade, those associated before the call included (initialize is also
  // the "upgrade my disconnected candidates" entry point).
  initialize(self, root) {
    const r = registryOf(self);
    // (…the node's own document: a live-tree node keeps none, which is its realm's, not the caller's)
    const doc = root._nodeType === 9 ? root : root._ownerDocument;
    if (!r.scoped && (root._nodeType === 9 || documentRegistry(doc) !== self)) {
      throw new DOMException("Failed to execute 'initialize' on 'CustomElementRegistry': a non-scoped registry can initialize only a tree of its own document.", 'NotSupportedError');
    }
    if (root._nodeType === 9) {
      // (…marked on the document, whichever realm's code creates in it: the gate of a creation's pin)
      if (documentRegistry(root) === null) { root._ceRegistry = self; root._ceInitialized = true; }
    } else if (root._isShadowRoot) {
      if (shadowRootRegistry(root) === null) root._ceRegistry = self;
    }
    const candidates = [];
    for (const el of inclusiveElementsIn(root)) {
      if (registryForElement(el) === null) el._ceRegistry = self;
      if (registryForElement(el) === self) candidates.push(el);
    }
    for (const el of candidates) {
      const ctor = ceCtorFor(el);
      if (ctor && Object.getPrototypeOf(el) !== ctor.prototype) upgradeElement(el, ctor);
    }
  },

  // Spec: walk `root`'s subtree and upgrade any element whose name has a
  // registered constructor but hasn't upgraded yet. Lit / Stencil flows that build
  // elements off-document then call `customElements.upgrade(fragment)` before
  // attaching depend on it.
  upgrade(self, root) {
    // The candidates are collected first (HTML: "a list of all of root's shadow-including inclusive descendant
    // elements" — a template's contents none of them), then each is tried: an upgrade runs a constructor, which may
    // replace the children still to walk.
    for (const node of shadowIncludingElementsIn(root)) {
      if (registryForElement(node) !== self) continue;   // (…of another registry: none of this one's to upgrade)
      const ctor = ceCtorFor(node);
      if (ctor && Object.getPrototypeOf(node) !== ctor.prototype) upgradeElement(node, ctor);
    }
  }
};

// The ONE non-scoped registry (HTML: the window's registry). `initialize` refuses
// documents for it, and adoption re-points elements associated with it.
export const customElements = new CustomElementRegistry();

// The AUTONOMOUS constructor registered under global-registry name `tag`, or
// undefined. Callers pass a name (an autonomous CE's local name, or a customized
// built-in's is value) and want that named definition's constructor — attachShadow's
// disabledFeatures probe (by local name / is value) and attachInternals (autonomous
// local name). Customized-built-in element MATCHING (by local name + is value) goes
// through `lookupCEDefinitionCtor` / `ceCtorFor` instead.
export function getCustomElementCtor(tag) {
  return namedDefinition(customElements, tag)?.ctor;
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
  return registryOf(customElements).ctorToDef.get(ctor)?.localName ?? null;
}

// The is value a DIRECT `new Ctor()` of a customized built-in constructs with — the
// definition's NAME (so the element, and any later clone, resolves the same
// definition by local name + is value). An autonomous CE has no is value → null.
export function customElementIsValueForCtor(ctor) {
  const d = registryOf(customElements).ctorToDef.get(ctor);
  return d && d.localName !== d.name ? d.name : null;
}

export function upgradeElement(el, ctor) {
  if (Object.getPrototypeOf(el) === ctor.prototype) return;
  // "Failed" elements never upgrade, through ANY entry point (define()'s match
  // sweep, customElements.upgrade(), importNode, connection) — see ceTryConnect.
  if (elementFlag(el, CE_FAILED)) return;
  // Once custom, always custom: lifecycle callbacks keep firing even after the
  // element's registry re-points to null (adoption into an inert document).
  setElementState(el, STATE_UPGRADED, STATE_UPGRADED);
  // HTML "upgrade an element": the element's definition set, and the reactions it is owed enqueued BEFORE its
  // constructor runs — attributeChanged for each attribute it observes, in the element's ATTRIBUTE-LIST order (not
  // observedAttributes order: custom-elements/reactions/Node asserts the class-before-title order), each by its LOCAL
  // name and namespace as a change reports it (so a parsed `<turbo-frame src="…">` sees its `src` change from null and
  // the FrameController kicks off the load); then connectedCallback, where it is connected. A change its constructor
  // makes is enqueued behind them.
  const d = globalThis.__dom;
  const def = definitionFor(el, ctor);
  d.ceSetDefinition(el._nid, def?.id ?? -1, def ?? null);
  if (d.ceHasCallback(el._nid, ATTRIBUTE_CHANGED_CALLBACK)) {
    for (const key of Object.keys(el._attrs)) {
      const [ns, , localName] = d.attrName(el, key);
      backupQueued(d.ceAttributeChanged(el._nid, el, localName, null, el._attrs[key], ns));
    }
  }
  if (isConnected(el)) fireCEHook(el, CONNECTED_CALLBACK);
  // Save/restore rather than null-out: this is the HTML "construction stack". A CE
  // constructor may (during its upgrade) define + synchronously upgrade ANOTHER
  // custom element — that inner upgrade consumes the slot and would otherwise leave
  // it null, so when this element's own `super()` reaches the Element constructor
  // there'd be no pending element to adopt and its prototype would never swap.
  const prev = ceState.pendingUpgrade;
  ceState.pendingUpgrade = el;
  try {
    // HTML "upgrade an element": a constructor that returns anything but the element it upgrades fails it.
    if (Reflect.construct(ctor, [], ctor) !== el) {
      throw new TypeError('The custom element constructor did not return the element being upgraded.');
    }
  } catch (e) {
    logThrew('custom element constructor', e);
    // Custom element state "FAILED" — an element whose UPGRADE threw has its definition taken back and its reaction
    // queue emptied (no attributeChanged, no connectedCallback) and never retries, exactly like the parser's
    // construction failure. The prototype still swaps: the spec's failed element keeps whatever the half-run
    // constructor built, and downstream code expects the class surface.
    setElementFlag(el, CE_FAILED, true);
    d.ceSetDefinition(el._nid, -1, null);
    d.ceClear(el._nid);
    try { Object.setPrototypeOf(el, ctor.prototype); } catch (_) {}
  } finally {
    ceState.pendingUpgrade = prev;
  }
  if (!elementFlag(el, CE_FAILED)) becomeCustom(el, ctor);
  // `:defined` flips here, element by element — a dynamic pseudo-class: what this moves is the style state, since
  // nothing else changes for an upgrade (no attribute, no DOM change).
  bumpStyleState();
  // A newly upgraded form-associated element reconciles its owner + disabled state
  // (HTML upgrade steps: enqueue formAssociatedCallback with the owner when non-null,
  // formDisabledCallback when disabled) — the single seam covering every upgrade path
  // (define's match sweep, customElements.upgrade, importNode's ceUpgradeTree,
  // ceTryConnect). Each reaction is idempotent (guarded on a change), so the extra
  // ceTryConnect call below is a no-op here.
  if (formAssociatedReset) formAssociatedReset(el);
  // …and a state a history traversal put back before it was one handed to it now (Chrome).
  const pending = rareDataOf(el)?.pendingFormState;
  if (pending !== undefined) {
    rareDataOf(el).pendingFormState = undefined;
    restoreFormStateOf(el, pending);
  }
  // …and the upgrade being a reaction of its own, the reactions it enqueued run as it ends — before another element
  // upgrades (custom-element-reaction-queue: "attributeChangedCallback and connectedCallback before start upgrading
  // another element").
  runReactionsOf(el);
}

// HTML "enqueue a custom element upgrade reaction": `el` upgraded by `ctor` as its reactions run — once: an element whose
// upgrade is queued (a fragment parse's, then connected by the insertion) is not queued again.
const upgradeQueued = new WeakSet();
function enqueueUpgrade(el, ctor) {
  if (upgradeQueued.has(el)) return;
  upgradeQueued.add(el);
  backupQueued(globalThis.__dom.ceEnqueueUpgrade(el._nid, el, upgradeReaction, [ctor]));
}
function upgradeReaction(ctor) {
  upgradeQueued.delete(this);
  upgradeElement(this, ctor);
}

// HTML "enqueue a custom element callback reaction": `el`'s definition's `which` callback (`CONNECTED_CALLBACK`, …),
// where it has one, with `args` — run as the [CEReactions] call it happened in returns (or, in none, at the backup
// element queue's microtask).
export function fireCEHook(el, which, args) {
  backupQueued(globalThis.__dom.ceHook(el._nid, el, which, args));
}

// HTML "adopt": every custom element in the adopted subtree gets an
// `adoptedCallback(oldDocument, newDocument)` reaction (a moved element's
// disconnected → adopted → connected sequence, or a bare `document.adoptNode`).
// Shadow-aware to match the connect / disconnect walks.
export function fireCEAdopted(subtree, oldDoc, newDoc) {
  backupQueued(globalThis.__dom.ceSubtreeHook(subtree._nid, ADOPTED_CALLBACK, [oldDoc, newDoc]));
}

// `attributeChangedCallback(name, oldValue, newValue, namespace)`
// for custom elements per the CE spec. Gated on the element's class
// declaring an `observedAttributes` array so non-CE elements (and
// CEs that opted out) pay nothing. Turbo's `FrameElement` observes
// `loading` / `src` / `disabled` / `complete` / `busy`; setting
// `frame.src = url` would otherwise mutate the attribute but never
// dispatch the chain that issues the fetch.
// `name` is the attribute's LOCAL name — what `observedAttributes` lists — and `namespace` its namespace (null for the
// attributes in none), which the callback receives as its fourth argument.
// The reaction to an attribute change (HTML "handle attribute changes"): enqueued, to run as the call that changed it
// returns.
// (Plain elements — the hot case, every setAttribute — answer on the state bit, with no call.)
export function enqueueAttributeChanged(el, name, oldValue, newValue, namespace = null) {
  if (!el || el._nodeType !== NODE_ELEMENT || !hasState(el, STATE_CUSTOM)) return;
  backupQueued(globalThis.__dom.ceAttributeChanged(el._nid, el, name, oldValue, newValue, namespace));
}

// HTML option "selectedness" model. An option's *selectedness* is internal state (`:checked`, the element state's
// STATE_SELECTED bit) distinct from the `selected` content attribute (`defaultSelected`): `.selected` / `:checked` /
// `select.value` read selectedness, while `[selected]` / `defaultSelected` / `:default` read the content attribute.
// They are wired together by the content-attribute change steps (an authored `selected`, when the option is not dirty,
// sets selectedness true) and decoupled by the IDL setter / `select_option` (which set its dirtiness,
// STATE_SELECTED_DIRTY). Keeping them separate is what lets selectedness survive an option being moved *out* of its
// select (real-browser / WPT moveBefore semantics) and lets a freshly-inserted selected option win over the incumbent.
// What the rules decide is the engine's (validity.rs `option_initialised`, `selectedness`, `option_disabled`); the
// options it changes are told to their selects here (`optionsChanged`).

// Initialise an option's selectedness from its authored `selected` content attribute exactly once (the parse-time
// default), however the option entered the tree (parser connect-walk, innerHTML replace, detached createElement +
// appendChild); a dirty one keeps its own.
export function ensureOptionSelInit(o) {
  if (!hasState(o, STATE_SELECTED_INIT)) optionsChanged(initialiseOptions(o));
}

// Nearest ancestor `<select>` of `node` (inclusive), walking past
// optgroup / arbitrary wrappers. Returns null when `node` is not in a
// select.
export function ownerSelectOf(node) {
  return node ? htmlAncestorOf(node, 'select', true) : null;
}


// HTML "selectedness setting algorithm" for a `<select>`. `justSelected`
// is the option that was just made selected (via insertion of an already
// selected option, or via the IDL setter), excluded from the de-dup pass
// so it wins over the incumbent. With `justSelected` null this is the
// plain reset run on insert / remove / parse.
export function runSelectednessAlgorithm(select, justSelected, deferContent) {
  if (!select || select._tag !== 'select') return;
  // A multiple-select has no implicit default and no single-selection
  // invariant to maintain, so there is nothing to reconcile — bail before
  // the O(N) option scan so a bulk `option.selected = true` loop over a
  // large multi-select stays O(N) overall (rule 3). Its options are
  // initialised independently (connect walk / finalizeSelectOptions).
  if (select._attrs.multiple != null) { syncSelectedContent(select, deferContent); return; }
  // (…the engine's run of it — every option initialised from its content attribute first, however the options were
  // built)
  optionsChanged(runSelectedness(select, justSelected));
  syncSelectedContent(select, deferContent);
}
// …and its `<selectedcontent>` made to mirror the selection — now, or (`deferContent`) at the next microtask.
export function syncSelectedContent(select, deferContent) {
  if (!elementFlag(select, SELECT_HAS_SELECTED_CONTENT)) return;
  if (deferContent) scheduleSelectedContentUpdate(select);
  else updateSelectedContent(select);
}

// Per-spec the `<selectedcontent>` update on a CHANGE (selectedness change, option
// removal, atomic move, value/selectedIndex set) is deferred to a microtask — only a
// fresh CONNECTION / parse updates it synchronously (in post-connection steps). This
// queues a deduped per-select microtask so e.g. moving the selected option doesn't
// rewrite selectedcontent until after the current task (selectedcontent-movebefore,
// -insertion-removal). The Capybara settle drains the microtask before the next read. The selects waiting are the
// engine's (selected_content.rs `queueSelectedContentUpdate`): the first queued queues the microtask that takes them.
export function scheduleSelectedContentUpdate(select) {
  if (!select || select._tag !== 'select' || !elementFlag(select, SELECT_HAS_SELECTED_CONTENT)) return;
  if (!globalThis.__dom.queueSelectedContentUpdate(select._nid)) return;
  globalThis.__csimQueueMicrotask(() => {
    for (const s of globalThis.__dom.takeSelectedContentUpdates()) { try { updateSelectedContent(s); } catch (_) {} }
  });
}

// HTML `<selectedcontent>`: each of a select's a snapshot of its selected option's content, re-cloned as the selection
// settles or it (re)connects — the engine's (selected_content.rs `updateSelectedContent`, through the bindings' change
// plumbing: dom-nodes.js `updateSelectedContentOf`). An update that leaves one as it is changes nothing — the parse-time
// re-runs as options stream in record nothing (selectedcontent-mutations) — but a `force`d one (a re-insertion) clones
// afresh. Re-entrancy guarded: the clones' connection can run a custom element's hook that updates the same select.
// The hot caller (runSelectednessAlgorithm) gates on SELECT_HAS_SELECTED_CONTENT so an ordinary select never pays
// (rule 3).
let selectedContentUpdater = () => {};
export function setSelectedContentUpdater(fn) { selectedContentUpdater = fn; }
export function updateSelectedContent(select, force) {
  if (!select || select._tag !== 'select' || elementFlag(select, SELECT_IN_UPDATE)) return;
  setElementFlag(select, SELECT_IN_UPDATE, true);
  try {
    selectedContentUpdater(select, !!force);
  } finally {
    setElementFlag(select, SELECT_IN_UPDATE, false);
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
  setElementFlag(select, SELECT_HAS_SELECTED_CONTENT, true);
  // First connection (parse build) fills idempotently; a RE-connection (the
  // selectedcontent was previously connected and got moved/re-inserted) is a tree
  // mutation that re-clones per spec — force it so the node replacement records.
  const reconnect = elementFlag(sc, EVER_CONNECTED);
  setElementFlag(sc, EVER_CONNECTED, true);
  updateSelectedContent(select, reconnect);
}

// HTML "ask for a reset" of a tree change — the engine's (validity.rs `ask_for_reset`): `nodes` inserted into `parent`
// (`inserted`), or removed from it — the select they are or were in, where any, running the selectedness setting
// algorithm, a just-inserted selected option (the last such, for a batch) winning over the incumbent. Its options that
// changed are told, and its `<selectedcontent>` follows.
// (…gated here first, as the overwhelming majority of mutations on an Avo-scale page are of no option or optgroup, into
// no select or optgroup, by the tags alone: no call, nothing made, for them — rule 3)
const affectsSelectedness = (node, parent) =>
  parent._tag === 'select' || parent._tag === 'optgroup' || node._tag === 'option' || node._tag === 'optgroup';
function askForResetIn(parent, nodes, inserted, deferContent) {
  const answer = askForResetOf(parent, nodes, inserted);
  if (answer === undefined) return;
  optionsChanged(answer[1]);
  syncSelectedContent(answer[0], deferContent);
}
// …for one node inserted (insertBefore / appendChild / replaceChild / moveBefore)…
export function askForReset(child, deferContent) {
  if (!child || child._nodeType !== NODE_ELEMENT) return;
  const parent = child._parent;
  if (parent && affectsSelectedness(child, parent)) askForResetIn(parent, [child], true, deferContent);
}
// …for a batch inserted at once (a fragment's children, a replace's list): ONE reset, where the last inserted selected
// option wins — a per-child one let the first win (the jQuery `.append(fragment)` WPT case)…
export function askForResetBatch(nodes, deferContent) {
  const parent = nodes && nodes.length ? nodes[0]._parent : null;
  if (parent && nodes.some((n) => affectsSelectedness(n, parent))) askForResetIn(parent, nodes, true, deferContent);
}
// …and for a node removed from `formerParent`, whose select picks a new default — its `<selectedcontent>` following at
// the next microtask (it shows the removed option's content until then: selectedcontent-insertion-removal).
export function askForResetAfterRemoval(removedChild, formerParent) {
  if (formerParent && affectsSelectedness(removedChild, formerParent)) askForResetIn(formerParent, [removedChild], false, true);
}

// Finalize a select whose options were (re)built outside the insert hooks
// and connect walk (`select.innerHTML = …`, `replaceChildren`). Unlike the
// reconcile-only algorithm, this also initialises every option's
// selectedness from its content attribute — necessary for a multiple-select
// (which the algorithm skips), and harmless/idempotent for a single one.
export function finalizeSelectOptions(select) {
  if (!select || select._tag !== 'select') return;
  optionsChanged(initialiseOptions(select));
  // `innerHTML` / `replaceChildren` build a select's <selectedcontent> without a
  // connect walk (notably on a DETACHED select), so flag it here too — then the
  // reconcile below mirrors the initial selection into it, and later value /
  // selectedIndex changes keep it in sync even while disconnected.
  if (!elementFlag(select, SELECT_HAS_SELECTED_CONTENT) && selectFirst(select, 'selectedcontent')) {
    setElementFlag(select, SELECT_HAS_SELECTED_CONTENT, true);
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
  // (…the candidates first: an upgrade runs the element's constructor, which may replace the children being walked)
  // (…of those a definition could be for, the engine's to name: `customElementCandidatesIn`)
  upgradeEach(customElementCandidatesIn(subtree).filter((el) => ceCtorFor(el)));
}
// …and `elements`, in their order: each an element of this realm's document with a definition, not yet that definition's.
function upgradeEach(elements) {
  for (const el of elements) {
    const ctor = ceCtorFor(el);
    if (ctor && Object.getPrototypeOf(el) !== ctor.prototype && el._ownerDocument === globalThis.document) {
      upgradeElement(el, ctor);
    }
  }
}
// (…a clone's copies, of this realm's tree, which another realm's clone asks for: dom-nodes.js `upgradeCopies`)
REALM.upgradeCopies = (copies) => {
  if (totalDefinitions !== 0) upgradeEach(copies);
};

// …and enqueued instead (HTML "create an element": an upgrade reaction where it finds a definition but runs no script —
// a fragment parse's, for the realm's document), to run as the call that parsed them returns.
export function ceEnqueueUpgradesIn(subtree) {
  if (totalDefinitions === 0) return;
  for (const el of customElementCandidatesIn(subtree)) {
    const ctor = ceCtorFor(el);
    if (ctor && Object.getPrototypeOf(el) !== ctor.prototype) enqueueUpgrade(el, ctor);
  }
}

// CE side of fireCEConnect's per-element walk: upgrade if pending,
// then fire `connectedCallback`. Script and `<link>` handling stays
// in bridge.entry.js because both need closure state
// (`__inHTMLGrafting`) the IIFE owns.
export function ceTryConnect(el) {
  // Custom element state "FAILED": the parser already ran this element's
  // constructor and it threw / returned the wrong thing, so the parser built
  // an HTMLUnknownElement fallback (constructParsedCustomElement). A failed
  // element never upgrades and never gets reactions — retrying here would
  // resurrect the very definition the parser rejected.
  if (elementFlag(el, CE_FAILED)) return;
  const ctor = ceCtorFor(el);
  if (!ctor) {
    // An ALREADY-upgraded element whose registry re-pointed to null (adopted
    // into an inert document) still gets its connectedCallback — reactions are
    // per-element once custom, independent of the current registry resolution.
    if (hasState(el, STATE_UPGRADED)) {
      fireCEHook(el, CONNECTED_CALLBACK);
      if (formAssociatedReset) formAssociatedReset(el);
    }
    return;
  }
  // UPGRADE (constructing an undefined element) needs a browsing context — HTML
  // "look up a custom element definition" returns null without one, so connecting an
  // undefined element into an INERT document (createHTMLDocument / createDocument /
  // cloned / DOMParser) must NOT upgrade it. connectedCallback, by contrast, fires on
  // connection to ANY document, so an ALREADY-upgraded element still gets it there
  // (a never-upgraded element has no definition, so fireCEHook is a no-op).
  // An upgrade is a reaction of its own (HTML "try to upgrade an element": enqueued), which runs as the call that connected
  // the element returns — after the scripts the same insertion runs — and enqueues the element's connectedCallback; the
  // parser's (`ceState.parsing`) constructs it at once.
  if (Object.getPrototypeOf(el) !== ctor.prototype && el._ownerDocument === globalThis.document) {
    if (ceState.parsing !== 0) upgradeElement(el, ctor);
    else enqueueUpgrade(el, ctor);
  } else {
    fireCEHook(el, CONNECTED_CALLBACK);
  }
  // Connecting can change the owner or disabled state of an ALREADY-upgraded
  // form-associated element (a move into a form's / disabled-<fieldset>'s subtree, or
  // its `form=` target now resolving). upgradeElement above already reconciled a fresh
  // upgrade; this covers the rest.
  if (formAssociatedReset) formAssociatedReset(el);
}

// A form-associated custom element's form owner and disabled state re-derived — `which` of them — by the engine, which
// enqueues the callbacks whatever changed is owed (ce_reactions.rs `ceFormStateReset`); whether its form owner changed.
export const FACE_FORM_OWNER = 1, FACE_DISABLED_STATE = 2;
export function resetCustomElementFormState(el, which) {
  const answer = globalThis.__dom.ceFormStateReset(el._nid, el, which);
  backupQueued((answer & 2) !== 0);
  return (answer & 1) !== 0;
}
// …the form owners of those in `root`'s tree a `form` attribute names it for (ce_reactions.rs `ceFormOwnersReset`):
// whether one changed.
export function resetFormOwnersNamedIn(root) {
  const answer = globalThis.__dom.ceFormOwnersReset(root._nid);
  backupQueued((answer & 2) !== 0);
  return (answer & 1) !== 0;
}
// …for those in `subtree` — which went in or
// out of a tree that is not connected: HTML's insertion and removing steps run whether or not it is (a connected one's
// run in the connection walks).
export function resetFormStateIn(subtree) {
  if (!anyFormAssociatedCE || !formAssociatedReset) return;
  for (const el of upgradedElementsIn(subtree)) formAssociatedReset(el);
}
// A subtree taken out of a connected tree: its custom elements' disconnectedCallback, shadow-including — balancing the
// shadow-aware connect (fireCEConnect, the same order) — and a form-associated element's form owner and disabled state
// re-derived, now that its form or disabled `<fieldset>` is no ancestor (enqueuing formAssociatedCallback(null) /
// formDisabledCallback(false): the removing steps).
export function fireCEDisconnect(subtree) {
  backupQueued(globalThis.__dom.ceSubtreeHook(subtree._nid, DISCONNECTED_CALLBACK));
  resetFormStateIn(subtree);
}

// CE reactions for an atomic move (`moveBefore`) of a CONNECTED subtree, per element in tree order (HTML "Reactions to
// atomic move are called in order of element, not in order of operation"): an element whose definition has
// `connectedMoveCallback` gets ONLY that; otherwise the disconnectedCallback + connectedCallback pair. The element never
// leaves the tree during the move, so `isConnected` stays true throughout both. Shadow-including, as the connect and
// disconnect reactions are.
export function fireCEMoveReactions(subtree) {
  backupQueued(globalThis.__dom.ceSubtreeHook(subtree._nid, CONNECTED_MOVE_CALLBACK));
}

globalThis.CustomElementRegistry = CustomElementRegistry;
