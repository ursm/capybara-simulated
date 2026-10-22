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
import { setTargetHash, targetElementNid } from './target.js';
import { FC_PENDING_BLOB, frameContentHeld, setFrameContent } from './frame-nav.js';
import { domStringList } from './dom-string-list.js';
import { installLocation } from './generated/bindings.js';
import { setHistoryState } from './history.js';
import { makeSlots, ownRealm, registerInterface, slotsOf } from './webidl.js';
import { REALM as NATIVE_REALM } from './native-query-shadow.js';
import { parseURL, schemeRoute } from './url-parse.js';
import { ROUTE_BLOB } from './constants.js';
import { documentBaseURL, documentEncoding, parseDocumentURL } from './base-url.js';
import { DOMException } from './dom-exception.js';

// Per HTML spec, `window.location` is a single live object whose
// component getters reflect the current URL — assignments to
// `location.href = …` or pushState/replaceState updates are visible
// through any reference taken earlier. Ember's `HistoryLocation.init`
// caches `this.location = window.location` once, then reads
// `this.location.pathname` on every popstate/setURL; if each
// `__csimUpdateLocation` created a brand-new object, that cached
// reference froze on the initial URL and Ember's history bookkeeping
// (`_previousURL`, `getURL()`) silently desynced from the real URL.
// So one persistent `location` reads the realm's URL — the engine's (realm_location.rs), by its parts' numbers
// (url_ops.rs `parts`) — afresh each time.
const URL_PARTS = { href: 0, protocol: 1, host: 4, hostname: 5, port: 6, pathname: 7, search: 8, hash: 9, origin: 10 };
const urlPart = (part) => globalThis.__dom.locationPart(URL_PARTS[part]);
const currentHref = () => urlPart('href');
// A cross-document navigation. In a NESTED browsing context (a frame realm — its
// `top` is the parent, unlike the main realm whose `top` is itself) a
// `location` assignment must navigate THAT FRAME, not the top page: route it to
// `__csimFrameNavigate(url, thisRealmId)`, which the host defers and applies by
// re-navigating the owning iframe (so we never dispose the child realm while its
// own location setter is mid-flight). The main realm keeps the plain top navigation. `initiator` the realm whose
// document navigates it where that is another's (`__csimNavigateFrom`: `open()`'s), its Referer that document's.
function dispatchNav(resolved, replace, initiator) {
  const NS = globalThis.RustyRacer;
  // A same-origin WINDOW realm (window.open in this isolate) is its own top, so the
  // frame branch below (top !== self) doesn't fire and the plain top-page path is
  // wrong (it'd navigate the opener). Route to __csimWindowRealmNavigate, which
  // reloads THIS realm's document — deferred host-side so we don't re-enter the
  // realm while its own location setter is on the stack.
  if (globalThis.__csimIsWindowRealm && typeof globalThis.__csimWindowRealmNavigate === 'function') {
    globalThis.__csimWindowRealmNavigate(resolved, NS.contextOf(globalThis), !!replace);
    return;
  }
  if (globalThis.__csimTop && globalThis.__csimTop !== globalThis &&
      typeof globalThis.__csimFrameNavigate === 'function') {
    // A location navigation supersedes a pending form submission to this same
    // frame (HTML "plan to navigate": one pending navigation per navigable, last
    // wins). The form submit's fetch lands in a microtask; cancel its plan NOW —
    // synchronously, same-isolate via the container — so that land skips and only
    // this navigation takes effect (form-submit-iframe-then-location-navigate).
    // FN_NAV_PENDING stays set: this nav replaces the form's, so the frame's
    // initial about:blank load stays suppressed until THIS navigation lands.
    const fe = globalThis.__csimFrameContainer;
    if (fe) globalThis.__dom.cancelFrameNavigation(fe._nid);
    const abs = resolved;
    // Navigating a frame to a blob: URL takes a reference to the blob NOW; the
    // page may revoke it before the deferred nav applies, so snapshot the bytes
    // into the owning iframe's navigation (frame-nav.js `FC_PENDING_BLOB`, consumed by
    // __csimNavigateFrameByRealm) — an earlier one's never consumed dropped first. A
    // blob's bytes live in its CREATING realm's local map (the host registry holds
    // only an existence marker unless workers exist), so resolve via the ancestor
    // realm chain — the navigator (an ancestor: parent/top, else self) holds them.
    if (schemeRoute(abs) === ROUTE_BLOB && globalThis.__csimFrameContainer) {
      const fe = globalThis.__csimFrameContainer;
      setFrameContent(fe, FC_PENDING_BLOB, null);
      for (const w of [globalThis.__csimParent, globalThis.__csimTop, globalThis]) {
        if (w && typeof w.__csimSnapshotFrameNavBlob === 'function') {
          w.__csimSnapshotFrameNavBlob(fe, abs);
          if (frameContentHeld(fe, FC_PENDING_BLOB)) break;
        }
      }
    }
    globalThis.__csimFrameNavigate(abs, NS.contextOf(globalThis), !!replace, initiator);
    return;
  }
  supersedePlannedNavigation();
  globalThis.__locationAssign(resolved, !!replace, initiator);
}
// A navigation of the top-level document planned — a location's, a hyperlink's followed, a form's submitted — which
// supersedes the one planned before it (HTML "plan to navigate": the later is taken; Chrome navigates to `/b` for
// `form.submit(); location.href = '/b'`, to the form's for the other order), the host taking whichever is left as the
// task ends. (A frame's are its container's to plan: `cancelFrameNavigation` above.)
export function supersedePlannedNavigation() {
  globalThis.__dom.supersedePlanned();
  globalThis.__csimCancelPlannedNavigation?.();
}
// HTML: `href`'s setter, `assign` and `replace` encoding-parse the given value relative to the ENTRY settings object —
// the document of the script that called them, whichever window's location it is — a failure a SyntaxError, so a
// malformed URL never reaches the navigation. `member` the words of the message: Chrome's. The entry is taken as the
// realm whose member was called: `location.assign.call(frame.location, 'x')` resolves against the page, as HTML has it,
// but the frame's own `href` setter called from the page (`frames[0].location.href = 'x'`) against the frame, where
// HTML has the page — the realm a script runs in is not entered per task here (a frame's tasks run in the page's
// entered context), so V8's entered context would be the page's for a frame's own scripts too.
function entryURL(input, member) {
  const doc = globalThis.document;
  const parsed = doc ? parseDocumentURL(doc, input) : parseURL(input, currentHref())?.href ?? null;
  if (parsed !== null) return parsed;
  throw new DOMException(`Failed to ${member} on 'Location': '${input}' is not a valid URL.`, 'SyntaxError');
}
// Location (HTML §7.2.4), generated from its IDL: one per window — this realm's `location` — every member its own,
// unforgeable property. Its URL is the document's (`urlPart`, as `__csimUpdateLocation` sets it); each setter sets a part
// of a copy of it as the URL Standard's setter does (url_ops.rs `location_set`) and navigates there, a fragment one in the
// document. A member of another realm's binding run on it is its own realm's (`ownRealm`): an iframe's location
// navigates that iframe, whoever's `assign` is called on it.
const REALM = {};
const locationOf = (o) => slotsOf(o, 'Location');
registerInterface('Location', (o) => locationOf(o) !== undefined);
class Location {
  constructor() { throw new TypeError("Failed to construct 'Location': Illegal constructor"); }
}
globalThis.Location = Location;
// (…a navigation to `url`, an absolute URL: a javascript: one run in the realm, a fragment one in the document, any
// other through the host)
function navigateTo(url, replace = false, initiator = undefined) {
  if (globalThis.__csimNavigateJavascriptURL(url, null)) return;
  if (!tryFragmentNavigate(url, replace)) dispatchNav(url, replace, initiator);
}
// …made of this realm's navigable by the document of realm `initiator` (`open()`'s of a navigable it chose): a
// javascript: URL of its evaluated here only where its origin is this one's (HTML "navigate to a javascript: URL":
// none across origins).
globalThis.__csimNavigateFrom = function (url, initiator) {
  if (/^javascript:/i.test(url) && !globalThis.__dom.sameOriginRealm(initiator)) return;
  navigateTo(url, false, initiator);
};
// (…its setters': the URL a part's setter navigates to, if any, and a SyntaxError for a protocol that is none — the
// engine's, in the document's encoding (url_ops.rs `location_set`))
function setPart(part, value) {
  const url = globalThis.__dom.locationSet(currentHref(), part, value, documentEncoding(globalThis.document));
  if (url !== null) navigateTo(url);
}
const locationSteps = {
  get_href: currentHref,
  set_href: (loc, url) => navigateTo(url),
  // `origin` is the serialization of THIS document's URL's origin. For a frame whose URL is opaque — about:blank (empty
  // `<iframe>`), srcdoc, or a javascript: URL — that origin is the opaque "null", even though the document's own
  // origin (`window.origin`) is the inherited parent (carried separately: `__csimSetDocumentOrigin`). The override is
  // seeded at frame build (see `__csimSetLocationOrigin`) and the engine's to answer with; decoupling it from `href`
  // keeps the realm's location string — and thus base-target / named-frame navigation — untouched. (self-origin.sub
  // about:blank / srcdoc subtests.)
  get_origin: () => urlPart('origin'),
  assign: (loc, url) => navigateTo(url),
  replace: (loc, url) => navigateTo(url, true),
  reload() {
    // In a NESTED browsing context (a frame realm) reload re-navigates THAT frame, not the top page: route to the host
    // fn `__csimFrameReload`, which defers and re-navigates the owning iframe by realm id (mirrors dispatchNav). The
    // main realm keeps the top reload — a navigation planned as any other, which replaces the one planned before it
    // (Chrome: `location.href = '/b'; location.reload()` reloads the document it is at).
    if (globalThis.__csimTop && globalThis.__csimTop !== globalThis && typeof globalThis.__csimFrameReload === 'function') {
      globalThis.__csimFrameReload(globalThis.RustyRacer.contextOf(globalThis));
      return;
    }
    supersedePlannedNavigation();
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
  locationSteps[`get_${part}`] = () => urlPart(part);
  locationSteps[`set_${part}`] = (loc, value) => setPart(part, value);
}
// (…a window's parent the global, not the WindowProxy its `__csimParent` may be; the top window's none)
const rawWindow = (win) => win && (win.__csimRawWindow || win);
function ancestorOrigins() {
  const origins = [];
  for (let win = globalThis, parent = rawWindow(win.__csimParent); parent && parent !== win; win = parent, parent = rawWindow(win.__csimParent)) {
    // (…its realm's document's origin, the engine's — "null" for one dropped)
    const realm = globalThis.__csimRealmOfWindow(parent);
    origins.push((realm != null && globalThis.__dom.realmOrigin(realm)) || 'null');
  }
  return origins;
}
// (…the URL `href`'s setter, `assign` and `replace` take resolved against the entry's document before the location's
// own realm navigates to it)
const steps = ownRealm(REALM, 'Location', locationOf, locationSteps);
for (const [member, words] of [['set_href', "set the 'href' property"], ['assign', "execute 'assign'"], ['replace', "execute 'replace'"]]) {
  const step = steps[member];
  steps[member] = (loc, url) => step(loc, entryURL(url, words));
}
const defineLocationMembers = installLocation(Location, steps);
// HTML's Location is an exotic object: its prototype is not to be changed nor it made inextensible (§7.2.4.1
// [[SetPrototypeOf]], [[PreventExtensions]]) — the Proxy a page holds, the object its members are defined on behind it.
const target = Object.create(Location.prototype);
const location = new Proxy(target, {
  setPrototypeOf: (t, proto) => proto === Object.getPrototypeOf(t),
  preventExtensions: () => false
});
makeSlots(location, 'Location', { realm: REALM, ancestorOrigins: null });
defineLocationMembers(location);
// HTML "set up a Location object": its own `valueOf` (Object.prototype's) and @@toPrimitive (undefined), neither of them
// to be changed.
Object.defineProperty(location, 'valueOf', { value: Object.prototype.valueOf, writable: false, enumerable: false, configurable: false });
Object.defineProperty(location, Symbol.toPrimitive, { value: undefined, writable: false, enumerable: false, configurable: false });
const setLocationFromUrl = (url) => globalThis.__dom.setLocationURL(url || '');


// The window's Location (window.js: `window.location`, [PutForwards=href] — `window.location = X` is
// `location.href = X`).
export { location };
// …and this realm's URL, as whichever realm asks for it — a window's, a worker's script's — read off the slot, not the
// `location` a page or a worker script can shadow (base-url.js `documentURL`).
NATIVE_REALM.realmURL = currentHref;

// HTML "navigate to a fragment", shared by every same-document fragment
// navigation: an anchor/area click (`fragmentNavigate` in dom-nodes.js)
// AND a `location.hash` / `location.href` / `location.assign` assignment
// (the setters below). When `destHref` resolves to a navigation to a
// fragment of the current document, we perform it here — synchronously
// update the live `location` object, mirror onto Ruby's history/current-URL,
// and fire `hashchange` when the URL changed — with NO document fetch.
// Returns true when the destination is same-document (handled here), false
// when it is not (the caller loads it: assigning a fragmentless URL its own —
// `location.href = location.href` on one — reloads). Relative refs resolve
// against the current location.
export function tryFragmentNavigate(destHref, replace = false) {
  const oldURL = currentHref();
  const dest = parseURL(destHref, oldURL);
  if (dest === null) return false;
  // (…HTML "navigate": a URL with a fragment — `#` too — equal to the document's but for their fragments, the engine's
  // rule: url_ops.rs `is_fragment_navigation`)
  if (!globalThis.__dom.urlIsFragmentNavigation(oldURL, dest.href)) return false;
  const newURL = dest.href;
  setLocationFromUrl(newURL);
  setHistoryState(null);   // (…the new entry's classic history API state: none)
  bumpSettleGen();
  retarget(dest.hash);
  // `location.assign`/`href`/`hash`/anchor click APPEND a history entry — but for the URL the document is already
  // at, which REPLACES it (HTML "navigate": "auto" history handling) — and `location.replace` REPLACES the current one.
  // Tagged with the navigating realm, like pushState: a fragment navigation inside an iframe
  // belongs to THAT frame's session history, not the top document's.
  const realmId = typeof globalThis.__csimRealmId === 'function' ? globalThis.__csimRealmId() : 0;
  try {
    if (replace || newURL === oldURL) {
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
  // (…none where the URL did not change: a navigation to the fragment the document is at only scrolls to it)
  if (newURL !== oldURL) queueHashChange(oldURL, newURL);
  return true;   // same-document fragment navigation performed
}
function queueHashChange(oldURL, newURL) {
  globalThis.__csimSetTimeout(() => {
    fireEvent(globalThis, new HashChangeEvent('hashchange', { oldURL, newURL }));
  }, 0);
}
// …and a traversal of the session history between two of the document's entries whose fragments differ (Ruby's
// `history_go`, after it fires the `popstate`).
globalThis.__csimQueueHashChange = queueHashChange;

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
    const base = currentHref();
    if (/^[a-z][a-z0-9+.-]*:/i.test(base)) s = parseURL(s, base)?.href ?? s;
  }
  setLocationFromUrl(s);
  // URL change is observable progress; settle yields on it the same
  // way it yields on DOM mutations. A load's or a traversal's fragment is the new target's.
  bumpSettleGen();
  if (!historyApi) retarget(urlPart('hash'));
};

// A load, a fragment navigation or a traversal gives the document a new target fragment (target.js): when the target
// element changes with it, the flip moves the style-state generation. A history API URL change is none of those —
// pushState / replaceState leave the target where it was — and an unchanged target moves no generation at all.
function retarget(newHash) {
  const doc = globalThis.document;
  if (!doc) return;
  const before = targetElementNid(doc);
  setTargetHash(newHash);
  if (targetElementNid(doc) !== before) bumpStyleState();
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
