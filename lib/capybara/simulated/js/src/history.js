// History stub — Turbo Drive + many SPA libs read `history.length`
// and call `history.pushState` / `replaceState`. We thread URL
// changes through `globalThis.__pushHistoryEntry` (Ruby Browser
// records history entry) for push and `globalThis.__setCurrentUrl`
// for replace, then sync `globalThis.location` via
// `__csimUpdateLocation`.
//
// InstantClick / Turbo-style SPA navigation flips the URL via
// pushState without a real document reload; any inline script that
// gates on `window.location.pathname` (Forem's top-bar XHR check
// for `!== '/notifications'`) must observe the new value.

function applyHistoryUrl(self, state, url, push) {
  self.state = state;
  if (!url) return;
  const s = String(url);
  if (globalThis.location && globalThis.location.href === s) return;
  // pushState appends a new history entry per browser model;
  // replaceState updates the current entry in place. Ruby's
  // `@history` mirrors browser history so `Capybara#go_back` can
  // navigate to the entry the user came from when SPA flows
  // (Turbo Visit, InstantClick) push the URL without a full nav.
  if (push && typeof globalThis.__pushHistoryEntry === 'function') {
    globalThis.__pushHistoryEntry(s);
  } else {
    globalThis.__setCurrentUrl(s);
  }
  globalThis.__csimUpdateLocation(s);
}

export const history = {
  length: 1,
  state:  null,
  pushState(state, _title, url)    { applyHistoryUrl(this, state, url, true); },
  replaceState(state, _title, url) { applyHistoryUrl(this, state, url, false); },
  back()    { globalThis.__locationReload(); },
  forward() { globalThis.__locationReload(); },
  go()      { globalThis.__locationReload(); }
};
