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
  if (globalThis.top && globalThis.top !== globalThis &&
      NS && typeof NS.contextOf === 'function' &&
      typeof globalThis.__csimFrameNavigate === 'function') {
    // Resolve against THIS frame's current URL (location.href in a frame is
    // relative to the frame's document), so the host gets an absolute URL.
    let abs = String(resolved);
    try { abs = new globalThis.URL(abs, _u.href).href; } catch (_) {}
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
for (const key of ['protocol', 'host', 'hostname', 'port', 'origin', 'username', 'password']) {
  Object.defineProperty(_location, key, {
    configurable: true,
    get() { return _u[key]; }
  });
}
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
  try {
    if (replace) {
      if (typeof globalThis.__setCurrentUrl  === 'function') globalThis.__setCurrentUrl(newURL, null);
    } else {
      if (typeof globalThis.__pushHistoryEntry === 'function') globalThis.__pushHistoryEntry(newURL, null);
    }
  } catch (_) {}
  try { globalThis.dispatchEvent(new globalThis.HashChangeEvent('hashchange', { oldURL, newURL })); } catch (_) {}
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
