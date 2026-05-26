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
function navTarget(resolved) { return globalThis.__locationAssign(resolved); }
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
  assign:  (next) => globalThis.__locationAssign(next),
  replace: (next) => globalThis.__locationAssign(next),
  reload:  () => globalThis.__locationReload()
};
Object.defineProperty(_location, 'href', {
  configurable: true,
  get() { return _u.href; },
  set(v) { navTarget(String(v)); }
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
      navTarget(composeWith({ [key]: part }));
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
  set(v) { globalThis.__locationAssign(String(v)); }
});

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
