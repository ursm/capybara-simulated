// Media queries for script: a media query list matched on this window's viewport by the style engine's own evaluator
// (style.rs `media_matches`, the one its cascade applies `@media` rules by — so a `matchMedia` branch and the CSS it
// pairs with never disagree), and `window.matchMedia`'s MediaQueryList over it.

import {
  EventTarget, MediaQueryListEvent, addListener, dispatchWithOnHandler, installEventHandlerAttrs, removeListener
} from './events.js';
import { installMediaQueryList } from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

// Whether the media query list `text` matches on the realm's viewport.
export const mediaMatches = (text) => globalThis.__dom.mediaMatches(String(text));

// THE viewport — one value, the engine's (viewport.rs): the driver's for a top-level window (`Browser#set_viewport`,
// Capybara's `resize_to`), a frame's its container's content box. `innerWidth` / `innerHeight` read it, and the `@media`
// cascade, `matchMedia` and the layout engine evaluate against it there. Page script reaches it only through the
// Window's `[Replaceable]` attributes, so an assignment shadows the getter for that page without repointing layout —
// exactly what a real browser does. (The window's OUTER size is the same: we model no window chrome.)
export const currentViewport = () => ({ width: globalThis.__dom.viewport(0), height: globalThis.__dom.viewport(1) });

// `matchMedia(query)`'s MediaQueryList (CSSOM View §4.2), generated from its IDL: its `media` the list serialized, and
// its listeners told when its answer flips — at a window's resize steps (`__csimViewportChanged`), so responsive
// component libraries see the transition. Its matches state, and which of a realm's lists flipped, are the engine's
// (media_query_lists.rs). No page constructs one.
class MediaQueryList extends EventTarget {
  constructor(token, text) {
    constructedBy(PLATFORM, token, 'MediaQueryList');
    super();
    const media = globalThis.__dom.mediaText(text);
    makeSlots(this, 'MediaQueryList', { media, id: globalThis.__dom.mqlNew(this, media) });
  }
}
const mqlOf = (o) => slotsOf(o, 'MediaQueryList');
registerInterface('MediaQueryList', (o) => mqlOf(o) !== undefined);
installMediaQueryList(MediaQueryList, {
  get_media: (mql) => mqlOf(mql).media,
  get_matches: (mql) => mediaMatches(mqlOf(mql).media),
  // (…the legacy `addListener` / `removeListener`: a `change` listener added or removed, as `addEventListener` would)
  addListener: (mql, callback) => addListener(mql, 'change', callback, false),
  removeListener: (mql, callback) => removeListener(mql, 'change', callback, false),
  installEventHandlers: installEventHandlerAttrs
});
globalThis.MediaQueryList = MediaQueryList;

// (The Window's, window.js, which converted `query`.)
export function matchMedia(query) {
  return new MediaQueryList(PLATFORM, query);
}
globalThis.__csimViewportChanged = function () {
  const changes = globalThis.__dom.mqlChanges();
  for (let i = 0; i < changes.length; i += 2) {
    const mql = changes[i], matches = changes[i + 1];
    dispatchWithOnHandler(mql, new MediaQueryListEvent('change', { matches, media: mqlOf(mql).media }));
  }
};
