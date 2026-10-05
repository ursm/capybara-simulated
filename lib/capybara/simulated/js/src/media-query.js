// Media queries for script: a media query list matched on this window's viewport by the style engine's own evaluator
// (style.rs `media_matches`, the one its cascade applies `@media` rules by — so a `matchMedia` branch and the CSS it
// pairs with never disagree), and `window.matchMedia`'s MediaQueryList over it.

import { Event, EventTarget, dispatchWithOnHandler, defineEventHandler } from './events.js';
import { defineClassString } from './webidl.js';

// Whether the media query list `text` matches on a viewport `vp`.
export function mediaMatches(text, vp) {
  return globalThis.__dom.mediaMatches(String(text), vp.width, vp.height);
}

// The driver-owned viewport (`platform-globals.js` `__csimViewport`, written by Ruby's
// `Browser#set_viewport`). Read it directly rather than through `innerWidth` / `innerHeight`:
// those are `[Replaceable]`, so a page that assigns them shadows the getter — and a page must not
// be able to move the `@media` breakpoints or the layout out from under the driver. Shared with
// the cascade resolver and the layout engine so all three agree on one size.
export function currentViewport() {
  const vp = globalThis.__csimViewport;
  return vp ? {width: vp.width, height: vp.height} : {width: 1024, height: 768};
}

// `matchMedia(query)`: its `media` the list serialized, and its listeners told when its answer flips — at a window's
// resize steps (`__csimViewportChanged`), so responsive component libraries see the transition.
class MediaQueryList extends EventTarget {
  static { defineClassString(this.prototype, 'MediaQueryList'); }   // (…its own, over EventTarget's)
  constructor(text) {
    super();
    this.media = globalThis.__dom.mediaText(text);
    this._lastMatches = mediaMatches(text, currentViewport());
  }
  get matches() { return mediaMatches(this.media, currentViewport()); }
  addListener(handler)    { this.addEventListener('change', handler); }
  removeListener(handler) { this.removeEventListener('change', handler); }
}
defineEventHandler(MediaQueryList.prototype, 'change');
const _activeQueries = [];
// A media query list's `change` event (CSSOM View): whether it matches now, and its query.
class MediaQueryListEvent extends Event {
  constructor(type, init = {}) {
    if (arguments.length < 1) throw new TypeError("Failed to construct 'MediaQueryListEvent': 1 argument required, but only 0 present.");
    super(type, init);
    this.matches = !!init.matches;
    this.media = init.media === undefined ? '' : String(init.media);
  }
}
globalThis.MediaQueryListEvent = MediaQueryListEvent;

// (The Window's, window.js, which converted `query`.)
export function matchMedia(query) {
  const mql = new MediaQueryList(query);
  _activeQueries.push(mql);
  return mql;
}
globalThis.__csimViewportChanged = function () {
  for (const mql of _activeQueries) {
    const now = mediaMatches(mql.media, currentViewport());
    if (now !== mql._lastMatches) {
      mql._lastMatches = now;
      dispatchWithOnHandler(mql, new MediaQueryListEvent('change', { matches: now, media: mql.media }));
    }
  }
};
