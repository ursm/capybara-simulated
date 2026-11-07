import { setStateBit, STATE_SELECTED_INIT } from './native-query-shadow.js';
import { HTML_NS } from './constants.js';
import {
  htmlElementMembers, mathMLElementMembers, registerNamespaceTargets, registerTagTarget, svgElementMembers,
  windowReflectingElementMembers
} from './dom-nodes.js';
import { htmlCanvasElementMembers } from './canvas.js';
import { htmlDialogElementMembers } from './dialog.js';
import { htmlInputElementMembers } from './html-input.js';
import {
  htmlButtonElementMembers, htmlFieldSetElementMembers, htmlFormElementMembers, htmlOptionElementMembers,
  htmlOutputElementMembers, htmlSelectElementMembers, htmlTextAreaElementMembers
} from './html-forms.js';
import { HTML_ELEMENT_INSTALLS, HTML_ELEMENT_INTERFACES, HTML_INTERFACE_PARENTS, installHTMLElement, installMathMLElement, installSVGElement } from './generated/bindings.js';
import {
  htmlAnchorElementMembers, htmlAreaElementMembers, htmlBaseElementMembers, htmlDataListElementMembers,
  htmlEmbedElementMembers, htmlFrameElementMembers, htmlIFrameElementMembers, htmlImageElementMembers,
  htmlLabelElementMembers, htmlLegendElementMembers, htmlLinkElementMembers, htmlMapElementMembers,
  htmlMarqueeElementMembers, htmlMeterElementMembers, htmlObjectElementMembers, htmlProgressElementMembers,
  htmlScriptElementMembers, htmlSlotElementMembers, htmlStyleElementMembers, htmlTemplateElementMembers,
  htmlTitleElementMembers, htmlTrackElementMembers
} from './html-elements.js';
import { htmlTableCellElementMembers, htmlTableElementMembers, htmlTableRowElementMembers, htmlTableSectionElementMembers } from './html-tables.js';
import {
  defineClassString,
  defineLegacyFactoryFunction,
  PLATFORM,
  reflectConstruct,
  interfaceCheck,
  registerInterface,
  thisIs,
  toBoolean,
  toDOMString,
  toUnsignedLong
} from './webidl.js';
import { reflectString, setReflectedString } from './reflect.js';
import { ctorDefinition } from './custom-elements.js';
import { htmlMediaElementMembers, htmlVideoElementMembers } from './media.js';
import { localNameOf } from './node-identity.js';

// The element interfaces: per-tag constructors (HTMLDivElement, …) whose prototypes chain as their IDL inherits, an
// element BORN with its interface's prototype (`registerTagTarget` / `registerNamespaceTargets`), so `instanceof` is
// ECMAScript's own OrdinaryHasInstance over that chain, as in Chrome and Firefox — no `Symbol.hasInstance` of ours: an
// element of another realm is no instance of this realm's interfaces, an element given another prototype is an
// instance of that one's, and `Object.create(div)` is an HTMLDivElement.
//
// Why every HTML element needs its own tag's interface:
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
// `HTMLElement` / `SVGElement` / `MathMLElement` are what every element of their namespace's prototype chain passes
// through. They're real `class extends Element` subclasses (not bare aliases), and a user's `class Foo extends
// HTMLElement` + `super()` reaches HTMLElement's constructor, which makes the element by Element's.

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
  HTMLIFrameElement: htmlIFrameElementMembers,
  HTMLObjectElement: htmlObjectElementMembers,
  HTMLCanvasElement: htmlCanvasElementMembers,
  HTMLMediaElement: htmlMediaElementMembers,
  HTMLVideoElement: htmlVideoElementMembers,
  HTMLBodyElement: windowReflectingElementMembers,
  HTMLFrameSetElement: windowReflectingElementMembers,
  HTMLOutputElement: htmlOutputElementMembers,
  HTMLFieldSetElement: htmlFieldSetElementMembers,
  HTMLButtonElement: htmlButtonElementMembers,
  HTMLOptionElement: htmlOptionElementMembers,
  HTMLTextAreaElement: htmlTextAreaElementMembers,
  HTMLInputElement: htmlInputElementMembers,
  HTMLSelectElement: htmlSelectElementMembers,
  HTMLFormElement: htmlFormElementMembers,
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

// Each element interface of its own an HTML element has — every one but HTMLElement — with the tags that have it (HTML
// "element interface": the generated table).
const TAG_INTERFACES = new Map();
for (const [tag, name] of Object.entries(HTML_ELEMENT_INTERFACES)) {
  if (name !== 'HTMLElement') TAG_INTERFACES.set(name, [...(TAG_INTERFACES.get(name) || []), tag]);
}

function makeTagCtor(name, tags, Parent, Element, htmlCtorCheck) {
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
    constructor() { htmlCtorCheck(Interface, new.target); return reflectConstruct(Element, [PLATFORM], new.target); }
  };
  // Name the interface so `el.constructor.name` reads e.g. 'HTMLAnchorElement' (the
  // dynamic `globalThis[name] = …` assignment doesn't infer it).
  Object.defineProperty(ctor, 'name', { value: name, configurable: true });
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
    // (…the platform's own HTMLElement, not the global: a page may have put another there — the
    // custom-elements-es5-adapter's wrapper, which constructs through the real one)
    const expected = def.localName === def.name
      ? HTMLElement
      : (tagToCtor.get(def.localName) || HTMLElement);
    if (activeFn !== expected) throw new TypeError('Illegal constructor');
  };
  // The namespace interfaces every element of that namespace is one of: HTMLElement — what each HTML tag's interface
  // extends, so an element's chain is HTMLDivElement → HTMLElement → Element as in a browser — SVGElement and
  // MathMLElement. Real classes, so a page's `class Foo extends HTMLElement` reaches HTMLElement's constructor through
  // its `super()`, and that makes its element by Element's.
  class HTMLElement extends Element {
    constructor() { htmlCtorCheck(HTMLElement, new.target); return reflectConstruct(Element, [PLATFORM], new.target); }
  }
  // (…interfaces of no element a script constructs: the driver makes their elements, past these constructors)
  class SVGElement extends Element {
    constructor() { throw new TypeError("Failed to construct 'SVGElement': Illegal constructor"); }
  }
  class MathMLElement extends Element {
    constructor() { throw new TypeError("Failed to construct 'MathMLElement': Illegal constructor"); }
  }
  // An HTML-namespace element whose (case-sensitive) name is not a standard HTML tag — `createElementNS(HTML_NS,
  // "DIV")` (uppercase) and unknown tags — EXCEPT one whose name is a valid custom element name: DOM's "create an
  // element" gives those the HTMLElement interface whether or not a definition exists yet (`<my-el>` is an
  // HTMLElement in browsers, defined or not). The one exception is a parser fallback for a custom element whose
  // constructor failed, which the spec explicitly makes HTMLUnknownElement (constructParsedCustomElement marks it).
  class HTMLUnknownElement extends HTMLElement {
    constructor() { htmlCtorCheck(HTMLUnknownElement, new.target); return reflectConstruct(Element, [PLATFORM], new.target); }
  }
  // `HTMLMediaElement` — the base interface of <audio>/<video>: what their interfaces extend, an interface of no
  // element of its own (so not in tagToCtor: `videoEl.constructor` is HTMLVideoElement).
  class HTMLMediaElement extends HTMLElement {
    constructor() { htmlCtorCheck(HTMLMediaElement, new.target); return reflectConstruct(Element, [PLATFORM], new.target); }
  }
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
  for (const [name, tags] of TAG_INTERFACES) {
    const ctor = makeTagCtor(name, tags, parentOf(name), Element, htmlCtorCheck);
    globalThis[name] = ctor;
    // (…elements of its tags born with the interface prototype)
    for (const t of tags) { tagToCtor.set(t, ctor); registerTagTarget(t, ctor.prototype); }
  }
  // What tells each tag interface's elements apart, for a conversion to one (`createImageBitmap`'s HTMLImageElement): an
  // HTML element of one of its tags — an inherited interface's (HTMLMediaElement) those of the interfaces extending it.
  const isHtmlElement = interfaceCheck('HTMLElement');
  const tagsOf = new Map();
  for (const [tag, ctor] of tagToCtor) {
    for (let c = ctor; c && c !== HTMLElement; c = Object.getPrototypeOf(c)) tagsOf.set(c.name, (tagsOf.get(c.name) || new Set()).add(tag));
  }
  for (const [name, tags] of tagsOf) registerInterface(name, (o) => isHtmlElement(o) && tags.has(localNameOf(o)));
  // Each element interface the bindings generate, installed on its class — its [Reflect…] members the binding's own, the
  // rest its implementation's.
  const interfaces = new Map([...tagToCtor.values(), HTMLMediaElement].map((ctor) => [ctor.name, ctor]));
  for (const [name, install] of Object.entries(HTML_ELEMENT_INSTALLS)) install(interfaces.get(name), HTML_ELEMENT_MEMBERS[name] ?? {});
  // HTMLElement's, SVGElement's and MathMLElement's members — and the mixins' they share (HTMLOrSVGElement's `focus` /
  // `dataset` / `tabIndex`, ElementCSSInlineStyle's `style`, GlobalEventHandlers' `on*`) — generated from their IDL
  // onto each (an SVG element has no `click` or `innerText`, an element in no such namespace no `focus` — Chrome); and
  // the WindowEventHandlers a `<body>` / `<frameset>` reflects to the Window that are no GlobalEventHandlers.
  installHTMLElement(HTMLElement, htmlElementMembers);
  installSVGElement(SVGElement, svgElementMembers);
  installMathMLElement(MathMLElement, mathMLElementMembers);
  // …and a tentative member the IDL the bindings read has not (declarative shadow roots' adopted style sheets): a
  // <template>'s `shadowrootadoptedstylesheets`, reflected as a string — a space-separated list of import-map specifiers
  // the parser resolves into the declarative shadow root's adoptedStyleSheets.
  const isTemplate = interfaceCheck('HTMLTemplateElement');
  Object.defineProperty(tagToCtor.get('template').prototype, 'shadowRootAdoptedStyleSheets', {
    get() { return reflectString(thisIs(this, isTemplate), 'shadowrootadoptedstylesheets'); },
    set(v) {
      const self = thisIs(this, isTemplate);
      setReflectedString(self, 'shadowrootadoptedstylesheets', toDOMString(v, false, "Failed to set the 'shadowRootAdoptedStyleSheets' property on 'HTMLTemplateElement': "));
    },
    enumerable: true,
    configurable: true
  });
  globalThis.HTMLDocument  = Document;
  // `CharacterData` and `Comment` are real classes (dom-nodes.js sets the
  // globals): the prototype chain is Text/Comment → CharacterData → Node, so
  // `instanceof` + the prototype-chain conformance tests hold. (Previously both
  // were aliased to `Text`, collapsing the chain and making Comment a Text.)

  // `Window` — the interface whose prototype the window's global inherits from (window.js `prepareWindowInterface`):
  // `self.constructor === Window`, `self instanceof Window` and the class string are its prototype's.
  globalThis.Window = function Window() { throw new TypeError("Failed to construct 'Window': Illegal constructor"); };

  // The legacy factory functions of HTML: `new Option(…)` (§4.10.10) — Stimulus controllers / select refresh paths build
  // replacement options with it; `new Image(…)` (§4.8.3) — ProseMirror's image-paste preload and a long tail of image
  // loaders probe loadability with it; `new Audio(…)` (§4.8.10) — Mastodon's sounds middleware builds one at
  // module-init time and appends `<source>`s to it.
  defineLegacyFactoryFunction('Option', 0, tagToCtor.get('option').prototype, (text, value, defaultSelected, selected) => {
    const o = globalThis.document._createElement(HTML_NS, null, 'option', undefined, null);
    if (text !== undefined) o._textContent = toDOMString(text);
    if (value !== undefined) o._setAttribute('value', toDOMString(value));
    if (toBoolean(defaultSelected)) o._setAttribute('selected', '');
    // Its SELECTEDNESS the 4th argument, the dirtiness flag left unset — NOT `o.selected =`, whose setter marks it
    // dirty: initialised, it is not re-derived from the `selected` content attribute, and not dirty, a later change of
    // that attribute still drives `.selected` (option-element-constructor "does not set dirtiness").
    o._selectedness = toBoolean(selected);
    setStateBit(o, STATE_SELECTED_INIT, true);
    return o;
  });
  defineLegacyFactoryFunction('Image', 0, tagToCtor.get('img').prototype, (width, height) => {
    const img = globalThis.document.createElementNS(HTML_NS, 'img');
    if (width !== undefined) img._setAttribute('width', String(toUnsignedLong(width, "Failed to construct 'Image': ")));
    if (height !== undefined) img._setAttribute('height', String(toUnsignedLong(height, "Failed to construct 'Image': ")));
    return img;
  });
  defineLegacyFactoryFunction('Audio', 0, tagToCtor.get('audio').prototype, (src) => {
    const audio = globalThis.document.createElementNS(HTML_NS, 'audio');
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
