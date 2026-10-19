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
import { installMessageChannel, installMessagePort } from './generated/bindings.js';
import { followWindowClock } from './timers.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

// (…this realm's, which its ports hold: its event loop, its events, and its plumbing to the host — looked up as it is
// called, which a worker's scope replaces once installed)
const REALM = {
  queueTask: (task) => globalThis.__csimSetTimeout(task, 0),
  messageEvent: (data, ports, failed) => createMessageEvent(failed ? 'messageerror' : 'message', { data, ports, origin: '', lastEventId: '', source: null }),
  endHere: (end) => globalThis.__csimPortEndHere(end),
  endGone: (end, held) => globalThis.__csimPortEndGone(end, held),
  endClosed: (end) => globalThis.__csimPortEndClosed(end),
  redeliver: (end, dataStr) => globalThis.__csimPortRedeliver(end, dataStr),
  post: (end, message, transfer) => REALM.postEncoded(end, globalThis.__csimEncodeMessage(message, transfer)),
  postEncoded: (end, dataStr) => globalThis.__csimPortRemotePost(end, dataStr)
};
// (…the ports holding an end of this isolate, kept alive as the host may deliver to them: the engine holds every port
// weakly)
const endHolders = new Set();

// A port's entanglement, its port message queue, whether it is enabled or detached, and the end a remote one is are the
// engine's (message_ports.rs), by its number. Its slots hold that number, the realm whose tasks and events its
// messages are, and the peer it is entangled with, kept alive with it — the engine's weak set names it.
export class MessagePort extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'MessagePort');
    super();
    makeSlots(this, 'MessagePort', { id: globalThis.__dom.portNew(this), realm: REALM, peer: null });
  }
}
const portOf = (o) => slotsOf(o, 'MessagePort');
// Whether `o` is a MessagePort, of any realm.
export const isMessagePort = (o) => portOf(o) !== undefined;
registerInterface('MessagePort', isMessagePort);

export const newMessagePort = () => new MessagePort(PLATFORM);
// Two new ports, entangled — a MessageChannel's, or a SharedWorker's outside port and the inside one its worker's
// `connect` carries.
export function newEntangledPorts() {
  const port1 = newMessagePort(), port2 = newMessagePort();
  globalThis.__dom.portEntangle(portOf(port1).id, portOf(port2).id);
  portOf(port1).peer = port2;
  portOf(port2).peer = port1;
  return [port1, port2];
}
export const portDetached = (port) => globalThis.__dom.portDetached(portOf(port).id);
export const peerOf = (port) => globalThis.__dom.portPeer(portOf(port).id);
// A remote port's post: through the host from its end, in its realm.
export function postRemote(port, message, transfer) {
  const s = portOf(port);
  const end = globalThis.__dom.portRemoteEnd(s.id);
  if (end === null) return false;
  s.realm.post(end, message, transfer);
  return true;
}

// A message arriving at `port`: a task on its queue where the queue is enabled, held till it is where not.
// (…`failed`: one that could not be read back here, its event a `messageerror`)
export function acceptMessage(port, data, ports, failed = false) {
  if (globalThis.__dom.portAccept(portOf(port).id, data, ports, failed)) deliver(port);
}
// (…a delivery task: the message the engine has next for the port when it runs, none where a transfer took it on)
function deliver(port) {
  const s = portOf(port);
  s.realm.queueTask(() => {
    const m = globalThis.__dom.portNext(s.id);
    if (m !== null) dispatchWithOnHandler(port, s.realm.messageEvent(m[0], m[1], m[2]));
  });
}
// `start()` — and an `onmessage` set: its queue enabled, what it held delivered in order. Once.
export function enablePort(port) {
  for (let n = globalThis.__dom.portEnable(portOf(port).id); n > 0; n--) deliver(port);
}
// `close()` disentangles it: detached (a closed port is no transferable), its peer — a port of the isolate, or the far
// end of its channel — left with nowhere to deliver. The peer itself stays open.
export function closePort(port) {
  const s = portOf(port);
  const end = globalThis.__dom.portClose(s.id);
  if (s.peer && portOf(s.peer).peer === port) portOf(s.peer).peer = null;
  s.peer = null;
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
  const end = globalThis.__dom.portTransfer(s.id, m.id);
  m.peer = s.peer;
  if (m.peer) portOf(m.peer).peer = moved;
  s.peer = null;
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
  const s = portOf(port);
  const lone = s.peer || peerOf(port) ? 0 : portOf(newMessagePort()).id;
  const went = globalThis.__dom.portToEnd(s.id, String(globalThis.__csimAllocPortChannel()), lone);
  if (went.length === 1) return went[0];
  const [end, pending, kept, keptEnd] = went;
  s.peer = null;
  endHolders.delete(port);
  if (kept === undefined) {
    s.realm.endGone(end, pending.map((m) => globalThis.__csimReencodeMessage({ data: m[0], ports: m[1], failed: m[2] })));
  } else {
    const k = portOf(kept);
    k.peer = null;
    endHolders.add(kept);
    k.realm.endHere(keptEnd);
    // (…what can no longer cross — one that failed already, one holding what crosses no isolate — read back as failed)
    for (const m of pending) k.realm.postEncoded(keptEnd, globalThis.__csimReencodeMessage({ data: m[0], ports: m[1], failed: m[2] }));
  }
  return end;
};
// …and THIS isolate's port at an end transferred TO it — one port however often the message names the end.
globalThis.__csimEndToPort = function (end) {
  end = String(end);
  const held = globalThis.__dom.portOfEnd(end);
  if (typeof held === 'object' && held !== null) return held;
  const port = newMessagePort();
  globalThis.__dom.portAtEnd(portOf(port).id, end);
  endHolders.add(port);
  REALM.endHere(end);
  return port;
};
// A message the host routed to an end this isolate holds: the serialized message (its data and the ports it
// transferred), decoded, accepted. One for an end it has given up since the host sent it — it was on its way — goes
// back, for the end's holder now.
globalThis.__csimPortEndDeliver = function (end, dataStr) {
  end = String(end);
  const held = globalThis.__dom.portOfEnd(end);
  if (typeof held !== 'object' || held === null) {
    if (held === true) REALM.redeliver(end, dataStr);
    return;
  }
  const m = globalThis.__csimDecodeMessage(dataStr);
  acceptMessage(held, m.data, m.ports, m.failed);
};

// A window or frame realm's half of the plumbing: a channel id unique in the isolate (`pc-r<realm>-<n>`), and the
// post, the taking and the giving up of an end made to the host directly. A worker's scope has its own (workers.js),
// its thread's outbox in place of the host.
let channelSeq = 0;
globalThis.__csimAllocPortChannel = function () {
  return 'pc-r' + globalThis.__csimRealmId() + '-' + (++channelSeq);
};
globalThis.__csimPortRemotePost = function (end, dataStr) {
  followWindowClock();
  globalThis.__csimClientPortPost(end, dataStr);
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
      installEventHandlerAttrs(proto, names, null, isSelf);
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
export class MessageChannel {
  constructor() {
    const [port1, port2] = newEntangledPorts();
    makeSlots(this, 'MessageChannel', { port1, port2 });
  }
}
const channelOf = (o) => slotsOf(o, 'MessageChannel');
registerInterface('MessageChannel', (o) => channelOf(o) !== undefined);
installMessageChannel(MessageChannel, {
  get_port1: (channel) => channelOf(channel).port1,
  get_port2: (channel) => channelOf(channel).port2
});
globalThis.MessageChannel = MessageChannel;
