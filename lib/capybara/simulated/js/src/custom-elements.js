// Custom Elements registry + lifecycle hooks: the bindings' share of HTML §4.13 — what reads a page's values (define()'s
// constructor, callbacks and static members) and what calls its code (constructors, callbacks). What is decided — the
// definitions and their lookups, an element's custom element state, the reactions owed and when they run, the
// construction stacks an upgrade's `super()` finds its element on — is the engine's (ce_reactions.rs), the agent's
// whichever realm's bindings ask.

import { SELECT_HAS_SELECTED_CONTENT, EVER_CONNECTED, SELECT_IN_UPDATE, elementFlag, setElementFlag } from './element-flags.js';
import { selectFirst } from './selectors.js';
import { optionsChanged } from './form-helpers.js';
import { bumpCascadeVersion } from './mutation-observer.js';
import { NODE_ELEMENT, HTML_NS, isHtml } from './constants.js';
import { logThrew }                 from './console.js';
import { isKnownHtmlElementName }   from './html-element-names.js';
import {
  hasState, htmlAncestorOf, initialiseOptions, runSelectedness, askForResetOf, setElementState,
  rareDataOf, customElementsIn, STATE_CUSTOM, STATE_FORM_ASSOCIATED,
  STATE_SELECTED_INIT, STATE_UPGRADED, STATE_PRECUSTOMIZED, isValueOf as engineIsValueOf, nodeDocumentOf, parentOrHostOf
} from './native-query-shadow.js';
import { isCallable, makeSlots, registerInterface, rejectedPromise, resolvedPromise, setCEReactionsRunner, slotsOf, createObject, reflectConstruct, rootInterface } from './webidl.js';
import { installCustomElementRegistry } from './generated/bindings.js';
import { DOMException } from './dom-exception.js';
import { attrsOf, namespaceOf, nidOf, nodeTypeOf, isShadowRoot } from './node-identity.js';
import { setCeInitialized, setNoBrowsingContext } from './document-state.js';
import { dom, engineOf, hostSteps } from './engine.js';

// Custom element definitions live PER CustomElementRegistry instance — in the engine (ce_reactions.rs), which looks one
// up by name, by local name and is value, and by constructor; the global `customElements` is one such instance. An
// element resolves definitions through its ASSOCIATED registry — its `ceRegistryOf` if it was created in a scoped shadow
// tree / document, otherwise the global one. How many there are, in every realm, the engine counts (`ceStack[4]`): the
// cheap gate for the walks only a definition makes owed.
let ceView = null;
export const ceStackView = () => (ceView ??= dom.ceStack);
export const hasAnyCEDefinitions = () => ceStackView()[4] !== 0;
// The definition a constructor was registered with, in any registry — the latest — or undefined: what the HTML
// constructor's sanity checks (dom-class-aliases.js) ask of a NewTarget, registry-agnostic, a scoped-registry element
// constructing through the same interface constructor; and the Element constructor's scoped-only rejection (new-able
// only through the global registry). One whose realm went is none.
export const ctorDefinition = (ctor) => dom.ceConstructorDefinition(ctor);
export const ctorHasAnyDefinition = (ctor) => ctorDefinition(ctor) !== undefined;
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
// registry, until a scoped registry's initialize() associates one (`ceRegistryOf`).
// A document's WINDOW registry: its realm's global registry for a live
// (browsing-context) document, null for an inert one — the engine's, which a document
// is given as it gets or loses a browsing context (`setWindowRegistryOf`). This — never
// the initialize()d association below — is what an element in the UNSET state
// tracks, and what a non-scoped registry re-points to on adoption: a scoped
// initialize() on an inert document associates new CREATIONS with the scoped
// registry, but adopted-in default elements still land on null.
export function windowRegistryOf(doc) {
  if (!doc) return customElements;   // ownerless node — pre-feature global fallback
  return dom.ceWindowRegistry(doc) ?? null;
}
// …given to `doc` with its browsing context (`registry`, its window's), or taken away (null).
export function setWindowRegistryOf(doc, registry) {
  setNoBrowsingContext(doc, registry === null);
  dom.ceSetWindowRegistry(doc, registry === null ? 0 : registryCodeOf(registry), registry);
}
// The registry of a document, an element or a shadow root, as the engine resolves it (ce_reactions.rs `registry_for`):
// its own where one is set — null for the null registry, and for the template contents' tracking null — else its node
// document's window registry (a document's own). An element's unset association (the common case) TRACKS THE NODE
// DOCUMENT — that is what makes cross-document adoption re-point a global-registry element for free; an explicit scoped
// registry is pinned; null is the "null registry" state (an upgrade candidate that never matches a definition). A
// document's is its ACTIVE registry — the initialize()d association when one exists, else the window registry: what
// `document.customElementRegistry` is, and newly created elements get.
export function documentRegistry(doc) {
  return doc ? dom.ceRegistryFor(doc) ?? null : customElements;
}
export function registryForElement(el) {
  return el ? dom.ceRegistryFor(el) ?? null : customElements;
}
export function shadowRootRegistry(root) {
  return dom.ceRegistryFor(root) ?? null;
}
// HTML "look up a custom element definition" for `registry` given a local name and is value — the create-time
// counterpart of `ceDefinitionFor` (which reads the pair off an existing element). Autonomous match: a definition NAMED
// localName whose own local name equals its name. Customized-built-in match: a definition whose local name is
// localName and whose name is the element's is value. A null registry matches nothing.
export function lookupCEDefinition(registry, localName, isValue) {
  return registry ? dom.ceLookUp(registryCodeOf(registry), localName, isValue == null ? undefined : String(isValue)) : undefined;
}
// …and the definition named `name` of `registry`, or undefined.
function namedDefinition(registry, name) {
  return dom.ceNamed(registryCodeOf(registry), name);
}
// HTML "look up a custom element definition" for `el`: its registry's — a constructor two scoped registries define is
// two definitions, each with the callbacks it was defined with — by (HTML namespace + local name + is value), NOT its
// qualified tag, so an XML/XHTML element carrying a namespace prefix (`html:custom-el`, localName `custom-el`) still
// upgrades by its local name (shadow-dom/innerHTML-setter.xhtml); or undefined.
function ceDefinitionFor(el) {
  if (!el || namespaceOf(el) !== HTML_NS) return undefined;
  return dom.ceDefinitionFor(el);
}
// What a definition is beside its callbacks, as define() read it (the engine's `DEFINE_*`: an element it makes custom is
// form-associated by it, and an upgrade refuses a shadow root it disables). How many form-associated ones there are, in
// every realm, the engine counts (`ceStack[5]`), so a page that defines none short-circuits every gate to O(1) (rule 3).
const DEFINE_FORM_ASSOCIATED = 1, DEFINE_DISABLE_SHADOW = 2;
const anyFormAssociatedCE = () => ceStackView()[5] !== 0;
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
export const hasFormAssociatedCustomElements = anyFormAssociatedCE;
// A form-associated custom element's restored persisted state (HTML §4.13.7.4): its formStateRestoreCallback enqueued
// with it and "restore" — or, for an element not upgraded yet, kept until it is (`upgradeElement`); one no definition
// makes form-associated, none.
export function restoreFormStateOf(el, state) {
  if (isFormAssociatedCustomElement(el)) fireCEHook(el, FORM_STATE_RESTORE_CALLBACK, [state, 'restore']);
  else if (!hasState(el, STATE_UPGRADED)) rareDataOf(el, true).pendingFormState = state;
}
// `el` made custom by definition `def`, by its constructor (HTML's HTML element constructor, its definition's
// construction stack empty: a direct `new`, or "create an element" constructing synchronously): its definition set and
// its custom element state "custom" — a form-associated custom element where the definition is form-associated — the
// engine's.
export function becomeCustom(el, def) {
  dom.ceMakeCustom(el, def.id, def);
}
// …and an element in custom element state "failed" (HTML "create an element": a construction that threw, or returned
// no fitting element, makes one in its stead).
export function markFailed(el) {
  setElementState(el, STATE_UPGRADED | STATE_PRECUSTOMIZED | STATE_CUSTOM, STATE_UPGRADED);
}
// Whether `el` is custom (state "custom"): what its definition's reactions are owed to.
export const isCustom = (el) => hasState(el, STATE_CUSTOM);

// The custom element reactions (HTML §4.13.6), the engine's (ce_reactions.rs): an element's callback reaction enqueued
// on its reaction queue, and the element on the current call's element queue — or on the backup one, whose microtask
// runs it, which an op that enqueued one there says is to be queued.
function backupQueued(queue) {
  if (queue) globalThis.__csimQueueMicrotask(runBackupElementQueue);
}
// …a reaction the engine enqueued there itself (attributes.rs: an attribute's change).
export function queueBackupReactions() {
  globalThis.__csimQueueMicrotask(runBackupElementQueue);
}
// HTML "invoke custom element reactions": each element's reactions in turn, those enqueued as they run included, a
// callback's exception reported. (…the engine's list read by index: a for…of would walk it by the iterator
// `Array.prototype` has, which a page replaces, and hand the page every element whose reactions run)
function invokeReactions(elements) {
  for (let i = 0; i < elements.length; i++) runReactionsOf(elements[i]);
}
// …one element's.
function runReactionsOf(el) {
  for (let r; (r = dom.ceTakeReaction(nidOf(el))) !== undefined;) {
    try { Reflect.apply(r[0], el, r[1]); } catch (e) { reportCallbackError(r[0], e); }
  }
}
function reportCallbackError(callback, e) {
  try { globalThis.__csimReportCallbackError(callback, e); } catch (_) { logThrew('custom element reaction', e); }
}
function runBackupElementQueue() {
  invokeReactions(dom.ceTakeBackup());
}
// …which a microtask checkpoint runs too, where the queue holds an element (`ceStack[2]`, no call): the microtask queued
// for it is one realm's, which a page left or a frame removed takes with it.
globalThis.__csimRunBackupReactions = runBackupElementQueue;
// …and the part of it realm `cid`'s elements are, as that realm goes: a frame navigates here at once, where a browser
// keeps the old document until the new one commits — and its microtask runs before then.
hostSteps.runBackupReactionsOf = (cid) => invokeReactions(dom.ceTakeBackup(cid));
// …and the element queue of the [CEReactions] call that returns (webidl.js `ceLeave`), popped.
setCEReactionsRunner((depth) => invokeReactions(dom.ceTakeQueue(depth)));
// A form-associated custom element: one made CUSTOM by a form-associated definition (a failed upgrade leaves it
// none, as it leaves the element no definition).
export function isFormAssociatedCustomElement(el) {
  return anyFormAssociatedCE() && el != null && hasState(el, STATE_FORM_ASSOCIATED);
}
// (`parsing`: how many parser connections run — the elements the parser connects are its "create an element for a
// token"'s, constructed at once where their definition is there, inside its markup insertion guard, not upgraded later)
export const ceState = { parsing: 0 };

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
export const isValidCustomElementName = (name) => dom.validCustomElementName(name);

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
  try { reflectConstruct(CONSTRUCT_PROBE, [], fn); return true; }
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
  return s.code || (s.code = engineOf(s.global).ceMakeRegistry(r, s.scoped));
}
// A node's custom element registry — an element's, a shadow root's, a document's: undefined for none set (it tracks its
// node document's), TRACKING_NULL for the template contents' null, null for the null registry, or a registry — its
// handle's (ce_reactions.rs), whose insertions carry the tracking null in and out of template contents.
export function ceRegistryOf(node) {
  return dom.ceRegistryOf(node, TRACKING_NULL);
}
export function setCeRegistryOf(node, registry) {
  dom.ceSetRegistry(node, registryCodeOf(registry), registry);
}
registerInterface('CustomElementRegistry', isRegistry);
// (…every one scoped but the window's, made first: `customElements`)
let windowRegistryMade = false;
export class CustomElementRegistry extends Object {
  constructor() {
    const scoped = windowRegistryMade;
    windowRegistryMade = true;
    const self = createObject(new.target);
    const slots = makeSlots(self, 'CustomElementRegistry');
    slots.scoped = scoped;
    // author-constructed registries are scoped; the window's one (`customElements`) not
    slots.code = 0;
    // what a node's association names it by (ce_reactions.rs), made as it first is one
    slots.global = globalThis;
    // …in its own realm (the window's is made into the snapshot, before any engine is there)
    slots.definitions = [];
    // its definitions' objects, which hold their callbacks: the engine holds them weakly, as they live with the registry
    slots.whenDefined = new Map();
    // its when-defined promise map, name -> { promise, resolve }: promises its page holds
    slots.steps = registrySteps;
    return self;
  }
}
rootInterface(CustomElementRegistry);
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

  // HTML "CustomElementRegistry.define(name, constructor, options)". What refuses it is the engine's to say, in the
  // spec's order (`ceDefineCheck`: name validity, the name and the constructor already defined, `extends` — refused by a
  // scoped registry, a valid custom element name or an HTMLUnknownElement name — and a definition already running,
  // whose flag it then sets) after IsConstructor, which asks the constructor; what the constructor gives — its callbacks,
  // observed attributes, disabled features and form-associatedness, read under the flag, getter, iterator and
  // conversion errors rethrown — is read here; the definition made, its candidates' upgrades enqueued, is the engine's
  // again (`ceDefine`); and the when-defined promise resolved as it returns.
  define(self, n, constructor, options) {
    if (!isConstructor(constructor)) {
      throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': the provided constructor is not a constructor.");
    }
    const code = registryCodeOf(self);
    const extendsName = options.extends ?? null;
    const refusal = dom.ceDefineCheck(code, n, constructor, extendsName, extendsName !== null && isKnownHtmlElementName(extendsName));
    if (refusal !== 0) throw defineRefusal(refusal, n, extendsName);
    // (…a customized built-in's local name the one it extends: `<button is="my-button">` matches, not `<my-button>`)
    const localName = extendsName ?? n;
    let formAssociated = false, disableInternals = false, disableShadow = false;
    // (…the callbacks, and the attributes it observes, as they are now: a later write to the prototype changes nothing
    // the definition calls)
    const callbacks = new Array(CALLBACKS.length);
    let observed = [];
    try {
      const prototype = constructor.prototype;
      if (prototype === null || (typeof prototype !== 'object' && typeof prototype !== 'function')) {
        throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': the constructor's prototype property is not an object.");
      }
      const collect = (from, to) => {
        for (let i = from; i < to; i++) {
          const v = prototype[CALLBACKS[i]];
          if (v !== undefined && !isCallable(v)) {
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
      // (…and the features it disables, as `disabledFeatures` says them now: the definition's flags, which attachInternals
      // and attachShadow read — never the page's getter again)
      const df = constructor.disabledFeatures;
      if (df !== undefined) {
        for (const feature of toSequenceDOMString(df)) {
          if (feature === 'internals') disableInternals = true;
          else if (feature === 'shadow') disableShadow = true;
        }
      }
      formAssociated = Boolean(constructor.formAssociated);
      if (formAssociated) collect(LIFECYCLE_CALLBACKS, CALLBACKS.length);
    } finally {
      dom.ceDefineEnd(code);
    }
    // (…the engine's, which a lookup answers with the object kept here — which holds the callbacks the engine holds weakly:
    // a definition lives with its registry)
    const def = { name: n, ctor: constructor, localName, callbacks, formAssociated, disableInternals, disableShadow, id: -1 };
    const made = dom.ceDefine(code, n, localName, def, callbacks, observed, constructor,
      (formAssociated ? DEFINE_FORM_ASSOCIATED : 0) | (disableShadow ? DEFINE_DISABLE_SHADOW : 0), upgradeReaction);
    def.id = made[0];
    registryOf(self).definitions.push(def);
    backupQueued(made[1]);
    // Form-associatedness is registry state that a STATIC pseudo-class reads: `:disabled` / `:enabled` start matching
    // every existing element of this name (its `disabled` attribute was inert until now). Nothing on the element or its
    // ancestors moved, and a `:disabled` rule is not tainted — so this is a rule-set-shaped change for the memos: move the
    // version.
    if (formAssociated) bumpCascadeVersion();
    resolveWhenDefined(registryOf(self), n, constructor);
  },

  get(self, name) { return namedDefinition(self, name)?.ctor; },

  // HTML "CustomElementRegistry.getName(constructor)": the name a constructor was
  // registered under, or null.
  getName(self, constructor) {
    return dom.ceConstructorDefinition(constructor, registryCodeOf(self))?.name ?? null;
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
    const doc = nodeTypeOf(root) === 9 ? root : nodeDocumentOf(root);
    if (!r.scoped && (nodeTypeOf(root) === 9 || documentRegistry(doc) !== self)) {
      throw new DOMException("Failed to execute 'initialize' on 'CustomElementRegistry': a non-scoped registry can initialize only a tree of its own document.", 'NotSupportedError');
    }
    if (nodeTypeOf(root) === 9) {
      // (…marked on the document, whichever realm's code creates in it: the gate of a creation's pin)
      if (documentRegistry(root) === null) { setCeRegistryOf(root, self); setCeInitialized(root, true); }
    } else if (isShadowRoot(root)) {
      if (shadowRootRegistry(root) === null) setCeRegistryOf(root, self);
    }
    // (…each inclusive descendant element with a null registry given this one, and each of this one tried for an upgrade:
    // the engine's)
    backupQueued(dom.ceTryUpgrades(root, TRY_INITIALIZE, registryCodeOf(self), upgradeReaction));
  },

  // HTML upgrade(root): each of root's shadow-including inclusive descendant elements whose registry is this one tried
  // for an upgrade, in shadow-including tree order — the engine's. Lit / Stencil flows that build elements off-document
  // then call `customElements.upgrade(fragment)` before attaching depend on it.
  upgrade(self, root) {
    backupQueued(dom.ceTryUpgrades(root, TRY_REGISTRY, registryCodeOf(self), upgradeReaction));
  }
};
// What `ceTryUpgrades` tries (ce_reactions.rs `TRY_*`): what a clone, an import or a fragment parse made, each by its own
// registry; the elements of a registry under a root; initialize()'s.
const TRY_MADE = 0, TRY_REGISTRY = 1, TRY_INITIALIZE = 2;
// What refuses a definition (ce_reactions.rs `DEFINE_*` refusals), as the exception define() throws.
function defineRefusal(refusal, n, extendsName) {
  const message = (m) => `Failed to execute 'define' on 'CustomElementRegistry': ${m}`;
  switch (refusal) {
    case 1: return new DOMException(message(`"${n}" is not a valid custom element name.`), 'SyntaxError');
    case 2: return new DOMException(message(`the name "${n}" has already been used with this registry.`), 'NotSupportedError');
    case 3: return new DOMException(message('the constructor has already been used with this registry.'), 'NotSupportedError');
    case 4: return new DOMException(message('a scoped registry cannot define a customized built-in element.'), 'NotSupportedError');
    case 5: return new DOMException(message(`"${extendsName}" is a valid custom element name, so it cannot be extended.`), 'NotSupportedError');
    case 6: return new DOMException(message(`"${extendsName}" is not a valid local name for a customized built-in element.`), 'NotSupportedError');
    default: return new DOMException(message('an element definition is already running.'), 'NotSupportedError');
  }
}

// The ONE non-scoped registry (HTML: the window's registry). `initialize` refuses
// documents for it, and adoption re-points elements associated with it.
export const customElements = new CustomElementRegistry();

// The AUTONOMOUS constructor registered under global-registry name `tag`, or
// HTML "look up a custom element definition" for `el` — its registry's, by its namespace, local name and is value —
// as attachShadow and attachInternals ask it: whether the definition disables a shadow root, and the definition an
// autonomous custom element (no is value) has — whose internals it may disable, and whether it is form-associated.
export function shadowDisabled(el) {
  return ceDefinitionFor(el)?.disableShadow === true;
}
export function autonomousDefinitionOf(el) {
  return engineIsValueOf(el) == null ? ceDefinitionFor(el) : undefined;
}

// The definition a DIRECT `new MyCustomElement()` constructs by — the window registry's whose constructor it is (HTML's
// HTML element constructor: "the current global object's" registry; a constructor only scoped registries define is
// none): its local name what the element is made with (a customized built-in's the one it extends), and, for a
// customized built-in, its name the element's is value.
export function globalDefinitionOf(ctor) {
  return dom.ceConstructorDefinition(ctor, registryCodeOf(customElements));
}

// HTML "upgrade an element" by definition `def`: the engine's steps (`ceUpgrade`) — which return at once for an element
// not "undefined" or "uncustomized", and otherwise enqueue the reactions it is owed (attributeChanged for each attribute
// its definition observes, in its attribute-list order; connected, where it is connected), push it onto `def`'s
// construction stack and make it "precustomized" — then its constructor constructed, whose `super()` takes the element
// off the stack (dom-nodes.js `Element`), and the engine's end of it (`ceUpgradeEnd`): "custom", or, where anything
// threw or the constructor returned another object, its definition and reactions taken back, its state left "failed" or
// "precustomized" and its prototype what the constructor left it (the class's where `super()` was reached: Chrome,
// Firefox) — and the exception reported, as "invoke custom element reactions" reports a reaction's.
// Whether it did not throw (an element it owed nothing is none that threw).
export function upgradeElement(el, def) {
  const steps = dom.ceUpgrade(el, def.id, def);
  if (steps === 0) return true;
  backupQueued(steps & UPGRADE_BACKUP);
  let constructed = false, thrown;
  try {
    if (steps & UPGRADE_SHADOW_REFUSED) {
      throw new DOMException("Failed to upgrade custom element: its definition disables shadow roots, and it has one.", 'NotSupportedError');
    }
    if (reflectConstruct(def.ctor, [], def.ctor) !== el) {
      throw new TypeError('The custom element constructor did not return the element being upgraded.');
    }
    constructed = true;
  } catch (e) {
    thrown = e;
  } finally {
    // (…ended whatever happened — a termination too, which must leave no element on the construction stack)
    dom.ceUpgradeEnd(el, def.id, def, constructed);
  }
  if (!constructed) {
    reportCallbackError(def.ctor, thrown);
    return false;
  }
  // A newly upgraded form-associated element reconciles its owner + disabled state
  // (HTML upgrade steps: enqueue formAssociatedCallback with the owner when non-null,
  // formDisabledCallback when disabled) — the single seam covering every upgrade path
  // (define's candidates, upgrade(), initialize(), a clone's or a parse's, a connection).
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
  return true;
}
const UPGRADE_SHADOW_REFUSED = 2, UPGRADE_BACKUP = 4;

// HTML "enqueue a custom element upgrade reaction": `el` upgraded by `def` as its reactions run (ce_reactions.rs
// `ceEnqueueUpgrade`) — enqueued again where it is already, as HTML has it: one it no longer owes returns at once.
function enqueueUpgrade(el, def) {
  backupQueued(dom.ceEnqueueUpgrade(nidOf(el), el, upgradeReaction, [def]));
}
function upgradeReaction(def) {
  upgradeElement(this, def);
}

// HTML "enqueue a custom element callback reaction": `el`'s definition's `which` callback (`CONNECTED_CALLBACK`, …),
// where it has one, with `args` — run as the [CEReactions] call it happened in returns (or, in none, at the backup
// element queue's microtask).
export function fireCEHook(el, which, args) {
  backupQueued(dom.ceHook(nidOf(el), el, which, args));
}

// HTML "adopt": every custom element in the adopted subtree gets an
// `adoptedCallback(oldDocument, newDocument)` reaction (a moved element's
// disconnected → adopted → connected sequence, or a bare `document.adoptNode`).
// Shadow-aware to match the connect / disconnect walks.
export function fireCEAdopted(subtree, oldDoc, newDoc) {
  backupQueued(dom.ceSubtreeHook(nidOf(subtree), ADOPTED_CALLBACK, [oldDoc, newDoc]));
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
  if (!el || nodeTypeOf(el) !== NODE_ELEMENT || !hasState(el, STATE_CUSTOM)) return;
  backupQueued(dom.ceAttributeChanged(nidOf(el), el, name, oldValue, newValue, namespace));
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
  if (!select || !isHtml(select, 'select')) return;
  // A multiple-select has no implicit default and no single-selection
  // invariant to maintain, so there is nothing to reconcile — bail before
  // the O(N) option scan so a bulk `option.selected = true` loop over a
  // large multi-select stays O(N) overall (rule 3). Its options are
  // initialised independently (connect walk / finalizeSelectOptions).
  if (attrsOf(select).multiple != null) { syncSelectedContent(select, deferContent); return; }
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
  if (!select || !isHtml(select, 'select') || !elementFlag(select, SELECT_HAS_SELECTED_CONTENT)) return;
  if (!dom.queueSelectedContentUpdate(nidOf(select))) return;
  globalThis.__csimQueueMicrotask(() => {
    for (const s of dom.takeSelectedContentUpdates()) { try { updateSelectedContent(s); } catch (_) {} }
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
  if (!select || !isHtml(select, 'select') || elementFlag(select, SELECT_IN_UPDATE)) return;
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
// changed are told, and its `<selectedcontent>` follows (`resetAnswered`). A change of children asks it of itself, the
// engine saying where it does (dom-nodes.js `changeFinished`, mutation.rs `CHANGE_ASKS_RESET`).
function askForResetIn(parent, nodes, inserted, deferContent) {
  const answer = askForResetOf(parent, nodes, inserted);
  if (answer !== undefined) resetAnswered(answer[0], answer[1], deferContent);
}
export function resetAnswered(select, changed, deferContent) {
  optionsChanged(changed);
  syncSelectedContent(select, deferContent);
}
// …for one node inserted (an option's selectedness set, moveBefore)…
export function askForReset(child, deferContent) {
  if (!child || nodeTypeOf(child) !== NODE_ELEMENT) return;
  const parent = parentOrHostOf(child);
  if (parent) askForResetIn(parent, [child], true, deferContent);
}
// …for a batch inserted at once (a fragment's children, a replace's list): ONE reset, where the last inserted selected
// option wins — a per-child one let the first win (the jQuery `.append(fragment)` WPT case)…
export function askForResetBatch(parent, nodes, deferContent) {
  askForResetIn(parent, nodes, true, deferContent);
}
// …and for a node removed from `formerParent`, whose select picks a new default — its `<selectedcontent>` following at
// the next microtask (it shows the removed option's content until then: selectedcontent-insertion-removal).
export function askForResetAfterRemoval(removedChild, formerParent) {
  if (formerParent) askForResetIn(formerParent, [removedChild], false, true);
}

// Finalize a select whose options were (re)built outside the insert hooks
// and connect walk (`select.innerHTML = …`, `replaceChildren`). Unlike the
// reconcile-only algorithm, this also initialises every option's
// selectedness from its content attribute — necessary for a multiple-select
// (which the algorithm skips), and harmless/idempotent for a single one.
export function finalizeSelectOptions(select) {
  if (!select || !isHtml(select, 'select')) return;
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

// HTML "create an element" with the synchronous custom elements flag unset — a fragment parse's, an import's, a clone's
// elements: each its registry has a definition for given an upgrade reaction, to run as the call that made them
// returns — in shadow-including tree order, the engine's (`ceTryUpgrades`). (A document with no browsing context has
// none: its window registry is null.) No definition in ANY registry, of any realm, skips the walk: cloneNode asks on
// every deep clone (Turbo StreamMessage / template.content), so a page with no custom elements pays O(1) (rule 3).
export function ceEnqueueUpgradesIn(subtree) {
  if (hasAnyCEDefinitions()) backupQueued(dom.ceTryUpgrades(subtree, TRY_MADE, 0, upgradeReaction));
}
// …and those of `elements`, a clone's copies (each element of the copy, in tree order), one by one.
export function ceEnqueueUpgradesOf(elements) {
  if (!hasAnyCEDefinitions()) return;
  for (let i = 0; i < elements.length; i++) {
    const def = ceDefinitionFor(elements[i]);
    if (def !== undefined) enqueueUpgrade(elements[i], def);
  }
}

// CE side of fireCEConnect's per-element walk — DOM "insert" step 7.7's: a custom element is owed its
// connectedCallback, any other is tried for an upgrade (HTML "try to upgrade an element": its registry's definition,
// where there is one, enqueued as an upgrade, which runs as the call that connected it returns — after the scripts the
// same insertion runs — and enqueues its connectedCallback). One being upgraded ("precustomized") or "failed" is tried
// too, and returns at the upgrade's first step. The parser's (`ceState.parsing`) constructs at once: its "create an
// element for a token". Script and `<link>` handling stays in bridge.entry.js.
export function ceTryConnect(el) {
  if (isCustom(el)) {
    fireCEHook(el, CONNECTED_CALLBACK);
  } else {
    const def = ceDefinitionFor(el);
    if (def !== undefined) {
      if (ceState.parsing !== 0) upgradeElement(el, def);
      else enqueueUpgrade(el, def);
    }
  }
  // Connecting can change the owner or disabled state of an ALREADY-upgraded
  // form-associated element (a move into a form's / disabled-<fieldset>'s subtree, or
  // its `form=` target now resolving). upgradeElement above already reconciled a fresh
  // upgrade; this covers the rest.
  if (formAssociatedReset) formAssociatedReset(el);
}

// A form-associated custom element's form owner and disabled state re-derived — `which` of them — by the engine, which
// enqueues the callbacks whatever changed is owed and notes a new owner (ce_reactions.rs `ceFormStateReset`).
export const FACE_FORM_OWNER = 1, FACE_DISABLED_STATE = 2;
export function resetCustomElementFormState(el, which) {
  backupQueued(dom.ceFormStateReset(nidOf(el), el, which));
}
// …the form owners of those in `root`'s tree a `form` attribute names it for (ce_reactions.rs `ceFormOwnersReset`).
export function resetFormOwnersNamedIn(root) {
  backupQueued(dom.ceFormOwnersReset(nidOf(root)));
}
// …for those in `subtree` — which went in or
// out of a tree that is not connected: HTML's insertion and removing steps run whether or not it is (a connected one's
// run in the connection walks).
export function resetFormStateIn(subtree) {
  if (!anyFormAssociatedCE() || !formAssociatedReset) return;
  for (const el of customElementsIn(subtree)) formAssociatedReset(el);
}
// A subtree taken out of a connected tree: its custom elements' disconnectedCallback, shadow-including — balancing the
// shadow-aware connect (fireCEConnect, the same order) — and a form-associated element's form owner and disabled state
// re-derived, now that its form or disabled `<fieldset>` is no ancestor (enqueuing formAssociatedCallback(null) /
// formDisabledCallback(false): the removing steps).
export function fireCEDisconnect(subtree) {
  backupQueued(dom.ceSubtreeHook(nidOf(subtree), DISCONNECTED_CALLBACK));
  resetFormStateIn(subtree);
}

// CE reactions for an atomic move (`moveBefore`) of a CONNECTED subtree, per element in tree order (HTML "Reactions to
// atomic move are called in order of element, not in order of operation"): an element whose definition has
// `connectedMoveCallback` gets ONLY that; otherwise the disconnectedCallback + connectedCallback pair. The element never
// leaves the tree during the move, so `isConnected` stays true throughout both. Shadow-including, as the connect and
// disconnect reactions are.
export function fireCEMoveReactions(subtree) {
  backupQueued(dom.ceSubtreeHook(nidOf(subtree), CONNECTED_MOVE_CALLBACK));
}

globalThis.CustomElementRegistry = CustomElementRegistry;
