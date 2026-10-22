// The document's origin, the engine's — what the realm's state and its requests are keyed by.

// `self.origin` / `window.origin` — the document's origin, the engine's (realm_location.rs `documentOrigin`). For a
// normal page / real-URL frame it's the serialized location origin; a frame whose document origin differs from its
// location origin was given it at frame build (`__csimSetDocumentOrigin`): an opaque-URL frame (about:blank / srcdoc /
// javascript:) inherits its parent's origin, and a sandboxed-without-allow-same-origin frame is the opaque "null". Read
// for CORS / postMessage-target checks. (self-origin.sub.) The Window's (window.js) and a worker's scope's.
export function documentOrigin() {
  return globalThis.__dom ? globalThis.__dom.documentOrigin() : '';
}
// …and whether it is OPAQUE (a document sandboxed without allow-same-origin) — read, as it is, WITHOUT the `origin`
// global: that is a Window PROTOTYPE accessor precisely so page script can shadow it (`var origin`), and what a document
// may do must not hinge on what the page happens to name a variable.
export function documentOriginIsOpaque() {
  return documentOrigin() === 'null';
}
// …and, where it is, why what a document has of its origin is refused it — HTML's storage key and cookie checks, a
// service worker container — a SecurityError in Chrome's words for the cause the engine finds (realm_location.rs
// `opaqueOriginCause`): a sandboxed document's (`sandboxed`), whatever its URL, a `data:` one's (`data`), one that
// inherited its origin (`other`), each the feature's where it has its own. Null where the origin is a tuple.
const OPAQUE_SANDBOXED = 1, OPAQUE_DATA_URL = 2;
export function opaqueOriginRefusal({
  sandboxed = "The document is sandboxed and lacks the 'allow-same-origin' flag.",
  other = 'Access is denied for this document.',
  data = other
}) {
  const cause = globalThis.__dom ? globalThis.__dom.opaqueOriginCause() : 0;
  if (cause === 0) return null;
  if (cause === OPAQUE_SANDBOXED) return sandboxed;
  return cause === OPAQUE_DATA_URL ? data : other;
}

// What a document's sandboxing flag set takes from it (realm_location.rs `sandboxed`): scripting, forms, simple
// dialogs, downloads — of the document `node` is in, of this realm's for none.
export const SANDBOXED_SCRIPTS = 0, SANDBOXED_FORMS = 1, SANDBOXED_MODALS = 2, SANDBOXED_DOWNLOADS = 3;
export const sandboxed = (flag, node = null) => globalThis.__dom.sandboxed(flag, node ? node._nid : null);
// …as the host asks it of a realm: whether a javascript: URL a frame loads with is evaluated (v8_runtime.rb), whether a
// download a frame's navigation makes is saved (browser.rb `save_downloaded_response`).
globalThis.__csimScriptsSandboxed = () => sandboxed(SANDBOXED_SCRIPTS);
globalThis.__csimDownloadsSandboxed = () => sandboxed(SANDBOXED_DOWNLOADS);
