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
// component libraries see the transition. Its matches state, and which of a realm's lists flipped, are the engine's
// (media_query_lists.rs). No page constructs one.
class MediaQueryList extends EventTarget {
  constructor(token, text) {
    constructedBy(PLATFORM, token, 'MediaQueryList');
    super();
    const media = globalThis.__dom.mediaText(text), vp = currentViewport();
    makeSlots(this, 'MediaQueryList', { media, id: globalThis.__dom.mqlNew(this, media, vp.width, vp.height) });
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

// (The Window's, window.js, which converted `query`.)
export function matchMedia(query) {
  return new MediaQueryList(PLATFORM, query);
}
globalThis.__csimViewportChanged = function () {
  const vp = currentViewport(), changes = globalThis.__dom.mqlChanges(vp.width, vp.height);
  for (let i = 0; i < changes.length; i += 2) {
    const mql = changes[i], matches = changes[i + 1];
    dispatchWithOnHandler(mql, new MediaQueryListEvent('change', { matches, media: mqlOf(mql).media }));
  }
};
