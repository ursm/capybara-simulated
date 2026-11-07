// Import maps. The module bodies themselves run natively (V8 via `Context#compile_module`); this file is the bridge-side
// glue that registers each `<script type="importmap">` and pushes the merged map to Ruby, so
// `Browser#resolve_module_request` agrees with the JS side.

import { documentBaseURL } from './base-url.js';
import { childTextContent, nodeDocumentOf } from './native-query-shadow.js';
import { dom } from './engine.js';

// The document's import map, the engine's (import_map.rs) as JSON — '' for none yet.
let importmap = '';
// HTML "resolve a module specifier" through it against `base` (the referrer's URL): the URL, or null for a TypeError.
export const resolveModuleSpecifier = (specifier, base) => dom.importMapResolve(importmap, String(specifier), String(base));
// …and "resolve a module integrity metadata" of a resolved URL: '' for none.
export const moduleIntegrity = (url) => dom.importMapIntegrity(importmap, String(url));

// HTML "register an import map": a prepared `<script type="importmap">`'s map, parsed against its node document's base
// URL and merged into the document's — an entry for a key it already has ignored ("merge existing and new import maps";
// importmap-rails ships its pins as several tags), text that is no import map reported (a SyntaxError for no JSON, a
// TypeError for no map) — then handed to the host, this realm's by its id, which resolves the realm's module specifiers
// through it too.
export function registerImportMap(el) {
  try { importmap = dom.importMapMerge(importmap || null, childTextContent(el), documentBaseURL(nodeDocumentOf(el))); }
  catch (e) { globalThis.__csimReportError(e); return; }
  // (…best-effort: where the host has not wired the callback — the snapshot path — the stub is a no-op)
  try { globalThis.__csim_pushImportmap(importmap, globalThis.__csimRealmId()); } catch (_) {}
}
