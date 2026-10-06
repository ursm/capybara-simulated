// Media queries for script: a media query list matched on this window's viewport by the style engine's own evaluator
// (style.rs `media_matches`, the one its cascade applies `@media` rules by — so a `matchMedia` branch and the CSS it
// pairs with never disagree), and `window.matchMedia`'s MediaQueryList over it.

import {
  EventTarget, MediaQueryListEvent, addListener, dispatchWithOnHandler, installEventHandlerAttrs, removeListener
} from './events.js';
import { installMediaQueryList } from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

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

// `matchMedia(query)`'s MediaQueryList (CSSOM View §4.2), generated from its IDL: its `media` the list serialized, and
// its listeners told when its answer flips — at a window's resize steps (`__csimViewportChanged`), so responsive
// component libraries see the transition. No page constructs one.
class MediaQueryList extends EventTarget {
  constructor(token, text) {
    constructedBy(PLATFORM, token, 'MediaQueryList');
    super();
    const s = makeSlots(this, 'MediaQueryList');
    s.media = globalThis.__dom.mediaText(text);
    s.lastMatches = mediaMatches(s.media, currentViewport());
  }
}
const mqlOf = (o) => slotsOf(o, 'MediaQueryList');
registerInterface('MediaQueryList', (o) => mqlOf(o) !== undefined);
installMediaQueryList(MediaQueryList, {
  get_media: (mql) => mqlOf(mql).media,
  get_matches: (mql) => mediaMatches(mqlOf(mql).media, currentViewport()),
  // (…the legacy `addListener` / `removeListener`: a `change` listener added or removed, as `addEventListener` would)
  addListener: (mql, callback) => addListener(mql, 'change', callback, false),
  removeListener: (mql, callback) => removeListener(mql, 'change', callback, false),
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.MediaQueryList = MediaQueryList;
const _activeQueries = [];

// (The Window's, window.js, which converted `query`.)
export function matchMedia(query) {
  const mql = new MediaQueryList(PLATFORM, query);
  _activeQueries.push(mql);
  return mql;
}
globalThis.__csimViewportChanged = function () {
  for (const mql of _activeQueries) {
    const s = mqlOf(mql), now = mediaMatches(s.media, currentViewport());
    if (now !== s.lastMatches) {
      s.lastMatches = now;
      dispatchWithOnHandler(mql, new MediaQueryListEvent('change', { matches: now, media: s.media }));
    }
  }
};
