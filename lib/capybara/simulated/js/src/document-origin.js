// The document's origin, the engine's — what the realm's state and its requests are keyed by.

import { REALM } from './native-query-shadow.js';
import { nidOf } from './node-identity.js';
import { dom, engineOf, hostSteps } from './engine.js';

// `self.origin` / `window.origin` — the document's origin, the engine's (realm_location.rs `documentOrigin`). For a
// normal page / real-URL frame it's the serialized location origin; a frame whose document origin differs from its
// location origin was given it at frame build (`setDocumentOrigin`): an opaque-URL frame (about:blank / srcdoc /
// javascript:) inherits its parent's origin, and a sandboxed-without-allow-same-origin frame is the opaque "null". Read
// for CORS / postMessage-target checks. (self-origin.sub.) The Window's (window.js) and a worker's scope's.
export function documentOrigin() {
  return dom ? dom.documentOrigin() : '';
}
// The realm's URL as the engine has it (location.js `realmURL`) — what the bindings' own steps read of the document's
// URL: not as a script may shadow `location` (a worker's `var location` an own property over its scope's accessor), nor
// through its Location's members, whose security check is a script's (location.js `locationSecurityCheck`) — and another
// window's, `global` its global, as its realm's engine has it (`locationPart`, its href the first part: url_ops.rs
// `parts`).
export const realmURL = (global = globalThis) => String(global === globalThis ? REALM.realmURL?.() ?? '' : engineOf(global).locationPart(0));
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
  const cause = dom ? dom.opaqueOriginCause() : 0;
  if (cause === 0) return null;
  if (cause === OPAQUE_SANDBOXED) return sandboxed;
  return cause === OPAQUE_DATA_URL ? data : other;
}

// What a document's sandboxing flag set takes from it (realm_location.rs `sandboxed`): scripting, forms, simple
// dialogs, downloads — of the document `node` is in, of this realm's for none.
export const SANDBOXED_SCRIPTS = 0, SANDBOXED_FORMS = 1, SANDBOXED_MODALS = 2, SANDBOXED_DOWNLOADS = 3;
// …and what `__dom.userActivation` asks of the window (user_activation.rs): its sticky activation, its transient one.
export const ACTIVATION_STICKY = 0, ACTIVATION_TRANSIENT = 1;
export const sandboxed = (flag, node = null) => dom.sandboxed(flag, node ? nidOf(node) : null);
// …as the host asks it of a realm: whether a javascript: URL a frame loads with is evaluated (v8_runtime.rb) — and
// whether a navigation realm `source`'s document made may save the download its response is, its target frame realm
// `target`'s navigable (-1 each for none), sandboxed as `begun` says where the navigation carries it (navigables.rs
// `download_allowed`).
hostSteps.scriptsSandboxed = () => sandboxed(SANDBOXED_SCRIPTS);
hostSteps.downloadAllowed = (source, target, begun) => dom.downloadAllowed(source, target, begun);
