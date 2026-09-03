// Importmap + URL-resolution helpers. The module bodies themselves
// run natively (V8 via `Context#compile_module`, QuickJS via
// `vm.module_loader`); this file is just the bridge-side glue that
// (a) collects `<script type="importmap">` and pushes the merged map
// to Ruby so `Browser#resolve_module_specifier` agrees with the JS
// side, and (b) resolves `<script type="module" src>` URLs against
// the current base before handing them to the runtime.

import { scriptText } from './walk.js';

const importmap = { imports: Object.create(null), scopes: Object.create(null), integrity: Object.create(null) };
globalThis.__csim_importmap = importmap;

export function resolveAgainst(url, base) {
  try {
    const u = globalThis.__csim_parseUrl(url, base || (globalThis.location && globalThis.location.href) || null);
    return u && !u.error ? u.href : url;
  } catch (_) { return url; }
}

// Ingest `<script type="importmap">` tags. Per HTML spec only the
// first map wins, but importmap-rails / Rails 8 can ship multi-pin
// output as separate tags; later maps override earlier keys.
export function ingestImportmaps(doc) {
  if (!doc || !doc.documentElement) return;
  const tags = doc.documentElement.getElementsByTagName('script');
  for (const t of tags) {
    if ((t._attrs.type || '').toLowerCase() !== 'importmap') continue;
    const src = t._attrs.src;
    let text;
    if (src) {
      try {
        const timingStart = globalThis.performance.now();
        const resp = globalThis.__rackFetch('GET', src, '', null, 'follow');
        if (typeof globalThis.__csimRecordResource === 'function') globalThis.__csimRecordResource({ name: src, initiatorType: 'script', startTime: timingStart, resp });
        text = resp && resp.status < 400 ? resp.body : null;
      } catch (_) { text = null; }
    } else {
      text = scriptText(t);
    }
    if (!text) continue;
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { continue; }
    if (parsed && typeof parsed === 'object') {
      if (parsed.imports && typeof parsed.imports === 'object') Object.assign(importmap.imports, parsed.imports);
      if (parsed.scopes  && typeof parsed.scopes  === 'object') Object.assign(importmap.scopes,  parsed.scopes);
      // The `integrity` section maps module URLs to metadata (HTML "resolve a
      // module integrity metadata"). Keys resolve against the map's base URL
      // NOW, so every consumer (module fetch, modulepreload) looks up by
      // resolved URL.
      if (parsed.integrity && typeof parsed.integrity === 'object') {
        const base = (doc.baseURI) || (globalThis.location && globalThis.location.href) || null;
        for (const k of Object.keys(parsed.integrity)) importmap.integrity[resolveAgainst(k, base)] = String(parsed.integrity[k]);
      }
    }
  }
  // Push the merged map to the Ruby side so resolver lookups agree
  // with the JS-side `__csim_importmap`. Best-effort: if Ruby hasn't
  // wired the callback (snapshot path), the stub is a no-op.
  try { globalThis.__csim_pushImportmap(JSON.stringify(importmap)); } catch (_) {}
}
