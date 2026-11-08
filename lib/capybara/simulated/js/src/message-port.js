// MessageChannel and MessagePort (HTML §9.4), generated from their IDL — channel messaging. Two entangled ports; a
// message posted on one is a task on the other's port message queue, which holds what arrives until `start()` or an
// `onmessage` enables it. A port is made by the platform alone (a channel's, a transfer's); what it is entangled with,
// what its queue holds and whether it is enabled or detached are the engine's (message_ports.rs). Its `postMessage`
// serializes the message (platform-globals.js, beside the structured clone); this is the entanglement it travels over.
//
// A port belongs to the realm that made it: its messages are tasks of that realm's event loop (a detached iframe's ports
// stop delivering with it) and MessageEvents of that realm — `realm` in its slots, whichever realm posts to it.
//
// A port whose peer is in ANOTHER isolate (a worker's, a service worker's, or a frame's port that went on to one) is a
// remote one: it is an END of a channel the host relays — `<channel>/0` or `<channel>/1` (`portRemoteEnd`) — and a message
// posted at it goes serialized through the host to whatever holds the other end, a realm of the window or a worker. An
// isolate says so as it takes an end (`endHere`), as it gives one up to another (`endGone`), handing the host the
// messages that end had received and not delivered, for its next holder — and hands back any that reach it after
// (`redeliver`) — and as a port closes its end (`endClosed`).

import { EventTarget, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { defineMessageChannel, installMessagePort } from './generated/bindings.js';
import { askedWorker, atItsTime, followWindowClock } from './timers.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf, inheritInterface, createObject } from './webidl.js';
import { dom, hostSteps, listMap, listOf } from './engine.js';

// (…this realm's, which its ports hold: its event loop, its events, and its plumbing to the host — looked up as it is
// called, which a worker's scope replaces once installed)
const REALM = {
  queueTask: (task) => globalThis.__csimSetTimeout(task, 0),
  read: (serialized) => globalThis.__csimReadMessage(serialized),
  messageEvent: (data, ports, failed) => createMessageEvent(failed ? 'messageerror' : 'message', { data, ports, origin: '', lastEventId: '', source: null }),
  endHere: (end) => globalThis.__csimPortEndHere(end),
  endGone: (end, held) => globalThis.__csimPortEndGone(end, held),
  endClosed: (end) => globalThis.__csimPortEndClosed(end),
  redeliver: (end, dataStr) => globalThis.__csimPortRedeliver(end, dataStr),
  post: (end, message, transfer) => REALM.postEncoded(end, globalThis.__csimEncodeMessage(message, transfer)),
  // (…an end a worker holds — a dedicated or a shared worker's, the host says — which takes it at the time it was posted
  // at: timers.js `askedWorker`)
  postEncoded: (end, dataStr) => {
    if (globalThis.__csimPortRemotePost(end, dataStr) === true) askedWorker();
  }
};
// (…the ports holding an end of this isolate, kept alive as the host may deliver to them: the engine holds every port
// weakly)
const endHolders = new Set();

// A port's entanglement, the order of its port message queue, whether it is enabled or detached, and the end a remote
// one is are the engine's (message_ports.rs), by its number. Its slots hold that number, the realm whose tasks and
// events its messages are, the messages its queue holds — each by the engine's number for it, its cloned data and
// ports and whether it failed — and the peer it keeps alive (`keeps`): the engine names ports weakly, and HTML keeps a
// port alive while its queue is enabled and its peer is, so a port holds its peer once THAT one is enabled
// (`enablePort`) — a port no one can enable, held by its peer alone, is collected, and what it held let go of with it
// (message_ports.rs `release`); posts to its peer then go nowhere.
export class MessagePort extends Object {
  constructor(token) {
    constructedBy(PLATFORM, token, 'MessagePort');
    const self = createObject(new.target);
    const slots = makeSlots(self, 'MessagePort');
    slots.id = dom.portNew(self);
    slots.realm = REALM;
    slots.keeps = null;
    slots.messages = new Map();
    return self;
  }
}
inheritInterface(MessagePort, EventTarget);
const portOf = (o) => slotsOf(o, 'MessagePort');
// Whether `o` is a MessagePort, of any realm.
export const isMessagePort = (o) => portOf(o) !== undefined;
registerInterface('MessagePort', isMessagePort);

export const newMessagePort = () => new MessagePort(PLATFORM);
// Two new ports, entangled — a MessageChannel's, or a SharedWorker's outside port and the inside one its worker's
// `connect` carries.
export function newEntangledPorts() {
  const port1 = newMessagePort(), port2 = newMessagePort();
  dom.portEntangle(portOf(port1).id, portOf(port2).id);
  return [port1, port2];
}
export const portDetached = (port) => dom.portDetached(portOf(port).id);
export const peerOf = (port) => dom.portPeer(portOf(port).id);
// A remote port's post: through the host from its end, in its realm.
export function postRemote(port, message, transfer) {
  const s = portOf(port);
  const end = dom.portRemoteEnd(s.id);
  if (end === null) return false;
  s.realm.post(end, message, transfer);
  return true;
}

// A message arriving at `port`: a task on its queue where the queue is enabled, held till it is where not — one another
// isolate sent read back already (its `data` and `ports`, `failed` where it could not be, its event a `messageerror`),
// one of this isolate's still `serialized` (`acceptSerialized`): HTML reads a port's message back as its task runs, in
// the realm that holds the port THEN — whichever a transfer took it on to.
// (…the engine holding an unread one's serialization with it, which it lets go of with the message: message_ports.rs)
export function acceptMessage(port, data, ports, failed = false) {
  accept(port, { data, ports, failed }, undefined);
}
export function acceptSerialized(port, serialized) {
  accept(port, { serialized }, serialized.serialized);
}
function accept(port, message, serialization) {
  const s = portOf(port);
  const n = dom.portAccept(s.id, serialization);
  s.messages.set(Math.abs(n), message);
  if (n > 0) deliver(port);
}
// (…a message as the realm of the port's slots `s` reads it: platform-globals.js `readMessage`)
const readHere = (s, m) => (m.serialized === undefined ? m : s.realm.read(m.serialized));
// (…a delivery task: the message the engine has next for the port when it runs, none where a transfer took it on)
function deliver(port) {
  const s = portOf(port);
  s.realm.queueTask(() => {
    const n = dom.portNext(s.id);
    if (n < 0) return;
    const held = s.messages.get(n);
    s.messages.delete(n);
    const m = readHere(s, held);
    dispatchWithOnHandler(port, s.realm.messageEvent(m.data, m.ports, m.failed));
  });
}
// (…the messages of the engine's numbers `pending`, taken out of the port's slots — a transfer's to another isolate, which
// reads them back here first: they go on encoded)
// (…one a read throws for lets the rest go unread: the engine has passed them on to these reads)
function takeMessages(s, pending) {
  const held = Array.from(pending, (n) => s.messages.get(n));
  s.messages = new Map();
  let read = 0;
  try {
    return held.map((m) => { const r = readHere(s, m); read++; return r; });
  } finally {
    for (const m of held.slice(read)) if (m.serialized !== undefined) dom.structuredDiscard(m.serialized.serialized);
  }
}
// `start()` — and an `onmessage` set: its queue enabled, what it held delivered in order. Once.
export function enablePort(port) {
  const peer = peerOf(port);
  if (peer !== null) portOf(peer).keeps = port;
  for (let n = dom.portEnable(portOf(port).id); n > 0; n--) deliver(port);
}
// (…the peer's hold on `port` let go of: `port` closed or transferred)
function unkeep(port, peer) {
  if (peer !== null && portOf(peer).keeps === port) portOf(peer).keeps = null;
}
// `close()` disentangles it: detached (a closed port is no transferable), its peer — a port of the isolate, or the far
// end of its channel — left with nowhere to deliver. The peer itself stays open.
export function closePort(port) {
  const s = portOf(port);
  unkeep(port, peerOf(port));
  const end = dom.portClose(s.id);
  s.keeps = null;
  s.messages = new Map();
  endHolders.delete(port);
  if (end !== null) s.realm.endClosed(end);
}
// A port transferred within the isolate — to a message's receiver, to another realm: a fresh port of THIS realm
// entangled in its place, its peer (or its channel end, which this realm takes) moved onto it, and every message it had
// not delivered — queued as tasks or held — held there, in order, ahead of any posted after: HTML's transfer-receiving
// steps move the tasks into the new port's queue "leaving [it] in its initial disabled state", for the receiver's
// `onmessage` or `start()` to enable. The source neutered.
export function movePort(port) {
  const s = portOf(port), moved = newMessagePort(), m = portOf(moved);
  // (…its peer's hold on it let go of — the new port starts disabled — and its hold on its peer the new port's)
  unkeep(port, peerOf(port));
  const end = dom.portTransfer(s.id, m.id);
  // (…every message it had not delivered the new port's, as the engine moved their places in its queue)
  m.messages = s.messages;
  s.messages = new Map();
  m.keeps = s.keeps;
  s.keeps = null;
  endHolders.delete(port);
  if (end !== null) {
    endHolders.add(moved);
    REALM.endHere(end);
  }
  return moved;
}

// ── Remote ports ──
// Transfer `port` to another isolate: the end the message carries for it (the same again for the same port, which a
// message can reference in its data and its transfer list both), `port` neutered. A remote port gives its end up to
// the receiver, with the messages it had received and not delivered; a port of this isolate makes a channel of its
// entanglement, its kept peer taking the other end here and posting what `port` held on to it, first (a lone port
// still gets a routable, if idle, end). Called by the message serializer (workers.js).
globalThis.__csimPortToEnd = function (port) {
  const s = portOf(port), peer = peerOf(port);
  // (…held here, not by its number alone, till the engine hands it back as the port that keeps the channel's end)
  const lone = peer !== null ? null : newMessagePort();
  unkeep(port, peer);
  const went = dom.portToEnd(s.id, dom.portChannel(), lone === null ? 0 : portOf(lone).id);
  if (went.length === 1) return went[0];
  const end = went[0], numbers = went[1], kept = went[2], keptEnd = went[3];
  const pending = takeMessages(s, numbers);
  s.keeps = null;
  endHolders.delete(port);
  if (kept === undefined) {
    s.realm.endGone(end, listMap(pending, (m) => globalThis.__csimReencodeMessage(m)));
  } else {
    const k = portOf(kept);
    k.keeps = null;
    endHolders.add(kept);
    k.realm.endHere(keptEnd);
    // (…what can no longer cross — one that failed already, one holding what crosses no isolate — read back as failed)
    for (const m of listOf(pending)) k.realm.postEncoded(keptEnd, globalThis.__csimReencodeMessage(m));
  }
  return end;
};
// …and THIS isolate's port at an end transferred TO it — one port however often the message names the end.
globalThis.__csimEndToPort = function (end) {
  end = String(end);
  const held = dom.portOfEnd(end);
  if (typeof held === 'object' && held !== null) return held;
  const port = newMessagePort();
  dom.portAtEnd(portOf(port).id, end);
  endHolders.add(port);
  REALM.endHere(end);
  return port;
};
// A message the host routed to an end this isolate holds: the serialized message (its data and the ports it
// transferred), decoded, accepted. One for an end it has given up since the host sent it — it was on its way — goes
// back, for the end's holder now.
hostSteps.portEndDeliver = function (end, dataStr) {
  end = String(end);
  const held = dom.portOfEnd(end);
  if (typeof held !== 'object' || held === null) {
    if (held === true) REALM.redeliver(end, dataStr);
    return;
  }
  // (…accepted at the time it was posted at, on this realm's clock: timers.js `atItsTime`)
  atItsTime('p' + end, globalThis.__csimSentAt(dataStr), () => {
    const m = globalThis.__csimDecodeMessage(dataStr);
    acceptMessage(held, m.data, m.ports, m.failed);
  });
};

// A window or frame realm's half of the plumbing: the post, the taking and the giving up of an end made to the host directly
// (the host keeps every window's channels — Browser#port_end_here). A worker's scope has its own (workers.js), its thread's
// outbox in place of the host.
globalThis.__csimPortRemotePost = function (end, dataStr) {
  followWindowClock();
  return globalThis.__csimClientPortPost(end, dataStr) === true;
};
globalThis.__csimPortEndHere = function (end) {
  followWindowClock();
  globalThis.__csimClientPortEndHere(end, globalThis.__csimRealmId());
};
globalThis.__csimPortEndGone = function (end, held) {
  globalThis.__csimClientPortEndGone(end, held, globalThis.__csimRealmId());
};
globalThis.__csimPortEndClosed = function (end) {
  globalThis.__csimClientPortEndClosed(end);
};
globalThis.__csimPortRedeliver = function (end, dataStr) {
  globalThis.__csimClientPortRedeliver(end, dataStr);
};

// Its members — `postMessage` the caller's (`post`) — and its event handlers, of which setting `onmessage` to a handler
// enables its queue as `start()` does (HTML §9.4.4); `addEventListener('message')` does not.
export function installPorts(post) {
  installMessagePort(MessagePort, {
    postMessage_message_transfer: (port, message, transfer) => post(port, message, transfer),
    postMessage_message_options: (port, message, options) => post(port, message, options.transfer),
    start: (port) => enablePort(port),
    close: (port) => closePort(port),
    installEventHandlers(proto, names, isSelf) {
      installEventHandlerAttrs(proto, names, isSelf);
      const handler = Object.getOwnPropertyDescriptor(proto, 'onmessage');
      const { set } = Object.getOwnPropertyDescriptor({
        set onmessage(v) {
          handler.set.call(this, v);
          if (v !== null && (typeof v === 'object' || typeof v === 'function')) enablePort(this);
        }
      }, 'onmessage');
      Object.defineProperty(proto, 'onmessage', { ...handler, set });
    }
  });
  globalThis.MessagePort = MessagePort;
}

// A MessageChannel: its two ports, entangled — React's scheduler and idle-callback polyfills post on one to be called
// back from the other, a task rather than a timer.
const channelOf = (o) => slotsOf(o, 'MessageChannel');
export const MessageChannel = defineMessageChannel({
  construct(slots) {
    const ports = newEntangledPorts();
    slots.port1 = ports[0];
    slots.port2 = ports[1];
  }
});
globalThis.MessageChannel = MessageChannel;
