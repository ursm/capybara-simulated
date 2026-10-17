import { HTML_ELEMENT_INTERFACES } from './generated/bindings.js';

// The HTML elements whose element interface is not HTMLUnknownElement (HTML "element interface": the generated table,
// from @webref/elements) — a dedicated one (HTMLDivElement, …) or HTMLElement, an obsolete-but-implemented name's
// (`acronym`, `center`, …) too — as a single source of truth: for `instanceof` narrowing (dom-class-aliases.js) and for
// `customElements.define`'s `extends` validation (custom-elements.js), which rejects a name whose interface is
// HTMLUnknownElement. Keeping the two consumers on one set is what keeps "is `<bgsound>` an HTMLElement?" and "can I
// `extends: 'bgsound'`?" answering the same way.
export const KNOWN_HTML_TAGS = new Set(Object.keys(HTML_ELEMENT_INTERFACES));

// Does `name` map to an interface OTHER than HTMLUnknownElement? (The element
// interface for `name` and the HTML namespace is not HTMLUnknownElement.)
export function isKnownHtmlElementName(name) {
  return KNOWN_HTML_TAGS.has(name);
}
