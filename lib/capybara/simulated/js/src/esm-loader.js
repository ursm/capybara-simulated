// Import maps. The module bodies themselves run natively (V8 via `Context#compile_module`); this file is the bridge-side
// glue that registers each `<script type="importmap">` and pushes the merged map to Ruby, so
// `Browser#resolve_module_specifier` agrees with the JS side.

import { scriptText } from './walk.js';
import { documentBaseURL } from './base-url.js';

// The document's import map, the engine's (import_map.rs) as JSON — '' for none yet.
let importmap = '';
// HTML "resolve a module specifier" through it against `base` (the referrer's URL): the URL, or null for a TypeError.
export const resolveModuleSpecifier = (specifier, base) => globalThis.__dom.importMapResolve(importmap, String(specifier), String(base));
// …and "resolve a module integrity metadata" of a resolved URL: '' for none.
export const moduleIntegrity = (url) => globalThis.__dom.importMapIntegrity(importmap, String(url));

// HTML "register an import map": a prepared `<script type="importmap">`'s map, parsed against its node document's base
// URL and merged into the document's — an entry for a key it already has ignored ("merge existing and new import maps";
// importmap-rails ships its pins as several tags), text that is no import map reported (a SyntaxError for no JSON, a
// TypeError for no map) — then handed to the host, this realm's by its id, which resolves the realm's module specifiers
// through it too.
export function registerImportMap(el) {
  try { importmap = globalThis.__dom.importMapMerge(importmap || null, scriptText(el), documentBaseURL(el._ownerDocument)); }
  catch (e) { globalThis.__csimReportError(e); return; }
  // (…best-effort: where the host has not wired the callback — the snapshot path — the stub is a no-op)
  try { globalThis.__csim_pushImportmap(importmap, globalThis.RustyRacer.contextOf(globalThis) | 0); } catch (_) {}
}
