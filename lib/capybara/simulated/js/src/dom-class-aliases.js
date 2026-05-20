// DOM constructor aliases for `instanceof` / `el.constructor === X`
// probes. Real subclass shapes are out of scope; the structural
// check is the only consumer.
//
// Most typed-element names alias straight to `Element` (or `Text`
// for character-data subtypes) because libraries (DOMPurify, Tribute,
// Stimulus, jQuery) just want the probe to not ReferenceError.
//
// `HTMLFormElement`, `HTMLBodyElement`, `HTMLAnchorElement` need
// tag-aware `instanceof` — Turbo Drive's `#shouldInterceptNavigation`
// branches on `element instanceof HTMLFormElement` to call form-only
// `#formActionIsVisitable` (which feeds `getAction$1` →
// `expandURL(undefined.toString())` and throws on `<a>` elements
// aliased to Element); PageRenderer's `renderElement` picks between
// `body.replaceWith(newBody)` and `documentElement.appendChild(
// newBody)` on `newElement instanceof HTMLBodyElement`, and an
// always-true alias steered every page visit into the appendChild
// branch — body content stayed un-replaced and post-attach modal
// flows never closed. Mastodon's `HandledLink` calls
// `element.innerText` / `element.href` after `instanceof
// HTMLAnchorElement`, so any non-anchor passing the check feeds
// `undefined.startsWith(...)` and crashes the entire timeline
// column into the React error boundary. Each ctor's
// `Symbol.hasInstance` matches the tag exclusively.

const PLAIN_ELEMENT_ALIASES = [
  'HTMLInputElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'HTMLOptionElement', 'HTMLButtonElement',
  'HTMLImageElement', 'HTMLScriptElement',
  'HTMLDivElement', 'HTMLSpanElement', 'HTMLTableElement',
  'HTMLLabelElement', 'HTMLLIElement', 'HTMLUListElement',
  'HTMLOListElement', 'HTMLAreaElement',
  'HTMLCanvasElement', 'HTMLDialogElement', 'HTMLHeadElement',
  'HTMLHtmlElement', 'HTMLIFrameElement', 'HTMLLinkElement',
  'HTMLMetaElement', 'HTMLStyleElement', 'HTMLTemplateElement',
  'SVGElement'
];

// Share `Element.prototype` so feature-detection probes against
// `<Ctor>.prototype` (file-saver's `'download' in HTMLAnchorElement
// .prototype`, etc.) walk the same IDL surface our Element exposes.
function makeTagCtor(tagName, Element) {
  const ctor = function () {};
  ctor.prototype = Element.prototype;
  Object.defineProperty(ctor, Symbol.hasInstance, {
    value: (obj) => obj != null && obj._tag === tagName
  });
  return ctor;
}

export function installDomClassAliases({ Element, Document, Text }) {
  for (const name of PLAIN_ELEMENT_ALIASES) globalThis[name] = Element;
  globalThis.HTMLFormElement   = makeTagCtor('form', Element);
  globalThis.HTMLBodyElement   = makeTagCtor('body', Element);
  globalThis.HTMLAnchorElement = makeTagCtor('a',    Element);
  globalThis.HTMLDocument      = Document;
  globalThis.CharacterData     = Text;
  globalThis.Comment           = Text;

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
}
