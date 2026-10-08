// BroadcastChannel (HTML §9.5), generated from its IDL — same-origin publish/subscribe across an agent's browsing
// contexts and workers: Mastodon's cross-tab sync, Discourse's MessageBus fall-back. A post reaches every OTHER channel
// of the same name and origin — this realm's, a frame's, another window's, a worker's — each its own deserialized copy,
// in the order the channels were made. Its name, whether it is closed and its id in this realm's registry are its
// internal slots'.

import { EventTarget, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { convertBroadcastChannelArguments, installBroadcastChannel } from './generated/bindings.js';
import { csimMaybeTransferIn, documentOrigin, serializeOriginKey, structuredClone } from './platform-globals.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';

// This realm's channels by name, and by the id the host's registry knows each by.
const channelsByName = new Map();
let   localSeq = 1;
const channelsByLocal = new Map();
// The realm id of the executing context (0 = the main window, else a frame or window realm), which keys a channel in
// the host's registry.
const realmId = () => globalThis.RustyRacer.contextOf(globalThis);

export class BroadcastChannel extends EventTarget {
  constructor(name) {
    [name] = convertBroadcastChannelArguments(arguments);
    super();
    const s = makeSlots(this, 'BroadcastChannel', { name, closed: false, local: localSeq++ });
    const set = channelsByName.get(name) || new Set();
    set.add(this);
    channelsByName.set(name, set);
    channelsByLocal.set(s.local, this);
    // Registered with the host's isolate-wide, creation-ordered registry, which delivers a post to every same-origin
    // channel "in creation order, oldest first" across realms where there is more than one (see `post`). A worker's
    // channel is not: a worker is a SEPARATE isolate, which the host reaches by its inbox — and its `contextOf` would
    // collide with the main window's realm 0.
    if (!globalThis.__csim_isWorker && typeof globalThis.__csimBcRegister === 'function') {
      try { globalThis.__csimBcRegister(realmId(), s.local, name, globalThis.__csimBcOriginKey()); } catch (_) {}
    }
  }
}
const channelOf = (o) => slotsOf(o, 'BroadcastChannel');
registerInterface('BroadcastChannel', (o) => channelOf(o) !== undefined);

function post(channel, message) {
  const s = channelOf(channel);
  if (s.closed) throw new globalThis.DOMException('BroadcastChannel is closed', 'InvalidStateError');
  // A worker that called `self.close()` has a terminated event loop: its posts are dropped — broadcastchannel/workers
  // "messages from/within a closed worker should be ignored".
  if (globalThis.__csimWorkerClosed) return;
  // The posting context's origin, two forms: the SERIALIZED one ("null" for an opaque context), which a receiver's
  // MessageEvent.origin is, and the SCOPING key (a unique token for an opaque origin, `__csimBcOriginKey`) the delivery
  // beyond this realm gates on — a BroadcastChannel is scoped to (origin, name).
  const origin    = documentOrigin();
  const originKey = globalThis.__csimBcOriginKey();
  // Serialized once, at post time: an uncloneable message throws DataCloneError synchronously, and a later change to it
  // reaches no receiver. Each receiver gets its own copy of that.
  const serialized = structuredClone(message);
  // Where another realm of this isolate is live, EVERY delivery — this realm's own channels included — goes through
  // the host's creation-ordered registry (`__csimBcPost`): one queue that snapshots the eligible channels at post time
  // is what orders a frame's channel against this realm's and keeps a channel made after the post from receiving it.
  // The host fans out to workers and other windows from there too.
  if (!globalThis.__csim_isWorker && typeof globalThis.__csimBcSiblingsExist === 'function' && globalThis.__csimBcSiblingsExist()) {
    if (typeof globalThis.__csimBcPost === 'function') {
      try { globalThis.__csimBcPost(realmId(), s.local, s.name, originKey, serialized, origin); } catch (_) {}
    }
    return;
  }
  // Alone in the isolate (the common app case — no frames): this realm's other channels, each a task of its own (HTML
  // "queue a global task on the DOM manipulation task source") — not a microtask, which ran ahead of every task the
  // page had queued and delivered a post before the poster's own promise jobs…
  const set = channelsByName.get(s.name);
  if (set) {
    for (const other of [...set]) {
      if (other === channel) continue;
      globalThis.__csimSetTimeout(() => {
        // (…against the set as it was at post time, which a close() changes in place: a channel an earlier handler
        // closed receives nothing)
        if (channelOf(other).closed || !set.has(other)) return;
        dispatchWithOnHandler(other, createMessageEvent('message', { data: structuredClone(serialized), origin, lastEventId: '', source: null, ports: [] }));
      }, 0);
    }
  }
  // …and, through the host, the other windows' and the workers' that share this origin, which this realm's registry
  // does not reach.
  if (typeof globalThis.__csimBroadcast === 'function') {
    try { globalThis.__csimBroadcast(s.name, message, realmId(), originKey); } catch (_) {}
  }
}

function close(channel) {
  const s = channelOf(channel);
  s.closed = true;
  const set = channelsByName.get(s.name);
  if (set) { set.delete(channel); if (set.size === 0) channelsByName.delete(s.name); }
  channelsByLocal.delete(s.local);
  if (!globalThis.__csim_isWorker && typeof globalThis.__csimBcUnregister === 'function') {
    try { globalThis.__csimBcUnregister(realmId(), s.local); } catch (_) {}
  }
}

installBroadcastChannel(BroadcastChannel, {
  get_name: (channel) => channelOf(channel).name,
  postMessage: (channel, message) => post(channel, message),
  close: (channel) => close(channel),
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.BroadcastChannel = BroadcastChannel;

// The host's ordered delivery of one queued message to one channel of this realm (where there is more than one
// realm): a channel closed since the post receives nothing.
globalThis.__csim_bcDeliverOne = function (localId, data, origin) {
  const channel = channelsByLocal.get(localId);
  if (!channel || channelOf(channel).closed) return;
  dispatchWithOnHandler(channel, createMessageEvent('message', { data, origin, lastEventId: '', source: null, ports: [] }));
};
// …and the messages posted in OTHER windows and in workers, to this realm's channels of their name — of the same
// origin alone: a post's origin KEY must be this context's (an opaque origin's is a token of its own agent cluster,
// which a blob: worker that inherited it shares, and nothing else does). MessageEvent.origin is the serialized origin.
globalThis.__csim_deliverBroadcasts = function (events) {
  if (!events || !events.length) return;
  const myKey = globalThis.__csimBcOriginKey();
  for (const ev of events) {
    const set = channelsByName.get(ev && ev.name);
    if (!set) continue;
    const senderKey = ev.origin == null ? '' : String(ev.origin);
    if (senderKey !== myKey) continue;
    const origin = serializeOriginKey(senderKey);
    const data = csimMaybeTransferIn(ev.data);
    // (…each channel's a task of its own, as this realm's own posts' — its microtasks run before the next channel's or
    // message's — against the channels as they are now: one an earlier handler closed receives nothing)
    for (const channel of [...set]) {
      globalThis.__csimSetTimeout(() => {
        if (channelOf(channel).closed || !set.has(channel)) return;
        dispatchWithOnHandler(channel, createMessageEvent('message', { data, origin, lastEventId: '', source: null, ports: [] }));
      }, 0);
    }
  }
};
