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

function parseUrlForLocation(url) {
  try {
    const u = globalThis.__csim_parseUrl(url, null);
    if (u && !u.error) {
      const loc = Object.assign({}, u, {
        toString() { return this.href; },
        assign:  (next) => globalThis.__locationAssign(next),
        replace: (next) => globalThis.__locationAssign(next),
        reload:  () => globalThis.__locationReload()
      });
      const navTarget = (resolved) => globalThis.__locationAssign(resolved);
      Object.defineProperty(loc, 'href', {
        configurable: true,
        get() { return u.href; },
        set(v) { navTarget(String(v)); }
      });
      // Our URL impl doesn't update `href` when a part setter fires,
      // so rebuild the absolute URL by string-composing the parts.
      const composeWith = (overrides) => {
        const o = Object.assign({}, u, overrides);
        const cred = o.username || o.password
          ? (o.username || '') + (o.password ? ':' + o.password : '') + '@'
          : '';
        return (o.protocol || '') + '//' + cred + (o.host || '') +
               (o.pathname || '') + (o.search || '') + (o.hash || '');
      };
      const assignPart = (key, prefix) => {
        Object.defineProperty(loc, key, {
          configurable: true,
          get() { return u[key]; },
          set(v) {
            const s = String(v == null ? '' : v);
            const part = prefix && s.length > 0 && !s.startsWith(prefix) ? prefix + s : s;
            navTarget(composeWith({ [key]: part }));
          }
        });
      };
      assignPart('pathname', '/');
      assignPart('hash',     '#');
      assignPart('search',   '?');
      return loc;
    }
  } catch (_) {}
  return {
    href: url || '', protocol: 'http:', host: '', hostname: '',
    port: '', pathname: '/', search: '', hash: '', origin: '',
    toString() { return this.href; },
    assign:  (next) => globalThis.__locationAssign(next),
    replace: (next) => globalThis.__locationAssign(next),
    reload:  () => globalThis.__locationReload()
  };
}

export function makeLocation(url) { return parseUrlForLocation(url); }

// Back globalThis.location with a getter/setter pair so
// `window.location = '/foo'` triggers navigation (per HTML spec
// `[LegacyUnforgeable] WindowProxy Window.location` with the
// `[Replaceable]` location-href setter behavior). Without the setter
// the assignment would silently rebind `globalThis.location` to the
// string, breaking every subsequent `location.href` access.
let _location = makeLocation('http://www.example.com/');
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
  _location = makeLocation(s);
  // URL change is observable progress; settle yields on it the same
  // way it yields on DOM mutations.
  bumpSettleGen();
};
