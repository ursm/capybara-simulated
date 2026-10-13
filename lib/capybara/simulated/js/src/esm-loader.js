// Importmap + URL-resolution helpers. The module bodies themselves
// run natively (V8 via `Context#compile_module`); this file is just the bridge-side glue that
// (a) collects `<script type="importmap">` and pushes the merged map
// to Ruby so `Browser#resolve_module_specifier` agrees with the JS
// side, and (b) resolves `<script type="module" src>` URLs against
// the current base before handing them to the runtime.

import { scriptText, scriptTypeOf, SCRIPT_IMPORT_MAP } from './walk.js';
import { documentElementOf } from './document-tree.js';
import { selectAll } from './selectors.js';

// The document's import map, the engine's (import_map.rs) as JSON — '' for none yet.
let importmap = '';
// HTML "resolve a module specifier" through it against `base` (the referrer's URL): the URL, or null for a TypeError.
export const resolveModuleSpecifier = (specifier, base) => globalThis.__dom.importMapResolve(importmap, String(specifier), String(base));
// …and "resolve a module integrity metadata" of a resolved URL: '' for none.
export const moduleIntegrity = (url) => globalThis.__dom.importMapIntegrity(importmap, String(url));

export function resolveAgainst(url, base) {
  try {
    const u = globalThis.__csim_parseUrl(url, base || (globalThis.location && globalThis.location.href) || null);
    return u && !u.error ? u.href : url;
  } catch (_) { return url; }
}

// Ingest `<script type="importmap">` tags: each map parsed against the document's base URL and merged into the
// document's — an entry for a key it already has ignored (HTML "merge existing and new import maps"; importmap-rails
// ships its pins as several tags) — then handed to the host, this realm's by its id, which resolves the realm's module
// specifiers through it too.
export function ingestImportmaps(doc) {
  const root = doc && documentElementOf(doc);
  if (!root) return;
  for (const t of selectAll(root, 'script')) {
    if (scriptTypeOf(t) !== SCRIPT_IMPORT_MAP) continue;
    const src = t._attrs.src;
    let text;
    if (src) {
      try {
        const timingStart = globalThis.__csimPerformanceNow();
        const resp = globalThis.__rackFetch('GET', src, '', null, 'follow');
        if (typeof globalThis.__csimRecordResource === 'function') globalThis.__csimRecordResource({ name: src, initiatorType: 'script', startTime: timingStart, resp });
        text = resp && resp.status < 400 ? resp.body : null;
      } catch (_) { text = null; }
    } else {
      text = scriptText(t);
    }
    if (!text) continue;
    const base = doc.baseURI || (globalThis.location && globalThis.location.href) || '';
    const merged = globalThis.__dom.importMapMerge(importmap || null, text, base);
    if (merged !== null) importmap = merged;
  }
  // (…best-effort: where the host has not wired the callback — the snapshot path — the stub is a no-op)
  try { globalThis.__csim_pushImportmap(importmap, globalThis.RustyRacer.contextOf(globalThis) | 0); } catch (_) {}
}
