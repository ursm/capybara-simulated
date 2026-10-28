// The document's origin, the engine's — what the realm's state and its requests are keyed by.

import { REALM } from './native-query-shadow.js';

// `self.origin` / `window.origin` — the document's origin, the engine's (realm_location.rs `documentOrigin`). For a
// normal page / real-URL frame it's the serialized location origin; a frame whose document origin differs from its
// location origin was given it at frame build (`__csimSetDocumentOrigin`): an opaque-URL frame (about:blank / srcdoc /
// javascript:) inherits its parent's origin, and a sandboxed-without-allow-same-origin frame is the opaque "null". Read
// for CORS / postMessage-target checks. (self-origin.sub.) The Window's (window.js) and a worker's scope's.
export function documentOrigin() {
  return globalThis.__dom ? globalThis.__dom.documentOrigin() : '';
}
// …and its policy container's referrer policy, which a request whose own is empty takes (Fetch "main fetch"): the
// document's (`<meta name="referrer">`), '' — the default — in a worker, whose own is not modeled.
export function containerReferrerPolicy() {
  return typeof globalThis.__csimDocumentReferrerPolicy === 'function' ? globalThis.__csimDocumentReferrerPolicy() : '';
}
// …and the URL a request whose referrer is `client` refers by (Referrer Policy "determine request's referrer" step 2):
// none ('') for a document of an opaque origin, else its URL — an iframe srcdoc document's its container document's
// (referrer.rs `requestClient`); a worker's its script's, undefined for none.
export function clientReferrerSource() {
  if (!globalThis.document) return realmURL() || undefined;
  const [, , opaque, , source] = globalThis.__dom.requestClient(undefined, '', undefined);
  return opaque ? '' : source;
}
// …and a request the host fetches for it (`__rackFetch(request, body)`, a keepalive's and an async XHR's too), described
// by name — `init` what the request says (method, url, headers, redirect, mode, credentials, referrerPolicy, referrer,
// cache, a navigation's facts) — its client this realm: its id, its URL, its origin, and its document's frame's
// ancestors' document URLs, which its cookies are judged by too (referrer.rs `ancestorDocuments`; none in a worker,
// which has no document): fetch_plan.rs `FetchPlan`.
export function hostRequest(init) {
  const realm = globalThis.__csimRealmId();
  const ancestors = globalThis.document && realm > 0 ? globalThis.__dom.ancestorDocuments(realm) : [];
  return { clientRealm: realm, clientUrl: realmURL(), clientOrigin: documentOrigin(), ancestors, ...init };
}
// (…the realm's URL as the engine has it (location.js `realmURL`), not as a script may shadow `location` — a worker's
// `var location` an own property over its scope's accessor)
const realmURL = () => String(REALM.realmURL?.() ?? '');
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
// …as the host asks it of a realm: whether a javascript: URL a frame loads with is evaluated (v8_runtime.rb) — and
// whether a navigation realm `source`'s document made may save the download its response is, its target frame realm
// `target`'s navigable (-1 each for none), sandboxed as `begun` says where the navigation carries it (navigables.rs
// `download_allowed`).
globalThis.__csimScriptsSandboxed = () => sandboxed(SANDBOXED_SCRIPTS);
globalThis.__csimDownloadAllowed = (source, target, begun) => globalThis.__dom.downloadAllowed(source, target, begun);
