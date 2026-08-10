// `globalThis.location` proxy. URL components mirror what Ruby's
// Browser tracks; updated on each `__csimLoadDocument(html, url)` /
// `__csimUpdateLocation(url)`. Library code (jQuery 1.x feature
// detect, Turbo Drive) reads `.href` early so we need a non-throwing
// initial value at module-init time.
//
// `location.{href,pathname,hash,search} = X` triggers a navigation
// through Ruby's `__locationAssign` host fn; `reload()` routes
// through `__locationReload`. SPA helpers (Turbo Drive's
// `history.replace`, Avo's tabs controller) pass `pathname + search`
// rather than a full URL, so `__csimUpdateLocation` resolves
// relative inputs against the current location to keep `.href` /
// `document.baseURI` absolute.

import { bumpSettleGen } from './mutation-observer.js';

// Per HTML spec, `window.location` is a single live object whose
// component getters reflect the current URL — assignments to
// `location.href = …` or pushState/replaceState updates are visible
// through any reference taken earlier. Ember's `HistoryLocation.init`
// caches `this.location = window.location` once, then reads
// `this.location.pathname` on every popstate/setURL; if each
// `__csimUpdateLocation` created a brand-new object, that cached
// reference froze on the initial URL and Ember's history bookkeeping
// (`_previousURL`, `getURL()`) silently desynced from the real URL.
// Keep `_u` as a mutable slot inside one persistent `loc` object.
let _u = (function () {
  try {
    const parsed = globalThis.__csim_parseUrl('http://www.example.com/', null);
    if (parsed && !parsed.error) return parsed;
  } catch (_) {}
  return {
    href: 'http://www.example.com/', protocol: 'http:', host: 'www.example.com',
    hostname: 'www.example.com', port: '', pathname: '/', search: '', hash: '',
    origin: 'http://www.example.com'
  };
})();
// A cross-document navigation. In a NESTED browsing context (a frame realm — its
// `top` is the parent, unlike the main realm whose `top` is itself) a
// `location` assignment must navigate THAT FRAME, not the top page: route it to
// `__csimFrameNavigate(url, thisRealmId)`, which the host defers and applies by
// re-navigating the owning iframe (so we never dispose the child realm while its
// own location setter is mid-flight). The main realm (and any engine without
// per-frame realms) keeps the plain top navigation.
function dispatchNav(resolved, replace) {
  const NS = globalThis.RustyRacer;
  // A same-origin WINDOW realm (window.open in this isolate) is its own top, so the
  // frame branch below (top !== self) doesn't fire and the plain top-page path is
  // wrong (it'd navigate the opener). Route to __csimWindowRealmNavigate, which
  // reloads THIS realm's document — deferred host-side so we don't re-enter the
  // realm while its own location setter is on the stack.
  if (globalThis.__csimIsWindowRealm && NS && typeof NS.contextOf === 'function' &&
      typeof globalThis.__csimWindowRealmNavigate === 'function') {
    let abs = String(resolved);
    try { abs = new globalThis.URL(abs, _u.href || undefined).href; } catch (_) {}
    globalThis.__csimWindowRealmNavigate(abs, NS.contextOf(globalThis), !!replace);
    return;
  }
  if (globalThis.top && globalThis.top !== globalThis &&
      NS && typeof NS.contextOf === 'function' &&
      typeof globalThis.__csimFrameNavigate === 'function') {
    // A location navigation supersedes a pending form submission to this same
    // frame (HTML "plan to navigate": one pending navigation per navigable, last
    // wins). The form submit's fetch lands in a microtask; cancel its plan NOW —
    // synchronously, same-isolate via frameElement — so that land skips and only
    // this navigation takes effect (form-submit-iframe-then-location-navigate).
    // `_frameNavPending` stays set: this nav replaces the form's, so the frame's
    // initial about:blank load stays suppressed until THIS navigation lands.
    const fe = globalThis.frameElement;
    if (fe && fe._plannedNav) {
      fe._plannedNav.cancelled = true;
      fe._plannedNav = null;
    }
    // Resolve against THIS frame's current URL. A frame that hasn't loaded a real
    // document yet (about:blank, or our initial bare-origin document at path "/")
    // has no meaningful base — a relative navigation resolves against the
    // navigator's (parent's) document, the inherited base (a fresh iframe driven
    // by its parent: form-submit-iframe-then-location-navigate). A frame that HAS
    // loaded a document has a real path, so its own base is used (the common
    // frame-own relative nav).
    let abs  = String(resolved);
    let base = _u.href;
    const blankish = !base || /^about:/i.test(base) || (_u.pathname === '/' && !_u.search && !_u.hash);
    if (blankish) {
      try { base = (globalThis.parent && globalThis.parent.location && globalThis.parent.location.href) || base; } catch (_) {}
    }
    try { abs = new globalThis.URL(abs, base).href; } catch (_) {}
    // Navigating a frame to a blob: URL takes a reference to the blob NOW; the
    // page may revoke it before the deferred nav applies, so snapshot the bytes
    // onto the owning iframe element (consumed by __csimNavigateFrameByRealm). A
    // blob's bytes live in its CREATING realm's local map (the host registry holds
    // only an existence marker unless workers exist), so resolve via the ancestor
    // realm chain — the navigator (an ancestor: parent/top, else self) holds them.
    if (/^blob:/i.test(abs) && globalThis.frameElement) {
      const fe = globalThis.frameElement;
      for (const w of [globalThis.parent, globalThis.top, globalThis]) {
        if (w && typeof w.__csimSnapshotFrameNavBlob === 'function') {
          w.__csimSnapshotFrameNavBlob(fe, abs);
          if (fe._pendingNavBlob) break;
        }
      }
    }
    globalThis.__csimFrameNavigate(abs, NS.contextOf(globalThis), !!replace);
    return;
  }
  globalThis.__locationAssign(String(resolved));
}
function navTarget(resolved) { return dispatchNav(resolved, false); }
// Spec: a Location setter / assign / replace parses the given value against the
// document's URL; a parse FAILURE throws a SyntaxError DOMException synchronously,
// so a malformed URL never reaches the navigation/fetch path (url/failure.html).
// A valid value (including a relative URL or a bare `#frag`, which resolve
// against the base) does not throw.
function validateNavOrThrow(input) {
  if (globalThis.__csim_urlIsMalformed(input, _u && _u.href)) {
    throw new globalThis.DOMException(
      "Failed to set the 'href' property on 'Location': '" + input + "' is not a valid URL.", 'SyntaxError');
  }
}
function composeWith(overrides) {
  const o = Object.assign({}, _u, overrides);
  const cred = o.username || o.password
    ? (o.username || '') + (o.password ? ':' + o.password : '') + '@'
    : '';
  return (o.protocol || '') + '//' + cred + (o.host || '') +
         (o.pathname || '') + (o.search || '') + (o.hash || '');
}
const _location = {
  toString() { return this.href; },
  assign:  (next) => { const s = String(next); validateNavOrThrow(s); if (!tryFragmentNavigate(s))       dispatchNav(s, false); },
  replace: (next) => { const s = String(next); validateNavOrThrow(s); if (!tryFragmentNavigate(s, true)) dispatchNav(s, true); },
  reload:  () => {
    // In a NESTED browsing context (a frame realm) reload re-navigates THAT
    // frame, not the top page: route to the host fn `__csimFrameReload`, which
    // defers and re-navigates the owning iframe by realm id (mirrors dispatchNav).
    // The main realm (and engines without per-frame realms) keep the top reload.
    const NS = globalThis.RustyRacer;
    if (globalThis.top && globalThis.top !== globalThis &&
        NS && typeof NS.contextOf === 'function' &&
        typeof globalThis.__csimFrameReload === 'function') {
      globalThis.__csimFrameReload(NS.contextOf(globalThis));
      return;
    }
    globalThis.__locationReload();
  }
};
Object.defineProperty(_location, 'href', {
  configurable: true,
  get() { return _u.href; },
  set(v) {
    const next = String(v);
    validateNavOrThrow(next);
    // Same-document fragment assignment (`location.href = '#x'` / a full
    // URL differing only in fragment) is handled in JS; otherwise a real
    // navigation through Ruby.
    if (tryFragmentNavigate(next)) return;
    navTarget(next);
  }
});
const partProps = {
  pathname: '/',
  hash:     '#',
  search:   '?',
};
for (const [key, prefix] of Object.entries(partProps)) {
  Object.defineProperty(_location, key, {
    configurable: true,
    get() { return _u[key]; },
    set(v) {
      const s = String(v == null ? '' : v);
      const part = s.length > 0 && !s.startsWith(prefix) ? prefix + s : s;
      const next = composeWith({ [key]: part });
      // Setting `location.hash` to its current value is a no-op in real
      // browsers (no navigation, no `hashchange`); only the fragment is
      // exempt — pathname/search assignment reloads even when unchanged.
      if (key === 'hash' && part === (_u.hash || '')) return;
      // A `location.hash` change is same-document → handled in JS.
      // pathname/search changes resolve as cross-document, so
      // `tryFragmentNavigate` returns false and we do a real navigation.
      if (tryFragmentNavigate(next)) return;
      navTarget(next);
    }
  });
}
for (const key of ['protocol', 'host', 'hostname', 'port', 'username', 'password']) {
  Object.defineProperty(_location, key, {
    configurable: true,
    get() { return _u[key]; }
  });
}
// `location.origin` is the serialization of THIS document's URL's origin. For a
// frame whose URL is opaque — about:blank (empty `<iframe>`), srcdoc, or a
// javascript: URL — that origin is the opaque "null", even though the document's
// own origin (`window.origin`) is the inherited parent (carried separately in
// `__csimDocumentOrigin`). The override is seeded at frame build (see
// `__csimSetLocationOrigin`); decoupling it from `href` keeps the realm's
// location string — and thus base-target / named-frame navigation — untouched.
// (self-origin.sub about:blank / srcdoc subtests.)
Object.defineProperty(_location, 'origin', {
  configurable: true,
  get() {
    if (globalThis.__csimLocationOriginOverride != null) return globalThis.__csimLocationOriginOverride;
    return _u.origin;
  }
});
function setLocationFromUrl(url) {
  try {
    const parsed = globalThis.__csim_parseUrl(url, null);
    if (parsed && !parsed.error) { _u = parsed; return; }
  } catch (_) {}
  _u = Object.assign({}, _u, { href: url || '', pathname: '/', search: '', hash: '' });
}

export function makeLocation(url) {
  // Back-compat shim: callers still ask for "the live location object";
  // updating `_u` in place is the source of truth.
  setLocationFromUrl(url);
  return _location;
}

Object.defineProperty(globalThis, 'location', {
  configurable: true,
  get() { return _location; },
  // `window.location = X` is [PutForwards=href] → same as `location.href = X`:
  // validate (throw SyntaxError on a malformed URL) then navigate.
  set(v) { const s = String(v); validateNavOrThrow(s); if (!tryFragmentNavigate(s)) dispatchNav(s, false); }
});

// HTML "navigate to a fragment", shared by every same-document fragment
// navigation: an anchor/area click (`fragmentNavigate` in dom-nodes.js)
// AND a `location.hash` / `location.href` / `location.assign` assignment
// (the setters below). When `destHref` resolves to the current document
// URL differing only in fragment, we perform it ENTIRELY in JS —
// synchronously update the live `location` object, mirror onto Ruby's
// history/current-URL, and fire `hashchange` when the fragment changed —
// with NO document fetch and NO Ruby round-trip. Returns true when the
// destination is same-document (handled here), false when it is cross-
// document OR identical (the caller decides: reload, no-op, …). Relative
// refs resolve against the current location. Returning true ONLY for an
// actual fragment change is deliberate: assigning the *current* URL
// (`location.href = location.href`) must still reload, so we must not
// swallow it as a same-document no-op.
export function tryFragmentNavigate(destHref, replace = false) {
  let dest, cur;
  try { dest = new globalThis.URL(String(destHref), _u.href); } catch (_) { return false; }
  try { cur  = new globalThis.URL(_u.href); }                  catch (_) { return false; }
  if (dest.origin !== cur.origin || dest.pathname !== cur.pathname || dest.search !== cur.search) {
    return false;   // cross-document
  }
  if (dest.hash === cur.hash) return false;   // identical URL — not a fragment navigation
  const oldURL = cur.href, newURL = dest.href;
  setLocationFromUrl(newURL);
  bumpSettleGen();
  // `location.assign`/`href`/`hash`/anchor click APPEND a history entry;
  // `location.replace` REPLACES the current one. Both fire `hashchange`.
  // Tagged with the navigating realm, like pushState: a fragment navigation inside an iframe
  // belongs to THAT frame's session history, not the top document's.
  const realmId = typeof globalThis.__csimRealmId === 'function' ? globalThis.__csimRealmId() : 0;
  try {
    if (replace) {
      if (typeof globalThis.__setCurrentUrl  === 'function') globalThis.__setCurrentUrl(newURL, null, realmId);
    } else {
      if (typeof globalThis.__pushHistoryEntry === 'function') globalThis.__pushHistoryEntry(newURL, null, realmId);
    }
  } catch (_) {}
  // `hashchange` is fired from a QUEUED TASK, not synchronously during the assignment:
  // HTML fires it while "applying the history step", after the script that navigated has run
  // to completion. Measured in Chrome — a listener registered on the line AFTER
  // `location.hash = '#x'` still receives the event, and it arrives before a co-queued
  // `setTimeout(…, 50)`. Firing it inline would deliver it to nobody in the very common
  // assign-then-await shape (`location.href = '#f'; await waitFor(window, 'hashchange')`).
  // `location.href` itself is already up to date synchronously, which is also what Chrome does.
  globalThis.setTimeout(() => {
    try { globalThis.dispatchEvent(new globalThis.HashChangeEvent('hashchange', { oldURL, newURL })); } catch (_) {}
  }, 0);
  return true;   // same-document fragment navigation performed
}

globalThis.__csimUpdateLocation = function (url) {
  let s = String(url || '');
  // SPA helpers (Turbo Drive's `history.replace`, Avo's tabs
  // controller) pass `pathname + search` rather than a full URL.
  // Real browsers resolve the pushState/replaceState argument
  // against the document's current location; storing the raw path
  // leaves `location.href` / `document.baseURI` schemeless, which
  // breaks any downstream `new URL(x, document.baseURI)` (Turbo's
  // lazy-frame `expandURL` is the canonical failure mode).
  if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    try {
      const base = (globalThis.location && globalThis.location.href) || null;
      if (base && /^[a-z][a-z0-9+.-]*:/i.test(base)) s = new URL(s, base).href;
    } catch (_) {}
  }
  setLocationFromUrl(s);
  // URL change is observable progress; settle yields on it the same
  // way it yields on DOM mutations.
  bumpSettleGen();
};

// An about:blank / about:srcdoc document's URL is opaque, but its base URL — used
// to resolve relative URLs — is inherited from its creator (HTML "about base
// URL"). Seeded at frame build (create_frame_realm, before the document loads)
// with the parent document's base URL; stored ON the document (which
// __csimLoadDocument reuses in place) so `documentBaseURL` reads the right base
// even for a cross-realm `contentDocument.baseURI`. `location.href` still reports
// about:blank/srcdoc; only relative resolution consults it, gated on an opaque URL.
globalThis.__csimSetAboutBaseURL = function (base) {
  if (globalThis.document) globalThis.document.__aboutBaseURL = base ? String(base) : null;
};
