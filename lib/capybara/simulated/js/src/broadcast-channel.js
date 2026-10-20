// BroadcastChannel (HTML §9.5), generated from its IDL — same-origin publish/subscribe across an agent's browsing
// contexts and workers: Mastodon's cross-tab sync, Discourse's MessageBus fall-back. A post reaches every OTHER channel
// of the same name and origin — this realm's, a frame's, another window's, a worker's — each its own deserialized copy,
// in the order the channels were made. Every channel of the isolate, its realm, name, origin and whether it is closed,
// is the engine's (broadcast_channels.rs), in that order; its slots hold its name and its number there.

import { EventTarget, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { convertBroadcastChannelArguments, installBroadcastChannel } from './generated/bindings.js';
import { documentOrigin, serializeOriginKey } from './platform-globals.js';
import { decodeMessage, encodeMessage, messageEventType } from './workers.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';
import { hostTask } from './timers.js';
import { DOMException } from './dom-exception.js';

const NO_TRANSFER = Object.freeze([]);
// A message posted to a channel, read back for one receiving it: its `message` — or `messageerror`, where it cannot be.
function broadcastEvent(serialized, origin) {
  const m = decodeMessage(serialized);
  return createMessageEvent(messageEventType(m), { data: m.data, origin, lastEventId: '', source: null, ports: [] });
}

// (…this realm's open channels, kept alive while they are: one may have a listener, and the engine holds every channel
// weakly)
const openChannels = new Set();
// The realm id of the executing context (0 = the main window, else a frame or window realm; a worker's realm is its
// own isolate's), which the host delivers a post across realms to.
const realmId = () => globalThis.RustyRacer.contextOf(globalThis);

export class BroadcastChannel extends EventTarget {
  constructor(name) {
    [name] = convertBroadcastChannelArguments(arguments);
    super();
    // (…its realm's set of open channels its own to leave as it closes, whichever realm's method closes it)
    makeSlots(this, 'BroadcastChannel', { name, id: globalThis.__dom.bcNew(this, name, globalThis.__csimBcOriginKey()), open: openChannels });
    openChannels.add(this);
  }
}
const channelOf = (o) => slotsOf(o, 'BroadcastChannel');
registerInterface('BroadcastChannel', (o) => channelOf(o) !== undefined);

// A delivery to the channel of the engine's number `id`: none where it is closed or gone since the post.
function deliverTo(id, serialized, origin) {
  const channel = globalThis.__dom.bcChannel(id);
  if (channel !== null) dispatchWithOnHandler(channel, broadcastEvent(serialized, origin));
}

function post(channel, message) {
  const s = channelOf(channel);
  const state = globalThis.__dom.bcState(s.id);
  if (state === 2) throw new DOMException('BroadcastChannel is closed', 'InvalidStateError');
  // (…one its realm took with it — a detached frame's — posts to no one)
  if (state === 0) return;
  // A worker that called `self.close()` has a terminated event loop: its posts are dropped — broadcastchannel/workers
  // "messages from/within a closed worker should be ignored".
  if (globalThis.__csimWorkerClosed) return;
  // The posting context's origin, two forms: the SERIALIZED one ("null" for an opaque context), which a receiver's
  // MessageEvent.origin is, and the SCOPING key (a unique token for an opaque origin, `__csimBcOriginKey`) the delivery
  // beyond this realm gates on — a BroadcastChannel is scoped to (origin, name).
  const origin    = documentOrigin();
  const originKey = globalThis.__csimBcOriginKey();
  // Serialized once, at post time (workers.js `encodeMessage`, as a message crossing isolates is — some of its receivers
  // are in other windows and workers): an uncloneable message throws DataCloneError synchronously, and a later change to
  // it reaches no receiver. Each receiver reads its own copy of that back, in its own realm.
  const serialized = encodeMessage(message, NO_TRANSFER);
  // The channels it reaches in this isolate, in creation order, as they are at post time (a channel made after it
  // receives nothing).
  const targets = globalThis.__dom.bcTargets(s.name, originKey, realmId(), s.id);
  // Where another realm of this isolate is live, EVERY delivery — this realm's own channels included — goes through
  // the host's queue (`__csimBcPost`): one queue is what orders a frame's channel against this realm's. The host fans
  // out to workers and other windows from there too.
  if (!globalThis.__csim_isWorker && typeof globalThis.__csimBcSiblingsExist === 'function' && globalThis.__csimBcSiblingsExist()) {
    if (typeof globalThis.__csimBcPost === 'function') {
      try { globalThis.__csimBcPost(s.name, Array.from(targets), originKey, serialized, origin); } catch (_) {}
    }
    return;
  }
  // Alone in the isolate (the common app case — no frames): each a task of its own (HTML "queue a global task on the
  // DOM manipulation task source") — not a microtask, which ran ahead of every task the page had queued and delivered a
  // post before the poster's own promise jobs; a channel an earlier handler closed receives nothing. (…this realm's
  // alone: a detached frame's realm is alone in its event loop, and the isolate's other realms are the host's to reach)
  const own = realmId();
  for (let i = 1; i < targets.length; i += 2) {
    if (targets[i - 1] !== own) continue;
    const id = targets[i];
    globalThis.__csimSetTimeout(() => deliverTo(id, serialized, origin), 0);
  }
  // …and, through the host, the other windows' and the workers' that share this origin.
  if (typeof globalThis.__csimBroadcast === 'function') {
    try { globalThis.__csimBroadcast(s.name, serialized, realmId(), originKey); } catch (_) {}
  }
}

function close(channel) {
  const s = channelOf(channel);
  globalThis.__dom.bcClose(s.id);
  s.open.delete(channel);
}

installBroadcastChannel(BroadcastChannel, {
  get_name: (channel) => channelOf(channel).name,
  postMessage: (channel, message) => post(channel, message),
  close: (channel) => close(channel),
  installEventHandlers: installEventHandlerAttrs
});
globalThis.BroadcastChannel = BroadcastChannel;

// The host's ordered delivery of one queued message to one channel of the isolate (where there is more than one realm):
// a channel closed since the post receives nothing.
globalThis.__csim_bcDeliverOne = hostTask(deliverTo);
// …and one posted in ANOTHER window or a worker, which the host queued against this isolate's channels in creation
// order as it does its own: its origin is the poster's KEY (an opaque origin's a token of its own agent cluster),
// which MessageEvent.origin serializes; its data read back for this channel alone (HTML deserializes per destination).
globalThis.__csim_bcDeliverInbound = hostTask(function (id, serialized, originKey) {
  deliverTo(id, serialized, serializeOriginKey(originKey == null ? '' : String(originKey)));
});
// The channels of the isolate a post from another window or a worker reaches, in creation order — but those of the
// realm it came through, where it names one — for the host to queue it for: [realm, id, …].
globalThis.__csimBcTargets = function (name, originKey, sourceRealm) {
  return Array.from(globalThis.__dom.bcTargets(String(name), originKey == null ? '' : String(originKey), sourceRealm == null ? -1 : sourceRealm, 0));
};
// A WORKER's channels — a worker is an isolate of its own, which the host reaches by its inbox — receive the messages
// posted in windows and other workers to their name, of the same origin alone. Each channel's delivery a task of its
// own (its microtasks run before the next channel's or message's), against the channels as they are then — one an
// earlier handler closed receives nothing — its data deserialized for it alone.
globalThis.__csim_deliverBroadcasts = hostTask(function (events) {
  if (!events || !events.length) return;
  const myKey = globalThis.__csimBcOriginKey();
  for (const ev of events) {
    if (!ev) continue;
    const senderKey = ev.origin == null ? '' : String(ev.origin);
    if (senderKey !== myKey) continue;
    const origin = serializeOriginKey(senderKey);
    const targets = globalThis.__dom.bcTargets(String(ev.name), senderKey, -1, 0);
    for (let i = 1; i < targets.length; i += 2) {
      const id = targets[i];
      globalThis.__csimSetTimeout(() => deliverTo(id, ev.data, origin), 0);
    }
  }
});
