// CloseWatcher (HTML §6.10.3), generated from its IDL: a script's close watcher, which its window's close watcher manager
// groups with the dialogs' and popovers' — a close request (the Escape key), requestClose(), close() and destroy() are
// the engine's (close_watchers.rs), which fires its `cancel` and `close` through `hostSteps.fireSimpleEvent`. Its slots
// hold the realm whose Window it watches in and its number there.

import { EventTarget, addAbortAlgorithm, installEventHandlerAttrs } from './events.js';
import { defineCloseWatcher } from './generated/bindings.js';
import { slotsOf } from './webidl.js';
import { DOMException } from './dom-exception.js';
import { dom, realmHooks } from './engine.js';

const watcherOf = (w) => slotsOf(w, 'CloseWatcher');

export const CloseWatcher = defineCloseWatcher(EventTarget, {
  // HTML "establish a close watcher" in this realm's Window — refused where its document is not fully active — and,
  // given a signal, destroyed as it aborts (or now, aborted already: `addAbortAlgorithm` adds nothing then).
  construct(slots, options) {
    const id = dom.closeWatcherNew(slots.owner);
    if (id < 0) throw new DOMException("Failed to construct 'CloseWatcher': CloseWatchers cannot be created in detached Windows.", 'InvalidStateError');
    const realm = realmHooks.realmId();
    slots.realm = realm;
    slots.id = id;
    const signal = options.signal;
    if (signal === undefined) return;
    if (dom.abortSignalAborted(slotsOf(signal, 'AbortSignal').id)) dom.closeWatcherDestroy(realm, id);
    else addAbortAlgorithm(signal, () => dom.closeWatcherDestroy(realm, id));
  },
  requestClose(w) { const s = watcherOf(w); dom.closeWatcherRequestClose(s.realm, s.id); },
  close(w) { const s = watcherOf(w); dom.closeWatcherClose(s.realm, s.id); },
  destroy(w) { const s = watcherOf(w); dom.closeWatcherDestroy(s.realm, s.id); },
  installEventHandlers: installEventHandlerAttrs
});
globalThis.CloseWatcher = CloseWatcher;
