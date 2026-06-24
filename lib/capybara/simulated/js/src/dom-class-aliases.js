import { HTML_NS, SVG_NS } from './constants.js';

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
  HTMLPreElement:      'pre',
  HTMLTitleElement:    'title',
  HTMLTableRowElement: 'tr',
  HTMLMenuElement:     'menu'
};

// Interfaces shared by several tags. `Symbol.hasInstance` matches any
// tag in the set (HTMLHeadingElement covers h1–h6, etc.).
const MULTI_TAG_ELEMENT_CTORS = {
  HTMLModElement:          ['del', 'ins'],
  HTMLTableColElement:     ['col', 'colgroup'],
  HTMLHeadingElement:      ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  HTMLQuoteElement:        ['blockquote', 'q'],
  HTMLTableCellElement:    ['td', 'th'],
  HTMLTableSectionElement: ['thead', 'tbody', 'tfoot']
};

// Every standard HTML tag name. An element whose tag is absent here is
// an `HTMLUnknownElement` (per the HTML spec's element-interface map).
const KNOWN_HTML_TAGS = new Set([
  'a','abbr','acronym','address','area','article','aside','audio','b','base',
  'bdi','bdo','bgsound','big','blockquote','body','br','button','canvas',
  'caption','center','cite','code','col','colgroup','data','datalist','dd',
  'del','details','dfn','dialog','dir','div','dl','dt','em','embed','fieldset',
  'figcaption','figure','font','footer','form','frame','frameset','h1','h2',
  'h3','h4','h5','h6','head','header','hgroup','hr','html','i','iframe','img',
  'input','ins','isindex','kbd','label','legend','li','link','main','map',
  'mark','marquee','menu','meta','meter','nav','nobr','noembed','noframes',
  'noscript','object','ol','optgroup','option','output','p','param','picture',
  'plaintext','pre','progress','q','rp','rt','ruby','s','samp','script',
  'section','select','slot','small','source','spacer','span','strike','strong',
  'style','sub','summary','sup','table','tbody','td','template','textarea',
  'tfoot','th','thead','time','title','tr','track','tt','u','ul','var','video',
  'wbr','xmp'
]);

// Share `Element.prototype` so feature-detection probes against
// `<Ctor>.prototype` (file-saver's `'download' in HTMLAnchorElement
// .prototype`, etc.) walk the same IDL surface our Element exposes.
// The `instanceof` match keys off the HTML namespace + the CASE-SENSITIVE
// `_localName` (NOT the always-lowercased `_tag`): `createElementNS(HTML_NS,
// "DIV")` has `_localName` "DIV" and is an HTMLUnknownElement, not an
// HTMLDivElement, and an element in a non-HTML namespace matches no HTML
// interface. Normal elements have `_localName === _tag` (lowercase), so they
// match exactly as before.
function makeTagCtor(name, tag, Element) {
  const ctor = function () {};
  // Name the interface so `el.constructor.name` reads e.g. 'HTMLAnchorElement'
  // (the dynamic `globalThis[name] = …` assignment doesn't infer it, and the
  // bare function would otherwise report ''/'ctor').
  Object.defineProperty(ctor, 'name', { value: name, configurable: true });
  ctor.prototype = Element.prototype;
  const match = Array.isArray(tag)
    ? (obj) => obj != null && obj._ns === HTML_NS && tag.indexOf(obj._localName) !== -1
    : (obj) => obj != null && obj._ns === HTML_NS && obj._localName === tag;
  Object.defineProperty(ctor, Symbol.hasInstance, { value: match });
  return ctor;
}

export function installDomClassAliases({ Element, Document, Text }) {
  // Reverse map: lowercase tag name → its specific interface constructor, built
  // as each tag ctor is created. Backs the `constructor` accessor installed at
  // the end so an element reports its precise interface
  // (`a.constructor === HTMLAnchorElement`) without per-tag prototypes.
  const tagToCtor = new Map();
  for (const [name, tag] of Object.entries(TAG_ELEMENT_CTORS)) {
    const ctor = makeTagCtor(name, tag, Element);
    globalThis[name] = ctor;
    tagToCtor.set(tag, ctor);
  }
  for (const [name, tags] of Object.entries(MULTI_TAG_ELEMENT_CTORS)) {
    const ctor = makeTagCtor(name, tags, Element);
    globalThis[name] = ctor;
    for (const t of tags) tagToCtor.set(t, ctor);
  }
  // An HTML-namespace element whose (case-sensitive) name is not a standard
  // HTML tag — `createElementNS(HTML_NS, "DIV")` (uppercase) and unknown tags.
  {
    const ctor = function () {};
    Object.defineProperty(ctor, 'name', { value: 'HTMLUnknownElement', configurable: true });
    ctor.prototype = Element.prototype;
    Object.defineProperty(ctor, Symbol.hasInstance, {
      value: (obj) => obj != null && obj._ns === HTML_NS && obj._localName != null && !KNOWN_HTML_TAGS.has(obj._localName)
    });
    globalThis.HTMLUnknownElement = ctor;
  }
  // `HTMLMediaElement` — the base interface of <audio>/<video>. `instanceof`
  // matches either (a video IS an HTMLMediaElement). Deliberately NOT registered
  // in tagToCtor, so `videoEl.constructor` stays the derived HTMLVideoElement.
  // The media-load state values are exposed as STATIC constants
  // (HTMLMediaElement.NETWORK_NO_SOURCE — what the resource-selection algorithm
  // reports); kept off the shared Element.prototype so they don't leak onto
  // every element as instance properties.
  {
    const ctor = function () {};
    Object.defineProperty(ctor, 'name', { value: 'HTMLMediaElement', configurable: true });
    ctor.prototype = Element.prototype;
    Object.defineProperty(ctor, Symbol.hasInstance, {
      value: (obj) => obj != null && obj._ns === HTML_NS && (obj._localName === 'audio' || obj._localName === 'video')
    });
    const MEDIA_CONSTS = {
      NETWORK_EMPTY: 0, NETWORK_IDLE: 1, NETWORK_LOADING: 2, NETWORK_NO_SOURCE: 3,
      HAVE_NOTHING: 0, HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3, HAVE_ENOUGH_DATA: 4
    };
    for (const [k, v] of Object.entries(MEDIA_CONSTS)) {
      Object.defineProperty(ctor, k, { value: v, enumerable: true });
    }
    globalThis.HTMLMediaElement = ctor;
  }
  // `HTMLElement` / `SVGElement` are the "any HTML / any SVG element" markers:
  // `instanceof` keys off the element's namespace (so a non-HTML-namespace
  // element is NOT an HTMLElement). They're real `extends Element` subclasses
  // (not bare functions) so an app's `class Foo extends HTMLElement { … }` +
  // `super()` still chains to Element's constructor; the namespace test lives in
  // `Symbol.hasInstance`. The added prototype layer is empty, and nothing reads
  // `HTMLElement.prototype` as an identity, so element behaviour is unchanged.
  class HTMLElement extends Element {}
  Object.defineProperty(HTMLElement, Symbol.hasInstance, { value: (obj) => obj != null && obj._ns === HTML_NS });
  class SVGElement extends Element {}
  Object.defineProperty(SVGElement, Symbol.hasInstance, { value: (obj) => obj != null && obj._ns === SVG_NS });
  globalThis.HTMLElement   = HTMLElement;
  globalThis.SVGElement    = SVGElement;
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

  // `new Option(text, value, defaultSelected, selected)` — legacy DOM
  // constructor still used by some Stimulus controllers / select
  // refresh paths to build replacement options.
  globalThis.Option = function Option(text, value, defaultSelected, selected) {
    const o = globalThis.document.createElement('option');
    if (text !== undefined)  o.textContent = String(text);
    if (value !== undefined) o.setAttribute('value', String(value));
    if (defaultSelected)     o.setAttribute('selected', '');
    if (selected)            o.selected = true;
    return o;
  };

  // `new Image(width, height)` — legacy alias for
  // `document.createElement('img')`. ProseMirror's image-paste preload
  // path and a long tail of image-loader libraries `new Image()` to
  // probe loadability before inserting; without the constructor that
  // throws "Image is not defined" and the editor init's Promise chain
  // rejects.
  globalThis.Image = function Image(width, height) {
    const img = globalThis.document.createElement('img');
    if (width  != null) img.setAttribute('width',  String(width | 0));
    if (height != null) img.setAttribute('height', String(height | 0));
    return img;
  };
  globalThis.Image.prototype = Element.prototype;

  // `new Audio(src)` is similarly common; we already define the
  // HTMLAudioElement constructor but the legacy `Audio` factory is
  // a separate global.
  globalThis.Audio = function Audio(src) {
    const a = globalThis.document.createElement('audio');
    if (src != null) a.setAttribute('src', String(src));
    return a;
  };
  globalThis.Audio.prototype = Element.prototype;

  // `el.constructor` must report the element's specific interface object
  // (`a.constructor === HTMLAnchorElement`) like a real browser, even though
  // every element shares `Element.prototype` (makeTagCtor keeps the single IDL
  // surface so `'download' in HTMLAnchorElement.prototype` and other
  // feature-detection probes resolve). A data `constructor` on the shared
  // prototype can only hold ONE value, so resolve it per-element via an accessor
  // keyed on the element's namespace + (case-sensitive) local name — the same
  // key the `instanceof` matchers use. Most elements share `Element.prototype`
  // directly; only `<form>` and `<select>` are reparented onto a dedicated
  // shared proto (FormNamedProto / SelectProto, each `Object.create(Element
  // .prototype)`) for their named-property / item members, so for those two
  // `Object.getPrototypeOf(el)` is that proto, not `Element.prototype` (the
  // accessor + `instanceof` stay correct — both key on `_localName`). `this`
  // with no `_localName`
  // — `Element.prototype` itself, or a subclass instance whose own prototype's
  // `constructor` shadows this — falls back to `Element`.
  Object.defineProperty(Element.prototype, 'constructor', {
    configurable: true,
    get() {
      const ln = this._localName;
      if (ln == null) return Element;
      if (this._ns === HTML_NS) {
        return tagToCtor.get(ln) ||
          (KNOWN_HTML_TAGS.has(ln) ? globalThis.HTMLElement : globalThis.HTMLUnknownElement);
      }
      if (this._ns === SVG_NS) return globalThis.SVGElement;
      return Element;
    }
  });

  // WebIDL: every interface prototype object carries an @@toStringTag property
  // whose value is the interface identifier, so `Object.prototype.toString` /
  // `String(el)` brand as e.g. "[object HTMLBodyElement]" — and the File/Blob
  // constructors stringify a non-Blob/non-BufferSource fileBit / a non-string
  // fileName via this brand. As with `constructor`, the shared Element.prototype
  // can hold only one value, so resolve it per-element from the same interface
  // accessor (its name is the interface identifier).
  Object.defineProperty(Element.prototype, Symbol.toStringTag, {
    configurable: true,
    get() { return this.constructor.name; }
  });
}
