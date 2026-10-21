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
// …and, where it is, why a document's own state is refused it — HTML's storage key and cookie checks, a SecurityError
// in Chrome's words: a `data:` document's (`dataWords`, the feature's), any other one sandboxed without
// allow-same-origin. Null where the origin is a tuple.
export function opaqueOriginRefusal(dataWords) {
  if (!documentOriginIsOpaque()) return null;
  return /^data:/i.test(globalThis.location?.href ?? '') ? dataWords
    : "The document is sandboxed and lacks the 'allow-same-origin' flag.";
}
