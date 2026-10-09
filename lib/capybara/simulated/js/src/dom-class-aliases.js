import { setSelectedness } from './form-helpers.js';
import { HTML_NS, SVG_NS, MATHML_NS } from './constants.js';
import {
  htmlElementMembers, installWindowReflectedHandlers, mathMLElementMembers, registerNamespaceTargets, registerTagTarget, reparentSelectProto,
  svgElementMembers
} from './dom-nodes.js';
import { htmlDialogElementMembers } from './dialog.js';
import { HTML_ELEMENT_INSTALLS, HTML_INTERFACE_PARENTS, installHTMLElement, installMathMLElement, installSVGElement } from './generated/bindings.js';
import {
  htmlAnchorElementMembers, htmlAreaElementMembers, htmlBaseElementMembers, htmlDataListElementMembers,
  htmlEmbedElementMembers, htmlFrameElementMembers, htmlImageElementMembers, htmlLabelElementMembers,
  htmlLegendElementMembers, htmlLinkElementMembers, htmlMapElementMembers, htmlMarqueeElementMembers,
  htmlMeterElementMembers, htmlProgressElementMembers, htmlScriptElementMembers, htmlSlotElementMembers,
  htmlStyleElementMembers, htmlTemplateElementMembers, htmlTitleElementMembers, htmlTrackElementMembers
} from './html-elements.js';
import { htmlTableCellElementMembers, htmlTableElementMembers, htmlTableRowElementMembers, htmlTableSectionElementMembers } from './html-tables.js';
import {
  defineClassString, defineConstants, defineLegacyFactoryFunction, interfaceCheck, registerInterface, toBoolean, toDOMString, toUnsignedLong
} from './webidl.js';
import { IDL_MEMBER_TAGS } from './idl-owned-members.js';
import { KNOWN_HTML_TAGS } from './html-element-names.js';
import { ctorDefinition, isValidCustomElementName } from './custom-elements.js';
import { installMediaIDL } from './media.js';

// DOM constructor aliases for `instanceof` / `el.constructor === X`
// probes. The per-tag constructors (HTMLDivElement, …) keep `Element
// .prototype` (so feature-detection probes like `'download' in
// HTMLAnchorElement.prototype` walk the IDL surface our Element exposes),
// and each `Symbol.hasInstance` matches the corresponding HTML tag
// exclusively — keyed on the HTML namespace + the case-sensitive
// `_localName` (so `createElementNS(HTML_NS, "DIV")` is an
// HTMLUnknownElement, and a non-HTML-namespace element matches none).
//
// Why every HTML element constructor needs tag-aware narrowing:
// libraries routinely branch on `el instanceof HTMLXxxElement` to
// decide between code paths. Aliasing all of these to plain
// `Element` (loose check that any element passes) silently steers
// non-matching elements into the wrong branch, where they fail in
// confusing ways:
//
// - Turbo Drive's `#shouldInterceptNavigation` calls form-only
//   `#formActionIsVisitable(el)` after `el instanceof HTMLFormElement`,
//   which feeds `expandURL(undefined.toString())` and throws on `<a>`.
// - Turbo's `PageRenderer.renderElement` picks `body.replaceWith(...)`
//   vs `documentElement.appendChild(...)` on `instanceof HTMLBodyElement`;
//   loose match steered every visit into the appendChild branch and
//   stranded post-visit modals.
// - Mastodon's `HandledLink` reads `.innerText` / `.href` after
//   `instanceof HTMLAnchorElement`, crashing the timeline column
//   into the React error boundary on any non-anchor element.
// - Discourse's style-loader checks `styleTarget instanceof
//   HTMLIFrameElement` after `document.querySelector('head')` and
//   on a true result tries `styleTarget.contentDocument.head`; a
//   loose match throws TypeError there, the catch caches `null` in
//   the getTarget memo, and the next style insertion's throw aborts
//   the dev_tools initializer's Promise chain mid-flight.
//
// `HTMLElement` / `SVGElement` are the spec's "any HTML / any SVG
// element" checks — namespace-keyed (`_ns === HTML_NS` / `SVG_NS`), so a
// non-HTML-namespace element is NOT an HTMLElement. They're real
// `class extends Element` subclasses (not bare aliases) so a user's
// `class Foo extends HTMLElement` + `super()` still chains to Element's
// constructor; the namespace test lives in their `Symbol.hasInstance`.

// The implementations of the generated element interfaces' members no content attribute reflects.
const HTML_ELEMENT_MEMBERS = {
  HTMLTitleElement: htmlTitleElementMembers,
  HTMLBaseElement: htmlBaseElementMembers,
  HTMLMapElement: htmlMapElementMembers,
  HTMLLabelElement: htmlLabelElementMembers,
  HTMLLegendElement: htmlLegendElementMembers,
  HTMLDataListElement: htmlDataListElementMembers,
  HTMLEmbedElement: htmlEmbedElementMembers,
  HTMLFrameElement: htmlFrameElementMembers,
  HTMLMarqueeElement: htmlMarqueeElementMembers,
  HTMLAnchorElement: htmlAnchorElementMembers,
  HTMLAreaElement: htmlAreaElementMembers,
  HTMLImageElement: htmlImageElementMembers,
  HTMLLinkElement: htmlLinkElementMembers,
  HTMLScriptElement: htmlScriptElementMembers,
  HTMLDialogElement: htmlDialogElementMembers,
  HTMLMeterElement: htmlMeterElementMembers,
  HTMLProgressElement: htmlProgressElementMembers,
  HTMLTemplateElement: htmlTemplateElementMembers,
  HTMLSlotElement: htmlSlotElementMembers,
  HTMLTrackElement: htmlTrackElementMembers,
  HTMLStyleElement: htmlStyleElementMembers,
  HTMLTableElement: htmlTableElementMembers,
  HTMLTableSectionElement: htmlTableSectionElementMembers,
  HTMLTableRowElement: htmlTableRowElementMembers,
  HTMLTableCellElement: htmlTableCellElementMembers
};

// Constructor name → tag name. Match HTML living-spec interface map.
// When a library trips on `HTMLXxxElement` we don't have, add the
// entry here rather than reintroducing the historic loose alias.
const TAG_ELEMENT_CTORS = {
  HTMLAnchorElement:   'a',
  HTMLAreaElement:     'area',
  HTMLBodyElement:     'body',
  HTMLButtonElement:   'button',
  HTMLCanvasElement:   'canvas',
  HTMLDialogElement:   'dialog',
  HTMLDivElement:      'div',
  HTMLFieldSetElement: 'fieldset',
  HTMLFormElement:     'form',
  HTMLHeadElement:     'head',
  HTMLHtmlElement:     'html',
  HTMLIFrameElement:   'iframe',
  HTMLImageElement:    'img',
  HTMLInputElement:    'input',
  HTMLLabelElement:    'label',
  HTMLLIElement:       'li',
  HTMLLinkElement:     'link',
  HTMLMetaElement:     'meta',
  HTMLOListElement:    'ol',
  HTMLOptGroupElement: 'optgroup',
  HTMLOptionElement:   'option',
  HTMLOutputElement:   'output',
  HTMLScriptElement:   'script',
  HTMLSelectElement:   'select',
  HTMLSlotElement:     'slot',
  HTMLSpanElement:     'span',
  HTMLStyleElement:    'style',
  HTMLTableElement:    'table',
  HTMLTemplateElement: 'template',
  HTMLTextAreaElement: 'textarea',
  HTMLUListElement:    'ul',
  HTMLVideoElement:    'video',
  HTMLAudioElement:    'audio',
  HTMLSourceElement:   'source',
  HTMLTrackElement:    'track',
  HTMLPictureElement:  'picture',
  HTMLProgressElement: 'progress',
  HTMLDataListElement: 'datalist',
  HTMLDataElement:     'data',
  HTMLTimeElement:     'time',
  HTMLDetailsElement:  'details',
  HTMLEmbedElement:    'embed',
  HTMLObjectElement:   'object',
  HTMLBaseElement:     'base',
  HTMLBRElement:       'br',
  HTMLTableCaptionElement: 'caption',
  HTMLDirectoryElement: 'dir',
  HTMLDListElement:    'dl',
  HTMLFontElement:     'font',
  HTMLFrameElement:    'frame',
  HTMLFrameSetElement: 'frameset',
  HTMLHRElement:       'hr',
  HTMLLegendElement:   'legend',
  HTMLMapElement:      'map',
  HTMLMeterElement:    'meter',
  HTMLParagraphElement: 'p',
  HTMLParamElement:    'param',
  HTMLTitleElement:    'title',
  HTMLTableRowElement: 'tr',
  HTMLMenuElement:     'menu',
  HTMLMarqueeElement:  'marquee',
  HTMLSelectedContentElement: 'selectedcontent'
};

// Interfaces shared by several tags. `Symbol.hasInstance` matches any
// tag in the set (HTMLHeadingElement covers h1–h6, etc.).
const MULTI_TAG_ELEMENT_CTORS = {
  HTMLModElement:          ['del', 'ins'],
  HTMLTableColElement:     ['col', 'colgroup'],
  HTMLHeadingElement:      ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  HTMLQuoteElement:        ['blockquote', 'q'],
  HTMLPreElement:          ['pre', 'listing', 'xmp'],
  HTMLTableCellElement:    ['td', 'th'],
  HTMLTableSectionElement: ['thead', 'tbody', 'tfoot']
};

// `KNOWN_HTML_TAGS` (the HTML element-interface map) lives in
// ./html-element-names.js so `customElements.define`'s `extends` validation can
// share the exact same "maps to HTMLUnknownElement?" answer.

// Share `Element.prototype` so feature-detection probes against
// `<Ctor>.prototype` (file-saver's `'download' in HTMLAnchorElement
// .prototype`, etc.) walk the same IDL surface our Element exposes.
// The `instanceof` match keys off the HTML namespace + the CASE-SENSITIVE
// `_localName` (NOT the always-lowercased `_tag`): `createElementNS(HTML_NS,
// "DIV")` has `_localName` "DIV" and is an HTMLUnknownElement, not an
// HTMLDivElement, and an element in a non-HTML namespace matches no HTML
// interface. Normal elements have `_localName === _tag` (lowercase), so they
// match exactly as before.
// Ordinary (spec `OrdinaryHasInstance`) prototype-chain instanceof: is `C.prototype`
// on `obj`'s prototype chain? Used as the fallback when a namespace/tag interface's
// Symbol.hasInstance is reached through a SUBCLASS.
function ordinaryHasInstance(C, obj) {
  if (typeof C !== 'function') return false;
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return false;
  const proto = C.prototype;
  if (proto === null || (typeof proto !== 'object' && typeof proto !== 'function')) return false;
  for (let p = Object.getPrototypeOf(obj); p !== null; p = Object.getPrototypeOf(p)) {
    if (p === proto) return true;
  }
  return false;
}

// Wrap a namespace/tag `instanceof` predicate so it applies ONLY when invoked as the
// interface `owner` itself. A user subclass (`class Foo extends HTMLElement`) inherits
// the interface's Symbol.hasInstance but must fall back to ordinary prototype-chain
// instanceof — otherwise every element of the same namespace/tag (e.g. a not-yet-
// upgraded custom element awaiting `super()`) would spuriously test true against the
// subclass. Returns a plain function so `this` is the right-hand side of `instanceof`.
function interfaceHasInstance(owner, directMatch) {
  return function (obj) {
    return this === owner ? directMatch(obj) : ordinaryHasInstance(this, obj);
  };
}

function makeTagCtor(name, tag, Parent, Element, htmlCtorCheck) {
  // A REAL subclass of the interface its IDL inherits (`Parent` — HTMLElement, or HTMLMediaElement for audio / video),
  // not a bare function: its own prototype is chained to the parent's, as a browser's is, so tag-specific IDL members
  // relocated onto it are own to this interface (`'readOnly' in button` false;
  // getOwnPropertyDescriptor works) and don't leak to other elements — but because
  // `super()` now reaches Element's constructor, a `class MyButton extends
  // HTMLButtonElement {}` customized built-in constructs / upgrades into a real
  // element (createElement's `new ctor()`, upgrade's `Reflect.construct`). A bare
  // function short-circuited super() and produced a non-Element object instead.
  // The constructor runs HTML's [HTMLConstructor] sanity checks (bad NewTarget /
  // wrong interface / undefined) BEFORE `super()` — so, per spec, they run before the
  // engine reads `NewTarget.prototype` in the allocation. `Interface` is the class's
  // own binding (the "active function object") — the one checked: the element is
  // Element's to make, past HTMLElement's constructor, whose own check would hold the
  // interface's NewTarget to HTMLElement.
  const ctor = class Interface extends Parent {
    constructor() { htmlCtorCheck(Interface, new.target); return Reflect.construct(Element, [], new.target); }
  };
  // Name the interface so `el.constructor.name` reads e.g. 'HTMLAnchorElement' (the
  // dynamic `globalThis[name] = …` assignment doesn't infer it).
  Object.defineProperty(ctor, 'name', { value: name, configurable: true });
  const match = Array.isArray(tag)
    ? (obj) => obj != null && obj._ns === HTML_NS && tag.indexOf(obj._localName) !== -1
    : (obj) => obj != null && obj._ns === HTML_NS && obj._localName === tag;
  Object.defineProperty(ctor, Symbol.hasInstance, { value: interfaceHasInstance(ctor, match) });
  return ctor;
}

export function installDomClassAliases({ Element, Document, Text }) {
  // Reverse map: lowercase tag name → its specific interface constructor, built
  // as each tag ctor is created. Backs the `constructor` accessor installed at
  // the end so an element reports its precise interface
  // (`a.constructor === HTMLAnchorElement`) — elements of tags that share an interface share its prototype, so the
  // prototype alone cannot say.
  const tagToCtor = new Map();
  // HTML [HTMLConstructor] sanity checks, shared by every interface constructor
  // (HTMLElement + each tag interface). `activeFn` is the interface whose constructor
  // is running (the "active function object"); `newTarget` is the outermost new.target.
  // A page never calls these directly on a plain element (the parser / createElement's
  // non-CE path use `createElementNode`, which constructs Element itself); only a custom element construction —
  // `new MyCE()`, an upgrade's `Reflect.construct`, or `Reflect.construct(HTMLxxx, [],
  // nt)` — reaches an interface constructor. It deliberately does NOT read
  // `newTarget.prototype` (the prototype-derivation half of HTMLConstructor is not
  // modelled yet), so the engine's allocation in `super()` reads it exactly once,
  // after these checks — satisfying the "only get .prototype once, after the sanity
  // checks" subtests. Cross-realm prototype fallback (a non-object prototype → the
  // NewTarget realm's default) is the deferred remainder.
  const htmlCtorCheck = (activeFn, newTarget) => {
    // NewTarget is the interface itself → a bare `new HTMLDivElement()` — illegal.
    if (newTarget === activeFn) throw new TypeError('Illegal constructor');
    // NewTarget must be a defined custom element (in ANY registry).
    const def = ctorDefinition(newTarget);
    if (def === undefined) throw new TypeError('Illegal constructor');
    // It must extend the RIGHT interface: HTMLElement for an autonomous CE, the
    // extended built-in's interface for a customized built-in.
    const expected = def.localName === def.name
      ? globalThis.HTMLElement
      : (tagToCtor.get(def.localName) || globalThis.HTMLElement);
    if (activeFn !== expected) throw new TypeError('Illegal constructor');
  };
  // The namespace interfaces every element of that namespace is one of: HTMLElement — what each HTML tag's interface
  // extends, so an element's chain is HTMLDivElement → HTMLElement → Element as in a browser — SVGElement and
  // MathMLElement. Real classes, so a page's `class Foo extends HTMLElement` reaches Element's constructor through
  // `super()`; `instanceof` keys off the element's namespace (Symbol.hasInstance), as an element's prototype is its
  // tag's or its namespace's.
  class HTMLElement extends Element {
    constructor() { htmlCtorCheck(HTMLElement, new.target); super(); }
  }
  Object.defineProperty(HTMLElement, Symbol.hasInstance, { value: interfaceHasInstance(HTMLElement, (obj) => obj != null && obj._ns === HTML_NS) });
  // (…interfaces of no element a script constructs: the driver makes their elements, past these constructors)
  class SVGElement extends Element {
    constructor() { throw new TypeError("Failed to construct 'SVGElement': Illegal constructor"); }
  }
  Object.defineProperty(SVGElement, Symbol.hasInstance, { value: interfaceHasInstance(SVGElement, (obj) => obj != null && obj._ns === SVG_NS) });
  class MathMLElement extends Element {
    constructor() { throw new TypeError("Failed to construct 'MathMLElement': Illegal constructor"); }
  }
  Object.defineProperty(MathMLElement, Symbol.hasInstance, { value: interfaceHasInstance(MathMLElement, (obj) => obj != null && obj._ns === MATHML_NS) });
  // An HTML-namespace element whose (case-sensitive) name is not a standard HTML tag — `createElementNS(HTML_NS,
  // "DIV")` (uppercase) and unknown tags — EXCEPT one whose name is a valid custom element name: DOM's "create an
  // element" gives those the HTMLElement interface whether or not a definition exists yet (`<my-el>` is an
  // HTMLElement in browsers, defined or not). The one exception is a parser fallback for a custom element whose
  // constructor failed, which the spec explicitly makes HTMLUnknownElement (constructParsedCustomElement marks it).
  class HTMLUnknownElement extends HTMLElement {
    constructor() { htmlCtorCheck(HTMLUnknownElement, new.target); return Reflect.construct(Element, [], new.target); }
  }
  Object.defineProperty(HTMLUnknownElement, Symbol.hasInstance, {
    value: interfaceHasInstance(HTMLUnknownElement, (obj) =>
      obj != null && obj._ns === HTML_NS && obj._localName != null &&
      !KNOWN_HTML_TAGS.has(obj._localName) &&
      (obj._unknownFallback === true || !isValidCustomElementName(obj._localName)))
  });
  // `HTMLMediaElement` — the base interface of <audio>/<video>: what their interfaces extend, an interface of no
  // element of its own (so not in tagToCtor: `videoEl.constructor` is HTMLVideoElement). The media-load state values
  // are its constants (HTMLMediaElement.NETWORK_NO_SOURCE — what the resource-selection algorithm reports).
  class HTMLMediaElement extends HTMLElement {
    constructor() { htmlCtorCheck(HTMLMediaElement, new.target); return Reflect.construct(Element, [], new.target); }
  }
  Object.defineProperty(HTMLMediaElement, Symbol.hasInstance, {
    value: interfaceHasInstance(HTMLMediaElement, (obj) => obj != null && obj._ns === HTML_NS && (obj._localName === 'audio' || obj._localName === 'video'))
  });
  const MEDIA_CONSTANTS = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE', 'HAVE_NOTHING',
                           'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
  const MEDIA_VALUES = [0, 1, 2, 3, 0, 1, 2, 3, 4];
  defineConstants(HTMLMediaElement, MEDIA_CONSTANTS, MEDIA_VALUES);
  defineConstants(HTMLMediaElement.prototype, MEDIA_CONSTANTS, MEDIA_VALUES);
  globalThis.HTMLMediaElement   = HTMLMediaElement;
  // (…each tag's interface extending the one its IDL says it inherits)
  const parentInterfaces = { HTMLElement, HTMLMediaElement };
  const parentOf = (name) => parentInterfaces[HTML_INTERFACE_PARENTS[name]] || HTMLElement;
  globalThis.HTMLElement        = HTMLElement;
  globalThis.SVGElement         = SVGElement;
  globalThis.MathMLElement      = MathMLElement;
  globalThis.HTMLUnknownElement = HTMLUnknownElement;
  registerNamespaceTargets({
    html: HTMLElement.prototype, htmlUnknown: HTMLUnknownElement.prototype,
    svg: SVGElement.prototype, mathml: MathMLElement.prototype
  });
  for (const [name, tag] of Object.entries(TAG_ELEMENT_CTORS)) {
    const ctor = makeTagCtor(name, tag, parentOf(name), Element, htmlCtorCheck);
    globalThis[name] = ctor;
    tagToCtor.set(tag, ctor);
    registerTagTarget(tag, ctor.prototype);   // elements of this tag are born with the interface prototype
  }
  for (const [name, tags] of Object.entries(MULTI_TAG_ELEMENT_CTORS)) {
    const ctor = makeTagCtor(name, tags, parentOf(name), Element, htmlCtorCheck);
    globalThis[name] = ctor;
    for (const t of tags) { tagToCtor.set(t, ctor); registerTagTarget(t, ctor.prototype); }
  }
  // A track's text track readiness states are HTMLTrackElement's constants, as the media-load states are HTMLMediaElement's.
  const TRACK_CONSTANTS = ['NONE', 'LOADING', 'LOADED', 'ERROR'], TRACK_VALUES = [0, 1, 2, 3];
  defineConstants(tagToCtor.get('track'), TRACK_CONSTANTS, TRACK_VALUES);
  defineConstants(tagToCtor.get('track').prototype, TRACK_CONSTANTS, TRACK_VALUES);
  // The media elements' members are their interfaces' own (media.js), defined there rather than moved there.
  installMediaIDL({ HTMLMediaElement, HTMLVideoElement: tagToCtor.get('video') });
  // What tells each tag interface's elements apart, for a conversion to one (`createImageBitmap`'s HTMLImageElement): an
  // HTML element of one of its tags — an inherited interface's (HTMLMediaElement) those of the interfaces extending it.
  const isHtmlElement = interfaceCheck('HTMLElement');
  const tagsOf = new Map();
  for (const [tag, ctor] of tagToCtor) {
    for (let c = ctor; c && c !== HTMLElement; c = Object.getPrototypeOf(c)) tagsOf.set(c.name, (tagsOf.get(c.name) || new Set()).add(tag));
  }
  for (const [name, tags] of tagsOf) registerInterface(name, (o) => isHtmlElement(o) && tags.has(o._localName));
  // Each element interface the bindings generate, installed on its class — its [Reflect…] members the binding's own, the
  // rest its implementation's — before the hand-written members below are relocated, which leave what an interface
  // defines itself alone.
  const interfaces = new Map([...tagToCtor.values()].map((ctor) => [ctor.name, ctor]));
  for (const [name, install] of Object.entries(HTML_ELEMENT_INSTALLS)) install(interfaces.get(name), HTML_ELEMENT_MEMBERS[name] ?? {});
  // Relocate tag-specific IDL members from the shared Element.prototype onto the
  // interface prototype(s) that own them — so they are OWN members there
  // (`'disabled' in button` true, `getOwnPropertyDescriptor(HTMLInputElement
  // .prototype,'readOnly')` works) and ABSENT from elements of other interfaces
  // (`'disabled' in div` false). The accessor is the same descriptor (its internal
  // tag dispatch is unchanged); only WHICH prototypes expose it moves. Driven by
  // IDL_MEMBER_TAGS (the @webref WebIDL surface), so the owning tag-set is
  // authoritative — no over-relocation, and universals (nonce/dataset, owned by the
  // base HTMLElement) are never listed here so they stay shared.
  const nodeProto = Object.getPrototypeOf(Element.prototype);   // Node.prototype
  // (…onto the prototypes whose interfaces define no member of the name themselves: one an interface defines as its
  // own — HTMLMediaElement's `controls`, media.js's — is neither overwritten nor shadowed by a shared accessor of the
  // same name, which another interface's elements keep — HTMLImageElement's)
  const definesOwn = (proto, prop) => {
    for (let p = proto; p && p !== Element.prototype; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, prop)) return true;
    return false;
  };
  const moveOnto = (protos, prop, desc) => {
    for (const proto of new Set(protos)) if (!definesOwn(proto, prop)) Object.defineProperty(proto, prop, desc);
  };
  const relocateMember = (prop, tags) => {
    // The member may sit on the shared Element.prototype or — for a few that were
    // (mis)placed on the base — Node.prototype. Move it from wherever it lives, so
    // an interface-specific member no longer leaks onto every element OR node
    // (`'submit' in div` / `'submit' in document` were both true).
    let host = Element.prototype;
    let desc = Object.getOwnPropertyDescriptor(host, prop);
    if (!desc && nodeProto) { host = nodeProto; desc = Object.getOwnPropertyDescriptor(host, prop); }
    if (!desc) return;   // unimplemented, or already relocated → nothing to move
    moveOnto(tags.map((t) => tagToCtor.get(t)).filter(Boolean).map((ctor) => ctor.prototype), prop, desc);
    delete host[prop];
  };
  // IDL_MEMBER_TAGS (generated from idl_members.json + this file's tag map) gives
  // each interface-specific member the element tags whose interface prototype owns
  // it — already excluding universal, SVG-shared, and unmodelled-interface members.
  // A member every tag of an inherited interface owns, and no other, is that interface's (HTMLMediaElement's `play` /
  // `src` — not audio's and video's apart, so a page's `HTMLMediaElement.prototype.play = stub` is the one they call).
  const parentTags = new Map();
  for (const [tag, ctor] of tagToCtor) {
    const parent = Object.getPrototypeOf(ctor);
    if (parent !== HTMLElement) parentTags.set(parent, [...(parentTags.get(parent) || []), tag]);
  }
  const ownerOf = (tags) => {
    for (const [parent, own] of parentTags) if (own.length === tags.length && own.every((t) => tags.includes(t))) return parent;
    return null;
  };
  for (const [member, tags] of Object.entries(IDL_MEMBER_TAGS)) {
    const parent = ownerOf(tags);
    if (!parent) { relocateMember(member, tags); continue; }
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, member);
    if (!desc) continue;
    moveOnto([parent.prototype], member, desc);
    delete Element.prototype[member];
  }
  // HTMLElement's, SVGElement's and MathMLElement's members — and the mixins' they share (HTMLOrSVGElement's `focus` /
  // `dataset` / `tabIndex`, ElementCSSInlineStyle's `style`, GlobalEventHandlers' `on*`) — generated from their IDL
  // onto each (an SVG element has no `click` or `innerText`, an element in no such namespace no `focus` — Chrome); and
  // the WindowEventHandlers a `<body>` / `<frameset>` reflects to the Window that are no GlobalEventHandlers.
  installHTMLElement(HTMLElement, htmlElementMembers);
  installSVGElement(SVGElement, svgElementMembers);
  installMathMLElement(MathMLElement, mathMLElementMembers);
  for (const tag of ['body', 'frameset']) installWindowReflectedHandlers(tagToCtor.get(tag).prototype);
  // A tentative member absent from idl_members.json (so not in IDL_MEMBER_TAGS), relocated explicitly.
  relocateMember('shadowRootAdoptedStyleSheets', ['template']);
  // <select> uses SelectProto and <form> a proxy; chain select through its
  // interface prototype so the members relocated above are inherited (a form is
  // born with its interface prototype, and its proxy wraps it).
  const selCtor = tagToCtor.get('select');
  if (selCtor) reparentSelectProto(selCtor.prototype);
  globalThis.HTMLDocument  = Document;
  // `CharacterData` and `Comment` are real classes (dom-nodes.js sets the
  // globals): the prototype chain is Text/Comment → CharacterData → Node, so
  // `instanceof` + the prototype-chain conformance tests hold. (Previously both
  // were aliased to `Text`, collapsing the chain and making Comment a Text.)

  // `Window` ctor — sandboxes / wrappers do `instanceof Window` to
  // distinguish a window from other globals. Real Window has many
  // members; we just need the constructor for the identity check.
  // `self.constructor === Window` is the precondition framework
  // `hasDOM` chains rely on; falling back to "non-DOM mode" means
  // they hand raw selector strings to renderers instead of
  // `document.querySelector(selector)`. Pin via `defineProperty` —
  // `Object.setPrototypeOf(globalThis, Window.prototype)` would risk
  // swapping out the engine-provided global prototype chain.
  globalThis.Window = function Window() {};
  try {
    Object.defineProperty(globalThis, 'constructor', {
      value: globalThis.Window, writable: true, configurable: true
    });
  } catch (_) {}
  // `x instanceof Window` — true for a browsing context's global (and a cross-realm/aux WindowProxy),
  // false for a worker global or a plain object. We can't put `Window.prototype` on the engine-provided
  // global's chain (see above), so brand via a window self-reference: only a Window has `window`/`self`
  // pointing back at itself (a worker drops `window`; a plain object has neither). Libraries feature-test
  // `self instanceof Window` to tell a window from a worker (xhr timeout tests' STALLED_REQUEST_URL).
  try {
    Object.defineProperty(globalThis.Window, Symbol.hasInstance, {
      configurable: true,
      value(o) { try { return o != null && o.window === o && o.self === o; } catch (_) { return false; } }
    });
  } catch (_) {}

  // The legacy factory functions of HTML: `new Option(…)` (§4.10.10) — Stimulus controllers / select refresh paths build
  // replacement options with it; `new Image(…)` (§4.8.3) — ProseMirror's image-paste preload and a long tail of image
  // loaders probe loadability with it; `new Audio(…)` (§4.8.10) — Mastodon's sounds middleware builds one at
  // module-init time and appends `<source>`s to it.
  defineLegacyFactoryFunction('Option', 0, tagToCtor.get('option').prototype, (text, value, defaultSelected, selected) => {
    const o = globalThis.document.createElement('option');
    if (text !== undefined) o.textContent = toDOMString(text);
    if (value !== undefined) o._setAttribute('value', toDOMString(value));
    if (toBoolean(defaultSelected)) o._setAttribute('selected', '');
    // Its SELECTEDNESS the 4th argument, the dirtiness flag left unset — NOT `o.selected =`, whose setter marks it
    // dirty: `_selInit` keeps the selectedness from being re-derived from the `selected` content attribute, and with
    // `_dirtySel` unset a later change of that attribute still drives `.selected` (option-element-constructor "does
    // not set dirtiness").
    setSelectedness(o, toBoolean(selected));
    o._selInit = true;
    return o;
  });
  defineLegacyFactoryFunction('Image', 0, tagToCtor.get('img').prototype, (width, height) => {
    const img = globalThis.document.createElement('img');
    if (width !== undefined) img._setAttribute('width', String(toUnsignedLong(width, "Failed to construct 'Image': ")));
    if (height !== undefined) img._setAttribute('height', String(toUnsignedLong(height, "Failed to construct 'Image': ")));
    return img;
  });
  defineLegacyFactoryFunction('Audio', 0, tagToCtor.get('audio').prototype, (src) => {
    const audio = globalThis.document.createElement('audio');
    audio._setAttribute('preload', 'auto');
    if (src !== undefined) audio._setAttribute('src', toDOMString(src));
    return audio;
  });

  // Each interface prototype's `constructor` is its interface object and its @@toStringTag its name (Web IDL §3.7.3),
  // data properties as in a browser — every element is born with its interface's prototype. (Element's and the
  // namespaces' are generated.)
  for (const iface of [HTMLUnknownElement, HTMLMediaElement, ...new Set(tagToCtor.values())]) {
    defineClassString(iface.prototype, iface.name);
  }
}
