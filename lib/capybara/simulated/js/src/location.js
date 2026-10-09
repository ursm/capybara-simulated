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

import { bumpSettleGen, bumpStyleState } from './mutation-observer.js';
import { fireEvent } from './dispatch.js';
import { HashChangeEvent } from './events.js';
import { indicatedPart, targetFragments, setTargetHash } from './target.js';
import { domStringList } from './dom-string-list.js';
import { installLocation } from './generated/bindings.js';
import { makeSlots, ownRealm, registerInterface, slotsOf } from './webidl.js';

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
// own location setter is mid-flight). The main realm keeps the plain top navigation.
function dispatchNav(resolved, replace) {
  const NS = globalThis.RustyRacer;
  // A same-origin WINDOW realm (window.open in this isolate) is its own top, so the
  // frame branch below (top !== self) doesn't fire and the plain top-page path is
  // wrong (it'd navigate the opener). Route to __csimWindowRealmNavigate, which
  // reloads THIS realm's document — deferred host-side so we don't re-enter the
  // realm while its own location setter is on the stack.
  if (globalThis.__csimIsWindowRealm && typeof globalThis.__csimWindowRealmNavigate === 'function') {
    let abs = String(resolved);
    try { abs = new globalThis.URL(abs, _u.href || undefined).href; } catch (_) {}
    globalThis.__csimWindowRealmNavigate(abs, NS.contextOf(globalThis), !!replace);
    return;
  }
  if (globalThis.__csimTop && globalThis.__csimTop !== globalThis &&
      typeof globalThis.__csimFrameNavigate === 'function') {
    // A location navigation supersedes a pending form submission to this same
    // frame (HTML "plan to navigate": one pending navigation per navigable, last
    // wins). The form submit's fetch lands in a microtask; cancel its plan NOW —
    // synchronously, same-isolate via the container — so that land skips and only
    // this navigation takes effect (form-submit-iframe-then-location-navigate).
    // `_frameNavPending` stays set: this nav replaces the form's, so the frame's
    // initial about:blank load stays suppressed until THIS navigation lands.
    const fe = globalThis.__csimFrameContainer;
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
      try { base = (globalThis.__csimParent && globalThis.__csimParent.location && globalThis.__csimParent.location.href) || base; } catch (_) {}
    }
    try { abs = new globalThis.URL(abs, base).href; } catch (_) {}
    // Navigating a frame to a blob: URL takes a reference to the blob NOW; the
    // page may revoke it before the deferred nav applies, so snapshot the bytes
    // onto the owning iframe element (consumed by __csimNavigateFrameByRealm). A
    // blob's bytes live in its CREATING realm's local map (the host registry holds
    // only an existence marker unless workers exist), so resolve via the ancestor
    // realm chain — the navigator (an ancestor: parent/top, else self) holds them.
    if (/^blob:/i.test(abs) && globalThis.__csimFrameContainer) {
      const fe = globalThis.__csimFrameContainer;
      for (const w of [globalThis.__csimParent, globalThis.__csimTop, globalThis]) {
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
// Spec: a Location setter / assign / replace parses the given value against the
// document's URL; a parse FAILURE throws a SyntaxError DOMException synchronously,
// so a malformed URL never reaches the navigation/fetch path (url/failure.html).
// A valid value (including a relative URL or a bare `#frag`, which resolve
// against the base) does not throw.
// (…`member` the words of the message: Chrome's)
function validateNavOrThrow(input, member) {
  if (globalThis.__csim_urlIsMalformed(input, _u && _u.href)) {
    throw new globalThis.DOMException(`Failed to ${member} on 'Location': '${input}' is not a valid URL.`, 'SyntaxError');
  }
}
// Location (HTML §7.2.4), generated from its IDL: one per window — this realm's `location` — every member its own,
// unforgeable property. Its URL is the document's (`_u`, as `__csimUpdateLocation` keeps it); each setter sets a part
// of a copy of it as the URL Standard's setter does (url_ops.rs `urlSet`) and navigates there, a fragment one in the
// document. A member of another realm's binding run on it is its own realm's (`ownRealm`): an iframe's location
// navigates that iframe, whoever's `assign` is called on it.
const REALM = {};
const locationOf = (o) => slotsOf(o, 'Location');
registerInterface('Location', (o) => locationOf(o) !== undefined);
class Location {
  constructor() { throw new TypeError("Failed to construct 'Location': Illegal constructor"); }
}
globalThis.Location = Location;
// (…the URL its copy becomes with `part` set to `value`, as the URL interface's setter sets it)
const withPart = (part, value) => globalThis.__dom.urlSet(_u.href, part, value)[0];
// (…a navigation to `url`: a fragment one in the document, any other through the host)
function navigateTo(url, replace = false) {
  if (!tryFragmentNavigate(url, replace)) dispatchNav(url, replace);
}
// (…its setters'; `protocol`'s a scheme — its value up to a colon — the scheme start state takes, else a SyntaxError,
// and a navigation only to an HTTP(S) URL; `host`'s, `hostname`'s, `port`'s and `pathname`'s none for a URL with an
// opaque path; `hash`'s an empty fragment for the empty string — the URL ending in `#` — and none to the same one)
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
function setPart(part, value) {
  if (part === 'protocol') {
    if (!SCHEME.test(value.replace(/[\t\n\r]/g, '') + ':')) {
      throw new globalThis.DOMException(
        `Failed to set the 'protocol' property on 'Location': '${value}' is an invalid protocol.`, 'SyntaxError');
    }
    const url = withPart('protocol', value);
    if (/^https?:/.test(url)) navigateTo(url);
    return;
  }
  if (part !== 'search' && part !== 'hash' && _u.pathname[0] !== '/' && _u.host === '') return;
  if (part === 'hash') {
    const url = withPart('hash', '#' + value.replace(/^#/, ''));
    if (url !== _u.href) navigateTo(url);
    return;
  }
  navigateTo(withPart(part, value));
}
const locationSteps = {
  get_href: () => _u.href,
  set_href(loc, url) {
    validateNavOrThrow(url, "set the 'href' property");
    navigateTo(url);
  },
  // `origin` is the serialization of THIS document's URL's origin. For a frame whose URL is opaque — about:blank (empty
  // `<iframe>`), srcdoc, or a javascript: URL — that origin is the opaque "null", even though the document's own
  // origin (`window.origin`) is the inherited parent (carried separately in `__csimDocumentOrigin`). The override is
  // seeded at frame build (see `__csimSetLocationOrigin`); decoupling it from `href` keeps the realm's location string —
  // and thus base-target / named-frame navigation — untouched. (self-origin.sub about:blank / srcdoc subtests.)
  get_origin: () => globalThis.__csimLocationOriginOverride ?? _u.origin,
  assign(loc, url) {
    validateNavOrThrow(url, "execute 'assign'");
    navigateTo(url);
  },
  replace(loc, url) {
    validateNavOrThrow(url, "execute 'replace'");
    navigateTo(url, true);
  },
  reload() {
    // In a NESTED browsing context (a frame realm) reload re-navigates THAT frame, not the top page: route to the host
    // fn `__csimFrameReload`, which defers and re-navigates the owning iframe by realm id (mirrors dispatchNav). The
    // main realm keeps the top reload.
    if (globalThis.__csimTop && globalThis.__csimTop !== globalThis && typeof globalThis.__csimFrameReload === 'function') {
      globalThis.__csimFrameReload(globalThis.RustyRacer.contextOf(globalThis));
      return;
    }
    globalThis.__locationReload();
  },
  // (…its ancestors' origins, nearest first: its parent's, its parent's parent's, … — the same list every time, as it
  // was when the location was made)
  get_ancestorOrigins(loc) {
    const s = locationOf(loc);
    return s.ancestorOrigins ??= domStringList(ancestorOrigins());
  }
};
for (const part of ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
  locationSteps[`get_${part}`] = () => _u[part];
  locationSteps[`set_${part}`] = (loc, value) => setPart(part, value);
}
function ancestorOrigins() {
  const origins = [];
  for (let win = globalThis; win.__csimParent && win.__csimParent !== win; win = win.__csimParent) {
    let origin = 'null';
    try { origin = win.__csimParent.__csimOrigin(); } catch (_) {}
    origins.push(origin);
  }
  return origins;
}
const defineLocationMembers = installLocation(Location, ownRealm(REALM, 'Location', locationOf, locationSteps));
const location = Object.create(Location.prototype);
makeSlots(location, 'Location', { realm: REALM, ancestorOrigins: null });
defineLocationMembers(location);
// HTML "set up a Location object": its own `valueOf` (Object.prototype's) and @@toPrimitive (undefined), neither of them
// to be changed.
Object.defineProperty(location, 'valueOf', { value: Object.prototype.valueOf, writable: false, enumerable: false, configurable: false });
Object.defineProperty(location, Symbol.toPrimitive, { value: undefined, writable: false, enumerable: false, configurable: false });
function setLocationFromUrl(url) {
  try {
    const parsed = globalThis.__csim_parseUrl(url, null);
    if (parsed && !parsed.error) { _u = parsed; return; }
  } catch (_) {}
  _u = Object.assign({}, _u, { href: url || '', pathname: '/', search: '', hash: '' });
}


// The window's Location (window.js: `window.location`, [PutForwards=href] — `window.location = X` is
// `location.href = X`).
export { location };

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
  retarget(dest.hash);
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
  globalThis.__csimSetTimeout(() => {
    fireEvent(globalThis, new HashChangeEvent('hashchange', { oldURL, newURL }));
  }, 0);
  return true;   // same-document fragment navigation performed
}

// (`historyApi`: a pushState / replaceState URL, which scrolls to no fragment and keeps the target.)
globalThis.__csimUpdateLocation = function (url, historyApi = false) {
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
  // way it yields on DOM mutations. A load's or a traversal's fragment is the new target's.
  bumpSettleGen();
  if (!historyApi) retarget(hashOf(s));
};

function hashOf(href) {
  try { return new globalThis.URL(String(href)).hash; } catch (_) { return ''; }
}

// A load, a fragment navigation or a traversal gives the document a new target fragment (target.js): when the target
// element changes with it, the flip moves the style-state generation. A history API URL change is none of those —
// pushState / replaceState leave the target where it was — and an unchanged target moves no generation at all.
function retarget(newHash) {
  const doc = globalThis.document;
  if (!doc) return;
  const before = indicatedPart(doc, targetFragments(doc));
  setTargetHash(newHash);
  const after = indicatedPart(doc, targetFragments(doc));
  if (before !== after) bumpStyleState();
}

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
