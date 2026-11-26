// Import maps and module specifier resolution: the document's import map and resolved module set are the engine's
// (module_map.rs), as its module map is; this file registers each `<script type="importmap">` and asks it.

import { documentBaseURL } from './base-url.js';
import { childTextContent, nodeDocumentOf } from './native-query-shadow.js';
import { dom, realmHooks } from './engine.js';

// HTML "resolve a module specifier" against `base` (the referrer's URL): the URL, or null for a TypeError.
export const resolveModuleSpecifier = (specifier, base) => dom.moduleResolve(String(specifier), String(base));
// …and "resolve a module integrity metadata" of a resolved URL: '' for none.
export const moduleIntegrity = (url) => dom.moduleIntegrity(String(url));

// HTML "register an import map": a prepared `<script type="importmap">`'s map, parsed against its node document's base
// URL and merged into the document's ("merge existing and new import maps": an entry for a key it already has ignored —
// importmap-rails ships its pins as several tags — and one that would change how a specifier already resolved resolves),
// text that is no import map reported (a SyntaxError for no JSON, a TypeError for no map).
export function registerImportMap(el) {
  try { dom.importMapRegister(childTextContent(el), documentBaseURL(nodeDocumentOf(el))); }
  catch (e) { realmHooks.reportError(e); }
}
