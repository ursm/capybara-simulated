// DOM constructor aliases for `instanceof` / `el.constructor === X`
// probes. We don't model real subclass shapes — every constructor's
// `prototype` is `Element.prototype` (so feature-detection probes
// like `'download' in HTMLAnchorElement.prototype` walk the IDL
// surface our Element exposes), and each `Symbol.hasInstance`
// matches the corresponding HTML tag exclusively.
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
// `HTMLElement` itself is the spec's "any HTML element" check — it
// stays loose because *every* HTML element is supposed to match. The
// SVG namespace doesn't have per-tag subclasses Discourse / Avo /
// Forem rely on, so SVGElement stays loose too.

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
function makeTagCtor(tag, Element) {
  const ctor = function () {};
  ctor.prototype = Element.prototype;
  const match = Array.isArray(tag)
    ? (obj) => obj != null && tag.indexOf(obj._tag) !== -1
    : (obj) => obj != null && obj._tag === tag;
  Object.defineProperty(ctor, Symbol.hasInstance, { value: match });
  return ctor;
}

export function installDomClassAliases({ Element, Document, Text }) {
  for (const [name, tag] of Object.entries(TAG_ELEMENT_CTORS)) {
    globalThis[name] = makeTagCtor(tag, Element);
  }
  for (const [name, tags] of Object.entries(MULTI_TAG_ELEMENT_CTORS)) {
    globalThis[name] = makeTagCtor(tags, Element);
  }
  // Any element whose tag is not a standard HTML element name.
  {
    const ctor = function () {};
    ctor.prototype = Element.prototype;
    Object.defineProperty(ctor, Symbol.hasInstance, {
      value: (obj) => obj != null && obj._tag != null && !KNOWN_HTML_TAGS.has(obj._tag)
    });
    globalThis.HTMLUnknownElement = ctor;
  }
  // `HTMLElement` and `SVGElement` are the "any HTML / any SVG"
  // markers — every (HTML / SVG) element passes their `instanceof`
  // check, so a plain Element alias is correct.
  globalThis.HTMLElement   = Element;
  globalThis.SVGElement    = Element;
  globalThis.HTMLDocument  = Document;
  globalThis.CharacterData = Text;
  globalThis.Comment       = Text;

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
}
